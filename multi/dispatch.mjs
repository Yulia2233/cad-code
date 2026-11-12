import path from 'node:path';

const multiCommands = new Set(['prepare', 'run-parts', 'status', 'assemble', 'export', 'stop', 'resume']);

export function classifyInvocation(argv) {
  if (multiCommands.has(argv[0])) return {kind: 'multi-command', command: argv[0]};
  if (argv.includes('--continue') || argv.includes('--session')) return {kind: 'delegate', reason: 'existing-session'};

  const stepFiles = [];
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] !== '--file' && argv[i] !== '-f') continue;
    const value = argv[i + 1];
    if (value && !value.startsWith('--') && ['.step', '.stp'].includes(path.extname(value).toLowerCase())) stepFiles.push(value);
  }
  if (stepFiles.length === 0) return {kind: 'delegate', reason: 'no-step-input'};
  if (stepFiles.length > 1) return {kind: 'error', reason: 'multiple-step-inputs', stepFiles};
  return {kind: 'inspect', stepFile: stepFiles[0], originalArgv: [...argv]};
}

export function decideSolidDispatch(invocation, solidCount) {
  if (invocation.kind !== 'inspect') return invocation;
  if (!Number.isSafeInteger(solidCount) || solidCount < 1) return {kind: 'error', reason: 'invalid-solid-count', solidCount};
  if (solidCount === 1) return {kind: 'delegate', reason: 'single-solid', originalArgv: invocation.originalArgv};
  return {kind: 'prepare-multisolid', stepFile: invocation.stepFile, solidCount, originalArgv: invocation.originalArgv};
}
