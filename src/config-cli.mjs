import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline/promises';
import {RUNTIME} from './paths.mjs';
import {loadProviderFile,providerSummary,savedProviderFile,saveProvider,validateProvider,listProviderModels} from './provider-config.mjs';

export async function readHiddenKey(input=process.stdin,output=process.stdout){
  if(!input.isTTY||typeof input.setRawMode!=='function')throw Error('Interactive key input requires a terminal; use --api-key-stdin for piped input');
  output.write('API key（留空保留已保存的密钥）: ');
  const raw=input.isRaw,wasPaused=input.isPaused();input.setRawMode(true);input.resume();
  return await new Promise((resolve,reject)=>{
    let text='';
    const done=(error)=>{input.off('data',onData);input.off('end',onEnd);input.setRawMode(raw);if(wasPaused)input.pause();output.write('\n');error?reject(error):resolve(text);};
    const onEnd=()=>done(Error('API key input ended before confirmation'));
    const onData=chunk=>{for(const ch of String(chunk)){if(ch==='\u0003'){done(Error('Configuration cancelled'));return;}if(ch==='\r'||ch==='\n'){done();return;}if(ch==='\u007f'||ch==='\b'){text=Array.from(text).slice(0,-1).join('');continue;}if(ch>=' '){text+=ch;if(text.length>8192){done(Error('API key is too long'));return;}}}};
    input.on('data',onData);input.once('end',onEnd);
  });
}

export async function configureCLI(args){
  const connectionPath=path.join(RUNTIME,'cli-connection.json');let live=null;
  try{const c=JSON.parse(fs.readFileSync(connectionPath));process.kill(c.pid,0);
    const response=await fetch(c.url+'/global/health',{headers:{authorization:'Basic '+Buffer.from('opencode:'+c.password).toString('base64')},signal:AbortSignal.timeout(1500)});
    if(response.ok)live=c;
  }catch{}
  let previous=null;const file=process.env.CAD_CODE_CREDENTIALS||savedProviderFile();if(file)previous=loadProviderFile(file);
  let current=providerSummary(previous);
  if(live?.website){const r=await fetch(live.website+'/api/provider');if(!r.ok)throw Error('Restart the existing backend once to enable API configuration');current=await r.json();}
  let base,key,model,thinking,show=false,fromStdin=false,listModels=false;
  for(let i=0;i<args.length;i++){
    if(['--base-url','--base_url'].includes(args[i])){base=args[++i];if(!base||base.startsWith('--'))throw Error('--base-url requires a URL');}
    else if(args[i]==='--model'){model=args[++i];if(!model||model.startsWith('--'))throw Error('--model requires a model ID');}
    else if(args[i]==='--thinking'){const value=args[++i];if(!['on','off'].includes(value))throw Error('--thinking must be on or off');thinking=value==='on';}
    else if(args[i]==='--list-models')listModels=true;
    else if(args[i]==='--api-key-stdin')fromStdin=true;
    else if(args[i]==='--show')show=true;
    else throw Error('Use: cad-code config [--show | --base-url URL --model MODEL --api-key-stdin | --list-models]');
  }
  if(show){if(base!==undefined||model!==undefined||thinking!==undefined||fromStdin||listModels)throw Error('--show cannot change configuration');console.log(JSON.stringify({base_url:current.base_url,model:current.model,thinking:current.thinking,api_key_configured:current.api_key_configured},null,2));return;}
  if(fromStdin){let text='';for await(const chunk of process.stdin){text+=chunk;if(text.length>8194)throw Error('API key is too long');}key=text.replace(/\r?\n$/,'');}
  else if(base===undefined&&model===undefined&&thinking===undefined&&!listModels){
    if(!process.stdin.isTTY)throw Error('Use cad-code config --base-url URL --api-key-stdin, or run config in a terminal');
    const rl=readline.createInterface({input:process.stdin,output:process.stdout});
    try{base=(await rl.question('Base URL'+(current.base_url?' ['+current.base_url+']':'')+': ')).trim()||current.base_url;model=(await rl.question('模型 ID ['+current.model+']: ')).trim()||current.model;const answer=(await rl.question('开启思考？on/off ['+(current.thinking?'on':'off')+']: ')).trim()||(current.thinking?'on':'off');if(!['on','off'].includes(answer))throw Error('Thinking must be on or off');thinking=answer==='on';}finally{rl.close();}
    key=await readHiddenKey();
  }
  const update={base_url:base??current.base_url,model:model??current.model,thinking:thinking??current.thinking,...(key!==undefined?{api_key:key}:{})};
  if(listModels){
    let models;
    if(live?.website){const response=await fetch(live.website+'/api/provider/models',{method:'POST',headers:{'content-type':'application/json','x-cad-config-token':live.configToken},body:JSON.stringify(update)});if(!response.ok)throw Error('Could not fetch model list: '+response.status);models=(await response.json()).models;}
    else models=await listProviderModels(validateProvider(update,{previous}));
    console.log(models.join('\n'));return;
  }
  if(live){
    if(!live.website||!live.configToken)throw Error('Restart the existing backend once to enable API configuration');
    const response=await fetch(live.website+'/api/provider',{method:'PUT',headers:{'content-type':'application/json','x-cad-config-token':live.configToken},
      body:JSON.stringify(update)});
    if(!response.ok)throw Error('Could not save API configuration: '+response.status);
  }else saveProvider(validateProvider(update,{previous}));
  console.log('API 配置已保存；密钥未显示。'+(live?'下一次模型请求生效。':'下次启动生效。'));
}
