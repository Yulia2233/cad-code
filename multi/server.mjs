import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawnSync} from 'node:child_process';
import {ROOT, RUNTIME, WORKSPACE, PYTHON, SKILL} from '../src/paths.mjs';
import {loadProviderFile} from '../src/provider-config.mjs';
import {prepareProject, runPreprocessor, sourceStep} from './cli.mjs';
import {resolveRegisteredProject, listRegisteredProjects, registerProject} from './registry.mjs';
import {readProject, updateProject} from './store.mjs';
import {runPartQueue, stopProjectPartSessions, ensureBackend} from './part-runner.mjs';
import {stageAssemblyInputs} from './inputs.mjs';
import {importFiles} from '../src/cli-input.mjs';
import {startAssemblyRuntime} from './assembly-runtime.mjs';
import {evaluateAssembly} from './evaluation.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const projectsRoot = path.resolve(process.env.CAD_CODE_MULTISOLID_PROJECTS || path.join(WORKSPACE, 'multisolid-projects'));
const port = Number(process.env.CAD_CODE_MULTI_PORT || 8773);
const maxUpload = 128 * 1024 * 1024;
const runningParts = new Map();
const assemblyRuntimes = new Map();
const finishingAssemblies = new Map();
const scoringAssemblies = new Map();
const json = (res, value, status = 200) => {
  res.writeHead(status, {'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store'});
  res.end(JSON.stringify(value));
};

function privateDirectory(directory) {
  fs.mkdirSync(directory, {recursive: true, mode: 0o700});
  const stat = fs.lstatSync(directory);
  if (stat.isSymbolicLink() || !stat.isDirectory()) throw Error('MultiServerError: expected a regular directory');
  fs.chmodSync(directory, 0o700);
}

async function readBody(req, limit) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit) throw Object.assign(Error('Request body is too large'), {status: 413});
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

async function readJSON(req, limit = 256 * 1024) {
  const bytes = await readBody(req, limit);
  try { return bytes.length ? JSON.parse(bytes.toString('utf8')) : {}; }
  catch { throw Error('Request body must be valid JSON'); }
}

async function readUpload(req) {
  const contentType = req.headers['content-type'] || '';
  const boundary = contentType.match(/multipart\/form-data\s*;\s*boundary=(?:"([^"]+)"|([^;\s]+))/i)?.slice(1).find(Boolean);
  if (!boundary || boundary.length > 200) throw Error('Upload must use multipart/form-data');
  const bytes = await readBody(req, maxUpload);
  const marker = Buffer.from('--' + boundary);
  const headerEnd = Buffer.from('\r\n\r\n');
  const first = bytes.indexOf(marker);
  const headersEnd = bytes.indexOf(headerEnd, first + marker.length);
  if (first < 0 || headersEnd < 0) throw Error('STEP upload is malformed');
  const headers = bytes.subarray(first + marker.length, headersEnd).toString('utf8');
  const disposition = headers.match(/content-disposition:\s*form-data;([^\r\n]+)/i)?.[1] || '';
  const field = disposition.match(/(?:^|;)\s*name="([^"]+)"/i)?.[1];
  const filename = disposition.match(/(?:^|;)\s*filename="([^"]*)"/i)?.[1];
  if (field !== 'step' || !filename) throw Error('Upload field "step" must contain one STEP file');
  const end = bytes.indexOf(Buffer.from('\r\n--' + boundary), headersEnd + headerEnd.length);
  if (end < 0) throw Error('STEP upload is missing its boundary terminator');
  const name = path.basename(filename).replace(/[\x00-\x1f\x7f]/g, '').slice(0, 180);
  if (!name || !['.step', '.stp'].includes(path.extname(name).toLowerCase())) throw Error('Uploaded file must have a .step or .stp extension');
  const data = bytes.subarray(headersEnd + headerEnd.length, end);
  if (!data.length) throw Error('Uploaded STEP file is empty');
  return {name, data};
}

