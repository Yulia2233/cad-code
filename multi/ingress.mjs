import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {RUNTIME, WORKSPACE} from '../src/paths.mjs';
import {classifyInvocation, decideSolidDispatch} from './dispatch.mjs';
import {sourceStep, runPreprocessor, prepareProject, defaultProjectPath, ensureMultiWeb, main} from './cli.mjs';

export async function routeCLI(argv) {
  if (process.env.CAD_CODE_SINGLE_SOLID === '1') return false;
  if (argv.includes('--help') || argv.includes('-h') || argv.includes('--session') || argv.includes('--continue')) return false;
  const command = argv[0];
  if (['ask','config','list','delete','export'].includes(command) && !argv.includes('--project')) return false;
  if (['inspect', 'prepare', 'run-parts', 'assemble', 'resume', 'stop'].includes(command) || (argv.includes('--project') && ['status', 'export'].includes(command))) {
    await main(argv); return true;
  }
  const invocation = classifyInvocation(argv);
  if (invocation.kind !== 'inspect') return false;
  const file = sourceStep(invocation.stepFile), inspection = runPreprocessor('inspect', file);
  const decision = decideSolidDispatch(invocation, inspection.solid_count);
  if (decision.kind === 'delegate') return false;
  if (decision.kind === 'error') throw Error('STEP inspection did not return a positive solid count');
  const prepared = prepareProject(file, defaultProjectPath(file, inspection.source.sha256), inspection);
  const base=await ensureMultiWeb();
  process.stdout.write(JSON.stringify({...prepared,workbench_url:base+'/#'+prepared.project.project_id}, null, 2) + '\n');
  return true;
}

export async function routeUpload(bytes, filename) {
  if (!/\.st(?:ep|p)$/i.test(filename)) throw Error('A STEP upload is required');
  const uploadDir = path.join(RUNTIME, 'multi', 'uploads');
  fs.mkdirSync(uploadDir, {recursive: true, mode: 0o700});
  const file = path.join(uploadDir, crypto.randomUUID() + '.step');
  fs.writeFileSync(file, bytes, {mode: 0o600, flag: 'wx'});
  try {
    const inspection = runPreprocessor('inspect', file);
    if (inspection.solid_count === 1) return {kind: 'single', solid_count: 1};
    if (!Number.isSafeInteger(inspection.solid_count) || inspection.solid_count < 2) throw Error('STEP has no valid solids');
    const label = path.basename(filename).replace(/[^A-Za-z0-9_.-]/g, '-').slice(0, 70);
    const output = path.join(WORKSPACE, 'multisolid-projects', label + '-' + crypto.randomUUID());
    const result = prepareProject(file, output, inspection, path.basename(filename));
    const base = await ensureMultiWeb();
    return {kind: 'multi', project_id: result.project.project_id, solid_count: inspection.solid_count, workbench_url: base + '/#' + result.project.project_id};
  } finally { fs.unlinkSync(file); }
}
