import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import CADCodePlugin from '../src/plugin.mjs';
import {sessionDir} from '../src/paths.mjs';
import {prepareSessionWorkspace} from '../src/workspace.mjs';
import {compileAssemblyPrompts} from './assembly-prompts.mjs';
import {savePromptSnapshot} from '../src/prompts.mjs';

function readContext(file) {
  if (!file) throw Error('AssemblyPromptError: CAD_CODE_ASSEMBLY_CONTEXT_FILE is required');
  const stat = fs.lstatSync(file);
  if (stat.isSymbolicLink() || !stat.isFile()) throw Error('AssemblyPromptError: context must be a regular file');
  const context = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (context.schema_version !== 'cad-code-assembly-context-v1' || typeof context.project_id !== 'string') throw Error('AssemblyPromptError: invalid assembly context');
  return context;
}

export default async function CADAssemblyPlugin({client}) {
  const base = await CADCodePlugin({client});
  return {
    ...base,
    'experimental.chat.system.transform': async(input, out) => {
      if (!out.system.some(text => typeof text === 'string' && text.split('\n')[0].trim() === '[CAD_CODE_ASSEMBLY_ROLE]')) return;
      if (!input.sessionID) throw Error('AssemblyPromptError: session context missing');
      prepareSessionWorkspace(input.sessionID);
      const context = readContext(process.env.CAD_CODE_ASSEMBLY_CONTEXT_FILE);
      const compiled = compileAssemblyPrompts({
        projectID: context.project_id,
        assemblyIR: context.assembly_ir,
        inputsManifest: context.inputs_manifest,
        partsIndex: context.parts_index,
        contextIndex: context.parts_index,
        outputRoot: context.output_root,
        evaluator: context.evaluator,
        skillDir: process.env.CAD_CODE_SKILL,
        assemblySkill: process.env.CAD_CODE_ASSEMBLY_SKILL,
      });
      const snapshot = {
        ...compiled,
        sessionID: input.sessionID,
        agent: 'cad-assembly',
        values: context,
        templateHashes: compiled.hashes,
        snapshotRoot: path.join(process.env.CAD_CODE_RUNTIME, 'prompt-snapshots'),
      };
      savePromptSnapshot(snapshot);
      const previous = fs.existsSync(path.join(sessionDir(input.sessionID), '.assembly-prompt.sha256'))
        ? fs.readFileSync(path.join(sessionDir(input.sessionID), '.assembly-prompt.sha256'), 'utf8').trim()
        : null;
      const current = crypto.createHash('sha256').update(compiled.system + '\0' + compiled.runtime).digest('hex');
      if (previous && previous !== current) throw Error('AssemblyPromptError: prompt snapshot changed during this session');
      if (!previous) fs.writeFileSync(path.join(sessionDir(input.sessionID), '.assembly-prompt.sha256'), current + '\n', {flag: 'wx', mode: 0o600});
      out.system.splice(0, out.system.length, compiled.system, compiled.runtime);
    },
  };
}