function projectSummary(record) {
  const project = readProject(record.path);
  const attempts = project.unique_parts.flatMap(part => part.attempts);
  const model = project.selected_model || null;
  return {
    id: project.project_id,
    project_id: project.project_id,
    name: record.name,
    source_name: project.source.filename,
    solid_count: project.counts.instances,
    unique_count: project.counts.unique_parts,
    status: project.state,
    selected_model: model,
    updated_at: project.updated_at,
    completed_count: project.unique_parts.filter(part => part.attempts.some(attempt => attempt.status === 'completed')).length,
    attempt_count: attempts.length,
    assembly_evaluation_status: project.assembly_attempts.at(-1)?.verdict ? (project.assembly_attempts.at(-1).verdict.ok ? 'passed' : 'failed') : 'not_evaluated',
  };
}

function fullProject(record) {
  const project = readProject(record.path);
  const dedup = JSON.parse(fs.readFileSync(path.join(record.path, 'preprocess/dedup-report.json'), 'utf8'));
  const matches = new Map((dedup.matches || []).map(row => [row.instance_id, row]));
  const value = {
    ...project,
    id: project.project_id,
    name: record.name,
    source_name: project.source.filename,
    solid_count: project.counts.instances,
    status: project.state,
    assembly_evaluation_status: project.assembly_attempts.at(-1)?.verdict ? (project.assembly_attempts.at(-1).verdict.ok ? 'passed' : 'failed') : 'not_evaluated',
    ready_for_assembly: project.unique_parts.every(part => part.attempts.some(attempt => attempt.status === 'completed' && attempt.deliverables?.model_py && attempt.deliverables?.model_step)),
    can_assemble: project.unique_parts.every(part => part.attempts.some(attempt => attempt.status === 'completed' && attempt.deliverables?.model_py && attempt.deliverables?.model_step)),
  };
  value.unique_parts = project.unique_parts.map(part => {
    const instanceIDs = project.instances.filter(instance => instance.part_id === part.id).map(instance => instance.id);
    const partMatches = instanceIDs.map(id => matches.get(id)).filter(Boolean);
    return {
      ...part,
      instance_ids: instanceIDs,
      dedup_evidence: {
        method: part.dedup_method,
        deduplicated_instances: partMatches.filter(item => item.deduplicated).map(item => item.instance_id),
        representative_instance: part.representative_instance,
      },
    };
  });
  return value;
}

function savedModel() {
  try {
    const value = JSON.parse(fs.readFileSync(path.join(RUNTIME, 'active-model.json'), 'utf8'));
    return value.model || null;
  } catch {
    try { return JSON.parse(fs.readFileSync(path.join(RUNTIME, 'cli-connection.json'), 'utf8')).model || null; }
    catch {
      try { return loadProviderFile(process.env.CAD_CODE_CREDENTIALS).model; }
      catch { return process.env.CAD_CODE_MODEL || null; }
    }
  }
}

function parseProjectRoute(pathname) {
  const match = pathname.match(/^\/api\/projects\/([A-Za-z0-9_-]{8,64})(?:\/(.*))?$/);
  if (!match) return null;
  return {record: resolveRegisteredProject(match[1]), action: match[2] || ''};
}

function safeProjectFile(projectDir, relative) {
  if (typeof relative !== 'string' || !relative || path.isAbsolute(relative)) throw Error('Invalid artifact path');
  const absolute = path.resolve(projectDir, relative);
  if (!absolute.startsWith(projectDir + path.sep)) throw Error('Artifact path escapes project');
  const stat = fs.lstatSync(absolute);
  if (stat.isSymbolicLink() || !stat.isFile() || fs.realpathSync(absolute) !== absolute) throw Error('Artifact must be a regular project file');
  return absolute;
}

async function ocRequest(connection, route, method = 'GET', body) {
  const url = new URL(connection.url);
  if (url.protocol !== 'http:' || !['127.0.0.1', 'localhost'].includes(url.hostname)) throw Error('Assembly backend must be local');
  const response = await fetch(new URL(route, url), {
    method,
    headers: {authorization: 'Basic ' + Buffer.from('opencode:' + connection.password).toString('base64'), ...(body ? {'content-type': 'application/json'} : {})},
    ...(body ? {body: JSON.stringify(body)} : {}),
    signal: AbortSignal.timeout(30000),
  });
  const value = await response.json().catch(() => null);
  if (!response.ok) throw Error(value?.error || `OpenCode returned ${response.status}`);
  return value;
}

