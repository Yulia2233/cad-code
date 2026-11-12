#!/usr/bin/env node
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import {spawn, spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {ROOT, RUNTIME, WORKSPACE, PYTHON, SKILL} from '../src/paths.mjs';
import {classifyInvocation, decideSolidDispatch} from './dispatch.mjs';
import {initializeProject, readProject, summarizeProject} from './store.mjs';
import {runPartQueue} from './part-runner.mjs';
import {registerProject} from './registry.mjs';
import {exportProject} from './export.mjs';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);

function usage() {
  console.log(`CAD Code multi-solid extension

  ./cad-code-multi inspect --file assembly.step
  ./cad-code-multi prepare --file assembly.step [--out project/path]
  ./cad-code-multi status --project project/path [--json]
  ./cad-code-multi run-parts --project project/path --parallel 4 [--prompt-file prompt.md]
  ./cad-code-multi resume --project project/path [--parallel 4] [--retry-failed]
  ./cad-code-multi stop --project project/path
  ./cad-code-multi assemble --project project/path [--wait --timeout 1800]
  ./cad-code-multi --web
  ./cad-code-multi --file part.step run "<existing single-part prompt>"

Single-solid inputs are inspected and delegated with their original arguments.
Multi-solid inputs are split and deduplicated into an independently tracked project.

Set CAD_CODE_MULTISOLID_CLI to the step-tools multisolid/cli.py entry point.
Set CAD_CODE_PYTHON to the SimpleCADAPI 2.2.7 Python interpreter.`);
}

function option(argv, name, {required = false} = {}) {
  const index = argv.indexOf(name);
  if (index < 0) {
    if (required) throw Error(`${name} is required`);
    return undefined;
  }
  const value = argv[index + 1];
  if (!value || value.startsWith('--')) throw Error(`${name} requires a value`);
  return value;
}

function promptOption(argv) {
  const file = option(argv, '--prompt-file');
  if (file) {
    const absolute = path.resolve(file), stat = fs.lstatSync(absolute);
    if (stat.isSymbolicLink() || !stat.isFile()) throw Error('--prompt-file must be a regular file');
    return fs.readFileSync(absolute, 'utf8');
  }
  return option(argv, '--prompt') || '';
}

export function sourceStep(file) {
  const absolute = path.resolve(file);
  const stat = fs.lstatSync(absolute);
  if (stat.isSymbolicLink() || !stat.isFile() || fs.realpathSync(absolute) !== absolute) throw Error('STEP input must be a regular file reached without symlinks');
  if (!['.step', '.stp'].includes(path.extname(absolute).toLowerCase())) throw Error('Input must have a .step or .stp extension');
  return absolute;
}

function toolConfig() {
  const cli = process.env.CAD_CODE_MULTISOLID_CLI || path.join(scriptDir, 'vendor/step-tools-multisolid/cli.py');
  const python = process.env.CAD_CODE_PYTHON || PYTHON;
  const stepir = process.env.CAD_CODE_STEPIR_SCRIPT || path.join(SKILL, 'scripts/stepir.py');
  if (!fs.existsSync(cli)) throw Error('Set CAD_CODE_MULTISOLID_CLI to the installed step-tools multisolid/cli.py');
  if (!fs.existsSync(python)) throw Error('Set CAD_CODE_PYTHON to the SimpleCADAPI 2.2.7 Python interpreter');
  if (!fs.existsSync(stepir)) throw Error('Set CAD_CODE_STEPIR_SCRIPT to the installed STEPIR v6.3 script');
  return {cli, python, stepir};
}

export function runPreprocessor(subcommand, file, out) {
  const {cli, python, stepir} = toolConfig();
  const args = [cli, subcommand, file];
  if (out) args.push('--out', out, '--python', python, '--stepir-script', stepir);
  const result = spawnSync(python, args, {encoding: 'utf8', maxBuffer: 16 * 1024 * 1024});
  if (result.error) throw Error(`Could not start multisolid preprocessor: ${result.error.message}`);
  if (result.status !== 0) throw Error((result.stderr || result.stdout || `Preprocessor exited with ${result.status}`).trim());
  try { return JSON.parse(result.stdout); }
  catch { throw Error('Multisolid preprocessor returned invalid JSON'); }
}

function printJSON(value, asJSON) {
  if (asJSON || process.stdout.isTTY === false) process.stdout.write(JSON.stringify(value, null, 2) + '\n');
  else console.log(JSON.stringify(value, null, 2));
}

function multiWebURL() {
  const port = Number(process.env.CAD_CODE_MULTI_PORT || 8773);
  if (!Number.isSafeInteger(port) || port < 1024 || port > 65535) throw Error('CAD_CODE_MULTI_PORT must be between 1024 and 65535');
  return `http://127.0.0.1:${port}`;
}

