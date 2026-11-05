import fs from 'node:fs';
import path from 'node:path';
import {RUNTIME,sessionDir} from './paths.mjs';

export function sessionRevision(id,runtime=RUNTIME){sessionDir(id);const file=path.join(runtime,'session-generations',id);return fs.existsSync(file)?Number(fs.readFileSync(file,'utf8')):0;}
export function assertSessionAvailable(id,{runtime=RUNTIME,revision}={}){
  sessionDir(id);
  const tombstone=path.join(runtime,'deleted-sessions.json');
  if(fs.existsSync(tombstone)&&JSON.parse(fs.readFileSync(tombstone,'utf8')).includes(id))throw Object.assign(Error('Conversation was deleted'),{code:'SessionDeleted'});
  if(fs.existsSync(path.join(runtime,'session-maintenance',id))||(revision!==undefined&&sessionRevision(id,runtime)!==revision))throw Object.assign(Error('Session data is being changed'),{code:'SessionMaintenance'});
}
