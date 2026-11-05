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
  function start(exe,args){const child=spawn(exe,args,{cwd:ROOT,env,stdio:['ignore','pipe','pipe']});const result={child,stdout:'',stderr:'',exit:null};child.stdout.setEncoding('utf8');child.stderr.setEncoding('utf8');child.stdout.on('data',x=>result.stdout+=x);child.stderr.on('data',x=>result.stderr+=x);result.finished=new Promise((resolve,reject)=>{child.on('error',reject);child.on('close',(code,signal)=>{result.exit={code,signal};resolve(result);});});running.push(result);return result;}
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
  return {directory,runtime,workspace,credentials,env,port,ocPort,gatewayPort,events,connection,start,finish,cli:args=>start(path.join(ROOT,'cad-code'),args)};
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

test('CLI --help needs no credential and starts no backend',async t=>{
  const f=await fixture(t),r=await f.finish(f.cli(['--help']));
  assert.equal(r.exit.code,0);assert.match(r.stdout,/OpenCode terminal agent/);assert.match(r.stdout,/--file/);
  assert.equal(fs.existsSync(f.runtime),false);assert.deepEqual(f.events(),[]);
});

test('CLI first start without credentials fails cleanly and releases its startup lock',async t=>{
  const f=await fixture(t),r=await f.finish(f.cli([]));
  assert.notEqual(r.exit.code,0,JSON.stringify({stdout:r.stdout,stderr:r.stderr,events:f.events()}));assert.match(r.stderr,/startup failed/i);
  assert.match(fs.readFileSync(path.join(f.runtime,'launcher.log'),'utf8'),/Provide --credentials/);
  assert.equal(fs.existsSync(path.join(f.runtime,'startup.lock')),false);assert.deepEqual(f.events(),[]);
});

test('CLI --file creates/binds one session, uses isolated config and cleans up its own backend',async t=>{
  const f=await fixture(t),source=path.join(f.directory,'圆柱.step'),bytes=Buffer.from('ISO-10303-21;\n原始输入\nEND-ISO-10303-21;');fs.writeFileSync(source,bytes);
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
  for(const name of ['stepir.py','cadeval.py','families_common.py'])assert.ok(fs.statSync(path.join(f.workspace,'ses_mock_created_1/tools',name)).isFile());
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
  for(const name of ['stepir.py','cadeval.py','families_common.py','cadthreads.py','robust_iou.py','frozen/compare.py'])assert.ok(fs.statSync(path.join(f.workspace,session.id,'tools',name)).isFile());
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
