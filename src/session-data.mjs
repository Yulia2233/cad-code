import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {RUNTIME,WORKSPACE} from './paths.mjs';

const valid=id=>typeof id==='string'&&/^ses_[A-Za-z0-9_-]+$/.test(id);
const check=id=>{if(!valid(id))throw Error('Invalid session ID');return id;};
const stat=p=>{try{return fs.lstatSync(p);}catch(e){if(e.code==='ENOENT')return null;throw e;}};
const hidden=['.cad-events.jsonl','.conversation.json'];
function safe(root,...parts){
  let current=path.resolve(root);
  for(const part of ['',...parts]){
    current=path.join(current,part);const s=stat(current);
    if(s?.isSymbolicLink())throw Error('Session data path must not be a symlink: '+current);
  }
  return current;
}
function roots(options={}){return {runtime:options.runtime||RUNTIME,workspace:options.workspace||WORKSPACE};}
function measure(dir){
  let files=0,bytes=0;
  for(const entry of fs.readdirSync(dir,{withFileTypes:true})){
    const p=path.join(dir,entry.name),s=fs.lstatSync(p);
    if(s.isSymbolicLink())continue;
    if(s.isDirectory()){const n=measure(p);files+=n.files;bytes+=n.bytes;}
    else if(s.isFile()){files++;bytes+=s.size;}
  }
  return {files,bytes};
}

export function workspaceInventory(sessions=[],options={}){
  const {workspace}=roots(options),root=safe(workspace),items=new Map();
  for(const session of sessions){if(valid(session.id))items.set(session.id,{id:session.id,title:session.title||session.id,parentID:session.parentID||null,hasConversation:true});}
  if(stat(root))for(const entry of fs.readdirSync(root,{withFileTypes:true})){
    if(valid(entry.name)&&entry.isDirectory())if(!items.has(entry.name))items.set(entry.name,{id:entry.name,title:entry.name,parentID:null,hasConversation:false});
  }
  return [...items.values()].map(item=>{const dir=safe(root,item.id),s=stat(dir),hasWorkspace=Boolean(s?.isDirectory());return {...item,hasWorkspace,...(hasWorkspace?measure(dir):{files:0,bytes:0})};}).sort((a,b)=>a.id.localeCompare(b.id));
}

export function clearWorkspace(id,options={}){
  check(id);const {runtime,workspace}=roots(options),dir=safe(workspace,id),s=stat(dir);
  if(!s)return {id,cleared:false,archive:null};
  if(!s.isDirectory())throw Error('Session workspace must be a directory');
  const sources=hidden.map(name=>safe(dir,name)).filter(p=>stat(p));
  for(const p of sources)if(!stat(p).isFile())throw Error('Trajectory must be a regular file');
  let archive=null;
  if(sources.length){
    const parent=safe(runtime,'trajectory-archives',id);fs.mkdirSync(parent,{recursive:true,mode:0o700});
    archive=path.join(parent,Date.now()+'-'+crypto.randomUUID());fs.mkdirSync(archive,{mode:0o700});
    for(const source of sources)fs.copyFileSync(source,path.join(archive,path.basename(source)),fs.constants.COPYFILE_EXCL);
  }
  fs.rmSync(dir,{recursive:true});return {id,cleared:true,archive};
}

// Match ownership fields, never incidental session IDs in text or parentID.
export function belongsToSessions(value,ids){
  const selected=ids instanceof Set?ids:new Set(ids);
  if(!value||typeof value!=='object')return false;
  if(selected.has(value.sessionID)||selected.has(value.sessionId))return true;
  const event=value.event||value;
  const props=event.properties;
  if(!props||typeof props!=='object')return false;
  if(selected.has(props.sessionID)||selected.has(props.sessionId)||selected.has(props.info?.sessionID)||selected.has(props.part?.sessionID))return true;
  return typeof event.type==='string'&&event.type.startsWith('session.')&&selected.has(props.info?.id);
}

