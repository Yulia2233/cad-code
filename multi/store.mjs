import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import {isDeepStrictEqual} from 'node:util';

export const PROJECT_SCHEMA = 'cad-code-project-v1';
export const PROJECT_STATES = Object.freeze([
  'received', 'inspecting', 'split_verified', 'deduplicated', 'ir_ready',
  'parts_queued', 'parts_running', 'parts_finished', 'awaiting_assembly',
  'assembly_running', 'evaluated', 'archived', 'failed',
]);

const transitions = new Map([
  ['received', new Set(['inspecting', 'failed'])],
  ['inspecting', new Set(['split_verified', 'failed'])],
  ['split_verified', new Set(['deduplicated', 'failed'])],
  ['deduplicated', new Set(['ir_ready', 'failed'])],
  ['ir_ready', new Set(['parts_queued', 'failed'])],
  ['parts_queued', new Set(['parts_running', 'parts_finished', 'failed'])],
  ['parts_running', new Set(['parts_queued', 'parts_finished', 'failed'])],
  ['parts_finished', new Set(['awaiting_assembly', 'failed'])],
  ['awaiting_assembly', new Set(['assembly_running', 'failed'])],
  ['assembly_running', new Set(['awaiting_assembly', 'evaluated', 'failed'])],
  ['evaluated', new Set(['awaiting_assembly', 'assembly_running', 'archived', 'failed'])],
  ['archived', new Set()],
  ['failed', new Set(['inspecting', 'parts_queued', 'awaiting_assembly'])],
]);

const validID = value => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/.test(value);

function writeAtomic(file, text) {
  const temporary = `${file}.${process.pid}.${crypto.randomBytes(6).toString('hex')}.tmp`;
  fs.writeFileSync(temporary, text, {flag: 'wx', mode: 0o600});
  fs.renameSync(temporary, file);
}

function withLock(projectDir, callback) {
  const lockPath = path.join(projectDir, '.project.lock');
  let lock;
  try {
    lock = fs.openSync(lockPath, 'wx', 0o600);
  } catch (error) {
    if (error.code === 'EEXIST') {
      let stale = false;
      try {
        const owner=JSON.parse(fs.readFileSync(lockPath,'utf8'));
        if(Number.isSafeInteger(owner.pid)&&owner.pid>0) {
          try { process.kill(owner.pid,0); } catch(probe) { stale=probe.code==='ESRCH'; }
        }
      } catch {}
      if(stale){fs.unlinkSync(lockPath);return withLock(projectDir,callback);}
      throw Error('ProjectBusy: another controller is updating this project');
    }
    throw error;
  }
  try {
    fs.writeSync(lock, JSON.stringify({pid: process.pid, started_at: new Date().toISOString()}));
    fs.fsyncSync(lock);
    return callback();
  } finally {
    fs.closeSync(lock);
    try { fs.unlinkSync(lockPath); } catch {}
  }
}