function assemblyAttempt(project, id) {
  const attempt = project.assembly_attempts.find(item => item.id === id);
  if (!attempt) throw Object.assign(Error('Assembly attempt not found'), {status: 404});
  return attempt;
}

async function createAssembly(record, selected) {
  const projectRoot = record.path;
  let project = readProject(projectRoot);
  if (!['parts_finished', 'awaiting_assembly', 'evaluated'].includes(project.state)) throw Error(`Project must finish single-part runs before assembly (state: ${project.state})`);
  if (!Array.isArray(selected) || selected.length !== project.unique_parts.length) throw Error('Select exactly one completed attempt for every unique part');
  const chosen = new Map();
  for (const row of selected) {
    if (!row || typeof row.part_id !== 'string' || typeof row.attempt_id !== 'string' || chosen.has(row.part_id)) throw Error('Assembly selection contains an invalid or duplicate part');
    chosen.set(row.part_id, row.attempt_id);
  }
  const selectedParts = [];
  for (const part of project.unique_parts) {
    const attemptID = chosen.get(part.id), attempt = part.attempts.find(item => item.id === attemptID);
    if (!attempt || attempt.status !== 'completed' || !attempt.deliverables?.model_py || !attempt.deliverables?.model_step) throw Error(`Part ${part.id} needs a completed attempt with model.py and model.step`);
    const notebook = safeProjectFile(projectRoot, attempt.deliverables.model_py);
    const stepir = safeProjectFile(projectRoot, part.stepir);
    const notebookHash = crypto.createHash('sha256').update(fs.readFileSync(notebook)).digest('hex');
    const stepirHash = crypto.createHash('sha256').update(fs.readFileSync(stepir)).digest('hex');
    if (part.stepir_version !== 'v6.3' || part.stepir_sha256 !== stepirHash) throw Error(`Part ${part.id} STEPIR version or hash mismatch`);
    selectedParts.push({part_id: part.id, notebook: attempt.deliverables.model_py, notebook_sha256: notebookHash, stepir: part.stepir, stepir_sha256: stepirHash, stepir_version: 'v6.3', stepeval_verdict: attempt.verdict, source_attempt: attempt.id});
  }

  const baseConnection = await ensureBackend();
  if (project.state === 'parts_finished' || project.state === 'evaluated') project = updateProject(projectRoot, project.revision, next => { next.state = 'awaiting_assembly'; });
  const providerConfig = path.join(RUNTIME, 'opencode.json');
  if (!fs.existsSync(providerConfig)) throw Error('The CAD Code backend must be started before assembly');
  const attemptID = 'assembly-' + new Date().toISOString().replace(/[-:.TZ]/g, '').slice(0, 17) + '-' + crypto.randomBytes(4).toString('hex');
  const attemptBase = path.join(projectRoot, 'assembly', attemptID);
  privateDirectory(path.dirname(attemptBase));
  fs.mkdirSync(attemptBase, {mode: 0o700});
  const runtimeDir = path.join(attemptBase, 'runtime');
  const workspaceDir = path.join(attemptBase, 'workspace');
  const contextFile = path.join(attemptBase, 'assembly-context.json');
  const assemblySkill = process.env.CAD_CODE_ASSEMBLY_SKILL || path.join(here, '../tools/assembly-skill');
  if (!fs.existsSync(path.join(assemblySkill, 'SKILL.md'))) throw Error('Assembly skill extension is missing; set CAD_CODE_ASSEMBLY_SKILL to its installed directory');
  const evaluator = 'The trusted controller evaluates the delivered source tree automatically after this turn';
  const context = {
    schema_version: 'cad-code-assembly-context-v1',
    project_id: project.project_id,
    assembly_ir: 'input/assembly.ir.json',
    inputs_manifest: 'input/assembly-inputs.json',
    parts_index: 'input/assembly-inputs.json',
    output_root: 'out',
    evaluator,
  };
  fs.writeFileSync(contextFile, JSON.stringify(context, null, 2) + '\n', {flag: 'wx', mode: 0o600});
  project = updateProject(projectRoot, project.revision, next => {
    next.state = 'assembly_running';
    for (const row of selected) next.unique_parts.find(part => part.id === row.part_id).selected_attempt_id = row.attempt_id;
    next.selected_model = baseConnection.model;
    next.assembly_attempts.push({id: attemptID, status: 'starting', started_at: new Date().toISOString(), finished_at: null, session_id: null, attempt_dir: null, runtime_dir: path.relative(projectRoot, runtimeDir), selected_parts: selectedParts.map(item => ({part_id: item.part_id, attempt_id: item.source_attempt}))});
  });
  let runtime;
  try {
    runtime = await startAssemblyRuntime({runtimeDir, workspaceDir, contextFile, baseConfigPath: providerConfig, pluginPath: path.join(here, 'assembly-plugin.mjs'), model: baseConnection.model, python: process.env.CAD_CODE_PYTHON || PYTHON, skill: SKILL, assemblySkill, opencodeBin: process.env.OPENCODE_BIN || 'opencode'});
    const session = await ocRequest(runtime.connection, '/session', 'POST', {title: `Assembly · ${project.source.filename}`});
    if (!/^ses_[A-Za-z0-9_-]+$/.test(session?.id || '')) throw Error('Assembly backend did not return a session ID');
    const sessionWorkspace = path.join(workspaceDir, session.id);
    for (let retry = 0; retry < 100 && !fs.existsSync(sessionWorkspace); retry++) await new Promise(resolve => setTimeout(resolve, 50));
    if (!fs.existsSync(sessionWorkspace)) throw Error('Assembly session workspace was not created');
    const inputManifest = stageAssemblyInputs({projectRoot, attemptInputDir: path.join(sessionWorkspace, 'input'), projectID: project.project_id, assemblyIRPath: 'assembly.ir.json', selectedParts});
    const adaptations = [];
    for (const part of inputManifest.parts) {
      const destination = path.join(sessionWorkspace, 'out/parts', part.part_id, 'model.py');
      const adapted = spawnSync(process.env.CAD_CODE_PYTHON || PYTHON,
        [path.join(here, 'notebook_adapter.py'), path.join(sessionWorkspace, 'input', part.notebook), destination],
        {encoding: 'utf8', maxBuffer: 1024 * 1024});
      if (adapted.status !== 0) throw Error('Child identity adaptation failed for ' + part.part_id + ': ' + adapted.stderr);
      adaptations.push({part_id: part.part_id, ...JSON.parse(adapted.stdout)});
    }
    fs.writeFileSync(path.join(attemptBase, 'identity-adaptations.json'), JSON.stringify(adaptations, null, 2) + '\n', {mode: 0o600, flag: 'wx'});
    const userMessage = 'Compose the selected part notebooks into the product assembly using input/assembly.ir.json and input/assembly-inputs.json. Adapted child copies are available in out/parts/<part-id>/model.py and use scad.notebook_id(); load each once with scad.use("parts/<part-id>/model.py", id="<part-id>"). Preserve every source occurrence and use source placement as the fallback for unresolved parts. Deliver out/product.py, out/product.scadpkg, out/product.step, and out/assembly-report.json. The trusted controller independently evaluates the complete source tree after this turn. Report your actual checks without inventing independent verdicts.';
    const updated = readProject(projectRoot);
    updateProject(projectRoot, updated.revision, next => {
      const attempt = next.assembly_attempts.find(item => item.id === attemptID);
      attempt.status = 'running';
      attempt.session_id = session.id;
      attempt.attempt_dir = path.relative(projectRoot, sessionWorkspace);
      attempt.input_sha256 = inputManifest.assembly_ir_sha256;
      attempt.inputs_sha256 = crypto.createHash('sha256').update(fs.readFileSync(path.join(sessionWorkspace, 'input/assembly-inputs.json'))).digest('hex');
      attempt.runtime_dir = path.relative(projectRoot, runtimeDir);
    });
    await ocRequest(runtime.connection, `/session/${session.id}/prompt_async`, 'POST', {agent: 'cad-assembly', model: {providerID: 'cad-local', modelID: runtime.connection.model}, parts: [{type: 'text', text: userMessage}]});
    assemblyRuntimes.set(`${project.project_id}:${attemptID}`, runtime);
    return {project_id: project.project_id, attempt_id: attemptID, session_id: session.id, attempt_dir: path.relative(projectRoot, sessionWorkspace), status: 'running', replay_status: 'not_evaluated'};
  } catch (error) {
    if (runtime) await runtime.stop();
    const current = readProject(projectRoot);
    updateProject(projectRoot, current.revision, next => {
      const attempt = next.assembly_attempts.find(item => item.id === attemptID);
      if (attempt) { attempt.status = 'failed'; attempt.finished_at = new Date().toISOString(); attempt.error = error.message; }
      next.state = 'awaiting_assembly';
    });
    throw error;
  }
}

