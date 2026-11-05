// Preserve emitted tool media before OpenCode's attachment resizing/role conversion.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {RUNTIME} from './paths.mjs';
export const mediaHash=value=>crypto.createHash('sha256').update(value).digest('hex');
export const mediaReceipt=(callID,content)=>`[CAD_TOOL_MEDIA_V1 call=${callID} sha256=${mediaHash(JSON.stringify(content))}]`;
const store=()=>path.join(RUNTIME,'tool-media');
const directory=callID=>path.join(store(),mediaHash(callID));
const file=(callID,sessionID)=>path.join(directory(callID),mediaHash(sessionID)+'.json');
function validate(content){
  if(!Array.isArray(content))throw Error('Invalid ordered tool content');
  for(const p of content){
    if(p.type==='input_text'&&typeof p.text==='string')continue;
    if(p.type==='input_image'&&/^data:image\/(png|jpeg);base64,[A-Za-z0-9+/]+={0,2}$/.test(p.image_url||'')){
      if(p.detail!==undefined&&!['auto','low','high','original'].includes(p.detail))throw Error('Invalid image detail');
      continue;
    }
    throw Error('Unsupported ordered tool content part');
  }
}
export function saveToolMedia(callID,{sessionID,content,code,output,failed=false}){
  if(typeof callID!=='string'||!callID||!/^ses_[\w-]+$/.test(sessionID||''))throw Error('Tool media requires exact session/call IDs');
  if(typeof code!=='string'||typeof output!=='string')throw Error('Tool media requires exact code/output');
  validate(content);
  const codeHash=mediaHash(code),outputHash=mediaHash(output),contentHash=mediaHash(JSON.stringify(content));
  const record={version:1,sessionID,callID,tool:'exec',codeHash,outputHash,contentHash,failed,content};
  const p=file(callID,sessionID);
  if(fs.existsSync(p)){
    const old=JSON.parse(fs.readFileSync(p));
    if(old.codeHash!==codeHash||old.outputHash!==outputHash||old.contentHash!==contentHash||old.failed!==failed)throw Error('ToolMediaConflict: existing call result cannot be overwritten');
    return old;
  }
  fs.mkdirSync(path.dirname(p),{recursive:true,mode:0o700});
  const temp=p+'.'+crypto.randomUUID()+'.tmp';fs.writeFileSync(temp,JSON.stringify(record),{mode:0o600});
  try{fs.linkSync(temp,p);}catch(e){if(e.code!=='EEXIST')throw e;const old=JSON.parse(fs.readFileSync(p));if(old.codeHash!==codeHash||old.outputHash!==outputHash||old.contentHash!==contentHash)throw Error('ToolMediaConflict: concurrent result differs');}finally{fs.unlinkSync(temp);}
  return record;
}
export function loadToolMedia(callID,{sessionID}={}){
  if(typeof callID!=='string'||!callID)return null;
  let p;
  if(sessionID)p=file(callID,sessionID);
  else{
    const d=directory(callID);if(!fs.existsSync(d))return null;
    const matches=fs.readdirSync(d).filter(x=>x.endsWith('.json'));
    if(matches.length>1)throw Error('ToolMediaAmbiguous: session ID required for repeated call ID');
    if(!matches.length)return null;p=path.join(d,matches[0]);
  }
  if(!fs.existsSync(p))return null;
  const record=JSON.parse(fs.readFileSync(p));validate(record.content);
  if(record.callID!==callID||(sessionID&&record.sessionID!==sessionID)||record.contentHash!==mediaHash(JSON.stringify(record.content)))throw Error('ToolMediaIntegrityError');
  return record;
}
function imageParts(content){return content.filter(x=>x.type==='input_image');}
function dimensions(bytes){
  if(bytes.length>=24&&bytes.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10])))return {width:bytes.readUInt32BE(16),height:bytes.readUInt32BE(20)};
  if(bytes[0]===255&&bytes[1]===216){for(let i=2;i+8<bytes.length;){if(bytes[i++]!==255)continue;let marker=bytes[i++];while(marker===255)marker=bytes[i++];if(marker===217||marker===218)break;const size=bytes.readUInt16BE(i);if(size<2||i+size>bytes.length)break;if([192,193,194,195,197,198,199,201,202,203,205,206,207].includes(marker))return {width:bytes.readUInt16BE(i+5),height:bytes.readUInt16BE(i+3)};i+=size;}}
  return {};
}
function toolContent(content){return content.map(p=>p.type==='input_text'?{type:'text',text:p.text}:{type:'image_url',image_url:{url:p.image_url,...(p.detail?{detail:p.detail==='original'?'high':p.detail}:{})}});}
function hasReceipt(content){return (typeof content==='string'?[content]:Array.isArray(content)?content.filter(p=>['text','input_text'].includes(p.type)).map(p=>p.text):[]).some(t=>typeof t==='string'&&t.includes('[CAD_TOOL_MEDIA_V1 '));}
export function restoreToolMedia(messages,{load=loadToolMedia,sessionID}={}){
  if(!Array.isArray(messages))return {messages,audit:[]};
  const out=messages.slice(),audit=[],calls=new Map(),seen=new Set();
  for(let i=0;i<messages.length;i++){
    const m=messages[i];
    if(m.role==='assistant')for(const call of m.tool_calls||[]){
      if(calls.has(call.id))calls.set(call.id,null);else calls.set(call.id,call);
    }
    if(m.role!=='tool'||!m.tool_call_id)continue;
    const record=load(m.tool_call_id,{sessionID});
    if(!record){if(hasReceipt(m.content))throw Error('ToolMediaAlignmentError: recorded image content is missing');continue;}
    if(!imageParts(record.content).length)continue;
    if(!/^ses_[\w-]+$/.test(sessionID||''))throw Error('ToolMediaAlignmentError: exact session ID required');
    if(seen.has(m.tool_call_id))throw Error('ToolMediaAmbiguous: duplicate tool result');seen.add(m.tool_call_id);
    const call=calls.get(m.tool_call_id);
    if(!call||call.function?.name!=='exec')throw Error('ToolMediaAlignmentError: matching exec call missing');
    let args;try{args=typeof call.function.arguments==='string'?JSON.parse(call.function.arguments):call.function.arguments;}catch{throw Error('ToolMediaAlignmentError: invalid tool arguments');}
    if(record.sessionID&&sessionID&&record.sessionID!==sessionID)throw Error('ToolMediaAlignmentError: session mismatch');
    if(record.codeHash&&mediaHash(args?.code||'')!==record.codeHash)throw Error('ToolMediaAlignmentError: code hash mismatch');
    const restored=toolContent(record.content);
    const already=Array.isArray(m.content)&&JSON.stringify(m.content)===JSON.stringify(restored);
    if(!already&&record.outputHash&&mediaHash(typeof m.content==='string'?m.content:JSON.stringify(m.content))!==record.outputHash)throw Error('ToolMediaAlignmentError: output hash mismatch');
    // This channel never creates synthetic user images. Refuse legacy attachment
    // conversion instead of guessing which user images are safe to remove.
    for(let j=i+1;j<messages.length&&messages[j].role!=='assistant';j++){
      const next=messages[j];
      if(next.role==='user'&&Array.isArray(next.content)&&next.content.some(p=>p.type==='text'&&p.text==='Attached media from tool result:'))throw Error('ToolMediaAlignmentAmbiguous: legacy attachment message must not be guessed or deleted');
    }
    out[i]={...m,content:restored};
    audit.push({callID:m.tool_call_id,sessionID:record.sessionID,messageIndex:i,mode:'tool_multimodal_original',alreadyAligned:already,contentHash:record.contentHash,partTypes:record.content.map(p=>p.type),images:imageParts(record.content).map(p=>{const bytes=Buffer.from(p.image_url.split(',')[1],'base64');return {sha256:mediaHash(bytes),bytes:bytes.length,...dimensions(bytes),requestedDetail:p.detail||null,forwardedDetail:p.detail==='original'?'high':p.detail||null};})});
  }
  return {messages:audit.length?out:messages,audit};
}
export function restoreResponsesToolMedia(input,options={}){
  if(!Array.isArray(input))return {input,audit:[]};
  // Share the exact call/code/output binding checks with Chat Completions,
  // while emitting native Responses function_call_output content blocks.
  const chatOutput=parts=>Array.isArray(parts)?parts.map(p=>p.type==='input_text'?{type:'text',text:p.text}:p.type==='input_image'?{type:'image_url',image_url:{url:p.image_url,...(p.detail?{detail:p.detail}:{})}}:p):parts;
  const corresponding=input.map(item=>item.type==='function_call'?{role:'assistant',tool_calls:[{id:item.call_id,function:{name:item.name,arguments:item.arguments}}]}:item.type==='function_call_output'?{role:'tool',tool_call_id:item.call_id,content:chatOutput(item.output)}:{role:item.role||'other',content:item.content});
  const checked=restoreToolMedia(corresponding,options);if(!checked.audit.length)return {input,audit:[]};
  const indexes=new Set(checked.audit.map(x=>x.messageIndex));
  return {input:input.map((item,i)=>indexes.has(i)?{...item,output:checked.messages[i].content.map(p=>p.type==='text'?{type:'input_text',text:p.text}:{type:'input_image',image_url:p.image_url.url,...(p.image_url.detail?{detail:p.image_url.detail}:{})})}:item),audit:checked.audit.map(x=>({...x,mode:'responses_function_call_output_original'}))};
}

