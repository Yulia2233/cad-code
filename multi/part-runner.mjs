import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {ROOT, RUNTIME, PYTHON, SKILL, sessionDir} from '../src/paths.mjs';
import {importFiles} from '../src/cli-input.mjs';
import {savedProviderFile} from '../src/provider-config.mjs';
import {readProject, updateProject} from './store.mjs';

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const ownAttemptID = () => 'attempt-' + crypto.randomUUID();

function localURL(value) {
  const url = new URL(value);
  if (url.protocol !== 'http:' || !['127.0.0.1', 'localhost'].includes(url.hostname)) throw Error('MultiSessionError: backend must be local');
  return url;
}

async function healthy(connection) {
  try {
    const url = localURL(connection.url);
    const response = await fetch(new URL('/global/health', url), {
      headers: {authorization: 'Basic ' + Buffer.from('opencode:' + connection.password).toString('base64')},
      signal: AbortSignal.timeout(1000),
    });
    return response.ok;
  } catch { return false; }
}

function readConnection(file) {
  try {
    const stat = fs.lstatSync(file);
    if (stat.isSymbolicLink() || !stat.isFile()) return null;
    const value = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (!Number.isSafeInteger(value.pid) || !value.password || !value.url || !value.website) return null;
    process.kill(value.pid, 0);
    localURL(value.url); localURL(value.website);
    return value;
  } catch { return null; }
}

export async function ensureBackend({runtime = RUNTIME, spawnProcess = spawn, getConnection = readConnection, health = healthy, credentials = process.env.CAD_CODE_CREDENTIALS || savedProviderFile(), wait = sleep} = {}) {
  fs.mkdirSync(runtime, {recursive: true, mode: 0o700});
  if (fs.lstatSync(runtime).isSymbolicLink()) throw Error('MultiSessionError: CAD Code runtime must not be a symlink');
  const link = path.join(runtime, 'cli-connection.json');
  let connection = getConnection(link);
  if (connection && await health(connection)) return connection;
  const credentialFile = credentials;
  if (!credentialFile || !fs.existsSync(credentialFile)) throw Error('Configure CAD Code API credentials before starting part sessions');
  const lock = path.join(runtime, 'startup.lock');
  let server, startupError, acquired = false;
  const release = () => {
    if (!acquired) return;
    try {
      if (fs.readFileSync(path.join(lock, 'pid'), 'utf8') === String(process.pid)) fs.rmSync(lock, {recursive: true, force: true});
    } catch {}
    acquired = false;
  };
  try {
  for (let attempt = 0; attempt < 140; attempt++) {
    try {
      fs.mkdirSync(lock);
      acquired = true;
      fs.writeFileSync(path.join(lock, 'pid'), String(process.pid), {flag: 'wx', mode: 0o600});
      const log = fs.openSync(path.join(runtime, 'launcher.log'), 'a', 0o600);
      server = spawnProcess(process.execPath, [path.join(ROOT, 'src/server.mjs'), '--managed-cli', '--web', '--credentials', credentialFile], {
        cwd: ROOT, env: process.env, detached: true, stdio: ['ignore', log, log],
      });
      fs.closeSync(log);
      server.unref();
      server.once('error', error => { startupError = error; release(); });
      break;
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      let stale = false;
      try {
        const pid = Number(fs.readFileSync(path.join(lock, 'pid'), 'utf8'));
        try { process.kill(pid, 0); } catch (probe) { if (probe.code === 'ESRCH') stale = true; }
      } catch { stale = Date.now() - fs.statSync(lock).mtimeMs > 2000; }
      if (stale) { fs.rmSync(lock, {recursive: true, force: true}); continue; }
      connection = getConnection(link);
      if (connection && await health(connection)) return connection;
      await wait(250);
    }
  }
  if (!server) throw Error('Another CAD Code instance is still starting. Try again shortly.');
  for (let attempt = 0; attempt < 120; attempt++) {
    if (startupError) throw startupError;
    connection = getConnection(link);
    if (connection?.pid === server.pid && await health(connection)) return connection;
    if (server.exitCode !== null) throw Error('CAD Code backend failed to start; inspect the existing launcher log');
    await wait(250);
  }
  throw Error('CAD Code backend startup timed out');
  } catch (error) { server?.kill('SIGTERM'); throw error; } finally { release(); }
}