async function finishAssembly(projectRoot, attempt) {
  if (!attempt.session_id || !attempt.runtime_dir) return attempt.status;
  const connection = JSON.parse(fs.readFileSync(path.join(projectRoot, attempt.runtime_dir, 'cli-connection.json')));
  const status = await ocRequest(connection, '/session/status');
  if (status[attempt.session_id]?.type === 'busy' || status[attempt.session_id]?.type === 'retry') return 'running';
  const messages = await ocRequest(connection, `/session/${attempt.session_id}/message`);
  const lastAssistant=messages.filter(message=>message.info?.role==='assistant').at(-1);
  const cutoff=attempt.turn_started_at || Date.parse(attempt.started_at) || 0;
  if(!lastAssistant || !((lastAssistant.info?.time?.completed>=cutoff && lastAssistant.info?.finish!=='tool-calls') || lastAssistant.info?.error))return 'running';
  const work=path.join(projectRoot,attempt.attempt_dir);
  const exported=await fetch(connection.website+'/api/sessions/'+attempt.session_id+'/export');
  if(!exported.ok)throw Error('Assembly trajectory export failed');
  const trajectory=await exported.json();
  if(trajectory.schema_version!=='cad-code-session-v2'||trajectory.id!==attempt.session_id)throw Error('Assembly export schema mismatch');
  const trajectoryPath=path.join('trajectories',attempt.session_id+'.json');
  fs.mkdirSync(path.join(projectRoot,'trajectories'),{recursive:true});
  const encoded=JSON.stringify(trajectory,null,2)+'\n';
  const trajectoryTmp=path.join(projectRoot,trajectoryPath)+'.'+crypto.randomUUID()+'.tmp';
  fs.writeFileSync(trajectoryTmp,encoded,{mode:0o600,flag:'wx'});fs.renameSync(trajectoryTmp,path.join(projectRoot,trajectoryPath));
  let evaluation, failure;
  if(fs.existsSync(path.join(work,'out/product.py'))) {
    try { evaluation=await evaluateAssembly(projectRoot,attempt); } catch(error) { failure=error.message; }
  } else failure='Assembly ended without out/product.py';
  const current=readProject(projectRoot);
  const latest=current.assembly_attempts.find(item=>item.id===attempt.id);
  if(!latest || latest.status!=='running' || latest.turn_started_at!==attempt.turn_started_at)return latest?.status||'interrupted';
  updateProject(projectRoot,current.revision,next=>{
    const row=next.assembly_attempts.find(item=>item.id===attempt.id);
    row.status=evaluation?.verdict?.ok===true ? 'completed' : 'failed';row.finished_at=new Date().toISOString();row.error=failure||null;
    row.verdict=evaluation?.verdict||null;
    row.deliverables={trajectory:trajectoryPath};
    if(evaluation)row.deliverables.verdict=evaluation.path;
    for(const [key,name] of Object.entries({product_py:'product.py',product_step:'product.step',product_scadpkg:'product.scadpkg',assembly_report:'assembly-report.json'})) {
      const checked=evaluation && ['product.step','product.scadpkg'].includes(name) ? path.join(projectRoot,evaluation.out,name) : path.join(work,'out',name);
      if(fs.existsSync(checked))row.deliverables[key]=path.relative(projectRoot,checked);
    }
    next.state=evaluation?'evaluated':'awaiting_assembly';
  });
  return evaluation?.verdict?.ok===true?'completed':'failed';
}
async function maybeFinishAssembly(projectRoot, attempt) {
  const actual=readProject(projectRoot).assembly_attempts.find(item=>item.id===attempt.id);
  if (!actual || ['completed','failed','interrupted','idle'].includes(actual.status)) return actual?.status || attempt.status;
  const key=projectRoot+':'+attempt.id;
  if(!finishingAssemblies.has(key)) {
    const promise=finishAssembly(projectRoot,attempt).finally(()=>finishingAssemblies.delete(key));
    finishingAssemblies.set(key,promise);
  }
  return finishingAssemblies.get(key);
}