async function webHealth(base) {
  try {
    const response = await fetch(base + '/api/config', {signal: AbortSignal.timeout(700)});
    if (!response.ok) return false;
    return (await response.json()).name === 'CAD Code multi-solid';
  } catch { return false; }
}

export async function ensureMultiWeb() {
  const base = multiWebURL();
  if (await webHealth(base)) return base;
  const directory = path.join(RUNTIME, 'multi');
  fs.mkdirSync(directory, {recursive: true, mode: 0o700});
  if (fs.lstatSync(directory).isSymbolicLink()) throw Error('CAD Code multi runtime directory must not be a symlink');
  const log = fs.openSync(path.join(directory, 'web.log'), 'a', 0o600);
  const child = spawn(process.execPath, [path.join(scriptDir, 'server.mjs')], {cwd: ROOT, env: process.env, detached: true, stdio: ['ignore', log, log]});
  fs.closeSync(log);
  child.unref();
  for (let attempt = 0; attempt < 120; attempt++) {
    if (child.exitCode !== null) throw Error('CAD Code multi-solid web failed to start; inspect the multi runtime web log');
    if (await webHealth(base)) return base;
    await new Promise(resolve => setTimeout(resolve, 250));
  }
  throw Error('CAD Code multi-solid web startup timed out');
}

async function assembleProject(projectDir, shouldWait, timeoutSeconds, selection) {
  const project = readProject(projectDir);
  const parts = selection || project.unique_parts.map(part => ({part_id: part.id, attempt_id: part.selected_attempt_id || part.attempts.filter(attempt=>attempt.status==='completed' && attempt.deliverables?.model_py && attempt.deliverables?.model_step).at(-1)?.id}));
  if (parts.some(part => !part.attempt_id)) throw Error('Select one completed attempt for every unique part before assembly');
  const base = await ensureMultiWeb();
  const response = await fetch(`${base}/api/projects/${encodeURIComponent(project.project_id)}/assemble`, {
    method: 'POST', headers: {'content-type': 'application/json'}, body: JSON.stringify({parts}),
  });
  const started = await response.json().catch(() => null);
  if (!response.ok) throw Error(started?.error || `Assembly start failed: ${response.status}`);
  if (!shouldWait) return started;
  if (!Number.isSafeInteger(timeoutSeconds) || timeoutSeconds < 60 || timeoutSeconds > 86400) throw Error('--timeout must be between 60 and 86400 seconds');
  const deadline = Date.now() + timeoutSeconds * 1000;
  let current = started;
  while (Date.now() < deadline) {
    const poll = await fetch(`${base}/api/projects/${encodeURIComponent(project.project_id)}/assembly/${encodeURIComponent(started.attempt_id)}?status_only=1`);
    current = await poll.json().catch(() => null);
    if (!poll.ok) throw Error(current?.error || `Assembly status failed: ${poll.status}`);
    if (['completed', 'idle', 'failed', 'interrupted'].includes(current.status)) return current;
    await new Promise(resolve => setTimeout(resolve, 1000));
  }
  throw Error(`Assembly did not finish within ${timeoutSeconds} seconds`);
}

function delegateOriginal(argv) {
  const child = spawn(process.execPath, [path.join(ROOT, 'src/cli.mjs'), ...argv], {cwd: process.cwd(), env: process.env, stdio: 'inherit'});
  child.once('error', error => { console.error(error.message); process.exitCode = 1; });
  child.once('exit', code => { process.exitCode = code ?? 1; });
}

export function defaultProjectPath(source, hash) {
  const base = path.basename(source, path.extname(source)).replace(/[^A-Za-z0-9_.-]+/g, '-').slice(0, 72) || 'assembly';
  return path.join(WORKSPACE, 'multisolid-projects', `${base}-${hash.slice(0, 10)}`);
}

