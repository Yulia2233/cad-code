import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import {RUNTIME} from '../src/paths.mjs';

const directory = path.join(RUNTIME, 'multi');
const registryFile = path.join(directory, 'projects.json');

function ensureRegistryDirectory() {
  fs.mkdirSync(directory, {recursive: true, mode: 0o700});
  const stat = fs.lstatSync(directory);
  if (stat.isSymbolicLink() || !stat.isDirectory()) throw Error('ProjectRegistryError: registry directory must not be a symlink');
}

function read() {
  ensureRegistryDirectory();
  if (!fs.existsSync(registryFile)) return {schema_version: 'cad-code-project-registry-v1', projects: []};
  const stat = fs.lstatSync(registryFile);
  if (stat.isSymbolicLink() || !stat.isFile()) throw Error('ProjectRegistryError: registry must be a regular file');
  const data = JSON.parse(fs.readFileSync(registryFile, 'utf8'));
  if (data.schema_version !== 'cad-code-project-registry-v1' || !Array.isArray(data.projects)) throw Error('ProjectRegistryError: invalid registry');
  return data;
}

function write(data) {
  const temporary = `${registryFile}.${process.pid}.${crypto.randomBytes(6).toString('hex')}.tmp`;
  fs.writeFileSync(temporary, JSON.stringify(data, null, 2) + '\n', {flag: 'wx', mode: 0o600});
  fs.renameSync(temporary, registryFile);
}

export function registerProject(projectDir, {name} = {}) {
  const absolute = fs.realpathSync(projectDir);
  const project = JSON.parse(fs.readFileSync(path.join(absolute, 'project.json'), 'utf8'));
  if (project.schema_version !== 'cad-code-project-v1' || !/^[A-Za-z0-9][A-Za-z0-9_-]{7,63}$/.test(project.project_id || '')) throw Error('ProjectRegistryError: invalid project manifest');
  const data = read();
  const row = {
    id: project.project_id,
    path: absolute,
    name: name || project.source?.filename || path.basename(absolute),
    created_at: project.created_at,
  };
  const existing = data.projects.find(item => item.id === row.id);
  if (existing && existing.path !== absolute) throw Error('ProjectRegistryError: project ID is already registered at another path');
  if (existing) Object.assign(existing, row);
  else data.projects.push(row);
  write(data);
  return row;
}

export function listRegisteredProjects() {
  return read().projects;
}

export function resolveRegisteredProject(projectID) {
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]{7,63}$/.test(projectID || '')) throw Error('ProjectRegistryError: invalid project ID');
  const item = read().projects.find(project => project.id === projectID);
  if (!item) throw Object.assign(Error('Project not found'), {status: 404});
  const absolute = path.resolve(item.path);
  const stat = fs.lstatSync(absolute);
  if (stat.isSymbolicLink() || !stat.isDirectory() || fs.realpathSync(absolute) !== absolute) throw Error('ProjectRegistryError: project path is not a regular directory');
  return {...item, path: absolute};
}
