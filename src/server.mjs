import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {spawn} from 'node:child_process';
import {ROOT,RUNTIME,WORKSPACE,PYTHON,SKILL,sessionDir,inside} from './paths.mjs';
import {sseDecoder,secretRedactor} from './streams.mjs';
import {qwenReasoningStream} from './reasoning-stream.mjs';
import {restoreToolMedia,restoreResponsesToolMedia,defaultResponsesImageDetail,normalizeQwenResponsesHistory,loadToolMedia} from './tool-media.mjs';
import {MAIN_PROMPT_MARKER,REVIEW_PROMPT_MARKER,loadPromptTemplates} from './prompts.mjs';
import {prepareSessionWorkspace} from './workspace.mjs';
import {sessionRevision} from './session-guard.mjs';
import {workspaceInventory,clearWorkspace,deleteTrajectoryFiles,belongsToSessions} from './session-data.mjs';
import {loadProviderFile,providerSummary,savedProviderFile,saveProvider,validateProvider,listProviderModels,qwenModel} from './provider-config.mjs';
// Validate source documents before opening listeners or starting a model runner.
loadPromptTemplates();
const port=Number(process.env.PORT||8772),ocPort=Number(process.env.CAD_CODE_OPENCODE_PORT||18134),gatewayPort=Number(process.env.CAD_CODE_GATEWAY_PORT||18135);
let model=process.env.CAD_CODE_MODEL||'qwen-v8';
const wireAPI=process.env.CAD_CODE_WIRE_API||'responses';
if(!['responses','chat'].includes(wireAPI))throw Error('CAD_CODE_WIRE_API must be responses or chat');
const maxForwardedBytes=Number(process.env.CAD_CODE_MAX_MODEL_REQUEST_BYTES||64*1024*1024);
if(!Number.isSafeInteger(maxForwardedBytes)||maxForwardedBytes<1024)throw Error('Invalid CAD_CODE_MAX_MODEL_REQUEST_BYTES');
const args=process.argv.slice(2),credentialArg=args.indexOf('--credentials');
const webEnabled=args.includes('--web');
fs.mkdirSync(RUNTIME,{recursive:true});fs.mkdirSync(WORKSPACE,{recursive:true});
const connectionFile=path.join(RUNTIME,'connection.json');
const credentialFile=credentialArg>=0?path.resolve(args[credentialArg+1]):process.env.CAD_CODE_CREDENTIALS||savedProviderFile();
if(!credentialFile&&!webEnabled)throw Error('Configure API with cad-code config, or start cad-code --web');
let activeProvider=credentialFile?loadProviderFile(credentialFile):null;
model=process.env.CAD_CODE_MODEL||activeProvider?.model||model;
if(activeProvider)activeProvider={...activeProvider,model};
const routingModel=model;
function recordModel(){const file=path.join(RUNTIME,'active-model.json'),temp=file+'.'+crypto.randomBytes(8).toString('hex')+'.tmp';fs.writeFileSync(temp,JSON.stringify({model,thinking:activeProvider?.thinking??true})+'\n',{mode:0o600,flag:'wx'});fs.renameSync(temp,file);}
recordModel();
if(credentialFile)fs.writeFileSync(connectionFile,JSON.stringify({credentialFile,model},null,2),{mode:0o600});
const knownSecrets=new Set(activeProvider?[activeProvider.apiKey]:[]);
const clean=value=>{let text=String(value);for(const secret of knownSecrets)text=text.split(secret).join('[REDACTED]');return text;};
const configToken=crypto.randomBytes(32).toString('hex');
const deletedFile=path.join(RUNTIME,'deleted-sessions.json');
const deletedSessions=new Set(fs.existsSync(deletedFile)?JSON.parse(fs.readFileSync(deletedFile)):[]);
const maintenance=new Set();
const generations=new Map();
function currentGeneration(id){return generations.has(id)?generations.get(id):sessionRevision(id);}
function sessionChanged(id,generation){return deletedSessions.has(id)?{error:'Conversation was deleted',status:404}:maintenance.has(id)||currentGeneration(id)!==generation?{error:'Session data changed; retry the request',status:409}:null;}
function lockFile(id){return path.join(RUNTIME,'session-maintenance',id);}
function writeDeleted(){const temp=deletedFile+'.tmp';fs.writeFileSync(temp,JSON.stringify([...deletedSessions]),{mode:0o600});fs.renameSync(temp,deletedFile);}

