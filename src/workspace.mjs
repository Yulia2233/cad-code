import fs from 'node:fs';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {ROOT,WORKSPACE,sessionDir} from './paths.mjs';
import {assertSessionAvailable} from './session-guard.mjs';

// Fixed bundle, shipped with cad-code; no dependency on the parent research repo.
const TOOL_FILES=['stepir.py','cadeval.py','families_common.py','cadthreads.py','robust_iou.py','frozen/compare.py','cad.py'];
function directory(p){
  try{fs.mkdirSync(p);}catch(e){if(e.code!=='EEXIST')throw e;}
  const stat=fs.lstatSync(p);
  if(stat.isSymbolicLink()||!stat.isDirectory())throw Error('Workspace directory must not be a symlink or non-directory: '+p);
}
export function prepareSessionWorkspace(sessionID){
  assertSessionAvailable(sessionID);
  const work=sessionDir(sessionID);
  fs.mkdirSync(path.dirname(WORKSPACE),{recursive:true});
  directory(WORKSPACE);directory(work);
  const tools=path.join(work,'tools');directory(tools);directory(path.join(tools,'frozen'));
  for(const name of TOOL_FILES){
    const target=path.join(tools,name);
    try{fs.copyFileSync(path.join(ROOT,'tools',name),target,fs.constants.COPYFILE_EXCL);}
    catch(e){
      if(e.code!=='EEXIST')throw e;
      // Session copies are editable. Resume fills missing files without replacing
      // an existing file, and never follows a tool-file symlink.
      const stat=fs.lstatSync(target);
      if(stat.isSymbolicLink()||!stat.isFile())throw Error('Workspace tool must be a regular file: '+target);
    }
  }
  if(!fs.existsSync(path.join(work,'.git'))){
    const git=spawnSync('git',['init','--quiet'],{cwd:work});
    if(git.status!==0)throw Error('Could not initialize session Git workspace');
    if(!fs.existsSync(path.join(work,'.gitignore')))fs.writeFileSync(path.join(work,'.gitignore'),'.tmp/\n.home/\n.cad-events.jsonl\n.conversation.json\n__marimo__/\n__pycache__/\nout/\n');
  }
  return work;
}