async function request(connection, route, method = 'GET', body, direct = false) {
  const base = localURL(direct ? connection.url : connection.website);
  const response = await fetch(new URL(route, base), {
    method,
    headers: {...(direct ? {authorization: 'Basic ' + Buffer.from('opencode:' + connection.password).toString('base64')} : {}), ...(body === undefined ? {} : {'content-type': 'application/json'})},
    ...(body === undefined ? {} : {body: JSON.stringify(body)}),
    signal: AbortSignal.timeout(30000),
  });
  const value = await response.json().catch(() => null);
  if (!response.ok) throw Object.assign(Error(value?.error || `CAD Code returned ${response.status} for ${route}`), {status: response.status});
  return value;
}

const sha = contents => crypto.createHash('sha256').update(contents).digest('hex');
const stamp = () => new Date().toISOString();
const validSession = value => /^ses_[A-Za-z0-9_-]+$/.test(value || '');
const activeStates = new Set(['creating', 'preparing', 'sending', 'queued', 'running', 'stopping', 'exporting', 'evaluating']);
function activeAttempts(project) {
  return project.unique_parts.flatMap(part => part.attempts.filter(attempt => activeStates.has(attempt.status)).map(attempt => ({part, attempt})));
}
function atomicJSON(file, data) {
  const tmp = `${file}.${crypto.randomUUID()}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2) + '\n', {flag: 'wx', mode: 0o600});
  fs.renameSync(tmp, file);
}
function regularFile(file) {
  const stat = fs.lstatSync(file);
  if (stat.isSymbolicLink() || !stat.isFile() || fs.realpathSync(file) !== file) throw Error('MultiSessionError: refusing non-regular file or symlink: ' + file);
  return file;
}
function projectFile(root, relative) {
  if (typeof relative !== 'string' || !relative || path.isAbsolute(relative)) throw Error('MultiSessionError: invalid project file path');
  const absolute = path.resolve(root, relative);
  if (!absolute.startsWith(root + path.sep)) throw Error('MultiSessionError: project path escapes root');
  return regularFile(absolute);
}
function privateDirectory(directory) {
  fs.mkdirSync(directory, {recursive: true, mode: 0o700});
  if (!fs.statSync(directory).isDirectory() || fs.realpathSync(directory) !== directory) throw Error('MultiSessionError: directory must not contain symlinks');
}
function update(root, mutate) { const current = readProject(root); return updateProject(root, current.revision, mutate); }
function findAttempt(project, id) {
  for (const part of project.unique_parts) {
    const attempt = part.attempts.find(item => item.id === id);
    if (attempt) return {part, attempt};
  }
  throw Error('MultiSessionError: unknown attempt');
}
function setAttempt(root, id, mutate) {
  return update(root, project => { const {part, attempt} = findAttempt(project, id); mutate(part, attempt, project); });
}
function copyDeliverable(source, destination) {
  if (!fs.existsSync(source)) return false;
  regularFile(source); privateDirectory(path.dirname(destination));
  if (fs.existsSync(destination)) {
    regularFile(destination);
    if (sha(fs.readFileSync(destination)) !== sha(fs.readFileSync(source))) throw Error('MultiSessionError: copied deliverable changed');
  } else fs.copyFileSync(source, destination, fs.constants.COPYFILE_EXCL);
  return true;
}
function checkHash(file, expected, label) {
  if (!/^[a-f0-9]{64}$/.test(expected || '') || sha(fs.readFileSync(file)) !== expected) throw Error(`MultiSessionError: ${label} hash mismatch`);
}

/** Preserve the old prompt byte-for-byte except its authorized installation-root substitution. */
export function partPromptText(prompt, root = ROOT) {
  const configuredRoot = process.env.CAD_CODE_ORIGINAL_ROOT || '/Users/liuyu/Documents/auto-research/step-8B-sft/cad-code';
  return prompt.replaceAll(configuredRoot, root);
}
const INPUT_NOTE = '\nThe input files have been copied to the session workspace: input/target.step, input/target.ir.jsonl. Use these relative paths.';
function loadPrompt(root, supplied) {
  const file = path.join(root, 'part-prompt.txt');
  let text = supplied;
  if (!text?.trim() && fs.existsSync(file)) text = fs.readFileSync(regularFile(file), 'utf8');
  else {
    if (!text?.trim()) {
      const configured = process.env.CAD_CODE_MULTISOLID_PART_PROMPT;
      if (!configured) throw Error('Set CAD_CODE_MULTISOLID_PART_PROMPT to the existing single-part prompt file');
      text = fs.readFileSync(regularFile(path.resolve(configured)), 'utf8');
    }
    text = partPromptText(text);
  }
  if (fs.existsSync(file)) {
    if (fs.readFileSync(regularFile(file), 'utf8') !== text) throw Error('MultiSessionError: project prompt cannot change between attempts');
  } else fs.writeFileSync(file, text, {flag: 'wx', mode: 0o600});
  const digest = sha(text), project = readProject(root);
  if (project.part_prompt_sha256 && project.part_prompt_sha256 !== digest) throw Error('MultiSessionError: saved prompt hash mismatch');
  if (!project.part_prompt_sha256) update(root, next => { next.part_prompt_sha256 = digest; });
  return text;
}

/** Invoke the unchanged original single-notebook evaluator, including its existing Linux sandbox. */
export async function evaluatePartNotebook({notebook, target, out, timeoutMs = 1800000, signal}, {spawnProcess = spawn, python = PYTHON, skill = SKILL} = {}) {
  privateDirectory(out);
  const script = regularFile(path.resolve(skill, 'scripts/stepeval.py'));
  if (process.platform === 'linux' && !process.env.CAD_CODE_BWRAP) throw Error('Linux independent evaluation requires the existing CAD_CODE_BWRAP sandbox');
  const args = ['-I', script, regularFile(notebook), regularFile(target), '--out', out, '--timeout', String(Math.max(1, Math.floor(Math.min(timeoutMs, 600000) / 1000)))];
  const stdout = fs.openSync(path.join(out, 'stdout.log'), 'w', 0o600), stderr = fs.openSync(path.join(out, 'stderr.log'), 'w', 0o600);
  let child;
  try { child = spawnProcess(python, args, {cwd: path.dirname(notebook), env: process.env, detached: true, stdio: ['ignore', stdout, stderr]}); }
  finally { fs.closeSync(stdout); fs.closeSync(stderr); }
  await new Promise((resolve, reject) => {
    let reason, hardKill;
    const stop = error => {
      if (reason) return; reason = error;
      const kill = sign => { try { process.kill(-child.pid, sign); } catch { try { child.kill(sign); } catch {} } };
      kill('SIGTERM'); hardKill = setTimeout(() => kill('SIGKILL'), 1500); hardKill.unref();
    };
    const abort = () => stop(Object.assign(Error('Independent evaluation interrupted'), {name: 'AbortError'}));
    const timer = setTimeout(() => stop(Error('Independent evaluation deadline exceeded')), timeoutMs);
    const clear = () => { clearTimeout(timer); if (!reason) clearTimeout(hardKill); signal?.removeEventListener('abort', abort); };
    child.once('error', error => { clear(); reject(error); });
    child.once('close', code => { clear(); reason ? reject(reason) : code === 0 ? resolve() : reject(Error(`stepeval exited with ${code}`)); });
    signal?.addEventListener('abort', abort, {once: true});
    if (signal?.aborted) abort();
  });
  const lines = fs.readFileSync(path.join(out, 'stdout.log'), 'utf8').trim().split(/\r?\n/);
  const report = JSON.parse(lines.at(-1));
  if (!report || typeof report !== 'object' || Array.isArray(report) || typeof report.ok !== 'boolean') throw Error('Independent stepeval returned an invalid report');
  return report;
}

/** Dependency injection keeps deterministic queue tests independent of live model accounts. */
export function createPartRunner({runtime = RUNTIME, backend = ensureBackend, web = (c, r, m, b) => request(c, r, m, b), oc = (c, r) => request(c, r, 'GET', undefined, true), importInputs = importFiles, workspace = sessionDir, evaluate = evaluatePartNotebook, wait = sleep, now = Date.now} = {}) {
  const runs = new Map();
  const stopRequests = new Map();
  const control = path.join(runtime, 'multi'), leaseFile = path.join(control, 'part-queue.json');
  function ownerFile(session) { if (!validSession(session)) throw Error('MultiSessionError: invalid session'); return path.join(control, 'owned-part-sessions', session + '.json'); }
  function own(root, project, attempt) {
    const file = ownerFile(attempt.session_id);
    let owner; try { owner = JSON.parse(fs.readFileSync(regularFile(file), 'utf8')); } catch { throw Error('MultiSessionOwnershipError: session was not created by this multi-project runner'); }
    if (owner.project_root !== root || owner.project_id !== project.project_id || owner.attempt_id !== attempt.id || owner.session_id !== attempt.session_id) throw Error('MultiSessionOwnershipError: session ownership mismatch');
    return owner;
  }
  function acquire(root) {
    privateDirectory(control);
    const project = readProject(root), lease = {pid: process.pid, token: crypto.randomUUID(), project_root: root, project_id: project.project_id, active: true};
    // A short exclusive guard makes stale lease takeover atomic across CLI/Web processes.
    const guard = leaseFile + '.lock'; let fd;
    for (let tries = 0; tries < 2; tries++) {
      try { fd = fs.openSync(guard, 'wx', 0o600); fs.writeSync(fd, JSON.stringify({pid: process.pid})); break; }
      catch (error) {
        if (error.code !== 'EEXIST') throw error;
        let stale = false;
        try {
          const owner = JSON.parse(fs.readFileSync(regularFile(guard), 'utf8'));
          if (Number.isSafeInteger(owner.pid) && owner.pid > 0) {
            try { process.kill(owner.pid, 0); } catch (probe) { stale = probe.code === 'ESRCH'; }
          }
        } catch {}
        if (!stale) throw Error('MultiQueueBusy: another controller is acquiring the global queue');
        fs.unlinkSync(guard);
      }
    }
    if (fd === undefined) throw Error('MultiQueueBusy: could not acquire the global queue');
    try {
      if (fs.existsSync(leaseFile)) {
        const previous = JSON.parse(fs.readFileSync(regularFile(leaseFile), 'utf8'));
        if (!Number.isSafeInteger(previous.pid) || previous.pid < 1) throw Error('MultiQueueBusy: invalid previous controller metadata');
        let alive = false; try { process.kill(previous.pid, 0); alive = true; } catch (error) { alive = error.code !== 'ESRCH'; }
        if (previous.active && alive) throw Error('MultiQueueBusy: another project runner owns the global queue');
        if (previous.project_root !== root) {
          let remaining;
          try { remaining = activeAttempts(readProject(previous.project_root)); } catch { throw Error('MultiQueueBusy: previous project cannot be verified; recover it before starting another project'); }
          if (remaining.length) throw Error('MultiQueueBusy: recover or stop the previous project sessions first');
        }
      }
      atomicJSON(leaseFile, lease);
    } finally { fs.closeSync(fd); fs.unlinkSync(guard); }
    return () => {
      const current = JSON.parse(fs.readFileSync(regularFile(leaseFile), 'utf8'));
      if (current.token === lease.token) atomicJSON(leaseFile, {...current, active: false});
    };
  }
  function stopped(root, controller) { return controller.signal.aborted || readProject(root).parts_stop_requested === true; }
  async function stopOneRequest(root, id, connection, reason) {
    const project = readProject(root), {attempt} = findAttempt(project, id);
    if (!activeStates.has(attempt.status) || !attempt.session_id) return null;
    own(root, project, attempt);
    if (!attempt.stop_acknowledged_at) {
      setAttempt(root, id, (_part, item) => { item.status = 'stopping'; item.stop_reason = reason; });
      await web(connection, `/api/sessions/${attempt.session_id}/stop`, 'POST', {});
      setAttempt(root, id, (part, item) => { part.status = 'queued'; item.status = 'exporting'; item.stop_reason = reason; item.stop_acknowledged_at = stamp(); });
    }
    return {attempt_id: id, session_id: attempt.session_id};
  }
  async function stopOne(root, id, connection, reason = 'stopped') {
    const key = root + '\0' + id;
    if (stopRequests.has(key)) return stopRequests.get(key);
    const pending = stopOneRequest(root, id, connection, reason);
    stopRequests.set(key, pending);
    try { return await pending; } finally { stopRequests.delete(key); }
  }
  async function start(root, partID, text, connection, timeoutMs, controller) {
    const project = readProject(root), part = project.unique_parts.find(item => item.id === partID);
    if (activeAttempts(project).some(row => row.part.id === partID)) throw Error('MultiSessionError: part already has an active attempt');
    const step = projectFile(root, part.target_step), ir = projectFile(root, part.stepir);
    checkHash(step, part.target_step_sha256, 'target STEP'); checkHash(ir, part.stepir_sha256, 'STEPIR');
    const id = ownAttemptID();
    update(root, next => { const target = next.unique_parts.find(item => item.id === partID); target.status = 'running'; target.attempts.push({id, session_id: null, status: 'creating', started_at: stamp(), deadline_at: new Date(now() + timeoutMs).toISOString(), deliverables: {}, verdict: null}); });
    let session;
    try {
      const created = await web(connection, '/api/sessions', 'POST', {title: `Part ${partID}`});
      if (!validSession(created?.id)) throw Error('Backend returned an invalid session ID');
      session = created.id;
      privateDirectory(path.dirname(ownerFile(session)));
      fs.writeFileSync(ownerFile(session), JSON.stringify({project_root: root, project_id: project.project_id, attempt_id: id, session_id: session}), {flag: 'wx', mode: 0o600});
      setAttempt(root, id, (_part, attempt, next) => { attempt.session_id = session; attempt.status = 'preparing'; next.selected_model = connection.model; });
      if (stopped(root, controller)) { await stopOne(root, id, connection); return id; }
      const imported = importInputs(session, [step, ir]);
      if (JSON.stringify(imported) !== JSON.stringify(['input/target.step', 'input/target.ir.jsonl'])) throw Error('MultiSessionError: imported part paths differ from the old single-part contract');
      setAttempt(root, id, (_part, attempt) => { attempt.status = 'sending'; attempt.submission_started_at = stamp(); });
      if (stopped(root, controller)) { await stopOne(root, id, connection); return id; }
      // Persist sending before the network call; an ambiguous acknowledgement must never cause a resend.
      await web(connection, `/api/sessions/${session}/send`, 'POST', {text: text + INPUT_NOTE});
      setAttempt(root, id, (_part, attempt) => { if (attempt.status === 'sending') { attempt.status = 'running'; attempt.sent_at = stamp(); } });
      if (stopped(root, controller)) await stopOne(root, id, connection);
    } catch (error) {
      const current = findAttempt(readProject(root), id).attempt;
      if (session && ['sending', 'stopping', 'exporting'].includes(current.status)) {
        setAttempt(root, id, (_part, attempt) => { attempt.error = error.message; });
      } else if (session) {
        await stopOne(root, id, connection, 'start_failed');
        setAttempt(root, id, (_part, attempt) => { attempt.error = error.message; });
      } else setAttempt(root, id, (target, attempt) => { target.status = 'failed'; attempt.status = 'failed'; attempt.error = error.message; attempt.finished_at = stamp(); });
    }
    return id;
  }
  function terminal(messages) {
    if (!Array.isArray(messages)) throw Error('Invalid backend message list');
    const user = messages.filter(message => message.info?.role === 'user').at(-1);
    const assistant = messages.filter(message => message.info?.role === 'assistant').at(-1);
    if (!user || !assistant) return {submitted: Boolean(user), done: false};
    const info = assistant.info;
    const parentMatches = !info.parentID || info.parentID === user.info.id;
    const pendingTool = (assistant.parts || []).some(part => part.type === 'tool' && ['pending', 'running'].includes(part.state?.status));
    const finished = Boolean(info.error || (info.time?.completed && info.finish && !['tool-calls', 'unknown'].includes(info.finish)));
    return {submitted: true, done: parentMatches && finished && !pendingTool};
  }
  async function finish(root, id, connection, evaluationTimeoutMs, signal) {
    const project = readProject(root), {part, attempt} = findAttempt(project, id);
    own(root, project, attempt);
    setAttempt(root, id, (_part, item) => { item.status = 'exporting'; });
    const directory = path.join(root, 'outputs', part.id, id), trajectory = path.join(root, 'trajectories', attempt.session_id + '.json');
    privateDirectory(directory); privateDirectory(path.dirname(trajectory));
    let data;
    if (fs.existsSync(trajectory)) data = JSON.parse(fs.readFileSync(regularFile(trajectory), 'utf8'));
    else data = await web(connection, `/api/sessions/${attempt.session_id}/export`);
    if (data?.schema_version !== 'cad-code-session-v2' || data.id !== attempt.session_id || !Array.isArray(data.messages) || !Array.isArray(data.tool_media)) throw Error('MultiSessionError: session export contract mismatch');
    if (!fs.existsSync(trajectory)) atomicJSON(trajectory, data);
    const deliverables = {...attempt.deliverables, trajectory: path.relative(root, trajectory)};
    const model = path.join(directory, 'model.py'), target = path.join(directory, 'target.step');
    const mappings = [['model_py', 'model.py'], ['submitted_model_step', 'model.step'], ['report', 'report.json']];
    for (const [key, name] of mappings) {
      const destination = path.join(directory, name === 'model.step' ? 'submitted-model.step' : name);
      if (copyDeliverable(path.join(workspace(attempt.session_id), 'out', name), destination) || fs.existsSync(destination)) {
        regularFile(destination); deliverables[key] = path.relative(root, destination);
      }
    }
    setAttempt(root, id, (_part, item) => { item.deliverables = deliverables; item.status = 'evaluating'; });
    let verdict;
    const verdictFile = path.join(directory, 'verdict.json');
    if (fs.existsSync(model)) {
      const source = projectFile(root, part.target_step); checkHash(source, part.target_step_sha256, 'source target');
      copyDeliverable(source, target);
      const notebookHash = sha(fs.readFileSync(regularFile(model)));
      const previous = findAttempt(readProject(root), id).attempt;
      // A cached verdict is trusted only when this controller recorded matching input/output hashes.
      if (previous.evaluation?.status === 'complete' && previous.evaluation.notebook_sha256 === notebookHash && previous.evaluation.target_sha256 === part.target_step_sha256) {
        checkHash(regularFile(verdictFile), previous.evaluation.verdict_sha256, 'independent verdict');
        verdict = JSON.parse(fs.readFileSync(verdictFile, 'utf8'));
      } else {
        const verify = path.join(directory, 'verify-' + crypto.randomUUID());
        setAttempt(root, id, (_part, item) => { item.evaluation = {status: 'running', notebook_sha256: notebookHash, target_sha256: part.target_step_sha256}; });
        verdict = await evaluate({notebook: model, target, out: verify, timeoutMs: evaluationTimeoutMs, signal});
        if (typeof verdict?.ok !== 'boolean') throw Error('Independent evaluation returned an invalid verdict');
        checkHash(model, notebookHash, 'copied notebook after independent evaluation');
        checkHash(target, part.target_step_sha256, 'copied target after independent evaluation');
        const rebuilt = path.join(verify, 'candidate.step');
        if (verdict.ok && !fs.existsSync(rebuilt)) throw Error('Independent evaluation accepted without producing candidate.step');
        if (fs.existsSync(rebuilt)) {
          copyDeliverable(rebuilt, path.join(directory, 'model.step'));
          deliverables.model_step = path.relative(root, path.join(directory, 'model.step'));
        }
        atomicJSON(verdictFile, verdict);
        setAttempt(root, id, (_part, item) => { item.deliverables = deliverables; item.evaluation = {status: 'complete', notebook_sha256: notebookHash, target_sha256: part.target_step_sha256, verdict_sha256: sha(fs.readFileSync(verdictFile))}; });
      }
    } else { verdict = {ok: false, run: {error: 'Session ended without out/model.py'}}; atomicJSON(verdictFile, verdict); }
    deliverables.verdict = path.relative(root, verdictFile);
    const current = findAttempt(readProject(root), id).attempt;
    const status = current.stop_reason === 'stopped' ? 'interrupted' : !current.stop_reason && verdict.ok && deliverables.model_py && deliverables.model_step ? 'completed' : 'failed';
    setAttempt(root, id, (targetPart, item) => {
      targetPart.status = status === 'interrupted' ? 'queued' : status;
      item.status = status; item.finished_at = stamp(); item.deliverables = deliverables; item.verdict = verdict;
      item.error = status === 'completed' ? null : item.stop_reason || verdict.run?.error || 'Independent stepeval did not pass';
    });
    return {part_id: part.id, attempt_id: id, session_id: attempt.session_id, status, deliverables, verdict};
  }
  async function stopProjectPartSessions(projectDir) {
    const root = fs.realpathSync(projectDir);
    update(root, next => { next.parts_stop_requested = true; });
    runs.get(root)?.controller.abort();
    const rows = activeAttempts(readProject(root)).filter(row => row.attempt.session_id);
    if (!rows.length) return [];
    const connection = await backend(), stoppedRows = [];
    for (const {attempt} of rows) { const result = await stopOne(root, attempt.id, connection); if (result) stoppedRows.push(result); }
    const project = readProject(root);
    if (project.state === 'parts_running') update(root, next => { next.state = 'parts_queued'; });
    return stoppedRows;
  }
  async function runPartQueue(projectDir, {parallel = 1, prompt = '', retryFailed = false, maxAttempts = 2, pollMs = 5000, timeoutMs = 7200000, evaluationTimeoutMs = 1800000, submissionTimeoutMs = 120000, maxFinalizeFailures = 3, signal, onUpdate = () => {}} = {}) {
    for (const [value, label, min, max] of [[parallel, 'parallel', 1, 40], [maxAttempts, 'maxAttempts', 1, 10], [pollMs, 'pollMs', 100, 60000], [timeoutMs, 'timeoutMs', 1000, 86400000], [evaluationTimeoutMs, 'evaluationTimeoutMs', 1000, 3600000], [submissionTimeoutMs, 'submissionTimeoutMs', 1000, 600000], [maxFinalizeFailures, 'maxFinalizeFailures', 1, 10]]) if (!Number.isSafeInteger(value) || value < min || value > max) throw Error(`${label} must be from ${min} through ${max}`);
    const root = fs.realpathSync(projectDir), release = acquire(root), controller = new AbortController();
    const abort = () => controller.abort(); signal?.addEventListener('abort', abort, {once: true}); if (signal?.aborted) abort();
    const finishing = new Map(), settled = []; let connection, halted = false, backendFailures = 0;
    runs.set(root, {controller});
    try {
      let project = readProject(root);
      if (retryFailed && ['awaiting_assembly', 'parts_finished', 'failed'].includes(project.state)) {
        if (project.state !== 'failed') project = update(root, next => { next.state = 'failed'; });
        project = update(root, next => { next.state = 'parts_queued'; });
      }
      if (!['ir_ready', 'parts_queued', 'parts_running'].includes(project.state)) throw Error(`MultiSessionError: cannot run parts while project is ${project.state}`);
      const text = loadPrompt(root, prompt);
      if (project.state === 'ir_ready') update(root, next => { next.state = 'parts_queued'; });
      update(root, next => { next.state = 'parts_running'; next.parallel = parallel; next.parts_stop_requested = false; });
      connection = await backend();
      for (const {attempt} of activeAttempts(readProject(root))) {
        if (attempt.session_id) own(root, readProject(root), attempt);
        else setAttempt(root, attempt.id, (part, item) => { part.status = 'failed'; item.status = 'failed'; item.error = 'Interrupted before an owned session was recorded; no prompt was sent'; item.finished_at = stamp(); });
      }
      while (!stopped(root, controller)) {
        // Completed finalizers mutate the durable attempt before the next scheduling decision.
        for (const [id, work] of finishing) if (work.done) {
          finishing.delete(id);
          if (work.error) {
            if (controller.signal.aborted) break;
            setAttempt(root, id, (part, item) => {
              item.finalize_failures = (item.finalize_failures || 0) + 1; item.error = work.error.message;
              if (item.finalize_failures >= maxFinalizeFailures) { part.status = 'failed'; item.status = 'failed'; item.finished_at = stamp(); }
              else item.status = 'exporting';
            });
          } else { settled.push(work.result); onUpdate({type: 'part_finished', ...work.result}); }
        }
        let statuses;
        try { statuses = await oc(connection, '/session/status'); backendFailures = 0; }
        catch (error) { if (++backendFailures >= 8) throw error; onUpdate({type: 'backend_retry', error: error.message}); await wait(pollMs); continue; }
        for (const {part, attempt} of activeAttempts(readProject(root))) {
          if (finishing.has(attempt.id) || stopped(root, controller)) continue;
          own(root, readProject(root), attempt);
          let shouldFinish = ['exporting', 'evaluating'].includes(attempt.status);
          if (attempt.status === 'stopping') { await stopOne(root, attempt.id, connection, attempt.stop_reason); shouldFinish = true; }
          if (!shouldFinish) {
            const deadline = Date.parse(attempt.deadline_at) || Date.parse(attempt.started_at) + timeoutMs;
            if (now() >= deadline) { await stopOne(root, attempt.id, connection, 'deadline_exceeded'); shouldFinish = true; }
            else if (!statuses?.[attempt.session_id] || statuses[attempt.session_id].type === 'idle') {
              let messages;
              try { messages = await oc(connection, `/session/${attempt.session_id}/message`); }
              catch (error) {
                if (error.status !== 404) throw error;
                // Only the per-session API can prove a session is missing. Idle sessions are absent from /status.
                setAttempt(root, attempt.id, (targetPart, item) => { targetPart.status = 'failed'; item.status = 'failed'; item.finished_at = stamp(); item.error = 'Owned session no longer exists'; });
                continue;
              }
              const observed = terminal(messages);
              shouldFinish = observed.done;
              if (!observed.submitted && now() - Date.parse(attempt.started_at) >= submissionTimeoutMs) { await stopOne(root, attempt.id, connection, 'submission_not_observed'); shouldFinish = true; }
            }
          }
          if (shouldFinish && !stopped(root, controller)) {
            const work = {done: false};
            work.promise = finish(root, attempt.id, connection, evaluationTimeoutMs, controller.signal).then(result => { work.result = result; }, error => { work.error = error; }).finally(() => { work.done = true; });
            finishing.set(attempt.id, work);
          }
        }
        project = readProject(root);
        // Re-read the manifest before every launch to honor external stop requests and late completion updates.
        for (const part of project.unique_parts) {
          if (stopped(root, controller)) break;
          const current = readProject(root), live = activeAttempts(current), latest = current.unique_parts.find(row => row.id === part.id);
          if (live.length >= parallel) break;
          if (live.some(row => row.part.id === part.id) || finishing.has(latest.attempts.at(-1)?.id)) continue;
          if (!(latest.status === 'queued' || (retryFailed && latest.status === 'failed'))) continue;
          if (latest.attempts.length >= maxAttempts) { update(root, next => { next.unique_parts.find(row => row.id === part.id).status = 'failed'; }); continue; }
          const id = await start(root, part.id, text, connection, timeoutMs, controller);
          onUpdate({type: 'part_started', part_id: part.id, attempt_id: id, session_id: findAttempt(readProject(root), id).attempt.session_id});
        }
        const current = readProject(root);
        if (!activeAttempts(current).length && !finishing.size) break;
        onUpdate({type: 'progress', project: current});
        await wait(pollMs);
      }
      halted = stopped(root, controller);
      if (halted) {
        update(root, next => { next.parts_stop_requested = true; });
        for (const {attempt} of activeAttempts(readProject(root))) if (attempt.session_id) await stopOne(root, attempt.id, connection);
        await Promise.all([...finishing.values()].map(work => work.promise));
        update(root, next => { if (next.state === 'parts_running') next.state = 'parts_queued'; });
      } else {
        update(root, next => { next.state = 'parts_finished'; });
        update(root, next => { next.state = 'awaiting_assembly'; });
      }
      return {project: readProject(root), settled, halted};
    } finally {
      // On errors keep all owned sessions recoverable and retain the global reservation for this project.
      controller.abort(); await Promise.all([...finishing.values()].map(work => work.promise));
      signal?.removeEventListener('abort', abort); runs.delete(root); release();
    }
  }
  return {runPartQueue, stopProjectPartSessions};
}

const defaultRunner = createPartRunner();
export const runPartQueue = (...args) => defaultRunner.runPartQueue(...args);
export const stopProjectPartSessions = (...args) => defaultRunner.stopProjectPartSessions(...args);
