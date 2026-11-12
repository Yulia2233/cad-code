import assert from 'node:assert/strict';
import {test} from 'node:test';
import fs from 'node:fs';
import path from 'node:path';
import net from 'node:net';
import http from 'node:http';
import crypto from 'node:crypto';
import {spawn} from 'node:child_process';
import {ROOT,PYTHON} from '../src/paths.mjs';

// The real launcher/server are exercised against a fake OpenCode executable.
// No model provider, real backend port or real connection file is contacted.
const fakeSource=`#!/usr/bin/env node
import http from 'node:http';
import fs from 'node:fs';
const argv=process.argv.slice(2),mode=argv[0];
const record=value=>fs.appendFileSync(process.env.MOCK_RECORD,JSON.stringify(value)+'\\n');
record({event:'spawn',mode,argv,pid:process.pid,ppid:process.ppid,cwd:process.cwd(),env:{OPENCODE_CONFIG:process.env.OPENCODE_CONFIG,XDG_DATA_HOME:process.env.XDG_DATA_HOME,OPENCODE_SERVER_USERNAME:process.env.OPENCODE_SERVER_USERNAME,passwordConfigured:Boolean(process.env.OPENCODE_SERVER_PASSWORD)}});
if(mode!=='serve'){setTimeout(()=>process.exit(0),Number(process.env.MOCK_ATTACH_MS||20));}
else{
 const port=Number(argv[argv.indexOf('--port')+1]),sessions=[{id:'ses_mock_existing',time:{updated:1}},{id:'ses_mock_previous',time:{updated:2}},{id:'ses_mock_child',parentID:'ses_mock_previous',time:{updated:99}}];
 const auth='Basic '+Buffer.from('opencode:'+process.env.OPENCODE_SERVER_PASSWORD).toString('base64');
 const sockets=new Set();let counter=0;
 const server=http.createServer(async(req,res)=>{
  if(req.headers.authorization!==auth){res.writeHead(401);return res.end('{}');}
  const route=new URL(req.url,'http://localhost').pathname;let input='';for await(const part of req)input+=part;
  const body=input?JSON.parse(input):null;record({event:'request',method:req.method,path:route,body});
  if(route==='/event'){res.writeHead(200,{'content-type':'text/event-stream'});res.write('data: {"type":"server.connected"}\\n\\n');return;}
  let value;
  if(route==='/global/health')value={healthy:true,version:'test-mock'};
  else if(route==='/session'&&req.method==='POST'){value={id:'ses_mock_created_'+(++counter),title:body.title,time:{updated:Date.now()}};sessions.push(value);}
  else if(route==='/session')value=sessions;
  else if(route==='/session/status')value=process.env.MOCK_STATUS_FILE&&fs.existsSync(process.env.MOCK_STATUS_FILE)?JSON.parse(fs.readFileSync(process.env.MOCK_STATUS_FILE)):{};
  else if(route.endsWith('/message')){if(!sessions.some(s=>s.id===route.split('/')[2])){res.writeHead(404,{'content-type':'application/json'});return res.end('{}');}value=process.env.MOCK_MESSAGES_FILE&&fs.existsSync(process.env.MOCK_MESSAGES_FILE)?JSON.parse(fs.readFileSync(process.env.MOCK_MESSAGES_FILE)):[];if(process.env.MOCK_MESSAGE_DELAY_FILE&&fs.existsSync(process.env.MOCK_MESSAGE_DELAY_FILE))await new Promise(resolve=>setTimeout(resolve,300));}
  else if(route.startsWith('/session/')&&req.method==='DELETE'){const id=route.split('/')[2],ids=new Set([id]);let changed=true;while(changed){changed=false;for(const s of sessions)if(ids.has(s.parentID)&&!ids.has(s.id)){ids.add(s.id);changed=true;}}for(let i=sessions.length-1;i>=0;i--)if(ids.has(sessions[i].id))sessions.splice(i,1);value=true;}
  else if(route.startsWith('/session/')){value=sessions.find(s=>s.id===route.split('/')[2]);if(!value){res.writeHead(404);return res.end('{}');}}
  else value={};
  res.writeHead(200,{'content-type':'application/json'});res.end(JSON.stringify(value));
 });
 server.on('connection',socket=>{sockets.add(socket);socket.on('close',()=>sockets.delete(socket));});
 server.listen(port,'127.0.0.1');
 process.on('SIGTERM',()=>{record({event:'terminated',pid:process.pid});for(const socket of sockets)socket.destroy();server.close(()=>process.exit(0));setTimeout(()=>process.exit(0),200).unref();});
}
`;

