// Recover only empty persisted reasoning parts from uniquely matched original
// upstream SSE. No generation, inference or changes to nonempty parts.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {RUNTIME,sessionDir} from '../src/paths.mjs';
const sessionID=process.argv[2];sessionDir(sessionID);
const c=JSON.parse(fs.readFileSync(path.join(RUNTIME,'cli-connection.json')));
const authorization='Basic '+Buffer.from('opencode:'+c.password).toString('base64');
const response=await fetch(c.url+'/session/'+sessionID+'/message',{headers:{authorization}});
if(!response.ok)throw Error('Cannot read conversation: '+response.status);
const messages=await response.json();const parts=messages.flatMap(m=>m.parts||[]).filter(p=>p.type==='reasoning'&&!p.text);
const records=path.join(RUNTIME,'model-requests'),recovered=[];
const sha=value=>crypto.createHash('sha256').update(value).digest('hex');
for(const part of parts){
  const itemID=part.metadata?.openai?.itemId;if(!itemID)continue;
  const metadata=part.metadata.openai;
  const indexes=[metadata.summaryIndex,metadata.contentIndex].filter(x=>x!==undefined);
  if(!indexes.length||indexes.some(x=>!Number.isSafeInteger(x)||x<0)||new Set(indexes).size!==1)continue;
  const contentIndex=indexes[0];
  const found=[];
  for(const entry of fs.readdirSync(records)){
    const root=path.join(records,entry),request=path.join(root,'forwarded-request.json'),stream=path.join(root,'response.sse');
    if(!fs.existsSync(request)||!fs.existsSync(stream))continue;
    let meta;try{meta=JSON.parse(fs.readFileSync(request));}catch{continue;}
    if(meta.sessionID!==sessionID)continue;
    const bytes=fs.readFileSync(stream);
    for(const line of bytes.toString('utf8').split('\n')){
      if(!line.startsWith('data:'))continue;
      let event;try{event=JSON.parse(line.slice(5));}catch{continue;}
      if(event.type==='response.reasoning_text.done'&&event.item_id===itemID&&event.content_index===contentIndex){
        found.push({text:event.text,stream,bytes});
      }
    }
  }
  if(found.length!==1||typeof found[0].text!=='string'||!found[0].text)continue;
  const source=found[0],proof={sessionID,messageID:part.messageID,partID:part.id,itemID,contentIndex,
    source:source.stream,source_sha256:sha(source.bytes),recovered_chars:source.text.length,text_sha256:sha(source.text)};
  const archive=path.join(RUNTIME,'reasoning-recovery',Date.now()+'-'+crypto.randomUUID());fs.mkdirSync(archive,{recursive:true,mode:0o700});
  fs.writeFileSync(path.join(archive,'before.json'),JSON.stringify(part,null,2),{mode:0o600});
  const fixed={...part,text:source.text,metadata:{...part.metadata,cadCodeReasoningRecovery:proof}};
  const update=await fetch(c.url+'/session/'+sessionID+'/message/'+part.messageID+'/part/'+part.id,{method:'PATCH',headers:{authorization,'content-type':'application/json'},body:JSON.stringify(fixed)});
  if(!update.ok)throw Error('Recovery failed: '+update.status);
  fs.writeFileSync(path.join(archive,'proof.json'),JSON.stringify(proof,null,2),{mode:0o600});recovered.push(proof);
}
console.log(JSON.stringify({sessionID,recovered_parts:recovered.length,recovered_chars:recovered.map(x=>x.recovered_chars),generated:false}));
