import path from 'node:path';
import fs from 'node:fs';
import {fileURLToPath} from 'node:url';
export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const REPO = path.dirname(ROOT);
export const RUNTIME = path.resolve(process.env.CAD_CODE_RUNTIME || path.join(ROOT, '.runtime'));
export const WORKSPACE = path.resolve(process.env.CAD_CODE_WORKSPACE || path.join(ROOT, 'workspace'));
export const PYTHON = process.env.CAD_CODE_PYTHON || path.join(RUNTIME, 'python/bin/python');
export const SKILL = process.env.CAD_CODE_SKILL || path.join(ROOT, 'skills/simplecadapi');
export function sessionDir(id) {
  if (!/^ses_[A-Za-z0-9_-]+$/.test(id)) throw Error('Invalid session ID');
  return path.join(WORKSPACE, id);
}
export function inside(root, relative) {
  const absolute = path.resolve(root, relative);
  if (absolute !== root && !absolute.startsWith(root + path.sep)) throw Error('Path outside workspace');
  let parent = absolute;
  while (!fs.existsSync(parent)) parent = path.dirname(parent);
  const resolved = fs.realpathSync(parent);
  if (resolved !== root && !resolved.startsWith(root + path.sep)) throw Error('Symlink outside workspace');
  return absolute;
}