export function deleteTrajectoryFiles(ids,options={}){
  ids=[...new Set(ids)];ids.forEach(check);
  const selected=new Set(ids),{runtime,workspace}=roots(options),deleted=[],unknown=[];
  safe(runtime);safe(workspace);
  const retain=(p,reason)=>unknown.push({path:p,reason});
  const remove=(root,...parts)=>{
    try{const p=safe(root,...parts);if(stat(p)){fs.rmSync(p,{recursive:true});deleted.push(p);}}
    catch(e){retain(path.join(root,...parts),e.message);}
  };
  for(const id of ids){
    for(const name of hidden){
      try{const p=safe(workspace,id,name),s=stat(p);if(s&&!s.isFile())retain(p,'Trajectory must be a regular file');else remove(workspace,id,name);}
      catch(e){retain(path.join(workspace,id,name),e.message);}
    }
    for(const area of ['prompt-snapshots','trajectory-archives','cancel'])remove(runtime,area,id);
  }
  function directories(area,visit){
    let root;try{root=safe(runtime,area);}catch(e){retain(path.join(runtime,area),e.message);return;}
    if(!stat(root))return;
    for(const entry of fs.readdirSync(root,{withFileTypes:true})){
      const p=path.join(root,entry.name);
      if(!entry.isDirectory()){retain(p,'Unknown non-directory record');continue;}
      visit(p);
    }
  }
  const hashes=new Set(ids.map(id=>crypto.createHash('sha256').update(id).digest('hex')+'.json'));
  directories('tool-media',dir=>{
    for(const name of fs.readdirSync(dir)){
      if(hashes.has(name)){remove(dir,name);continue;}
      const p=path.join(dir,name);
      try{
        safe(dir,name);
        const record=JSON.parse(fs.readFileSync(p,'utf8'));
        if(!valid(record.sessionID)||crypto.createHash('sha256').update(record.sessionID).digest('hex')+'.json'!==name)retain(p,'Unknown media ownership');
      }catch{retain(p,'Unknown or damaged media record');}
    }
  });
  directories('model-requests',dir=>{
    const owners=[];let damaged=false;
    for(const name of ['request.json','forwarded-request.json']){
      const p=path.join(dir,name);if(!stat(p))continue;
      try{safe(dir,name);const value=JSON.parse(fs.readFileSync(p,'utf8'));if(!valid(value.sessionID))damaged=true;else owners.push(value.sessionID);}
      catch{damaged=true;}
    }
    if(damaged||!owners.length||new Set(owners).size!==1){retain(dir,'Unknown, damaged or conflicting request ownership');return;}
    if(selected.has(owners[0]))remove(path.dirname(dir),path.basename(dir));
  });
  const events=path.join(runtime,'events.jsonl');
  if(stat(events)){
    try{
      safe(runtime,'events.jsonl');const source=fs.readFileSync(events,'utf8');
      const lines=source.match(/[^\n]*\n|[^\n]+$/g)||[];let count=0;
      const kept=lines.filter((line,index)=>{try{
        const value=JSON.parse(line);
        if(belongsToSessions(value,selected)){count++;return false;}
        const event=value?.event||value,props=event?.properties;
        if(![value?.sessionID,value?.sessionId,props?.sessionID,props?.sessionId,props?.info?.sessionID,props?.part?.sessionID,...(event?.type?.startsWith('session.')?[props?.info?.id]:[])].some(valid))retain(events+':'+(index+1),'Unknown event ownership retained');
      }catch{retain(events+':'+(index+1),'Invalid event JSON retained');}return true;});
      if(count){const temp=events+'.'+crypto.randomUUID()+'.tmp';try{fs.writeFileSync(temp,kept.join(''),{flag:'wx',mode:stat(events).mode&0o777});fs.renameSync(temp,events);}finally{if(stat(temp))fs.unlinkSync(temp);}deleted.push(events+' ('+count+' events)');}
    }catch(e){retain(events,e.message);}
  }
  return {ids,deleted,unknown};
}