async function rescoreAssembly(projectRoot, attempt) {
  const key=projectRoot+':'+attempt.id;
  if(scoringAssemblies.has(key))return scoringAssemblies.get(key);
  const promise=(async()=>{
    const current=readProject(projectRoot),row=current.assembly_attempts.find(item=>item.id===attempt.id);
    if(!row || !row.deliverables?.product_py)throw Error('Assembly source code is missing');
    if(['starting','running'].includes(row.status))throw Object.assign(Error('Assembly turn is still running'),{status:409});
    const result=await evaluateAssembly(projectRoot,row);
    const next=readProject(projectRoot);
    updateProject(projectRoot,next.revision,draft=>{
      const selected=draft.assembly_attempts.find(item=>item.id===attempt.id);
      selected.verdict=result.verdict;selected.evaluation_dir=result.out;selected.error=result.verdict.ok?null:result.verdict.error||'Independent assembly evaluation failed';
      selected.status=result.verdict.ok?'completed':'failed';selected.finished_at=new Date().toISOString();
      selected.deliverables.verdict=result.path;
      for(const [key,name] of Object.entries({product_step:'product.step',product_scadpkg:'product.scadpkg'}))selected.deliverables[key]=path.relative(projectRoot,path.join(projectRoot,result.out,name));
      draft.state='evaluated';
    });
    return result;
  })().finally(()=>scoringAssemblies.delete(key));
  scoringAssemblies.set(key,promise);return promise;
}