async function freePorts(){
  const sockets=[];
  try{for(let i=0;i<3;i++){const server=net.createServer();await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));sockets.push(server);}return sockets.map(s=>s.address().port);}
  finally{await Promise.all(sockets.map(s=>new Promise(resolve=>s.close(resolve))));}
}
function alive(pid){try{process.kill(pid,0);return true;}catch{return false;}}
async function until(fn,timeout=8000){const end=Date.now()+timeout;while(Date.now()<end){const result=await fn();if(result)return result;await new Promise(r=>setTimeout(r,30));}throw Error('Timed out waiting for test process');}
async function fixture(t){
  const directory=path.join(ROOT,'.runtime','cli-smoke-'+crypto.randomBytes(7).toString('hex'));
  fs.mkdirSync(directory,{recursive:true});
  const runtime=path.join(directory,'runtime'),workspace=path.join(directory,'workspace'),record=path.join(directory,'mock.jsonl'),binary=path.join(directory,'opencode-mock.mjs'),credentials=path.join(directory,'provider.json');
  fs.writeFileSync(binary,fakeSource,{mode:0o700});
  fs.writeFileSync(credentials,JSON.stringify({settings:{baseURL:'http://127.0.0.1:9/v1',apiKey:'MOCK_ONLY_NOT_A_REAL_CREDENTIAL'}}),{mode:0o600});
  const [port,ocPort,gatewayPort]=await freePorts();
  assert.ok([port,ocPort,gatewayPort].every(p=>![8772,18134,18135].includes(p)));
  const env={...process.env,CAD_CODE_RUNTIME:runtime,CAD_CODE_WORKSPACE:workspace,CAD_CODE_PYTHON:PYTHON,OPENCODE_BIN:binary,MOCK_RECORD:record,PORT:String(port),CAD_CODE_OPENCODE_PORT:String(ocPort),CAD_CODE_GATEWAY_PORT:String(gatewayPort)};
  delete env.CAD_CODE_CREDENTIALS;
  const running=[];
  function start(exe,args,{stdin='ignore'}={}){const child=spawn(exe,args,{cwd:ROOT,env,stdio:[stdin,'pipe','pipe']});const result={child,stdout:'',stderr:'',exit:null};child.stdout.setEncoding('utf8');child.stderr.setEncoding('utf8');child.stdout.on('data',x=>result.stdout+=x);child.stderr.on('data',x=>result.stderr+=x);result.finished=new Promise((resolve,reject)=>{child.on('error',reject);child.on('close',(code,signal)=>{result.exit={code,signal};resolve(result);});});running.push(result);return result;}
  async function finish(result){const timer=setTimeout(()=>result.child.kill('SIGTERM'),12000);try{return await result.finished;}finally{clearTimeout(timer);}}
  const events=()=>fs.existsSync(record)?fs.readFileSync(record,'utf8').trim().split('\n').filter(Boolean).map(JSON.parse):[];
  const connection=()=>{try{return JSON.parse(fs.readFileSync(path.join(runtime,'cli-connection.json')));}catch{return null;}};
  t.after(async()=>{
    for(const r of running)if(!r.exit)r.child.kill('SIGTERM');
    await Promise.race([Promise.allSettled(running.map(r=>r.finished)),new Promise(r=>setTimeout(r,2500))]);
    const pids=new Set(events().filter(e=>e.event==='spawn'&&e.mode==='serve').flatMap(e=>[e.pid,e.ppid]));
    const c=connection();if(c)pids.add(c.pid);
    for(const pid of pids)if(pid!==process.pid&&alive(pid)){try{process.kill(pid,'SIGTERM');}catch{}}
    await new Promise(r=>setTimeout(r,150));
    fs.rmSync(directory,{recursive:true,force:true});
  });
  return {directory,runtime,workspace,credentials,env,port,ocPort,gatewayPort,events,connection,start,finish,cli:(args,options)=>start(path.join(ROOT,'cad-code'),args,options)};
}

