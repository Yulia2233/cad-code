import path from 'node:path';
import fs from 'node:fs';
import {fileURLToPath} from 'node:url';
export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const REPO = path.dirname(ROOT);
export const RUNTIME = path.resolve(process.env.CAD_CODE_RUNTIME || path.join(ROOT, '.runtime'));
export const WORKSPACE = path.resolve(process.env.CAD_CODE_WORKSPACE || path.join(ROOT, 'workspace'));
export const PYTHON = process.env.CAD_CODE_PYTHON || path.join(RUNTIME, process.platform === 'win32' ? 'python/Scripts/python.exe' : 'python/bin/python');
export const SKILL = process.env.CAD_CODE_SKILL || path.join(ROOT, 'skills/simplecadapi');
export function sessionDir(id) {
  if (!/^ses_[A-Za-z0-9_-]+$/.test(id)) throw Error('Invalid session ID');
  return path.join(WORKSPACE, id);
}
export function inside(root, relative) {
  const norm = p => (process.platform === 'win32' ? p.toLowerCase() : p);
  const absRoot = path.resolve(root);
  const absolute = path.resolve(absRoot, relative);
  if (norm(absolute) !== norm(absRoot) && !norm(absolute).startsWith(norm(absRoot + path.sep))) throw Error('Path outside workspace');
  let parent = absolute;
  while (!fs.existsSync(parent)) parent = path.dirname(parent);
  const resolved = fs.realpathSync(parent);
  const resolvedRoot = fs.existsSync(absRoot) ? fs.realpathSync(absRoot) : absRoot;
  if (norm(resolved) !== norm(resolvedRoot) && !norm(resolved).startsWith(norm(resolvedRoot + path.sep))) throw Error('Symlink outside workspace');
  return absolute;
}
