import assert from 'node:assert/strict';
import {test} from 'node:test';
import {compileAssemblyPrompts} from '../multi/assembly-prompts.mjs';

test('assembly prompt is independent, English, v6.3-specific, and uses source placement fallback', () => {
  const result = compileAssemblyPrompts({
    projectID: 'project-1', assemblyIR: 'input/assembly.ir.json', inputsManifest: 'input/assembly-inputs.json',
    partsIndex: 'input/parts.json', outputRoot: 'out', evaluator: 'tools/assemblyeval.py', skillDir: 'skills/simplecadapi', assemblySkill: 'extensions/simplecadapi-assembly',
  });
  assert.match(result.system, /SimpleCADAPI 2\.2\.7/);
  assert.match(result.system, /STEPIR v6\.3/);
  assert.match(result.system, /source placement as the static fallback/);
  assert.doesNotMatch(result.system + result.runtime, /\{\{[A-Z0-9_]+\}\}/);
  assert.match(result.runtime, /input\/assembly\.ir\.json/);
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