// vLLM's Qwen3.5 Responses frontend requires image detail explicitly. This
// provider-specific adapter adds metadata only; it preserves the original URL
// and bytes and records every location changed for request auditing.
export function defaultResponsesImageDetail(input,{detail='high'}={}){
  if(!Array.isArray(input))return {input,audit:[]};
  const audit=[];
  function visit(value,location){
    if(Array.isArray(value)){
      let changed=false;const items=value.map((item,index)=>{const result=visit(item,`${location}[${index}]`);changed||=result.value!==item;return result.value;});
      return {value:changed?items:value,changed};
    }
    if(!value||typeof value!=='object')return {value,changed:false};
    if(value.type==='input_image'&&typeof value.image_url==='string'&&value.detail==null){
      audit.push({location,detail,sha256:mediaHash(Buffer.from(value.image_url.split(',')[1]||'','base64'))});
      return {value:{...value,detail},changed:true};
    }
    let changed=false;const result={...value};
    for(const [key,item] of Object.entries(value)){
      if(!Array.isArray(item)&&(!item||typeof item!=='object'))continue;
      const child=visit(item,`${location}.${key}`);if(child.value!==item){result[key]=child.value;changed=true;}
    }
    return {value:changed?result:value,changed};
  }
  const normalized=visit(input,'input');
  return {input:normalized.value,audit};
}

// OpenCode replays assistant text as Responses output_text parts when it sends
// the full transcript again. vLLM's Qwen Responses schema accepts input_text in
// prior messages, so normalize only historical assistant message content.
export function normalizeQwenResponsesHistory(input){
  if(!Array.isArray(input))return {input,audit:[]};
  const audit=[];let changed=false;
  const output=input.map((item,inputIndex)=>{
    if(item?.role!=='assistant'||!Array.isArray(item.content))return item;
    let itemChanged=false;
    const content=item.content.map((part,contentIndex)=>{
      if(part?.type!=='output_text')return part;
      itemChanged=changed=true;
      audit.push({input_index:inputIndex,content_index:contentIndex,from:'output_text',to:'input_text',text_sha256:mediaHash(part.text||'')});
      return {type:'input_text',text:part.text||''};
    });
    return itemChanged?{...item,content}:item;
  });
  return {input:changed?output:input,audit};
}