test('Qwen gateway forwards historical assistant input_text and preserves tool and user content',async t=>{
  const forwarded=[];
  const upstream=http.createServer(async(req,res)=>{
    let raw='';for await(const chunk of req)raw+=chunk;
    forwarded.push(JSON.parse(raw));
    res.writeHead(200,{'content-type':'application/json'});res.end(JSON.stringify({id:'resp_mock',output:[]}));
  });
  await new Promise(resolve=>upstream.listen(0,'127.0.0.1',resolve));
  t.after(()=>new Promise(resolve=>upstream.close(resolve)));
  const f=await fixture(t);
  fs.writeFileSync(f.credentials,JSON.stringify({baseURL:`http://127.0.0.1:${upstream.address().port}/v1`,apiKey:'MOCK_ONLY_NOT_A_REAL_CREDENTIAL'}));
  f.cli(['--credentials',f.credentials,'--web']);
  await until(()=>f.connection());
  const config=JSON.parse(fs.readFileSync(path.join(f.runtime,'opencode.json'))),provider=config.provider['cad-local'];
  const input=[{role:'user',content:[{type:'input_text',text:'继续重建'}]},
    {role:'assistant',content:[{type:'output_text',text:'正在检查曲面。',annotations:[]}]},
    {type:'function_call',call_id:'call_mock',name:'exec',arguments:'{"code":"text(1)"}'},
    {type:'function_call_output',call_id:'call_mock',output:'1'}];
  const response=await fetch(provider.options.baseURL+'/responses',{method:'POST',
    headers:{authorization:'Bearer '+provider.options.apiKey,'content-type':'application/json'},
    body:JSON.stringify({model:'old-provider',input,stream:false})});
  assert.equal(response.status,200,await response.text());assert.equal(forwarded.length,1);
  assert.equal(forwarded[0].model,'qwen-v8');assert.equal(forwarded[0].temperature,1);
  assert.equal(forwarded[0].reasoning.effort,'medium');
  assert.deepEqual(forwarded[0].input,[input[0],{role:'assistant',content:[{type:'input_text',text:'正在检查曲面。'}]},input[2],input[3]]);
  const requests=path.join(f.runtime,'model-requests'),entry=fs.readdirSync(requests)[0];
  const audit=JSON.parse(fs.readFileSync(path.join(requests,entry,'media-alignment.json')));
  assert.equal(audit.provider_history_normalization.length,1);
  const original=JSON.parse(fs.readFileSync(path.join(requests,entry,'request.json')));
  assert.deepEqual(original.body.input,input);
});

test('web can configure an empty installation, rotates credentials live and retains them on restart',async t=>{
  const requests=[];
  const upstream=http.createServer(async(req,res)=>{requests.push(req.headers.authorization);res.writeHead(200,{'content-type':'application/json'});res.end('{"data":[]}');});
  await new Promise(resolve=>upstream.listen(0,'127.0.0.1',resolve));t.after(()=>new Promise(resolve=>upstream.close(resolve)));
  const f=await fixture(t),backend=f.cli(['--web']),connection=await until(()=>f.connection());
  const get=()=>fetch(connection.website+'/api/provider');
  let response=await get(),settings=await response.json();assert.equal(settings.configured,false);assert.equal(settings.api_key_configured,false);
  const gateway=JSON.parse(fs.readFileSync(path.join(f.runtime,'opencode.json'))).provider['cad-local'].options;
  const modelRequest=()=>fetch(gateway.baseURL+'/models',{headers:{authorization:'Bearer '+gateway.apiKey}});
  assert.equal((await modelRequest()).status,503);
  const update={base_url:`http://127.0.0.1:${upstream.address().port}/v1`,api_key:'TEST_SECRET_ROTATION_ONE'};
  const put=(value,headers={})=>fetch(connection.website+'/api/provider',{method:'PUT',headers:{'content-type':'application/json','x-cad-config-token':settings.config_token,...headers},body:JSON.stringify(value)});
  assert.equal((await put(update,{'x-cad-config-token':'wrong'})).status,403);
  assert.equal((await put(update,{origin:'https://evil.example'})).status,403);
  const badHost=await new Promise((resolve,reject)=>{
    const request=http.request(connection.website+'/api/provider',{method:'PUT',headers:{host:'evil.example','content-type':'application/json','x-cad-config-token':settings.config_token}},response=>{response.resume();response.on('end',()=>resolve(response.statusCode));});
    request.on('error',reject);request.end(JSON.stringify(update));
  });
  assert.equal(badHost,403);
  assert.equal((await put({...update,base_url:'file:///tmp/a'})).status,400);
  response=await put(update);assert.equal(response.status,200);assert.equal((await response.text()).includes(update.api_key),false);
  assert.equal((await modelRequest()).status,200);assert.equal(requests.at(-1),'Bearer '+update.api_key);
  const secret2='TEST_SECRET_ROTATION_TWO';assert.equal((await put({api_key:secret2})).status,200);
  assert.equal((await modelRequest()).status,200);assert.equal(requests.at(-1),'Bearer '+secret2);
  assert.equal((await put({base_url:update.base_url,api_key:''})).status,200);
  settings=await (await get()).json();assert.equal(settings.api_key_configured,true);assert.equal(JSON.stringify(settings).includes(secret2),false);
  const managed=path.join(f.runtime,'provider.json');assert.equal(JSON.parse(fs.readFileSync(managed)).apiKey,secret2);assert.equal(fs.statSync(managed).mode&0o777,0o600);
  assert.equal(fs.readFileSync(path.join(f.runtime,'opencode.json'),'utf8').includes(secret2),false);
  backend.child.kill('SIGTERM');await f.finish(backend);
  const next=f.cli(['--web']);await until(()=>{const c=f.connection();return c?.pid!==connection.pid&&c;});
  const restarted=f.connection();assert.equal((await (await fetch(restarted.website+'/api/provider')).json()).base_url,update.base_url);
  next.child.kill('SIGTERM');await f.finish(next);
});

