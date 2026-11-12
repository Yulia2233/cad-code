import assert from 'node:assert/strict';
import {test} from 'node:test';
import {classifyInvocation, decideSolidDispatch} from '../multi/dispatch.mjs';

test('ordinary commands and explicit session continuation delegate untouched', () => {
  assert.deepEqual(classifyInvocation(['run', 'hello']), {kind: 'delegate', reason: 'no-step-input'});
  assert.deepEqual(classifyInvocation(['--file', 'part.step', '--session', 'ses_existing', 'run', 'hello']), {kind: 'delegate', reason: 'existing-session'});
});

test('one STEP input retains its exact original argv for single-solid delegation', () => {
  const argv = ['--file', './part.step', '--file', './part.ir.jsonl', 'run', 'rebuild this'];
  const inspected = classifyInvocation(argv);
  assert.equal(inspected.kind, 'inspect');
  assert.equal(inspected.stepFile, './part.step');
  assert.deepEqual(decideSolidDispatch(inspected, 1), {kind: 'delegate', reason: 'single-solid', originalArgv: argv});
  assert.deepEqual(argv, ['--file', './part.step', '--file', './part.ir.jsonl', 'run', 'rebuild this']);
});

test('multiple STEP inputs fail closed and multi-solid inputs select the new flow', () => {
  assert.equal(classifyInvocation(['--file', 'a.step', '--file', 'b.stp', 'run', 'x']).reason, 'multiple-step-inputs');
  const inspected = classifyInvocation(['--file', 'assembly.STEP', 'run', 'assemble']);
  assert.deepEqual(decideSolidDispatch(inspected, 3), {
    kind: 'prepare-multisolid', stepFile: 'assembly.STEP', solidCount: 3, originalArgv: ['--file', 'assembly.STEP', 'run', 'assemble'],
  });
});

test('invalid inspection results never fall through to single-solid mode', () => {
  const invocation = classifyInvocation(['--file', 'part.step']);
  assert.equal(decideSolidDispatch(invocation, 0).kind, 'error');
  assert.equal(decideSolidDispatch(invocation, NaN).kind, 'error');
});
