import assert from 'node:assert/strict';
import {test} from 'node:test';
import {compileAssemblyPrompts} from '../multi/assembly-prompts.mjs';

test('assembly prompt is independent, English, v6.3-specific, and uses source placement fallback', () => {
  const result = compileAssemblyPrompts({
    projectID: 'project-1', assemblyIR: 'input/assembly.ir.json', inputsManifest: 'input/assembly-inputs.json',
    partsIndex: 'input/parts.json', contextIndex: 'input/assembly-context-index.json', outputRoot: 'out', evaluator: 'tools/assemblyeval.py', skillDir: 'skills/simplecadapi', assemblySkill: 'extensions/simplecadapi-assembly',
  });
  assert.match(result.system, /SimpleCADAPI 2\.2\.7/);
  assert.match(result.system, /STEPIR v6\.3/);
  assert.match(result.system, /Use source-pose fixed edges for unresolved/);
  assert.doesNotMatch(result.system + result.runtime, /\{\{[A-Z0-9_]+\}\}/);
  assert.match(result.runtime, /input\/assembly\.ir\.json/);
  assert.match(result.runtime, /assembly-context-index\.json/);
  assert.match(result.runtime, /Do not read the complete manifest/);
  assert.match(result.runtime, /controller-generated `out\/product\.py`/);
  assert.doesNotMatch(result.runtime, /Read the input manifest and assembly IR first/);
});

test('assembly prompts require complete context and never evaluate template values', () => {
  assert.throws(() => compileAssemblyPrompts({projectID: 'project-1'}), /missing assemblyIR/);
  const result = compileAssemblyPrompts({
    projectID: '{{OUTPUT_ROOT}}', assemblyIR: 'input/a.json', inputsManifest: 'input/i.json',
    partsIndex: 'input/p.json', outputRoot: 'out/$&', evaluator: 'eval.py', skillDir: 'skill', assemblySkill: 'assembly-skill',
  });
  assert.match(result.runtime, /Project ID: `\{\{OUTPUT_ROOT\}\}`/);
  assert.match(result.runtime, /Output root: `out\/\$&`/);
});