test('CLI config accepts a key on stdin, displays no key and starts from the saved provider',async t=>{
  const f=await fixture(t),key='TEST_SECRET_STDIN_ONE';
  const r=f.cli(['config','--base-url','https://example.test/v1','--api-key-stdin'],{stdin:'pipe'});r.child.stdin.end(key+'\n');
  const result=await f.finish(r);assert.equal(result.exit.code,0,result.stderr);assert.equal((result.stdout+result.stderr).includes(key),false);
  const show=await f.finish(f.cli(['config','--show']));assert.equal(show.exit.code,0,show.stderr);
  assert.deepEqual(JSON.parse(show.stdout),{base_url:'https://example.test/v1',model:'qwen-v8',thinking:true,api_key_configured:true});assert.deepEqual(f.events(),[]);
  const web=f.cli(['--web']);const connection=await until(()=>f.connection());
  const changed=f.cli(['config','--base-url','https://changed.test/v1','--api-key-stdin'],{stdin:'pipe'});changed.child.stdin.end('TEST_SECRET_STDIN_TWO\n');
  assert.equal((await f.finish(changed)).exit.code,0);
  const stored=await (await fetch(connection.website+'/api/provider')).json();assert.equal(stored.base_url,'https://changed.test/v1');assert.equal(stored.api_key_configured,true);
  web.child.kill('SIGTERM');await f.finish(web);
});

test('web model selection changes actual upstream requests, CLI status and persisted startup model',async t=>{
  const forwarded=[];
  const upstream=http.createServer(async(req,res)=>{
    let raw='';for await(const chunk of req)raw+=chunk;
    res.writeHead(200,{'content-type':'application/json'});
    if(req.url==='/v1/models')return res.end(JSON.stringify({data:[{id:'Qwen/custom-27B'},{id:'gpt-6.1-sol'},{id:'Qwen/custom-27B'}]}));
    forwarded.push(JSON.parse(raw));res.end(JSON.stringify({id:'resp_mock',output:[]}));
  });
  await new Promise(resolve=>upstream.listen(0,'127.0.0.1',resolve));t.after(()=>new Promise(resolve=>upstream.close(resolve)));
  const f=await fixture(t),base=`http://127.0.0.1:${upstream.address().port}/v1`;
  fs.writeFileSync(f.credentials,JSON.stringify({baseURL:base,apiKey:'MODEL_SELECTION_TEST_KEY'}));
  const web=f.cli(['--web','--credentials',f.credentials]),connection=await until(()=>f.connection());
  const summary=await (await fetch(connection.website+'/api/provider')).json();
  const headers={'content-type':'application/json','x-cad-config-token':summary.config_token};
  let response=await fetch(connection.website+'/api/provider/models',{method:'POST',headers,body:JSON.stringify({})});
  assert.deepEqual((await response.json()).models,['Qwen/custom-27B','gpt-6.1-sol']);
  response=await fetch(connection.website+'/api/provider',{method:'PUT',headers,body:JSON.stringify({model:'Qwen/custom-27B'})});assert.equal(response.status,200);
  assert.equal((await response.json()).model,'Qwen/custom-27B');
  const gateway=JSON.parse(fs.readFileSync(path.join(f.runtime,'opencode.json'))).provider['cad-local'].options;
  const request=()=>fetch(gateway.baseURL+'/responses',{method:'POST',headers:{'content-type':'application/json',authorization:'Bearer '+gateway.apiKey},body:JSON.stringify({model:'qwen-v8',input:[{role:'assistant',content:[{type:'output_text',text:'progress'}]}]})});
  assert.equal((await request()).status,200);assert.equal(forwarded.at(-1).model,'Qwen/custom-27B');assert.equal(forwarded.at(-1).reasoning.effort,'medium');assert.equal(forwarded.at(-1).input[0].content[0].type,'input_text');
  assert.equal(forwarded.at(-1).chat_template_kwargs.enable_thinking,true);
  const off=await f.finish(f.cli(['config','--thinking','off']));assert.equal(off.exit.code,0,off.stderr);
  assert.equal((await request()).status,200);assert.equal(forwarded.at(-1).chat_template_kwargs.enable_thinking,false);assert.equal(forwarded.at(-1).reasoning.effort,'low');
  const on=await f.finish(f.cli(['config','--thinking','on']));assert.equal(on.exit.code,0,on.stderr);
  const cli=await f.finish(f.cli(['config','--model','gpt-6.1-sol']));assert.equal(cli.exit.code,0,cli.stderr);
  assert.equal((await request()).status,200);assert.equal(forwarded.at(-1).model,'gpt-6.1-sol');assert.equal(forwarded.at(-1).reasoning.effort,'high');assert.equal(forwarded.at(-1).input[0].content[0].type,'output_text');
  const show=await f.finish(f.cli(['config','--show']));assert.equal(JSON.parse(show.stdout).model,'gpt-6.1-sol');
  const list=await f.finish(f.cli(['config','--list-models']));assert.equal(list.exit.code,0,list.stderr);assert.match(list.stdout,/Qwen\/custom-27B/);
  const run=await f.finish(f.cli(['run','test routing only']));assert.equal(run.exit.code,0,run.stderr);
  assert.equal(f.events().find(e=>e.event==='spawn'&&e.mode==='run').argv.includes('cad-local/qwen-v8'),true);
  web.child.kill('SIGTERM');await f.finish(web);
  const next=f.cli(['--web']);const restarted=await until(()=>{const c=f.connection();return c?.pid!==connection.pid&&c;});
  const after=await (await fetch(restarted.website+'/api/config')).json();assert.equal(after.model,'gpt-6.1-sol');
  next.child.kill('SIGTERM');await f.finish(next);
});

