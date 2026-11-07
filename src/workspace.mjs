import fs from 'node:fs';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {WORKSPACE,sessionDir} from './paths.mjs';
import {assertSessionAvailable} from './session-guard.mjs';

// Sessions get no tool copies: the CAD scripts live in the skill (SKILL/scripts: stepir.py, stepeval.py) and are run
// from there, read-only, by absolute path.
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
  if(!fs.existsSync(path.join(work,'.git'))){
    const git=spawnSync('git',['init','--quiet'],{cwd:work});
    if(git.status!==0)throw Error('Could not initialize session Git workspace');
    if(!fs.existsSync(path.join(work,'.gitignore')))fs.writeFileSync(path.join(work,'.gitignore'),'.tmp/\n.home/\n.cad-events.jsonl\n.conversation.json\n__marimo__/\n__pycache__/\nout/\n');
  }
  return work;
}