const mime = file => ({'.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.json': 'application/json; charset=utf-8', '.step': 'application/step', '.stp': 'application/step', '.py': 'text/plain; charset=utf-8'})[path.extname(file).toLowerCase()] || 'application/octet-stream';

const app = http.createServer(async(req, res) => {
  try {
    if (![`127.0.0.1:${port}`, `localhost:${port}`].includes(req.headers.host) || req.headers['sec-fetch-site'] === 'cross-site') return json(res, {error: 'Host refused'}, 403);
    const origin = req.headers.origin;
    if (origin && origin !== `http://127.0.0.1:${port}` && origin !== `http://localhost:${port}`) return json(res, {error: 'Origin refused'}, 403);
    const url = new URL(req.url, `http://127.0.0.1:${port}`), route = url.pathname;
    if (route === '/api/config' && req.method === 'GET') return json(res, {name: 'CAD Code multi-solid', model: savedModel(), assembly_evaluation_status: 'available'});
    if (route === '/api/projects' && req.method === 'GET') return json(res, listRegisteredProjects().map(projectSummary));
    if (route === '/api/projects' && req.method === 'POST') {
      const {name, data} = await readUpload(req);
      privateDirectory(path.join(RUNTIME, 'multi/uploads'));
      privateDirectory(projectsRoot);
      const source = path.join(RUNTIME, 'multi/uploads', `${process.pid}-${crypto.randomUUID()}${path.extname(name).toLowerCase()}`);
      fs.writeFileSync(source, data, {flag: 'wx', mode: 0o600});
      try {
        const canonical = sourceStep(source), inspected = runPreprocessor('inspect', canonical);
        if (inspected.solid_count === 1) {
          const connection = await ensureBackend();
          const created = await fetch(connection.website + '/api/sessions', {method:'POST', headers:{'content-type':'application/json'}, body:JSON.stringify({title:'CAD input · ' + name})});
          if (!created.ok) throw Error('Could not create single-part session');
          const session = await created.json();
          const uploaded = await fetch(connection.website + '/api/sessions/' + session.id + '/upload?name=' + encodeURIComponent(name), {method:'POST',headers:{'content-type':'application/octet-stream'},body:data});
          if (!uploaded.ok) throw Error('Could not import original STEP into single-part session');
          return json(res,{kind:'single',session_id:session.id,session_url:connection.website+'/#'+session.id},201);
        }

        const safeName = path.basename(name, path.extname(name)).replace(/[^A-Za-z0-9_.-]+/g, '-').slice(0, 64) || 'assembly';
        const output = path.join(projectsRoot, `${safeName}-${inspected.source.sha256.slice(0, 10)}`);
        const result = prepareProject(canonical, output, inspected, name);
        const record = listRegisteredProjects().find(item => item.id === result.project.project_id);
        return json(res, fullProject(record), 201);
      } finally { fs.unlinkSync(source); }
    }
    const parsed = parseProjectRoute(route);
    if (parsed) {
      const {record, action} = parsed;
      if (!action && req.method === 'GET') {
        for (const attempt of readProject(record.path).assembly_attempts.filter(item => item.status === 'running')) await maybeFinishAssembly(record.path,attempt);
        return json(res, fullProject(record));
      }
      if (action === 'run-parts' && req.method === 'POST') {
        const body = await readJSON(req), parallel = Number(body.parallel);
        if (!Number.isSafeInteger(parallel) || parallel < 1 || parallel > 40) throw Error('parallel must be an integer from 1 through 40');
        if (!body.prompt?.trim()) {
          const promptPath = process.env.CAD_CODE_MULTISOLID_PART_PROMPT;
          if (!promptPath || !fs.existsSync(promptPath)) throw Error('Set CAD_CODE_MULTISOLID_PART_PROMPT to the existing single-part prompt file before starting jobs');
        }
        if (runningParts.has(record.id)) return json(res, {ok: true, already_running: true, project_id: record.id}, 202);
        const beforeRun = readProject(record.path);
        if(!['ir_ready','parts_queued','parts_running','parts_finished','awaiting_assembly','failed'].includes(beforeRun.state))throw Error('Project cannot start parts in state '+beforeRun.state);
        const controller = new AbortController();
        const run = {controller, started_at: new Date().toISOString()}; runningParts.set(record.id, run);
        run.promise = runPartQueue(record.path, {parallel, prompt: typeof body.prompt === 'string' ? body.prompt : '', signal: controller.signal})
          .catch(error => { console.error('Multi-solid queue error:', String(error.message || error)); })
          .finally(() => { if (runningParts.get(record.id) === run) runningParts.delete(record.id); });
        return json(res, {ok: true, project_id: record.id, parallel}, 202);
      }
      if (action === 'assemble' && req.method === 'POST') {
        const body = await readJSON(req);
        return json(res, await createAssembly(record, body.parts), 202);
      }
      if (action === 'stop' && req.method === 'POST') {
        const running = runningParts.get(record.id);
        running?.controller.abort();
        const stoppedParts = await stopProjectPartSessions(record.path);
        const project = readProject(record.path), stoppedAssembly = [];
        for (const attempt of project.assembly_attempts.filter(item => ['starting', 'running'].includes(item.status))) {
          if (!attempt.session_id || !attempt.runtime_dir) continue;
          const connection = JSON.parse(fs.readFileSync(path.join(record.path, attempt.runtime_dir, 'cli-connection.json'), 'utf8'));
          await ocRequest(connection, `/session/${attempt.session_id}/abort`, 'POST', {});
          const current = readProject(record.path);
          updateProject(record.path, current.revision, next => {
            const row = next.assembly_attempts.find(item => item.id === attempt.id);
            row.status = 'interrupted'; row.finished_at = new Date().toISOString();
            if (!next.assembly_attempts.some(item => item.status === 'running')) next.state = 'awaiting_assembly';
          });
          stoppedAssembly.push({attempt_id: attempt.id, session_id: attempt.session_id});
        }
        return json(res, {stopped_parts: stoppedParts, stopped_assembly: stoppedAssembly});
      }
      const assemblyRoute = action.match(/^assembly\/([A-Za-z0-9_-]{8,80})(?:\/(.*))?$/);
      if (assemblyRoute) {
        const attempt = assemblyAttempt(readProject(record.path), assemblyRoute[1]), subroute = assemblyRoute[2] || '';
        const connection = JSON.parse(fs.readFileSync(path.join(record.path, attempt.runtime_dir, 'cli-connection.json'), 'utf8'));
        if (!subroute && req.method === 'GET') {
          if (url.searchParams.has('status_only')) {
            const status = await ocRequest(connection, '/session/status');
            const effectiveStatus = await maybeFinishAssembly(record.path, attempt);
            return json(res, {attempt_id: attempt.id, session_id: attempt.session_id, attempt_dir: attempt.attempt_dir, status: effectiveStatus, session_status: status[attempt.session_id] || {type: 'idle'}, replay_status: 'not_evaluated'});
          }
          const [messages, status] = await Promise.all([ocRequest(connection, `/session/${attempt.session_id}/message`), ocRequest(connection, '/session/status')]);
          const effectiveStatus = await maybeFinishAssembly(record.path, attempt);
          return json(res, {attempt_id: attempt.id, session_id: attempt.session_id, attempt_dir: attempt.attempt_dir, status: effectiveStatus, messages, session_status: status[attempt.session_id] || {type: 'idle'}, replay_status: 'not_evaluated'});
        }
        if (subroute === 'score' && req.method === 'POST') {
          const result=await rescoreAssembly(record.path,attempt);
          return json(res,{attempt_id:attempt.id,status:result.verdict.ok?'completed':'failed',verdict:result.verdict,verdict_path:result.path});
        }
        if (subroute === 'send' && req.method === 'POST') {
          if(finishingAssemblies.has(record.path+':'+attempt.id))throw Error('Evaluation is in progress; wait before continuing this attempt');
          const statuses=await ocRequest(connection,'/session/status');
          if(['busy','retry'].includes(statuses[attempt.session_id]?.type))throw Object.assign(Error('Assembly is still running'),{status:409});
          const body = await readJSON(req, 64 * 1024);
          if (typeof body.text !== 'string' || !body.text.trim()) throw Error('Message is empty');
          await ocRequest(connection, `/session/${attempt.session_id}/prompt_async`, 'POST', {agent: 'cad-assembly', model: {providerID: 'cad-local', modelID: connection.model}, parts: [{type: 'text', text: body.text}]});
          const current = readProject(record.path);
          updateProject(record.path, current.revision, next => { next.state = 'assembly_running'; const selected=next.assembly_attempts.find(item => item.id === attempt.id);selected.status = 'running';selected.turn_started_at=Date.now(); });
          return json(res, {ok: true});
        }
        if (subroute === 'file' && req.method === 'GET') {
          const work = path.join(record.path, attempt.attempt_dir);
          const requested = url.searchParams.get('path') || '';
          const key = {'out/product.py':'product_py','out/product.step':'product_step','out/product.scadpkg':'product_scadpkg','out/assembly-report.json':'assembly_report'}[requested];
          const file = key && attempt.deliverables?.[key] ? safeProjectFile(record.path,attempt.deliverables[key]) : safeProjectFile(work,requested);
          res.writeHead(200, {'content-type': mime(file), 'x-content-type-options': 'nosniff', 'cache-control': 'no-store'});
          return fs.createReadStream(file).pipe(res);
        }
      }
    }
    const staticFile = route === '/' ? 'index.html' : route.slice(1);
    if (!staticFile.includes('..')) {
      const file = path.join(here, 'public', staticFile);
      if (fs.existsSync(file) && fs.lstatSync(file).isFile()) {
        res.writeHead(200, {'content-type': mime(file), 'cache-control': 'no-cache', 'x-content-type-options': 'nosniff'});
        return fs.createReadStream(file).pipe(res);
      }
    }
    return json(res, {error: 'Not found'}, 404);
  } catch (error) {
    const status = error.status || 400;
    return json(res, {error: error.message || String(error)}, status);
  }
});

if (!Number.isSafeInteger(port) || port < 1024 || port > 65535) throw Error('CAD_CODE_MULTI_PORT must be between 1024 and 65535');
privateDirectory(projectsRoot);
app.listen(port, '127.0.0.1', () => console.log(`CAD Code multi-solid web: http://127.0.0.1:${port}`));

for (const record of listRegisteredProjects()) {
  try {
    const project = readProject(record.path);
    if (['parts_queued', 'parts_running'].includes(project.state) && !runningParts.has(record.id)) {
      const controller = new AbortController(), run = {controller, started_at: new Date().toISOString()};
      runningParts.set(record.id, run);
      run.promise = runPartQueue(record.path, {parallel: project.parallel || 1, prompt: '', signal: controller.signal})
        .catch(error => { console.error('Recovered multi-solid queue error:', String(error.message || error)); })
        .finally(() => { if (runningParts.get(record.id) === run) runningParts.delete(record.id); });
    }
  } catch (error) { console.error('Could not recover multi-solid project:', record.id, String(error.message || error)); }
}
