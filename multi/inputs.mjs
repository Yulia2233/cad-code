import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import {buildAssemblyContextAssets} from './assembly-context.mjs';

const hashFile = file => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const partIDPattern = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/;

function resolveInput(root, relative, label) {
  if (typeof relative !== 'string' || !relative || path.isAbsolute(relative)) throw Error(`AssemblyInputError: ${label} must be project-relative`);
  const rootPath = fs.realpathSync(root);
  const file = path.resolve(rootPath, relative);
  if (file === rootPath || !file.startsWith(rootPath + path.sep)) throw Error(`AssemblyInputError: ${label} is outside project`);
  const stat = fs.lstatSync(file);
  if (stat.isSymbolicLink() || !stat.isFile()) throw Error(`AssemblyInputError: ${label} must be a regular file`);
  if (fs.realpathSync(file) !== file) throw Error(`AssemblyInputError: ${label} resolves through a symlink`);
  if (/\.(?:step|stp|scadpkg)$/i.test(file)) throw Error(`AssemblyInputError: ${label} has a forbidden geometry artifact extension`);
  return file;
}

export function stageAssemblyInputs({projectRoot, attemptInputDir, projectID, assemblyIRPath, selectedParts}) {
  if (!Array.isArray(selectedParts) || selectedParts.length === 0) throw Error('AssemblyInputError: selectedParts must not be empty');
  const root = fs.realpathSync(projectRoot);
  const assemblyIR = resolveInput(root, assemblyIRPath, 'assembly IR');
  const files = [{source: assemblyIR, target: 'assembly.ir.json', role: 'assembly_ir'}];
  const partRows = [];
  const seen = new Set();

  for (const part of selectedParts) {
    if (!partIDPattern.test(part?.part_id || '') || seen.has(part.part_id)) throw Error('AssemblyInputError: invalid or duplicate part ID');
    seen.add(part.part_id);
    if (part.stepir_version !== 'v6.3') throw Error(`AssemblyInputError: ${part.part_id} must use STEPIR v6.3`);
    const notebook = resolveInput(root, part.notebook, `${part.part_id} notebook`);
    const stepir = resolveInput(root, part.stepir, `${part.part_id} STEPIR`);
    if (path.extname(notebook).toLowerCase() !== '.py' || !/\.ir\.jsonl$/i.test(stepir)) throw Error(`AssemblyInputError: invalid notebook or STEPIR file for ${part.part_id}`);
    const notebookHash = hashFile(notebook), stepirHash = hashFile(stepir);
    if (part.notebook_sha256 && part.notebook_sha256 !== notebookHash) throw Error(`AssemblyInputError: notebook hash mismatch for ${part.part_id}`);
    if (part.stepir_sha256 && part.stepir_sha256 !== stepirHash) throw Error(`AssemblyInputError: STEPIR hash mismatch for ${part.part_id}`);
    const notebookTarget = `parts/${part.part_id}/model.py`;
    const stepirTarget = `parts/${part.part_id}/target.ir.jsonl`;
    files.push({source: notebook, target: notebookTarget, role: 'part_notebook'});
    files.push({source: stepir, target: stepirTarget, role: 'stepir_v6.3'});
    partRows.push({
      part_id: part.part_id,
      notebook: notebookTarget,
      notebook_sha256: notebookHash,
      stepir: stepirTarget,
      stepir_version: 'v6.3',
      stepir_sha256: stepirHash,
      stepeval_verdict: part.stepeval_verdict ?? null,
      source_attempt: part.source_attempt ?? null,
    });
  }

  const assemblyIRHash = hashFile(assemblyIR);
  const contextAssets = buildAssemblyContextAssets({projectRoot: root, projectID, assemblyIRPath,
    assemblyIRHash, selectedParts});
  const contextIndexTarget = 'assembly-context-index.json';
  const contextIndexBytes = Buffer.from(JSON.stringify(contextAssets.index, null, 2) + '\n');
  files.push({target: contextIndexTarget, role: 'assembly_context_index', content: contextIndexBytes});
  for (const page of contextAssets.pageFiles) files.push({target: page.target, role: page.role, content: Buffer.from(page.content)});

  const destination = path.resolve(attemptInputDir);
  if (fs.existsSync(destination)) throw Error('AssemblyInputError: refusing to overwrite input snapshot');
  fs.mkdirSync(path.dirname(destination), {recursive: true});
  const temporary = `${destination}.tmp-${process.pid}-${crypto.randomBytes(6).toString('hex')}`;
  fs.mkdirSync(temporary, {recursive: true});
  try {
    for (const file of files) {
      const target = path.join(temporary, file.target);
      fs.mkdirSync(path.dirname(target), {recursive: true});
      if (file.source) fs.copyFileSync(file.source, target, fs.constants.COPYFILE_EXCL);
      else fs.writeFileSync(target, file.content, {flag: 'wx', mode: 0o600});
    }
    const manifest = {
      schema_version: 'cad-code-assembly-inputs-v1',
      project_id: projectID,
      assembly_ir: 'assembly.ir.json',
      assembly_ir_sha256: assemblyIRHash,
      context_index: contextIndexTarget,
      context_index_sha256: hashFile(path.join(temporary, contextIndexTarget)),
      parts: partRows,
      files: files.map(({target, role}) => ({path: target, role, sha256: hashFile(path.join(temporary, target))})),
    };
    fs.writeFileSync(path.join(temporary, 'assembly-inputs.json'), JSON.stringify(manifest, null, 2) + '\n', {flag: 'wx', mode: 0o600});
    fs.renameSync(temporary, destination);
    return manifest;
  } catch (error) {
    fs.rmSync(temporary, {recursive: true, force: true});
    throw error;
  }
}