export function prepareProject(source, projectDir, inspected = runPreprocessor('inspect', source), sourceName = path.basename(source)) {
  if (inspected.solid_count <= 1) throw Error('prepare is only for multi-solid STEP files; use the existing single-solid workflow');
  const output = path.resolve(projectDir);
  if (fs.existsSync(output)) throw Error(`Project output already exists: ${output}`);
  fs.mkdirSync(path.dirname(output), {recursive: true, mode: 0o700});
  if (fs.lstatSync(path.dirname(output)).isSymbolicLink()) throw Error('Project parent directory must not be a symlink');
  const prepared = runPreprocessor('prepare', source, output);
  if (path.resolve(prepared.project_dir) !== output) throw Error('Preprocessor wrote to an unexpected project directory');
  const irPath = path.join(output, 'assembly.ir.json');
  const assemblyIR = JSON.parse(fs.readFileSync(irPath, 'utf8'));
  const storedSource = path.join(output, 'source/source.step');
  const sourceHash = crypto.createHash('sha256').update(fs.readFileSync(source)).digest('hex');
  const storedHash = crypto.createHash('sha256').update(fs.readFileSync(storedSource)).digest('hex');
  if (storedHash !== sourceHash) throw Error('Preprocessor source snapshot does not match the input STEP');
  if (prepared.source_sha256 && prepared.source_sha256 !== sourceHash) throw Error('Source STEP changed during preprocessing');
  const project = initializeProject({
    projectDir: output,
    source: {sha256: sourceHash, solid_count: inspected.solid_count, filename: sourceName},
    assemblyIR,
  });
  registerProject(output, {name: sourceName});
  return {prepared, project: summarizeProject(project), project_dir: output};
}

export async function main(argv = args) {
  const args = argv;
  if (args.includes('--help') || args.includes('-h')) return usage();
  const command = args[0];
  if (args.includes('--web') && command !== 'inspect' && command !== 'prepare') {
    console.log(await ensureMultiWeb());
    return;
  }
  if (command === 'inspect') {
    const source = sourceStep(option(args, '--file', {required: true}));
    printJSON(runPreprocessor('inspect', source), true);
    return;
  }
  if (command === 'prepare') {
    const source = sourceStep(option(args, '--file', {required: true}));
    const inspected = runPreprocessor('inspect', source);
    const output = option(args, '--out') || defaultProjectPath(source, inspected.source.sha256);
    const result = prepareProject(source, output, inspected);
    printJSON(result, args.includes('--json'));
    return;
  }
  if (command === 'status') {
    const projectDir = path.resolve(option(args, '--project', {required: true}));
    const summary = summarizeProject(readProject(projectDir));
    printJSON(summary, args.includes('--json'));
    return;
  }
  if (command === 'run-parts' || command === 'resume') {
    const projectDir = path.resolve(option(args, '--project', {required: true}));
    const project = readProject(projectDir);
    const parallelText = option(args, '--parallel');
    const parallel = parallelText === undefined ? (command === 'resume' ? project.parallel || 1 : 1) : Number(parallelText);
    const result = await runPartQueue(projectDir, {
      parallel,
      prompt: command === 'run-parts' ? promptOption(args) : '',
      retryFailed: args.includes('--retry-failed'),
      onUpdate: event => { if (event.type !== 'progress') process.stderr.write(JSON.stringify(event) + '\n'); },
    });
    printJSON({project: summarizeProject(result.project), halted: result.halted, settled: result.settled}, true);
    return;
  }
  if (command === 'stop') {
    const projectDir = path.resolve(option(args, '--project', {required: true}));
    const project = readProject(projectDir), base = await ensureMultiWeb();
    const response = await fetch(`${base}/api/projects/${encodeURIComponent(project.project_id)}/stop`, {method: 'POST'});
    const result = await response.json().catch(() => null);
    if (!response.ok) throw Error(result?.error || `Stop failed: ${response.status}`);
    printJSON(result, true);
    return;
  }
  if (command === 'assemble') {
    const projectDir = path.resolve(option(args, '--project', {required: true}));
    const timeout = Number(option(args, '--timeout') || '1800');
    const selected = option(args, '--parts');
    printJSON(await assembleProject(projectDir, args.includes('--wait'), timeout, selected ? JSON.parse(selected) : undefined), true);
    return;
  }
  if (command === 'export') {
    printJSON(exportProject(path.resolve(option(args, '--project', {required:true})), path.resolve(option(args, '--out', {required:true}))), true);
    return;
  }

  const invocation = classifyInvocation(args);
  if (invocation.kind === 'delegate') return delegateOriginal(args);
  if (invocation.kind === 'error') throw Error(invocation.reason === 'multiple-step-inputs' ? 'One STEP per task is supported; create separate projects for separate files' : 'Invalid invocation');
  const source = sourceStep(invocation.stepFile);
  const inspected = runPreprocessor('inspect', source);
  const decision = decideSolidDispatch(invocation, inspected.solid_count);
  if (decision.kind === 'delegate') return delegateOriginal(args);
  const output = defaultProjectPath(source, inspected.source.sha256);
  const result = prepareProject(source, output, inspected);
  printJSON({
    ...result,
    next_command: `./cad-code-multi run-parts --project ${JSON.stringify(output)} --prompt <existing-single-part-prompt>`,
  }, false);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => { console.error(error.message || String(error)); process.exitCode = 1; });
}