test('CLI --help needs no credential and starts no backend',async t=>{
  const f=await fixture(t),r=await f.finish(f.cli(['--help']));
  assert.equal(r.exit.code,0);assert.match(r.stdout,/OpenCode terminal agent/);assert.match(r.stdout,/--file/);assert.match(r.stdout,/export SESSION_ID/);
  assert.equal(fs.existsSync(f.runtime),false);assert.deepEqual(f.events(),[]);
});

test('CLI export preserves inputs, reasoning, assistant text, tool calls and results; output is private and never silently overwritten',async t=>{
  const f=await fixture(t),id='ses_mock_previous',messagesFile=path.join(f.directory,'messages.json'),output=path.join(f.directory,'trajectory.json');
  f.env.MOCK_MESSAGES_FILE=messagesFile;
  const messages=[
    {info:{id:'msg_user',sessionID:id,role:'user'},parts:[{id:'part_input',type:'text',text:'重建 target.step'}]},
    {info:{id:'msg_assistant_1',sessionID:id,role:'assistant'},parts:[
      {id:'part_reasoning',type:'reasoning',text:'先检查输入 STEP 的面和实体。'},
      {id:'part_progress',type:'text',text:'我先读取模型结构。'},
      {id:'part_tool',type:'tool',tool:'exec',callID:'call_export_1',state:{status:'completed',input:{code:'const r = await tools.exec_command({cmd:"python inspect.py"}); text(r);'},output:'solid_count=1\\nfaces=12\\n',metadata:{}}}
    ]},
    {info:{id:'msg_assistant_2',sessionID:id,role:'assistant'},parts:[{id:'part_final',type:'text',text:'模型已检查完成。'}]}
  ];
  fs.writeFileSync(messagesFile,JSON.stringify(messages));
  const callID='call_export_1',code=messages[1].parts[2].state.input.code,outputText=messages[1].parts[2].state.output;
  const mediaContent=[{type:'input_text',text:'检查完成'}, {type:'input_image',image_url:'data:image/png;base64,aGVsbG8='}];
  const sha=value=>crypto.createHash('sha256').update(value).digest('hex');
  const mediaDirectory=path.join(f.runtime,'tool-media',sha(callID));fs.mkdirSync(mediaDirectory,{recursive:true});
  fs.writeFileSync(path.join(mediaDirectory,sha(id)+'.json'),JSON.stringify({version:1,sessionID:id,callID,tool:'exec',codeHash:sha(code),outputHash:sha(outputText),contentHash:sha(JSON.stringify(mediaContent)),failed:false,content:mediaContent}));
  messages[1].parts[2].state.metadata.cadMedia={callID};fs.writeFileSync(messagesFile,JSON.stringify(messages));
  const backend=f.cli(['--web','--credentials',f.credentials]),connection=await until(()=>f.connection());
  const exported=await f.finish(f.cli(['export',id,'--output',output]));
  assert.equal(exported.exit.code,0,exported.stderr);assert.match(exported.stdout,/3 条消息、1 次工具调用（1 条含结果）、1 份工具媒体/);
  assert.equal(fs.statSync(output).mode&0o777,0o600);
  const trajectory=JSON.parse(fs.readFileSync(output,'utf8'));
  assert.equal(trajectory.schema_version,'cad-code-session-v2');assert.equal(trajectory.id,id);assert.equal(trajectory.model,'qwen-v8');
  assert.deepEqual(trajectory.messages,messages);assert.equal(trajectory.tool_media.length,1);assert.deepEqual(trajectory.tool_media[0].content,mediaContent);
  assert.equal(trajectory.messages[0].parts[0].text,'重建 target.step');
  assert.equal(trajectory.messages[1].parts[0].text,'先检查输入 STEP 的面和实体。');
  assert.equal(trajectory.messages[1].parts[1].text,'我先读取模型结构。');
  assert.equal(trajectory.messages[1].parts[2].state.input.code.includes('inspect.py'),true);
  assert.equal(trajectory.messages[1].parts[2].state.output,'solid_count=1\\nfaces=12\\n');
  assert.equal(trajectory.messages[2].parts[0].text,'模型已检查完成。');
  const blocked=await f.finish(f.cli(['export',id,'-o',output]));assert.notEqual(blocked.exit.code,0);assert.match(blocked.stderr,/EEXIST|already exists/i);
  assert.deepEqual(JSON.parse(fs.readFileSync(output,'utf8')),trajectory);
  const replaced=await f.finish(f.cli(['export',id,'--output',output,'--force']));assert.equal(replaced.exit.code,0,replaced.stderr);
  const streamed=await f.finish(f.cli(['export',id,'--output','-']));assert.equal(streamed.exit.code,0,streamed.stderr);
  assert.deepEqual(JSON.parse(streamed.stdout),trajectory);
  assert.equal(streamed.stderr,'');
  backend.child.kill('SIGTERM');await f.finish(backend);
});

