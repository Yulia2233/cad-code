import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import {EventEmitter} from 'node:events';
import {test} from 'node:test';
import {createPartRunner, ensureBackend, evaluatePartNotebook, partPromptText} from '../multi/part-runner.mjs';
import {initializeProject, readProject, updateProject} from '../multi/store.mjs';

const hash = text => crypto.createHash('sha256').update(text).digest('hex');
const pause = () => new Promise(resolve => setTimeout(resolve, 1));
function setup(t, count = 1) {
  const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cad-part-runner-')));
  t.after(() => fs.rmSync(tmp, {recursive: true, force: true}));
  const runtime = path.join(tmp, 'runtime'), workspaceRoot = path.join(tmp, 'sessions');
  fs.mkdirSync(workspaceRoot);
  function project(name, n = count) {
    const root = path.join(tmp, name); fs.mkdirSync(root);
    const parts = Array.from({length: n}, (_, i) => {
      const id = `part-${String(i).padStart(3, '0')}`, dir = path.join(root, id);
      fs.mkdirSync(dir); fs.writeFileSync(path.join(dir, 'target.step'), 'target ' + id); fs.writeFileSync(path.join(dir, 'target.ir.jsonl'), '{"solids":1}\n');
      return {id, target_step: id + '/target.step', target_step_sha256: hash('target ' + id), stepir: id + '/target.ir.jsonl', stepir_sha256: hash('{"solids":1}\n'), stepir_version: 'v6.3'};
    });
    const ir = {schema_version: 'step-assembly-ir-v1', unique_parts: parts, instances: parts.map((part, i) => ({id: 'instance-' + i, part_id: part.id, placement: {origin: [0, 0, 0], x_axis: [1, 0, 0], y_axis: [0, 1, 0]}}))};
    fs.writeFileSync(path.join(root, 'assembly.ir.json'), JSON.stringify(ir));
    initializeProject({projectDir: root, source: {solid_count: n, sha256: 'a'.repeat(64)}, assemblyIR: ir});
    return root;
  }
  const root = project('project');
  const workspace = id => path.join(workspaceRoot, id);
  const importInputs = (id, files) => {
    const input = path.join(workspace(id), 'input'); fs.mkdirSync(input, {recursive: true});
    for (const file of files) fs.copyFileSync(file, path.join(input, path.basename(file)));
    return ['input/target.step', 'input/target.ir.jsonl'];
  };
  return {tmp, root, runtime, project, workspace, importInputs};
}
async function fakeBackend(t, env, {completeAfter = 3, wave = 0, exportErrors = 0, hold = false, failSendAck = false, onCreate = async () => {}} = {}) {
  const sessions = new Map(), stops = [], sent = [], exports = [];
  let creates = 0, active = 0, maxActive = 0;
  const server = http.createServer(async (req, res) => {
    try {
      const route = new URL(req.url, 'http://localhost').pathname;
      let body = ''; for await (const chunk of req) body += chunk;
      const payload = body ? JSON.parse(body) : null;
      const json = (value, status = 200) => { res.writeHead(status, {'content-type': 'application/json'}); res.end(JSON.stringify(value)); };
      if (route === '/api/sessions' && req.method === 'POST') {
        const id = 'ses_test_' + ++creates;
        sessions.set(id, {id, polls: 0, submitted: false, counted: false}); await onCreate(id); return json({id});
      }
      if (route === '/session/status') return json({ses_someone_elses: {type: 'busy'}}); // Idle owned sessions are intentionally absent.
      const match = route.match(/^\/(api\/sessions|session)\/(ses_[\w-]+)\/(send|stop|message|export)$/);
      if (!match) return json({error: 'not found'}, 404);
      const [, , id, action] = match, session = sessions.get(id);
      if (!session) return json({error: 'not found'}, 404);
      if (action === 'send') {
        assert.equal(session.submitted, false, 'no prompt may be resent to a session');
        sent.push({id, text: payload.text}); session.submitted = true; active++; maxActive = Math.max(maxActive, active);
        const out = path.join(env.workspace(id), 'out'); fs.mkdirSync(out, {recursive: true});
        fs.writeFileSync(path.join(out, 'model.py'), 'model source ' + id);
        fs.writeFileSync(path.join(out, 'model.step'), 'UNTRUSTED submitted step');
        fs.writeFileSync(path.join(out, 'verdict.json'), '{"ok":true,"riou":1}');
        return json({ok: !failSendAck}, failSendAck ? 502 : 200);
      }
      if (action === 'stop') { stops.push(id); session.stopped = true; return json({ok: true}); }
      if (action === 'message') {
        session.polls++;
        if (!session.submitted) return json([]);
        const messages = [{info: {id: 'usr_' + id, role: 'user'}, parts: [{type: 'text', text: sent.find(row => row.id === id)?.text}]}];
        const done = session.stopped || (!hold && sessions.size >= wave && session.polls >= completeAfter);
        if (done && !session.counted) { session.counted = true; active--; }
        if (done) messages.push({info: {id: 'msg_' + id, role: 'assistant', parentID: 'usr_' + id, time: {completed: Date.now()}, finish: 'stop'}, parts: [{type: 'text', text: 'done'}]});
        else if (session.polls > 1) messages.push({info: {id: 'tool_' + id, role: 'assistant', parentID: 'usr_' + id, time: {completed: Date.now()}, finish: 'tool-calls'}, parts: []});
        return json(messages);
      }
      if (action === 'export') {
        exports.push(id);
        if (exportErrors-- > 0) return json({error: 'transient export error'}, 502);
        return json({schema_version: 'cad-code-session-v2', id, model: 'gpt-6.1-sol', messages: [{info: {role: 'assistant'}, parts: [{type: 'text', text: 'original transcript'}]}], tool_media: [{call_id: 'original'}]});
      }
    } catch (error) { res.writeHead(500, {'content-type': 'application/json'}); res.end(JSON.stringify({error: error.message})); }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }));
  const base = 'http://127.0.0.1:' + server.address().port;
  const connection = {url: base, website: base, password: 'test-local-secret', model: 'gpt-6.1-sol'};
  return {connection, sessions, stops, sent, exports, get creates() { return creates; }, get maxActive() { return maxActive; }};
}
function evaluator(env, {ok = true, failures = 0} = {}) {
  const calls = [];
  const evaluate = async ({notebook, target, out, signal}) => {
    assert.ok(!notebook.startsWith(env.workspace('')), 'evaluate only a copied notebook');
    assert.ok(notebook.startsWith(env.root + path.sep));
    assert.equal(path.basename(notebook), 'model.py'); assert.equal(path.basename(target), 'target.step');
    assert.equal(signal.aborted, false);
    calls.push({notebook, target, out});
    if (failures-- > 0) throw Error('temporary evaluator launch error');
    fs.mkdirSync(out, {recursive: true}); fs.writeFileSync(path.join(out, 'candidate.step'), 'VERIFIED STEP');
    return {ok, run: 'ok', format: [], riou: ok ? 1 : 0.25, solids: 1, complete: ok};
  };
  return {calls, evaluate};
}
function runner(env, backend, evaluation) {
  return createPartRunner({runtime: env.runtime, backend: async () => backend.connection, importInputs: env.importInputs, workspace: env.workspace, evaluate: evaluation.evaluate, wait: pause});
}

