import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {spawn} from 'node:child_process';
import {ROOT,RUNTIME,WORKSPACE,PYTHON,SKILL,sessionDir,inside} from './paths.mjs';
import {sseDecoder,secretRedactor} from './streams.mjs';
const port=Number(process.env.PORT||8772),ocPort=Number(process.env.CAD_CODE_OPENCODE_PORT||18134),gatewayPort=Number(process.env.CAD_CODE_GATEWAY_PORT||18135);
const model=process.env.CAD_CODE_MODEL||'gpt-6.1-sol';
const args=process.argv.slice(2),credentialArg=args.indexOf('--credentials');
const webEnabled=args.includes('--web');
fs.mkdirSync(RUNTIME,{recursive:true});fs.mkdirSync(WORKSPACE,{recursive:true});
const connectionFile=path.join(RUNTIME,'connection.json');
const saved=fs.existsSync(connectionFile)?JSON.parse(fs.readFileSync(connectionFile)):{};
const credentialFile=credentialArg>=0?path.resolve(args[credentialArg+1]):process.env.CAD_CODE_CREDENTIALS||saved.credentialFile;
if(!credentialFile)throw Error('Provide --credentials /path/to/provider.json on the first start');
fs.writeFileSync(connectionFile,JSON.stringify({credentialFile,model},null,2),{mode:0o600});
let configText=fs.readFileSync(credentialFile,'utf8').trim().replace(/,$/,'');
let provider;try{provider=JSON.parse(configText);}catch{provider=JSON.parse('{'+configText+'}');}
provider=provider.ccvibe||provider;const settings=provider.settings||provider.options||provider;
const upstream=settings.baseURL||settings.base_url,key=settings.apiKey||settings.api_key;
if(!upstream||!key)throw Error('Credential file must contain baseURL and apiKey');
const clean=value=>String(value).split(key).join('[REDACTED]');
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
    const route=new URL(req.url,'http://localhost').pathname.replace(/^\/v1/,'');
    if(!['/chat/completions','/models'].includes(route))return json(res,{error:'Unknown model route'},404);
    let payload;if(req.method==='POST'){
      payload=JSON.parse(await body(req));payload.temperature=1;payload.model=model;
      payload.reasoning_effort='high';payload.store=false;
    }
    const requestID=Date.now()+'-'+crypto.randomBytes(4).toString('hex');
    const logDir=path.join(RUNTIME,'model-requests',requestID);fs.mkdirSync(logDir,{recursive:true});
    fs.writeFileSync(path.join(logDir,'request.json'),clean(JSON.stringify({time:new Date().toISOString(),route,body:payload},null,2)));
    const controller=new AbortController();res.on('close',()=>{if(!res.writableEnded)controller.abort();});
    const upstreamResponse=await fetch(upstream.replace(/\/$/,'')+route,{method:req.method,headers:{authorization:'Bearer '+key,'content-type':'application/json'},...(payload?{body:JSON.stringify(payload)}:{}),signal:controller.signal});
    res.writeHead(upstreamResponse.status,{'content-type':upstreamResponse.headers.get('content-type')||'application/json','cache-control':'no-cache','x-accel-buffering':'no'});
    const log=fs.createWriteStream(path.join(logDir,'response.'+(payload?.stream?'sse':'json')));
    const redactor=secretRedactor(key,b=>log.write(b));
    try{for await(const chunk of upstreamResponse.body){redactor.write(Buffer.from(chunk));res.write(chunk);}}finally{redactor.end();log.end();res.end();}
  }catch(e){if(!res.headersSent)json(res,{error:clean(e.message)},502);else res.end();}
});
await new Promise((resolve,reject)=>gateway.listen(gatewayPort,'127.0.0.1',resolve).on('error',reject));
const dirs={config:path.join(RUNTIME,'xdg/config'),data:path.join(RUNTIME,'xdg/data'),state:path.join(RUNTIME,'xdg/state'),cache:path.join(RUNTIME,'xdg/cache')};
for(const p of Object.values(dirs))fs.mkdirSync(p,{recursive:true});
const opencodeConfig={
  $schema:'https://opencode.ai/config.json',model:'cad-local/'+model,small_model:'cad-local/'+model,default_agent:'cad-code',
  plugin:[new URL('file://'+path.join(ROOT,'src/plugin.mjs')).href],instructions:[],
  enabled_providers:['cad-local'],compaction:{auto:true,prune:false,reserved:1024},
  provider:{'cad-local':{name:'CAD Code · GPT6.1',npm:'@ai-sdk/openai-compatible',options:{baseURL:`http://127.0.0.1:${gatewayPort}/v1`,apiKey:gatewayToken},models:{[model]:{name:'GPT‑6.1 Sol',tool_call:true,reasoning:true,attachment:true,modalities:{input:['text','image'],output:['text']},limit:{context:262144,input:262144,output:16384}}}}},
  agent:{'cad-code':{description:'使用 SimpleCADAPI 完成建模、检查、导出和渲染',mode:'primary',model:'cad-local/'+model,temperature:1,prompt:'You are CAD Code, an interactive CAD coding agent. Reply in Chinese. Use the provided full SimpleCADAPI skill and the actual runtime. Read the skill first, route the task, inspect precise API pages, build and validate real artifacts. Use exec(code) for computation and file operations. Use question for requirements, todowrite for progress, and task with subagent_type="cad-review" for independent visual verification of artifacts under out/. Only claim observations actually returned by tools. Complete the requested work and give real artifact paths.',tools:{'*':false,exec:true,question:true,todowrite:true,task:true},permission:{'*':'deny',exec:'allow',question:'allow',todowrite:'allow',task:{'*':'deny','cad-review':'allow'}}},'cad-review':{description:'独立检查父任务 out/ 下的真实渲染与验证结果，父产物只读。',mode:'subagent',model:'cad-local/'+model,temperature:1,prompt:'You are an independent CAD evidence reviewer. Inspect actual parent output artifacts through exec and image(view_image). Treat source comments and parent verdicts as claims. Return a concise Chinese evidence-based verdict and limitations. Never edit parent files or claim unobserved checks.',tools:{'*':false,exec:true},permission:{'*':'deny',exec:'allow'}},compaction:{model:'cad-local/'+model,temperature:1}},
  permission:{'*':'deny',exec:'allow',question:'allow',todowrite:'allow',task:{'*':'deny','cad-review':'allow'}}
};
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
fs.writeFileSync(path.join(RUNTIME,'cli-connection.json'),JSON.stringify({pid:process.pid,url:ocBase,password:ocPassword,model,website:webEnabled?`http://127.0.0.1:${port}`:null}),{mode:0o600});
// Full OpenCode event archive; the DB and snapshots survive refresh/restart.
async function archiveEvents(){
  while(!shuttingDown){try{
    const r=await fetch(ocBase+'/event',{headers:{authorization:auth}});
    const decoder=sseDecoder(data=>{try{const e=JSON.parse(data);fs.appendFileSync(path.join(RUNTIME,'events.jsonl'),clean(JSON.stringify({time:new Date().toISOString(),event:e}))+'\n');}catch{}});
    for await(const b of r.body)decoder.write(Buffer.from(b));decoder.end();
  }catch{}if(!shuttingDown)await new Promise(r=>setTimeout(r,1000));}
}
archiveEvents();
const mime=p=>({'.html':'text/html; charset=utf-8','.css':'text/css','.js':'text/javascript','.png':'image/png','.jpg':'image/jpeg','.jpeg':'image/jpeg','.svg':'image/svg+xml','.json':'application/json','.stl':'model/stl','.step':'application/step','.stp':'application/step','.py':'text/plain; charset=utf-8','.md':'text/plain; charset=utf-8'})[path.extname(p).toLowerCase()]||'application/octet-stream';
function files(work){let out=[];if(!fs.existsSync(work))return out;function walk(dir){for(const f of fs.readdirSync(dir,{withFileTypes:true})){if(f.name.startsWith('.')||f.name==='__marimo__'||f.name==='__pycache__'||f.isSymbolicLink())continue;const p=path.join(dir,f.name);if(f.isDirectory())walk(p);else{const stat=fs.statSync(p);out.push({path:path.relative(work,p),size:stat.size,mtime:stat.mtimeMs});}}}walk(work);return out.sort((a,b)=>b.mtime-a.mtime);}
app=http.createServer(async(req,res)=>{
  try{
    const origin=req.headers.origin;if(origin&&origin!==`http://127.0.0.1:${port}`&&origin!==`http://localhost:${port}`)return json(res,{error:'Origin refused'},403);
    const url=new URL(req.url,`http://127.0.0.1:${port}`),route=url.pathname;
    if(route==='/api/config')return json(res,{name:'CAD Code',model,temperature:1,context:262144,vision:true,skill:'SimpleCADAPI 2.2.5',python:PYTHON});
    if(route==='/api/sessions'){
      if(req.method==='POST'){const a=await readJSON(req),s=await oc('/session','POST',{title:a.title||'新的 CAD 任务'});const work=sessionDir(s.id);fs.mkdirSync(work,{recursive:true});return json(res,s);}
      return json(res,await oc('/session'));
    }
    const m=route.match(/^\/api\/sessions\/(ses_[\w-]+)(?:\/(.*))?$/);
    if(m){const [,id,action]=m,work=sessionDir(id);fs.mkdirSync(work,{recursive:true});
      if(!action){const [messages,status]=await Promise.all([oc(`/session/${id}/message`),oc('/session/status')]);const state={id,messages,status:status[id]||{type:'idle'},files:files(work)};fs.writeFileSync(path.join(work,'.conversation.json'),JSON.stringify(state));return json(res,state);}
      if(action==='send'&&req.method==='POST'){const a=await readJSON(req);if(!a.text?.trim())throw Error('Message is empty');await oc(`/session/${id}/prompt_async`,'POST',{agent:'cad-code',model:{providerID:'cad-local',modelID:model},parts:[{type:'text',text:a.text}]});return json(res,{ok:true});}
      if(action==='stop'&&req.method==='POST'){const dir=path.join(RUNTIME,'cancel');fs.mkdirSync(dir,{recursive:true});fs.writeFileSync(path.join(dir,id),String(Date.now()));await oc(`/session/${id}/abort`,'POST',{});return json(res,{ok:true});}
      if(action==='upload'&&req.method==='POST'){
        const name=path.basename(url.searchParams.get('name')||'');if(!/^[\w.\-\u4e00-\u9fff ]{1,150}$/.test(name))throw Error('Invalid filename');
        const p=inside(work,'input/'+name);fs.mkdirSync(path.dirname(p),{recursive:true});fs.writeFileSync(p,await body(req));return json(res,{path:'input/'+name});
      }
      if(action==='file'){
        const p=inside(work,url.searchParams.get('path')||'');if(!fs.statSync(p).isFile())throw Error('Not a file');
        const ext=path.extname(p).toLowerCase(),type=['.png','.jpg','.jpeg','.step','.stp','.stl','.json'].includes(ext)?mime(p):'text/plain; charset=utf-8';
        res.writeHead(200,{'content-type':type,'x-content-type-options':'nosniff','cache-control':'no-store',...(url.searchParams.has('download')?{'content-disposition':`attachment; filename*=UTF-8''${encodeURIComponent(path.basename(p))}`}:{})});return fs.createReadStream(p).pipe(res);
      }
      if(action==='export'){const data=await oc(`/session/${id}/message`);res.writeHead(200,{'content-type':'application/json','content-disposition':`attachment; filename="${id}.json"`});return res.end(JSON.stringify({schema_version:'cad-code-session-v1',id,model,messages:data},null,2));}
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
console.log(`CAD Code CLI backend ready: ${ocBase} · ${model} · SimpleCADAPI2.2.5${webEnabled?' · web http://127.0.0.1:'+port:''}`);
