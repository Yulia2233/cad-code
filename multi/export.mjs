import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import {readProject} from './store.mjs';

const sha = data => crypto.createHash('sha256').update(data).digest('hex');
function regular(root,relative) {
  if(typeof relative!=='string'||!relative||path.isAbsolute(relative)) throw Error('Export path must be project-relative');
  const absolute=path.resolve(root,relative);
  if(!absolute.startsWith(root+path.sep))throw Error('Export path escapes project');
  if(fs.realpathSync(absolute)!==absolute||!fs.lstatSync(absolute).isFile())throw Error('Export rejects symlinks and non-files');
  return absolute;
}
function walkCode(root,relative,files) {
  const directory=path.join(root,relative);
  if(!fs.existsSync(directory))return;
  for(const entry of fs.readdirSync(directory,{withFileTypes:true})) {
    if(entry.isSymbolicLink())throw Error('Export rejects symlinked output');
    if(entry.name.startsWith('.')||['__pycache__','__marimo__'].includes(entry.name))continue;
    const rel=path.join(relative,entry.name);
    if(entry.isDirectory())walkCode(root,rel,files);
    else if(/\.(py|step|stp|json|jsonl|png|jpg|jpeg|scadpkg)$/.test(entry.name))files.add(rel);
  }
}
export function exportProject(projectDir, output) {
  const root=fs.realpathSync(projectDir), project=readProject(root);
  if(['parts_running','assembly_running'].includes(project.state))throw Error('Stop or finish project sessions before export');
  const files=new Set(['project.json','assembly.ir.json','source/source.step','preprocess/split-manifest.json','preprocess/dedup-report.json']);
  for(const part of project.unique_parts) {
    files.add(part.target_step);files.add(part.stepir);
    for(const attempt of part.attempts)for(const rel of Object.values(attempt.deliverables||{}))if(typeof rel==='string')files.add(rel);
  }
  for(const attempt of project.assembly_attempts) {
    for(const rel of Object.values(attempt.deliverables||{}))if(typeof rel==='string')files.add(rel);
    if(attempt.attempt_dir) {
      walkCode(root,path.join(attempt.attempt_dir,'input'),files);
      walkCode(root,path.join(attempt.attempt_dir,'out'),files);
      walkCode(root,path.join(attempt.attempt_dir,'evaluation'),files);
    }
  }
  const target=path.resolve(output);
  if(target===root||target.startsWith(root+path.sep))throw Error('Export must be outside the live project');
  if(fs.existsSync(target))throw Error('Export destination already exists');
  const records=[...files].sort().map(relative=>{
    const file=regular(root,relative);
    if(/(?:^|\/)(?:runtime|\.runtime|\.git)(?:\/|$)/.test(relative)||/(?:connection|provider|opencode)\.json$/.test(relative))throw Error('Runtime state cannot enter project export');
    return {path:relative,file,sha256:sha(fs.readFileSync(file))};
  });
  fs.mkdirSync(path.dirname(target),{recursive:true});
  const temp=target+'.tmp-'+crypto.randomUUID();fs.mkdirSync(temp,{mode:0o700});
  try {
    for(const row of records){const dest=path.join(temp,row.path);fs.mkdirSync(path.dirname(dest),{recursive:true});fs.copyFileSync(row.file,dest);if(sha(fs.readFileSync(dest))!==row.sha256)throw Error('Export content changed during copy');}
    const manifest={schema_version:'cad-code-project-export-v1',project_id:project.project_id,created_at:new Date().toISOString(),files:records.map(({file,...row})=>row)};
    fs.writeFileSync(path.join(temp,'export-manifest.json'),JSON.stringify(manifest,null,2)+'\n');
    fs.renameSync(temp,target);return {project_id:project.project_id,output:target,files:records.length};
  }catch(error){fs.rmSync(temp,{recursive:true,force:true});throw error;}
}
