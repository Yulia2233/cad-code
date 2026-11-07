import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {RUNTIME} from './paths.mjs';

export function validateProvider(value,{previous=null}={}){
  if(!value||typeof value!=='object'||Array.isArray(value))throw Error('API configuration must be an object');
  const base=value.base_url??value.baseURL??previous?.baseURL;
  const supplied=value.api_key??value.apiKey;
  const key=supplied===undefined||supplied===''?previous?.apiKey:supplied;
  const model=value.model??value.model_id??previous?.model??'qwen-v8';
  const thinking=value.thinking??previous?.thinking??true;
  if(typeof base!=='string'||!base.trim())throw Error('Base URL is required');
  let url;try{url=new URL(base.trim());}catch{throw Error('Base URL must be an absolute HTTP(S) URL');}
  if(!['http:','https:'].includes(url.protocol)||!url.hostname||url.username||url.password||url.search||url.hash)throw Error('Base URL must use HTTP(S), without credentials, query or fragment');
  if(typeof key!=='string'||!key.trim()||key.length>8192||/[\s\x00-\x1f\x7f]/.test(key))throw Error('A nonempty API key without whitespace is required');
  if(typeof model!=='string'||!model.trim()||model.trim().length>256||/[\s\x00-\x1f\x7f]/.test(model.trim()))throw Error('Model ID is required and must not contain whitespace');
  if(typeof thinking!=='boolean')throw Error('Thinking must be true or false');
  if(!thinking&&/^gpt-6(?:\.|-|$)/i.test(model.trim()))throw Error('This GPT-6 model does not support disabling reasoning; choose a supported model or enable thinking.');
  return {baseURL:url.toString().replace(/\/+$/,''),apiKey:key,model:model.trim(),thinking};
}

export function loadProviderFile(file){
  let text=fs.readFileSync(file,'utf8').trim().replace(/,$/,'');
  let value;try{value=JSON.parse(text);}catch{try{value=JSON.parse('{'+text+'}');}catch{throw Error('Invalid API configuration JSON');}}
  value=value.ccvibe||value;return validateProvider(value.settings||value.options||value);
}

export function providerSummary(provider){return {base_url:provider?.baseURL||'',model:provider?.model||'qwen-v8',thinking:provider?.thinking??true,api_key_configured:Boolean(provider?.apiKey),configured:Boolean(provider?.baseURL&&provider?.apiKey)};}

export function selectedModel(fallback='qwen-v8',runtime=RUNTIME){
  const file=path.join(runtime,'active-model.json');
  if(!fs.existsSync(file))return fallback;
  const value=JSON.parse(fs.readFileSync(file,'utf8'));return value.model;
}
export function qwenModel(model){return /qwen/i.test(model);}
export function selectedThinking(runtime=RUNTIME){const file=path.join(runtime,'active-model.json');return fs.existsSync(file)?JSON.parse(fs.readFileSync(file,'utf8')).thinking!==false:true;}

export async function listProviderModels(provider){
  provider=validateProvider(provider);
  let response;try{response=await fetch(provider.baseURL+'/models',{headers:{authorization:'Bearer '+provider.apiKey},signal:AbortSignal.timeout(8000)});}
  catch{throw Error('无法连接模型列表接口；可直接填写模型 ID。');}
  if(!response.ok){await response.body?.cancel();throw Error('无法获取模型列表（HTTP '+response.status+'）；可直接填写模型 ID。');}
  const type=response.headers.get('content-type')||'';
  if(!type.includes('json')){await response.body?.cancel();throw Error('模型列表接口没有返回 JSON；可直接填写模型 ID。');}
  let size=0,chunks=[];for await(const chunk of response.body){size+=chunk.length;if(size>1024*1024)throw Error('模型列表过大；可直接填写模型 ID。');chunks.push(chunk);}
  let data;try{data=JSON.parse(Buffer.concat(chunks).toString('utf8'));}catch{throw Error('模型列表不是有效 JSON；可直接填写模型 ID。');}
  const entries=Array.isArray(data)?data:data.data||data.models;
  if(!Array.isArray(entries))throw Error('模型列表格式不支持；可直接填写模型 ID。');
  return [...new Set(entries.map(x=>typeof x==='string'?x:x?.id).filter(x=>typeof x==='string'&&x.length<=256&&x.length>0&&!/[\s\x00-\x1f\x7f]/.test(x)))].slice(0,1000).sort();
}

export function savedProviderFile(runtime=RUNTIME){
  const pointer=path.join(runtime,'connection.json');
  if(fs.existsSync(pointer))return JSON.parse(fs.readFileSync(pointer,'utf8')).credentialFile;
  const managed=path.join(runtime,'provider.json');return fs.existsSync(managed)?managed:null;
}

function regularOrMissing(file){
  try{const stat=fs.lstatSync(file);if(stat.isSymbolicLink()||!stat.isFile())throw Error('API configuration path must be a regular file');}
  catch(e){if(e.code!=='ENOENT')throw e;}
}
export function saveProvider(provider,{runtime=RUNTIME}={}){
  provider=validateProvider(provider);
  fs.mkdirSync(runtime,{recursive:true,mode:0o700});
  if(fs.lstatSync(runtime).isSymbolicLink())throw Error('Runtime directory must not be a symlink');
  const file=path.join(runtime,'provider.json'),pointer=path.join(runtime,'connection.json');
  regularOrMissing(file);regularOrMissing(pointer);
  const temporary=file+'.'+crypto.randomBytes(8).toString('hex')+'.tmp';
  try{fs.writeFileSync(temporary,JSON.stringify(provider)+'\n',{mode:0o600,flag:'wx'});fs.renameSync(temporary,file);}
  finally{if(fs.existsSync(temporary))fs.unlinkSync(temporary);}
  const next=pointer+'.'+crypto.randomBytes(8).toString('hex')+'.tmp';
  try{fs.writeFileSync(next,JSON.stringify({credentialFile:file})+'\n',{mode:0o600,flag:'wx'});fs.renameSync(next,pointer);}
  finally{if(fs.existsSync(next))fs.unlinkSync(next);}
  return file;
}