test('idle omission and late terminal message do not cause premature completion; prompt bytes and original export survive', async t => {
  const env = setup(t), backend = await fakeBackend(t, env, {completeAfter: 4, failSendAck: true}), evaluation = evaluator(env);
  const prompt = 'Existing prompt.\n';
  const result = await runner(env, backend, evaluation).runPartQueue(env.root, {prompt, pollMs: 100});
  assert.equal(result.project.state, 'awaiting_assembly'); assert.equal(result.project.unique_parts[0].status, 'completed');
  assert.equal(backend.creates, 1); assert.equal(backend.sent.length, 1); assert.equal(evaluation.calls.length, 1);
  assert.ok(backend.sessions.get('ses_test_1').polls >= 4);
  assert.equal(backend.sent[0].text, prompt + '\nThe input files have been copied to the session workspace: input/target.step, input/target.ir.jsonl. Use these relative paths.');
  const attempt = result.project.unique_parts[0].attempts[0];
  assert.equal(fs.readFileSync(path.join(env.root, attempt.deliverables.model_step), 'utf8'), 'VERIFIED STEP');
  assert.equal(fs.readFileSync(path.join(env.root, attempt.deliverables.submitted_model_step), 'utf8'), 'UNTRUSTED submitted step');
  const trajectory = JSON.parse(fs.readFileSync(path.join(env.root, attempt.deliverables.trajectory)));
  assert.equal(trajectory.schema_version, 'cad-code-session-v2'); assert.deepEqual(trajectory.tool_media, [{call_id: 'original'}]);
});

