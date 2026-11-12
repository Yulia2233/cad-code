import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const known = new Set(['PROJECT_ID', 'ASSEMBLY_IR', 'INPUTS_MANIFEST', 'PARTS_INDEX', 'OUTPUT_ROOT', 'ASSEMBLY_EVALUATOR', 'SKILL_DIR', 'ASSEMBLY_SKILL']);
const hash = value => crypto.createHash('sha256').update(value).digest('hex');

function render(template, values) {
  const names = [...template.matchAll(/\{\{([^{}]*)\}\}/g)].map(match => match[1]);
  for (const name of names) {
    if (!known.has(name)) throw Error('AssemblyPromptError: unknown placeholder ' + name);
    if (values[name] === undefined || values[name] === null) throw Error('AssemblyPromptError: missing value ' + name);
  }
  return template.replace(/\{\{([A-Z][A-Z0-9_]*)\}\}/g, (_, name) => String(values[name]));
}

export function compileAssemblyPrompts({projectID, assemblyIR, inputsManifest, partsIndex, outputRoot, evaluator, skillDir, assemblySkill, docsDir = path.join(import.meta.dirname, 'docs')}) {
  for (const [label, value] of Object.entries({projectID, assemblyIR, inputsManifest, partsIndex, outputRoot, evaluator, skillDir, assemblySkill})) {
    if (typeof value !== 'string' || !value.trim()) throw Error('AssemblyPromptError: missing ' + label);
  }
  const system = fs.readFileSync(path.join(docsDir, 'system-prompt.assembly.en.md'), 'utf8').trimEnd();
  const runtimeTemplate = fs.readFileSync(path.join(docsDir, 'runtime-prompt.assembly.en.md'), 'utf8');
  const runtime = render(runtimeTemplate, {
    PROJECT_ID: projectID,
    ASSEMBLY_IR: assemblyIR,
    INPUTS_MANIFEST: inputsManifest,
    PARTS_INDEX: partsIndex,
    OUTPUT_ROOT: outputRoot,
    ASSEMBLY_EVALUATOR: evaluator,
    SKILL_DIR: skillDir,
    ASSEMBLY_SKILL: assemblySkill,
  });
  return {
    system,
    runtime,
    hashes: {system: hash(system), runtimeTemplate: hash(runtimeTemplate)},
  };
}