test('CLI export rejects invalid IDs and does not create a destination when the session is missing',async t=>{
  const f=await fixture(t),backend=f.cli(['--web','--credentials',f.credentials]);await until(()=>f.connection());
  const invalid=await f.finish(f.cli(['export','not-a-session']));assert.notEqual(invalid.exit.code,0);assert.match(invalid.stderr,/cad-code export/);
  const output=path.join(f.directory,'missing.json'),missing=await f.finish(f.cli(['export','ses_missing','--output',output]));
  assert.notEqual(missing.exit.code,0);assert.equal(fs.existsSync(output),false);
  backend.child.kill('SIGTERM');await f.finish(backend);
});

test('workspace and conversation deletion are independent, authenticated, and do not recreate a cleared workspace',async t=>{
  const f=await fixture(t),statusFile=path.join(f.directory,'status.json'),delayFile=path.join(f.directory,'delay-message');f.env.MOCK_STATUS_FILE=statusFile;f.env.MOCK_MESSAGE_DELAY_FILE=delayFile;
  const backend=f.cli(['--web','--credentials',f.credentials]),connection=await until(()=>f.connection());
  const id='ses_mock_previous',child='ses_mock_child',work=path.join(f.workspace,id);
  fs.mkdirSync(work,{recursive:true});fs.writeFileSync(path.join(work,'model.py'),'geometry code');fs.writeFileSync(path.join(work,'.cad-events.jsonl'),'original trace\n');
  const inventory=await (await fetch(connection.website+'/api/data')).json();assert.ok(inventory.items.find(x=>x.id===id).hasWorkspace);
  const remove=(scope,token=inventory.config_token)=>fetch(connection.website+'/api/sessions/'+id+'/'+scope,{method:'DELETE',headers:{'content-type':'application/json','x-cad-config-token':token},body:JSON.stringify({confirm:id})});
  assert.equal((await remove('workspace','wrong')).status,403);
  fs.writeFileSync(statusFile,JSON.stringify({[child]:{type:'busy'}}));assert.equal((await remove('workspace')).status,409);assert.equal(fs.existsSync(path.join(work,'model.py')),true);
  fs.writeFileSync(statusFile,'{}');assert.equal((await remove('workspace')).status,200);assert.equal(fs.existsSync(work),false);
  const archive=path.join(f.runtime,'trajectory-archives',id);assert.equal(fs.existsSync(archive),true);
  const after=await fetch(connection.website+'/api/sessions/'+id);assert.equal(after.status,200);assert.equal(fs.existsSync(work),false);
  const send=await new Promise(resolve=>{
    const request=http.request(connection.website+'/api/sessions/'+id+'/send',{method:'POST',headers:{'content-type':'application/json'}},response=>{response.resume();response.on('end',()=>resolve({request,status:response.statusCode}));});
    request.on('error',()=>{});request.write('{"text":');
    setTimeout(async()=>{await remove('workspace');request.end('"stale task"}');},60);
  });
  assert.equal(send.status,409);assert.equal(fs.existsSync(work),false);
  fs.mkdirSync(work);fs.writeFileSync(path.join(work,'model.py'),'retained geometry');fs.writeFileSync(path.join(work,'.cad-events.jsonl'),'new trace');
  const other=path.join(f.workspace,'ses_mock_existing');fs.mkdirSync(other,{recursive:true});fs.writeFileSync(path.join(other,'keep.step'),'other geometry');
  fs.writeFileSync(delayFile,'delay');const previousReads=f.events().filter(e=>e.path==='/session/'+id+'/message').length;
  const staleRead=fetch(connection.website+'/api/sessions/'+id);await until(()=>f.events().filter(e=>e.path==='/session/'+id+'/message').length>previousReads);
  const result=await remove('conversation');assert.equal(result.status,200);assert.deepEqual((await result.json()).deleted_sessions.sort(),[id,child].sort());
  assert.equal((await staleRead).status,404);assert.equal(fs.existsSync(path.join(work,'.conversation.json')),false);
  assert.equal(fs.readFileSync(path.join(work,'model.py'),'utf8'),'retained geometry');assert.equal(fs.existsSync(path.join(work,'.cad-events.jsonl')),false);assert.equal(fs.existsSync(archive),false);
  assert.equal(fs.readFileSync(path.join(other,'keep.step'),'utf8'),'other geometry');
  const final=await (await fetch(connection.website+'/api/data')).json();const orphan=final.items.find(x=>x.id===id);assert.equal(orphan.hasWorkspace,true);assert.equal(orphan.hasConversation,false);
  assert.equal((await fetch(connection.website+'/api/sessions/'+id)).status,404);
  const listing=await f.finish(f.cli(['list']));assert.equal(listing.exit.code,0,listing.stderr);assert.match(listing.stdout,/ses_mock_previous/);
  const denied=await f.finish(f.cli(['delete','workspace',id]));assert.notEqual(denied.exit.code,0);assert.match(denied.stderr,/confirmation/);
  const deleted=await f.finish(f.cli(['delete','workspace',id,'--yes']));assert.equal(deleted.exit.code,0,deleted.stderr);assert.equal(fs.existsSync(work),false);
  backend.child.kill('SIGTERM');await f.finish(backend);
});