test('model-authored passing verdict never overrides independent failed stepeval', async t => {
  const env = setup(t), backend = await fakeBackend(t, env), evaluation = evaluator(env, {ok: false});
  const result = await runner(env, backend, evaluation).runPartQueue(env.root, {prompt: 'existing', pollMs: 100});
  const attempt = result.project.unique_parts[0].attempts[0];
  assert.equal(attempt.status, 'failed'); assert.equal(attempt.verdict.ok, false);
  assert.equal(JSON.parse(fs.readFileSync(path.join(env.root, attempt.deliverables.verdict))).riou, 0.25);
});

test('export and evaluator retries reuse the owned session and saved export without resending', async t => {
  const env = setup(t), backend = await fakeBackend(t, env, {exportErrors: 1}), evaluation = evaluator(env, {failures: 1});
  const result = await runner(env, backend, evaluation).runPartQueue(env.root, {prompt: 'existing', pollMs: 100});
  assert.equal(result.project.unique_parts[0].status, 'completed'); assert.equal(backend.creates, 1); assert.equal(backend.sent.length, 1);
  assert.equal(backend.exports.length, 2); assert.equal(evaluation.calls.length, 2);
  assert.equal(result.project.unique_parts[0].attempts[0].finalize_failures, 2);
});

test('40 slots are filled and never exceeded across 45 queued parts', async t => {
  const env = setup(t, 45), backend = await fakeBackend(t, env, {completeAfter: 1, wave: 40}), evaluation = evaluator(env);
  const result = await runner(env, backend, evaluation).runPartQueue(env.root, {prompt: 'existing', parallel: 40, pollMs: 100});
  assert.equal(backend.maxActive, 40); assert.equal(backend.creates, 45); assert.equal(evaluation.calls.length, 45);
  assert.equal(result.project.unique_parts.filter(part => part.status === 'completed').length, 45);
  assert.ok(result.project.unique_parts.every(part => part.attempts.length === 1));
});

test('abort stops only owned sessions, leaves export recoverable, and blocks simultaneous runners', async t => {
  const env = setup(t, 2), backend = await fakeBackend(t, env, {hold: true}), evaluation = evaluator(env), engine = runner(env, backend, evaluation);
  const secondRoot = env.project('other', 1), controller = new AbortController();
  let firstStarted; const started = new Promise(resolve => { firstStarted = resolve; });
  const active = engine.runPartQueue(env.root, {prompt: 'existing', parallel: 2, pollMs: 100, signal: controller.signal, onUpdate: event => { if (event.type === 'progress') firstStarted(); }});
  await started;
  await assert.rejects(engine.runPartQueue(secondRoot, {prompt: 'existing', pollMs: 100}), /MultiQueueBusy/);
  await assert.rejects(engine.runPartQueue(env.root, {prompt: 'existing', pollMs: 100}), /MultiQueueBusy/);
  controller.abort(); const result = await active;
  assert.equal(result.halted, true); assert.equal(result.project.state, 'parts_queued');
  assert.deepEqual(new Set(backend.stops), new Set(['ses_test_1', 'ses_test_2']));
  assert.ok(result.project.unique_parts.every(part => part.attempts[0].status === 'exporting'));
  assert.equal(evaluation.calls.length, 0);
  await assert.rejects(engine.runPartQueue(secondRoot, {prompt: 'existing', pollMs: 100}), /recover or stop the previous/);
});