export function initializeProject({projectDir, source, assemblyIR}) {
  const root = path.resolve(projectDir);
  if (!fs.statSync(root).isDirectory() || fs.lstatSync(root).isSymbolicLink()) throw Error('ProjectStoreError: project directory must be a regular directory');
  if (fs.existsSync(path.join(root, 'project.json'))) throw Error('ProjectStoreError: project manifest already exists');
  if (!assemblyIR || assemblyIR.schema_version !== 'step-assembly-ir-v1' || !Array.isArray(assemblyIR.unique_parts) || !Array.isArray(assemblyIR.instances)) {
    throw Error('ProjectStoreError: invalid step-assembly-ir-v1 data');
  }
  if (!source || !Number.isSafeInteger(source.solid_count) || source.solid_count !== assemblyIR.instances.length || !/^[a-f0-9]{64}$/.test(source.sha256 || '')) {
    throw Error('ProjectStoreError: source summary does not match assembly IR');
  }
  const assemblyIRFile = path.join(root, 'assembly.ir.json');
  if (!fs.existsSync(assemblyIRFile) || fs.lstatSync(assemblyIRFile).isSymbolicLink() || !fs.statSync(assemblyIRFile).isFile()) {
    throw Error('ProjectStoreError: assembly.ir.json must be a regular project file');
  }
  const storedIR = JSON.parse(fs.readFileSync(assemblyIRFile, 'utf8'));
  if (!isDeepStrictEqual(storedIR, assemblyIR)) {
    throw Error('ProjectStoreError: assembly IR file does not match supplied data');
  }
  const seenParts = new Set();
  const parts = assemblyIR.unique_parts.map(part => {
    if (!validID(part?.id) || seenParts.has(part.id) || part.stepir_version !== 'v6.3') throw Error('ProjectStoreError: invalid or duplicate v6.3 part entry');
    seenParts.add(part.id);
    return {...part, status: 'queued', attempts: []};
  });
  const instanceIDs = new Set();
  for (const instance of assemblyIR.instances) {
    if (!validID(instance?.id) || instanceIDs.has(instance.id) || !seenParts.has(instance.part_id)) throw Error('ProjectStoreError: invalid instance mapping');
    instanceIDs.add(instance.id);
  }
  const now = new Date().toISOString();
  const project = {
    schema_version: PROJECT_SCHEMA,
    project_id: crypto.randomUUID(),
    revision: 0,
    state: 'ir_ready',
    created_at: now,
    updated_at: now,
    source: {sha256: source.sha256, solid_count: source.solid_count, filename: source.filename ?? null},
    counts: {instances: assemblyIR.instances.length, unique_parts: parts.length},
    assembly_ir: {path: 'assembly.ir.json', sha256: crypto.createHash('sha256').update(fs.readFileSync(assemblyIRFile)).digest('hex')},
    unique_parts: parts,
    instances: assemblyIR.instances,
    assembly_attempts: [],
    events: [{revision: 0, state: 'ir_ready', time: now}],
  };
  writeAtomic(path.join(root, 'project.json'), JSON.stringify(project, null, 2) + '\n');
  return project;
}

export function readProject(projectDir) {
  const file = path.join(path.resolve(projectDir), 'project.json');
  const value = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (value.schema_version !== PROJECT_SCHEMA || !validID(value.project_id) || !PROJECT_STATES.includes(value.state) || !Number.isSafeInteger(value.revision)) {
    throw Error('ProjectStoreError: invalid project manifest');
  }
  return value;
}

export function updateProject(projectDir, expectedRevision, mutate) {
  const root = path.resolve(projectDir);
  return withLock(root, () => {
    const project = readProject(root);
    if (project.revision !== expectedRevision) throw Error(`ProjectConflict: expected revision ${expectedRevision}, found ${project.revision}`);
    const next = structuredClone(project);
    mutate(next);
    if (next.project_id !== project.project_id || next.schema_version !== PROJECT_SCHEMA) throw Error('ProjectStoreError: identity fields are immutable');
    if (!PROJECT_STATES.includes(next.state)) throw Error('ProjectStoreError: unknown project state');
    if (next.state !== project.state && !transitions.get(project.state).has(next.state)) throw Error(`ProjectTransitionError: ${project.state} cannot transition to ${next.state}`);
    next.revision++;
    next.updated_at = new Date().toISOString();
    next.events.push({revision: next.revision, state: next.state, time: next.updated_at});
    writeAtomic(path.join(root, 'project.json'), JSON.stringify(next, null, 2) + '\n');
    return next;
  });
}

export function summarizeProject(project) {
  const partCounts = Object.fromEntries(['queued', 'running', 'completed', 'failed'].map(status => [status, project.unique_parts.filter(part => part.status === status).length]));
  const ready = project.unique_parts.length > 0 && project.unique_parts.every(part => part.attempts.some(attempt => attempt.status === 'completed' && attempt.deliverables?.model_py && attempt.deliverables?.model_step));
  return {
    id: project.project_id,
    project_id: project.project_id,
    revision: project.revision,
    state: project.state,
    status: project.state,
    instances: project.counts.instances,
    solid_count: project.counts.instances,
    unique_parts: project.counts.unique_parts,
    part_status: partCounts,
    selected_model: project.selected_model || null,
    assembly_attempts: project.assembly_attempts.length,
    ready_for_assembly: ready,
    can_assemble: ready,
  };
}