test('headless CLI without credentials gives configuration instructions without starting a backend',async t=>{
  const f=await fixture(t),r=await f.finish(f.cli([]));
  assert.notEqual(r.exit.code,0);assert.match(r.stderr,/cad-code config/);
  assert.equal(fs.existsSync(path.join(f.runtime,'startup.lock')),false);assert.deepEqual(f.events(),[]);
});

test('CLI --file creates/binds one session, uses isolated config and cleans up its own backend',async t=>{
  const f=await fixture(t),source=path.join(f.directory,'圆柱.step'),bytes=Buffer.from('ISO-10303-21;\n原始输入\nEND-ISO-10303-21;');fs.writeFileSync(source,bytes);
  f.env.CAD_CODE_SINGLE_SOLID='1';
  const r=await f.finish(f.cli(['--credentials',f.credentials,'--file',source,'--mini']));
  assert.equal(r.exit.code,0,r.stderr);
  const events=f.events(),created=events.find(e=>e.event==='request'&&e.path==='/session'&&e.method==='POST');assert.ok(created);
  assert.equal(events.filter(e=>e.event==='request'&&e.path==='/session'&&e.method==='POST').length,1);
  const attach=events.find(e=>e.event==='spawn'&&e.mode==='attach');assert.ok(attach);
  assert.equal(attach.argv[attach.argv.indexOf('--session')+1],'ses_mock_created_1');assert.ok(attach.argv.includes('--mini'));
  assert.equal(attach.argv[attach.argv.indexOf('--dir')+1],f.workspace);
  assert.equal(attach.env.OPENCODE_CONFIG,path.join(f.runtime,'opencode.json'));assert.equal(attach.env.XDG_DATA_HOME,path.join(f.runtime,'xdg/data'));assert.equal(attach.env.passwordConfigured,true);
  assert.doesNotMatch(fs.readFileSync(path.join(f.runtime,'opencode.json'),'utf8'),/MOCK_ONLY_NOT_A_REAL_CREDENTIAL/);
  assert.equal(fs.statSync(path.join(f.runtime,'opencode.json')).mode&0o777,0o600);
  assert.deepEqual(fs.readFileSync(path.join(f.workspace,'ses_mock_created_1/input/圆柱.step')),bytes);assert.deepEqual(fs.readFileSync(source),bytes);
  assert.ok(fs.statSync(path.join(f.workspace,'ses_mock_created_1/.git')).isDirectory());assert.equal(fs.existsSync(path.join(f.workspace,'ses_mock_created_1/tools')),false);
  const connection=f.connection();assert.ok(connection);await until(()=>!alive(connection.pid));
  const serve=events.find(e=>e.event==='spawn'&&e.mode==='serve');await until(()=>!alive(serve.pid));
});