test('restart resumes an owned exporting attempt instead of creating another session', async t => {
  const env = setup(t), backend = await fakeBackend(t, env, {hold: true}), evaluation = evaluator(env), engine = runner(env, backend, evaluation);
  const controller = new AbortController();
  await engine.runPartQueue(env.root, {prompt: 'existing', pollMs: 100, signal: controller.signal, onUpdate: event => { if (event.type === 'part_started') controller.abort(); }});
  // A restart must recover the interrupted export before deciding whether another attempt is allowed.
  const result = await runner(env, backend, evaluation).runPartQueue(env.root, {pollMs: 100, maxAttempts: 1});
  assert.equal(backend.creates, 1); assert.equal(backend.sent.length, 1); assert.equal(backend.exports.length, 1);
  assert.equal(evaluation.calls.length, 1); assert.equal(result.project.unique_parts[0].attempts.length, 1);
  assert.equal(result.project.unique_parts[0].attempts[0].status, 'interrupted');
});

test('retries are bounded even when independent evaluation always fails', async t => {
  const env = setup(t), backend = await fakeBackend(t, env, {completeAfter: 1}), evaluation = evaluator(env, {ok: false});
  const result = await runner(env, backend, evaluation).runPartQueue(env.root, {prompt: 'existing', pollMs: 100, retryFailed: true, maxAttempts: 2});
  assert.equal(backend.creates, 2); assert.equal(evaluation.calls.length, 2); assert.equal(result.project.unique_parts[0].status, 'failed');
});

test('a finished project can retry failed parts without rerunning completed parts', async t => {
  const env = setup(t), backend = await fakeBackend(t, env, {completeAfter: 1});
  await runner(env, backend, evaluator(env, {ok: false})).runPartQueue(env.root, {prompt: 'existing', pollMs: 100});
  const accepted = evaluator(env);
  const result = await runner(env, backend, accepted).runPartQueue(env.root, {retryFailed: true, maxAttempts: 2, pollMs: 100});
  assert.equal(backend.creates, 2); assert.equal(accepted.calls.length, 1);
  assert.equal(result.project.unique_parts[0].status, 'completed'); assert.equal(result.project.unique_parts[0].attempts.length, 2);
});

test('stop during session creation records ownership then stops without submitting a prompt', async t => {
  const env = setup(t); let engine;
  const backend = await fakeBackend(t, env, {onCreate: async () => { await engine.stopProjectPartSessions(env.root); }}), evaluation = evaluator(env);
  engine = runner(env, backend, evaluation);
  const result = await engine.runPartQueue(env.root, {prompt: 'existing', pollMs: 100});
  assert.equal(result.halted, true); assert.equal(backend.creates, 1); assert.equal(backend.sent.length, 0);
  assert.deepEqual(backend.stops, ['ses_test_1']); assert.equal(evaluation.calls.length, 0);
});

test('deadline stops only the expired session and never accepts its otherwise passing notebook', async t => {
  const env = setup(t), backend = await fakeBackend(t, env, {hold: true}), evaluation = evaluator(env);
  let clock = Date.now();
  const engine = createPartRunner({runtime: env.runtime, backend: async () => backend.connection, importInputs: env.importInputs, workspace: env.workspace, evaluate: evaluation.evaluate, now: () => clock, wait: async () => { clock += 600; await pause(); }});
  const result = await engine.runPartQueue(env.root, {prompt: 'existing', pollMs: 100, timeoutMs: 1000});
  assert.deepEqual(backend.stops, ['ses_test_1']); assert.equal(backend.creates, 1);
  assert.equal(result.project.unique_parts[0].attempts[0].status, 'failed');
  assert.equal(result.project.unique_parts[0].attempts[0].stop_reason, 'deadline_exceeded');
});