const json=(res,body,status=200)=>{res.writeHead(status,{'content-type':'application/json; charset=utf-8','cache-control':'no-store'});res.end(JSON.stringify(body));};
async function body(req,max=32*1024*1024){let size=0,out=[];for await(const b of req){size+=b.length;if(size>max)throw Error('Request too large');out.push(b);}return Buffer.concat(out);}
async function readJSON(req){const b=await body(req);return b.length?JSON.parse(b):{};}
const ocPassword=crypto.randomBytes(24).toString('hex'),gatewayToken=crypto.randomBytes(24).toString('hex');
const auth='Basic '+Buffer.from('opencode:'+ocPassword).toString('base64');
const ocBase=`http://127.0.0.1:${ocPort}`;
async function oc(route,method='GET',data){
  const response=await fetch(ocBase+route,{method,headers:{authorization:auth,...(data?{'content-type':'application/json'}:{})},...(data?{body:JSON.stringify(data)}:{})});
  const s=await response.text();let value;try{value=JSON.parse(s);}catch{value=s;}
  if(!response.ok)throw Error(`OpenCode ${response.status}: `+clean(typeof value==='string'?value:JSON.stringify(value)).slice(0,1200));
  return value;
}
// Only this gateway holds the external credential; execution workers never inherit it.
const gateway=http.createServer(async(req,res)=>{
  try{
    if(req.headers.authorization!=='Bearer '+gatewayToken)return json(res,{error:'Unauthorized'},401);
    const session=req.headers['x-cad-session-id'];
    if(deletedSessions.has(session))return json(res,{error:'Conversation was deleted'},404);
    if(maintenance.has(session))return json(res,{error:'Session data is being changed'},409);
    const provider=activeProvider;if(!provider)return json(res,{error:{type:'ProviderNotConfigured',message:'Configure Base URL and API key in API settings or cad-code config.'}},503);
    const {baseURL:upstream,apiKey:key,model:requestModel,thinking}=provider;
    const route=new URL(req.url,'http://localhost').pathname.replace(/^\/v1/,'');
    if(!['/chat/completions','/responses','/models'].includes(route))return json(res,{error:'Unknown model route'},404);
    const requestID=Date.now()+'-'+crypto.randomBytes(4).toString('hex');
    const logDir=path.join(RUNTIME,'model-requests',requestID);fs.mkdirSync(logDir,{recursive:true});
    let payload,rawPayload,mediaAudit=[],providerImageDefaults=[],providerHistoryNormalization=[];if(req.method==='POST'){
      payload=JSON.parse(await body(req));rawPayload=structuredClone(payload);payload.temperature=1;payload.model=requestModel;
      fs.writeFileSync(path.join(logDir,'request.json'),clean(JSON.stringify({time:new Date().toISOString(),route,sessionID:req.headers['x-cad-session-id']||null,body:rawPayload},null,2)));
      payload.store=false;
      try{
        if(route==='/responses'){
          payload.reasoning={...payload.reasoning,effort:qwenModel(requestModel)?(thinking?'medium':'low'):(thinking?'high':'none')};
          if(qwenModel(requestModel))payload.chat_template_kwargs={...payload.chat_template_kwargs,enable_thinking:thinking};
          const restored=restoreResponsesToolMedia(payload.input,{sessionID:req.headers['x-cad-session-id']});payload.input=restored.input;mediaAudit=restored.audit;
          if(qwenModel(requestModel)){
            const history=normalizeQwenResponsesHistory(payload.input);
            payload.input=history.input;providerHistoryNormalization=history.audit;
            const normalized=defaultResponsesImageDetail(payload.input,{detail:'high'});
            payload.input=normalized.input;providerImageDefaults=normalized.audit;
          }
        }else{payload.reasoning_effort=qwenModel(requestModel)?(thinking?'medium':'low'):(thinking?'high':'none');if(qwenModel(requestModel))payload.chat_template_kwargs={...payload.chat_template_kwargs,enable_thinking:thinking};const restored=restoreToolMedia(payload.messages,{sessionID:req.headers['x-cad-session-id']});payload.messages=restored.messages;mediaAudit=restored.audit;}
      }catch(e){fs.writeFileSync(path.join(logDir,'media-alignment-error.json'),JSON.stringify({error:e.message}));return json(res,{error:{type:'ToolMediaAlignmentError',message:e.message}},400);}
    }
    fs.writeFileSync(path.join(logDir,'forwarded-request.json'),clean(JSON.stringify({time:new Date().toISOString(),route,sessionID:req.headers['x-cad-session-id']||null,body:payload},null,2)));
    fs.writeFileSync(path.join(logDir,'media-alignment.json'),JSON.stringify({mode:'tool_multimodal_original',restored:mediaAudit,provider_history_normalization:providerHistoryNormalization,provider_image_defaults:providerImageDefaults},null,2));
    const forwardedBody=payload?JSON.stringify(payload):null;
    if(forwardedBody&&Buffer.byteLength(forwardedBody)>maxForwardedBytes){const error={type:'ToolMediaPayloadTooLarge',message:'The full model request exceeds the configured byte limit; no images or history were dropped or resized.',bytes:Buffer.byteLength(forwardedBody),limit:maxForwardedBytes};fs.writeFileSync(path.join(logDir,'response-error.json'),JSON.stringify(error));return json(res,{error},413);}
    const controller=new AbortController();res.on('close',()=>{if(!res.writableEnded)controller.abort();});
    const upstreamResponse=await fetch(upstream.replace(/\/$/,'')+route,{method:req.method,headers:{authorization:'Bearer '+key,'content-type':'application/json'},...(payload?{body:forwardedBody}:{}),signal:controller.signal});
    if(!upstreamResponse.ok&&mediaAudit.length){const error=await upstreamResponse.text();fs.writeFileSync(path.join(logDir,'response-error.json'),clean(JSON.stringify({status:upstreamResponse.status,error})));return json(res,{error:{type:'MultimodalToolResponseRejected',message:'Upstream rejected the exact tool image request; no role conversion, image resizing or silent fallback was applied.',upstream_status:upstreamResponse.status,detail:clean(error)}},upstreamResponse.status);}
    res.writeHead(upstreamResponse.status,{'content-type':upstreamResponse.headers.get('content-type')||'application/json','cache-control':'no-cache','x-accel-buffering':'no'});
    const log=fs.createWriteStream(path.join(logDir,'response.'+(payload?.stream?'sse':'json')));
    const redactor=secretRedactor(key,b=>log.write(b));
    const streamAudit=[];
    const clientLog=payload?.stream&&qwenModel(requestModel)&&route==='/responses'?fs.createWriteStream(path.join(logDir,'client-response.sse')):null;
    const clientRedactor=clientLog?secretRedactor(key,b=>clientLog.write(b)):null;
    const adapter=clientLog?qwenReasoningStream(chunk=>{clientRedactor.write(chunk);res.write(chunk);},entry=>streamAudit.push(entry)):null;
    try{for await(const chunk of upstreamResponse.body){redactor.write(Buffer.from(chunk));if(adapter)adapter.write(Buffer.from(chunk));else res.write(chunk);}}
    finally{adapter?.end();clientRedactor?.end();clientLog?.end();redactor.end();log.end();if(adapter)fs.writeFileSync(path.join(logDir,'reasoning-stream-adaptation.json'),JSON.stringify({mode:'full_reasoning_text_protocol_adaptation',text_rewritten:false,events:streamAudit},null,2));res.end();}
  }catch(e){if(!res.headersSent)json(res,{error:clean(e.message)},502);else res.end();}
});
await new Promise((resolve,reject)=>gateway.listen(gatewayPort,'127.0.0.1',resolve).on('error',reject));
const dirs={config:path.join(RUNTIME,'xdg/config'),data:path.join(RUNTIME,'xdg/data'),state:path.join(RUNTIME,'xdg/state'),cache:path.join(RUNTIME,'xdg/cache')};
for(const p of Object.values(dirs))fs.mkdirSync(p,{recursive:true});
const opencodeConfig={
  $schema:'https://opencode.ai/config.json',model:'cad-local/'+model,small_model:'cad-local/'+model,default_agent:'cad-code',
  plugin:[new URL('file://'+path.join(ROOT,'src/plugin.mjs')).href],instructions:[],
  enabled_providers:['cad-local'],compaction:{auto:true,prune:false,reserved:1024},
  provider:{'cad-local':{name:'CAD Code · '+model,npm:wireAPI==='responses'?'@ai-sdk/openai':'@ai-sdk/openai-compatible',options:{baseURL:`http://127.0.0.1:${gatewayPort}/v1`,apiKey:gatewayToken},models:{[model]:{name:model,tool_call:true,reasoning:true,attachment:true,modalities:{input:['text','image'],output:['text']},limit:{context:262144,input:262144,output:16384}}}}},
  agent:{'cad-code':{description:'使用 SimpleCADAPI 完成建模、检查、导出和渲染',mode:'primary',model:'cad-local/'+model,temperature:1,prompt:MAIN_PROMPT_MARKER,tools:{'*':false,exec:true,question:true,todowrite:true,task:true},permission:{'*':'deny',exec:'allow',question:'allow',todowrite:'allow',task:{'*':'deny','cad-review':'allow'}}},'cad-review':{description:'独立检查父任务 out/ 下的真实渲染与验证结果，父产物只读。',mode:'subagent',model:'cad-local/'+model,temperature:1,prompt:REVIEW_PROMPT_MARKER,tools:{'*':false,exec:true},permission:{'*':'deny',exec:'allow'}},compaction:{model:'cad-local/'+model,temperature:1}},
  permission:{'*':'deny',exec:'allow',question:'allow',todowrite:'allow',task:{'*':'deny','cad-review':'allow'}}
};
// BEGIN MULTISOLID ADDITIVE CONFIG
// Assembly backends opt in in a separate process; the ordinary configuration above is unchanged.
if(process.env.CAD_CODE_ASSEMBLY_CONTEXT_FILE){
  const {buildAssemblyConfig}=await import('../multi/assembly-runtime.mjs');
  Object.assign(opencodeConfig,buildAssemblyConfig(opencodeConfig,{pluginPath:path.join(ROOT,'multi/assembly-plugin.mjs'),model}));
}
// END MULTISOLID ADDITIVE CONFIG
const configPath=path.join(RUNTIME,'opencode.json');fs.writeFileSync(configPath,JSON.stringify(opencodeConfig,null,2),{mode:0o600});
// This isolated project stops parent-project instruction discovery.
if(!fs.existsSync(path.join(WORKSPACE,'.git')))await new Promise((resolve,reject)=>{const p=spawn('git',['init','--quiet'],{cwd:WORKSPACE,stdio:'ignore'});p.on('exit',c=>c===0?resolve():reject(Error('git init failed')));});
const ocLog=fs.openSync(path.join(RUNTIME,'opencode.log'),'a');
const ocProcess=spawn(process.env.OPENCODE_BIN||'opencode',['serve','--hostname','127.0.0.1','--port',String(ocPort)],{cwd:WORKSPACE,env:{...process.env,OPENCODE_CONFIG:configPath,OPENCODE_CONFIG_DIR:dirs.config,XDG_CONFIG_HOME:dirs.config,XDG_DATA_HOME:dirs.data,XDG_STATE_HOME:dirs.state,XDG_CACHE_HOME:dirs.cache,OPENCODE_SERVER_PASSWORD:ocPassword,CAD_CODE_PYTHON:PYTHON,CAD_CODE_SKILL:SKILL,CAD_CODE_NODE:process.env.CAD_CODE_NODE||process.execPath,OPENCODE_DISABLE_CLAUDE_CODE:'true'},stdio:['ignore',ocLog,ocLog]});
let shuttingDown=false;let app;
function shutdown(){if(shuttingDown)return;shuttingDown=true;ocProcess.kill('SIGTERM');gateway.close();app?.close();setTimeout(()=>process.exit(0),1500).unref();}
process.on('SIGINT',shutdown);process.on('SIGTERM',shutdown);
ocProcess.on('exit',c=>{if(!shuttingDown)console.error('OpenCode exited:',c,'See .runtime/opencode.log');});
let ready=false;
for(let i=0;i<90;i++){try{await oc('/global/health');ready=true;break;}catch{await new Promise(r=>setTimeout(r,500));}}
if(!ready){ocProcess.kill();gateway.close();throw Error('OpenCode did not become ready; see .runtime/opencode.log');}
fs.writeFileSync(path.join(RUNTIME,'status.json'),JSON.stringify({model,python:PYTHON,skill:SKILL,opencode:ocBase,website:`http://127.0.0.1:${port}`,pid:process.pid,startedAt:new Date().toISOString()},null,2));
// Full OpenCode event archive; the DB and snapshots survive refresh/restart.
async function archiveEvents(){
  while(!shuttingDown){try{
    const r=await fetch(ocBase+'/event',{headers:{authorization:auth}});
    const decoder=sseDecoder(data=>{try{const e=JSON.parse(data);if(belongsToSessions(e,deletedSessions))return;fs.appendFileSync(path.join(RUNTIME,'events.jsonl'),clean(JSON.stringify({time:new Date().toISOString(),event:e}))+'\n');}catch{}});
    for await(const b of r.body)decoder.write(Buffer.from(b));decoder.end();
  }catch{}if(!shuttingDown)await new Promise(r=>setTimeout(r,1000));}
}
archiveEvents();
async function stopSessionExecution(id){
  const workersDir=path.join(RUNTIME,'workers'),workerFile=path.join(workersDir,id+'.json');
  if(!fs.existsSync(workerFile))return;
  const worker=JSON.parse(fs.readFileSync(workerFile));
  if(worker.sessionID!==id||!Number.isSafeInteger(worker.pid))throw Error('Invalid execution worker metadata');
  const cancel=path.join(RUNTIME,'cancel',id);fs.mkdirSync(path.dirname(cancel),{recursive:true});fs.writeFileSync(cancel,String(Date.now()));
  const deadline=Date.now()+3000;
  while(Date.now()<deadline){
    try{process.kill(worker.pid,0);}catch(e){if(e.code==='ESRCH')return;throw e;}
    await new Promise(resolve=>setTimeout(resolve,30));
  }
  throw Error('Execution worker has not stopped; data was not deleted. Retry after stopping the task.');
}
const mime=p=>({'.html':'text/html; charset=utf-8','.css':'text/css','.js':'text/javascript','.png':'image/png','.jpg':'image/jpeg','.jpeg':'image/jpeg','.svg':'image/svg+xml','.json':'application/json','.stl':'model/stl','.step':'application/step','.stp':'application/step','.py':'text/plain; charset=utf-8','.md':'text/plain; charset=utf-8'})[path.extname(p).toLowerCase()]||'application/octet-stream';
function files(work){let out=[];if(!fs.existsSync(work))return out;function walk(dir){for(const f of fs.readdirSync(dir,{withFileTypes:true})){if(f.name.startsWith('.')||f.name==='__marimo__'||f.name==='__pycache__'||f.isSymbolicLink())continue;const p=path.join(dir,f.name);if(f.isDirectory())walk(p);else{const stat=fs.statSync(p);out.push({path:path.relative(work,p),size:stat.size,mtime:stat.mtimeMs});}}}walk(work);return out.sort((a,b)=>b.mtime-a.mtime);}
app=http.createServer(async(req,res)=>{
  try{
    if(![`127.0.0.1:${port}`,`localhost:${port}`].includes(req.headers.host)||req.headers['sec-fetch-site']==='cross-site')return json(res,{error:'Host refused'},403);
    const origin=req.headers.origin;if(origin&&origin!==`http://127.0.0.1:${port}`&&origin!==`http://localhost:${port}`)return json(res,{error:'Origin refused'},403);
    const url=new URL(req.url,`http://127.0.0.1:${port}`),route=url.pathname;
    // BEGIN MULTISOLID ADDITIVE API
    if(route==='/api/multisolid/dispatch'&&req.method==='POST'){
      const {routeUpload}=await import('../multi/ingress.mjs');
      return json(res,await routeUpload(await body(req),url.searchParams.get('name')||''));
    }
    // END MULTISOLID ADDITIVE API
    if(route==='/api/provider/models'){
      if(req.method!=='POST')return json(res,{error:'Method not allowed'},405);
      if(req.headers['x-cad-config-token']!==configToken)return json(res,{error:'Configuration token required'},403);
      if(!req.headers['content-type']?.startsWith('application/json'))return json(res,{error:'JSON required'},415);
      const draft=JSON.parse((await body(req,16384)).toString('utf8'));
      const provider=validateProvider(draft,{previous:activeProvider});
      return json(res,{models:await listProviderModels(provider)});
    }
    if(route==='/api/provider'){
      if(req.method==='GET')return json(res,{...providerSummary(activeProvider),config_token:configToken});
      if(req.method!=='PUT')return json(res,{error:'Method not allowed'},405);
      if(req.headers['x-cad-config-token']!==configToken)return json(res,{error:'Configuration token required'},403);
      if(!req.headers['content-type']?.startsWith('application/json'))return json(res,{error:'JSON required'},415);
      const update=JSON.parse((await body(req,16384)).toString('utf8'));
      const next=validateProvider(update,{previous:activeProvider});
      knownSecrets.add(next.apiKey);saveProvider(next);activeProvider=next;model=next.model;recordModel();
      const link=path.join(RUNTIME,'cli-connection.json');const connection=JSON.parse(fs.readFileSync(link));connection.model=model;connection.thinking=next.thinking;fs.writeFileSync(link,JSON.stringify(connection),{mode:0o600});
      const statusFile=path.join(RUNTIME,'status.json');const status=JSON.parse(fs.readFileSync(statusFile));status.model=model;fs.writeFileSync(statusFile,JSON.stringify(status,null,2));
      return json(res,{...providerSummary(activeProvider),effective:'next_request'});
    }
    if(route==='/api/config')return json(res,{name:'CAD Code',model,temperature:1,context:262144,vision:true,wireAPI,toolImageMode:'tool_multimodal_original',skill:'SimpleCADAPI 2.2.7',python:PYTHON,providerConfigured:Boolean(activeProvider),thinking:activeProvider?.thinking??true});
    if(route==='/api/data'&&req.method==='GET'){const sessions=await oc('/session');return json(res,{items:workspaceInventory(sessions),config_token:configToken});}
    if(route==='/api/sessions'){
      if(req.method==='POST'){const a=await readJSON(req),s=await oc('/session','POST',{title:a.title||'新的 CAD 任务'});prepareSessionWorkspace(s.id);return json(res,s);}
      return json(res,await oc('/session'));
    }
    const m=route.match(/^\/api\/sessions\/(ses_[\w-]+)(?:\/(.*))?$/);
    if(m){const [,id,action]=m,work=sessionDir(id),generation=currentGeneration(id);
      if(['workspace','conversation'].includes(action)&&req.method==='DELETE'){
        if(req.headers['x-cad-config-token']!==configToken)return json(res,{error:'Configuration token required'},403);
        const confirmed=await readJSON(req);if(confirmed.confirm!==id)return json(res,{error:'Confirm the exact session ID'},400);
        const sessions=await oc('/session');const ids=new Set([id]);let changed=true;
        while(changed){changed=false;for(const s of sessions)if(s.parentID&&ids.has(s.parentID)&&!ids.has(s.id)){ids.add(s.id);changed=true;}}
        if(action==='conversation'&&!sessions.some(s=>s.id===id))return json(res,{error:'Conversation not found'},404);
        const states=await oc('/session/status');if([...ids].some(x=>states[x]&&states[x].type!=='idle'))return json(res,{error:'Stop this task and its reviews before deleting data'},409);
        if([...ids].some(x=>maintenance.has(x)))return json(res,{error:'Session data is already being changed'},409);
        for(const x of ids){generations.set(x,currentGeneration(x)+1);const revisionFile=path.join(RUNTIME,'session-generations',x);fs.mkdirSync(path.dirname(revisionFile),{recursive:true});fs.writeFileSync(revisionFile,String(generations.get(x)));maintenance.add(x);fs.mkdirSync(path.dirname(lockFile(x)),{recursive:true});fs.writeFileSync(lockFile(x),'locked');}
        try{
          for(const x of ids)await stopSessionExecution(x);
          if(action==='workspace')return json(res,{ok:true,scope:'workspace',...clearWorkspace(id)});
          for(const x of ids)deletedSessions.add(x);
          try{await oc('/session/'+id,'DELETE');}catch(e){for(const x of ids)deletedSessions.delete(x);throw e;}
          writeDeleted();const result=deleteTrajectoryFiles([...ids]);
          return json(res,{ok:true,scope:'conversation',deleted_sessions:[...ids],...result});
        }finally{for(const x of ids){maintenance.delete(x);fs.rmSync(lockFile(x),{force:true});}}
      }
      if(deletedSessions.has(id)&&!['file','workspace'].includes(action))return json(res,{error:'Conversation was deleted'},404);
      if(!action){const [messages,status]=await Promise.all([oc(`/session/${id}/message`),oc('/session/status')]);const invalid=sessionChanged(id,generation);if(invalid)return json(res,{error:invalid.error},invalid.status);const state={id,messages,status:status[id]||{type:'idle'},files:files(work)};if(fs.existsSync(work))fs.writeFileSync(path.join(work,'.conversation.json'),JSON.stringify(state));return json(res,state);}
      if(action==='send'&&req.method==='POST'){const a=await readJSON(req);const invalid=sessionChanged(id,generation);if(invalid)return json(res,{error:invalid.error},invalid.status);prepareSessionWorkspace(id);if(!a.text?.trim())throw Error('Message is empty');await oc(`/session/${id}/prompt_async`,'POST',{agent:'cad-code',model:{providerID:'cad-local',modelID:routingModel},parts:[{type:'text',text:a.text}]});return json(res,{ok:true});}
      if(action==='stop'&&req.method==='POST'){const dir=path.join(RUNTIME,'cancel');fs.mkdirSync(dir,{recursive:true});fs.writeFileSync(path.join(dir,id),String(Date.now()));await oc(`/session/${id}/abort`,'POST',{});return json(res,{ok:true});}
      if(action==='upload'&&req.method==='POST'){
        const bytes=await body(req);const invalid=sessionChanged(id,generation);if(invalid)return json(res,{error:invalid.error},invalid.status);prepareSessionWorkspace(id);
        const name=path.basename(url.searchParams.get('name')||'');if(!/^[\w.\-\u4e00-\u9fff ]{1,150}$/.test(name))throw Error('Invalid filename');
        const p=inside(work,'input/'+name);fs.mkdirSync(path.dirname(p),{recursive:true});fs.writeFileSync(p,bytes);return json(res,{path:'input/'+name});
      }
      if(action==='file'){
        const p=inside(work,url.searchParams.get('path')||'');if(!fs.statSync(p).isFile())throw Error('Not a file');
        const ext=path.extname(p).toLowerCase(),type=['.png','.jpg','.jpeg','.step','.stp','.stl','.json'].includes(ext)?mime(p):'text/plain; charset=utf-8';
        res.writeHead(200,{'content-type':type,'x-content-type-options':'nosniff','cache-control':'no-store',...(url.searchParams.has('download')?{'content-disposition':`attachment; filename*=UTF-8''${encodeURIComponent(path.basename(p))}`}:{})});return fs.createReadStream(p).pipe(res);
      }
      if(action==='tool-image'){
        const callID=url.searchParams.get('call'),index=Number(url.searchParams.get('index'));
        if(!callID||!Number.isSafeInteger(index)||index<0)throw Error('Invalid image reference');
        const record=loadToolMedia(callID,{sessionID:id});const part=record?.content.filter(p=>p.type==='input_image')[index];
        if(!part)throw Error('Tool image not found');const [header,data]=part.image_url.split(',');
        res.writeHead(200,{'content-type':header.slice(5,header.indexOf(';')),'x-content-type-options':'nosniff','cache-control':'no-store'});return res.end(Buffer.from(data,'base64'));
      }
      if(action==='export'){
        const data=await oc(`/session/${id}/message`),toolMedia=[];
        for(const message of data)for(const part of message.parts||[])if(part.type==='tool'&&part.state?.metadata?.cadMedia){
          const record=loadToolMedia(part.callID,{sessionID:id});if(!record)throw Error('ToolMediaAlignmentError: original image record missing from export');toolMedia.push(record);
        }
        res.writeHead(200,{'content-type':'application/json','content-disposition':`attachment; filename="${id}.json"`});return res.end(JSON.stringify({schema_version:'cad-code-session-v2',id,model,messages:data,tool_media:toolMedia},null,2));
      }
    }
    if(route==='/api/questions')return json(res,await oc('/question'));
    const q=route.match(/^\/api\/questions\/([^/]+)\/reply$/);
    if(q&&req.method==='POST'){const a=await readJSON(req);return json(res,await oc('/question/'+q[1]+'/reply','POST',a));}
    if(route.startsWith('/api/'))return json(res,{error:'Unknown API route'},404);
    const p=inside(path.join(ROOT,'public'),route==='/'?'index.html':'.'+route);
    if(!fs.existsSync(p))return json(res,{error:'Not found'},404);
    res.writeHead(200,{'content-type':mime(p),'cache-control':'no-cache'});fs.createReadStream(p).pipe(res);
  }catch(e){json(res,{error:clean(e.message)},400);}
});
if(webEnabled)await new Promise((resolve,reject)=>app.listen(port,'127.0.0.1',resolve).on('error',reject));
fs.writeFileSync(path.join(RUNTIME,'cli-connection.json'),JSON.stringify({pid:process.pid,url:ocBase,password:ocPassword,configToken,model,routingModel,thinking:activeProvider?.thinking??true,website:webEnabled?`http://127.0.0.1:${port}`:null}),{mode:0o600});
console.log(`CAD Code CLI backend ready: ${ocBase} · ${model} · SimpleCADAPI2.2.7${webEnabled?' · web http://127.0.0.1:'+port:''}`);