test('CLI --file --session imports into the requested existing session',async t=>{
  const f=await fixture(t),source=path.join(f.directory,'target.step');fs.writeFileSync(source,'existing input');
  const r=await f.finish(f.cli(['--credentials',f.credentials,'--session','ses_mock_existing','--file',source]));assert.equal(r.exit.code,0,r.stderr);
  assert.equal(f.events().filter(e=>e.event==='request'&&e.path==='/session'&&e.method==='POST').length,0);
  assert.equal(fs.readFileSync(path.join(f.workspace,'ses_mock_existing/input/target.step'),'utf8'),'existing input');
  const attach=f.events().find(e=>e.event==='spawn'&&e.mode==='attach');assert.equal(attach.argv[attach.argv.indexOf('--session')+1],'ses_mock_existing');
});

test('CLI --file --continue selects the most recent parent session rather than a child',async t=>{
  const f=await fixture(t),source=path.join(f.directory,'target.step');fs.writeFileSync(source,'continue input');
  const r=await f.finish(f.cli(['--credentials',f.credentials,'--continue','--file',source]));assert.equal(r.exit.code,0,r.stderr);
  const attach=f.events().find(e=>e.event==='spawn'&&e.mode==='attach');assert.equal(attach.argv.includes('--continue'),false);assert.equal(attach.argv[attach.argv.indexOf('--session')+1],'ses_mock_previous');
  assert.equal(fs.readFileSync(path.join(f.workspace,'ses_mock_previous/input/target.step'),'utf8'),'continue input');
});

test('CLI file-import failure exits nonzero and tears down its newly owned backend',async t=>{
  const f=await fixture(t),source=path.join(f.directory,'not-there.step');
  f.env.CAD_CODE_SINGLE_SOLID='1';
  const r=await f.finish(f.cli(['--credentials',f.credentials,'--file',source]));
  assert.notEqual(r.exit.code,0);assert.match(r.stderr,/ENOENT|no such file/i);
  assert.equal(f.events().some(e=>e.event==='spawn'&&e.mode==='attach'),false);
  const connection=f.connection();assert.ok(connection);await until(()=>!alive(connection.pid));
  const serve=f.events().find(e=>e.event==='spawn'&&e.mode==='serve');await until(()=>!alive(serve.pid));
});

test('CLI --web keeps its owned backend until termination and does not spawn a terminal',async t=>{
  const f=await fixture(t),r=f.cli(['--web','--credentials',f.credentials]);
  const connection=await until(()=>f.connection());
  await until(()=>r.stdout.includes('可选网页'));
  assert.equal(r.exit,null);assert.equal(f.events().some(e=>e.event==='spawn'&&['attach','run'].includes(e.mode)),false);
  const response=await fetch(connection.website+'/api/config');assert.equal(response.status,200);assert.equal((await response.json()).model,'qwen-v8');
  const created=await fetch(connection.website+'/api/sessions',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({title:'Workspace tools'})});
  assert.equal(created.status,200);const session=await created.json();
  assert.ok(fs.statSync(path.join(f.workspace,session.id,'.git')).isDirectory());assert.equal(fs.existsSync(path.join(f.workspace,session.id,'tools')),false);
  r.child.kill('SIGTERM');const exited=await f.finish(r);assert.equal(exited.exit.code,0);
  await until(()=>!alive(connection.pid));
});

test('CLI reuses a healthy backend without stopping it, and run mode selects its model',async t=>{
  const f=await fixture(t),backend=f.start(process.execPath,[path.join(ROOT,'src/server.mjs'),'--web','--credentials',f.credentials]);
  const connection=await until(()=>f.connection());
  const r=await f.finish(f.cli(['run','只读取环境，不调用外部模型']));assert.equal(r.exit.code,0,r.stderr);
  assert.equal(alive(backend.child.pid),true);
  const response=await fetch(connection.url+'/global/health',{headers:{authorization:'Basic '+Buffer.from('opencode:'+connection.password).toString('base64')}});assert.equal(response.status,200);
  const events=f.events();assert.equal(events.filter(e=>e.event==='spawn'&&e.mode==='serve').length,1);
  const run=events.find(e=>e.event==='spawn'&&e.mode==='run');assert.ok(run);assert.ok(run.argv.includes('--thinking'));assert.equal(run.argv[run.argv.indexOf('--attach')+1],connection.url);assert.equal(run.argv[run.argv.indexOf('--model')+1],'cad-local/qwen-v8');
  assert.equal(events.some(e=>e.event==='terminated'),false);
  backend.child.kill('SIGTERM');await f.finish(backend);
});