test('dead controller lease and guard are recoverable for the same project', async t => {
  const env = setup(t), backend = await fakeBackend(t, env), evaluation = evaluator(env);
  let deadPID = 2147483647; assert.throws(() => process.kill(deadPID, 0), {code: 'ESRCH'});
  const control = path.join(env.runtime, 'multi'); fs.mkdirSync(control, {recursive: true});
  fs.writeFileSync(path.join(control, 'part-queue.json'), JSON.stringify({pid: deadPID, active: true, project_root: env.root, token: 'dead'}));
  fs.writeFileSync(path.join(control, 'part-queue.json.lock'), JSON.stringify({pid: deadPID}));
  const result = await runner(env, backend, evaluation).runPartQueue(env.root, {prompt: 'existing', pollMs: 100});
  assert.equal(result.project.unique_parts[0].status, 'completed'); assert.equal(backend.creates, 1);
  assert.equal(fs.existsSync(path.join(control, 'part-queue.json.lock')), false);
});

test('stop refuses a session ID lacking this project owner record', async t => {
  const env = setup(t), backend = await fakeBackend(t, env), evaluation = evaluator(env);
  const current = readProject(env.root);
  updateProject(env.root, current.revision, project => { project.unique_parts[0].status = 'running'; project.unique_parts[0].attempts.push({id: 'attempt-forged', status: 'running', session_id: 'ses_someone_elses'}); });
  await assert.rejects(runner(env, backend, evaluation).stopProjectPartSessions(env.root), /OwnershipError/);
  assert.equal(backend.stops.length, 0);
});

test('startup lock is released on success and owned startup failure', async t => {
  const env = setup(t), credentials = path.join(env.tmp, 'credentials.json'); fs.writeFileSync(credentials, '{}', {mode: 0o600});
  let spawned = false, killed = false;
  const child = new EventEmitter(); Object.assign(child, {pid: process.pid + 100000, exitCode: null, unref() {}, kill() { killed = true; }});
  const options = {runtime: env.runtime, credentials, wait: pause, spawnProcess: () => { spawned = true; return child; }, getConnection: () => spawned ? {pid: child.pid, url: 'http://127.0.0.1', website: 'http://127.0.0.1', password: 'test'} : null, health: async () => true};
  assert.equal((await ensureBackend(options)).pid, child.pid); assert.equal(fs.existsSync(path.join(env.runtime, 'startup.lock')), false); assert.equal(killed, false);
  spawned = false; child.exitCode = 1;
  await assert.rejects(ensureBackend({...options, getConnection: () => null}), /failed to start/);
  assert.equal(killed, true); assert.equal(fs.existsSync(path.join(env.runtime, 'startup.lock')), false);
});

test('independent evaluator invokes the unchanged stepeval with -I and copied notebook/target', async t => {
  const env = setup(t), skill = path.join(env.tmp, 'skill'), scripts = path.join(skill, 'scripts'); fs.mkdirSync(scripts, {recursive: true});
  const script = path.join(scripts, 'stepeval.py'); fs.writeFileSync(script, 'ORIGINAL EVALUATOR BYTES');
  const notebook = path.join(env.root, 'model.py'), target = path.join(env.root, 'target.step'); fs.writeFileSync(notebook, 'model'); fs.writeFileSync(target, 'target');
  let invoked;
  const result = await evaluatePartNotebook({notebook, target, out: path.join(env.root, 'verify'), timeoutMs: 2000}, {python: '/configured/python', skill, spawnProcess: (command, args, options) => {
    invoked = {command, args, options}; fs.writeSync(options.stdio[1], JSON.stringify({ok: false, run: 'ok', riou: 0.2}) + '\n');
    const child = new EventEmitter(); child.pid = process.pid + 100000; setImmediate(() => child.emit('close', 0)); return child;
  }});
  assert.equal(result.ok, false); assert.equal(invoked.command, '/configured/python');
  assert.deepEqual(invoked.args.slice(0, 4), ['-I', script, notebook, target]); assert.equal(invoked.options.stdio[0], 'ignore');
  assert.equal(fs.readFileSync(script, 'utf8'), 'ORIGINAL EVALUATOR BYTES');
  assert.equal(partPromptText('A\r\nB\n'), 'A\r\nB\n');
});
