import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const baselinePath = path.join(root, 'multi/single-solid-baseline.sha256');
const exact = new Set([
  'docs/runtime-prompt.md',
  'docs/system-prompt.en.md',
  'skills/manifest.json',
]);
const frozenSource = new Set(['cli.mjs', 'cli-input.mjs', 'executor.mjs', 'paths.mjs', 'plugin.mjs', 'prompts.mjs', 'server.mjs', 'worker.mjs', 'workspace.mjs']);

function trackedFiles() {
  const result = spawnSync('git', ['ls-files', '-z'], {cwd: root, encoding: 'buffer'});
  if (result.status !== 0) throw Error('FreezeCheckError: git ls-files failed');
  return result.stdout.toString('utf8').split('\0').filter(Boolean).filter(file =>
    exact.has(file) || file.startsWith('skills/simplecadapi/') || file.startsWith('public/') ||
    file.startsWith('docs/') || (file.startsWith('src/') && frozenSource.has(path.basename(file))));
}

function digest(file) {
  let bytes = fs.readFileSync(path.join(root, file));
  if (['src/cli.mjs', 'src/server.mjs', 'public/app.js'].includes(file)) {
    bytes = Buffer.from(bytes.toString('utf8').replace(/^([ \t]*)\/\/ BEGIN MULTISOLID ADDITIVE [^\n]+\n[\s\S]*?^\1\/\/ END MULTISOLID ADDITIVE [^\n]+\n/gm, ''));
  }
  return crypto.createHash('sha256').update(bytes).digest('hex');
}

export function createBaseline() {
  const files = trackedFiles();
  if (!files.length) throw Error('FreezeCheckError: frozen file list is empty');
  return files.sort().map(file => `${digest(file)}  ${file}`).join('\n') + '\n';
}

export function checkBaseline() {
  if (!fs.existsSync(baselinePath)) throw Error('FreezeCheckError: baseline file is missing');
  const expected = new Map(fs.readFileSync(baselinePath, 'utf8').trimEnd().split('\n').map(line => {
    const match = line.match(/^([a-f0-9]{64})  (.+)$/);
    if (!match) throw Error('FreezeCheckError: malformed baseline row');
    return [match[2], match[1]];
  }));
  const actualFiles = trackedFiles().sort();
  const differences = [];
  for (const file of actualFiles) {
    if (!expected.has(file)) differences.push(`unbaselined: ${file}`);
    else if (expected.get(file) !== digest(file)) differences.push(`changed: ${file}`);
  }
  for (const file of expected.keys()) if (!actualFiles.includes(file)) differences.push(`missing: ${file}`);
  if (differences.length) throw Error('FreezeCheckError: ' + differences.join('\n'));
  return {files: actualFiles.length, baseline: baselinePath};
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    if (process.argv[2] === '--write') {
      fs.writeFileSync(baselinePath, createBaseline(), {flag: 'wx'});
      console.log(`Recorded ${trackedFiles().length} frozen files`);
    } else {
      const result = checkBaseline();
      console.log(`Verified ${result.files} frozen files`);
    }
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
