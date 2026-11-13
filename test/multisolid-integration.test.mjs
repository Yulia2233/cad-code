import assert from 'node:assert/strict';
import {test} from 'node:test';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import http from 'node:http';
import net from 'node:net';
import crypto from 'node:crypto';
import {spawn, spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {readProject, updateProject} from '../multi/store.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PYTHON = process.env.CAD_CODE_PYTHON || path.join(ROOT, '.runtime/python/bin/python');
const sha = value => crypto.createHash('sha256').update(value).digest('hex');
const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==';
const partSource = `# /// script
# requires-python = ">=3.10"
# dependencies = ["simplecadapi"]
# [tool.simplecadapi]
# id = "model"
# revision = "1.0.0"
# ///
import marimo
app = marimo.App()
with app.setup:
    import simplecadapi as scad
@app.cell
def _():
    # ---- feature: box (build) ----
    box = scad.make_box_rsolid(2., 3., 4.)
    return (box,)
@app.cell
def _(box):
    model = scad.Part(part_id="model", body=box)
    return (model,)
if __name__ == "__main__":
    app.run()
`;

// This fake serves the real OpenCode HTTP contract, imports the configured
// plugin, executes its real tool and sends its output through the real gateway.
// Only the model's authoring decision is fixed; no external model is contacted.
const mockOpenCode = String.raw`#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
const record = value => fs.appendFileSync(process.env.MOCK_RECORD, JSON.stringify(value) + '\n');
const argv=process.argv.slice(2), mode=argv[0];
record({event:'process',pid:process.pid,ppid:process.ppid,mode,runtime:process.env.CAD_CODE_RUNTIME});
if(mode!=='serve') { record({event:'cli',argv}); process.exit(0); }
const config=JSON.parse(fs.readFileSync(process.env.OPENCODE_CONFIG));
const sessions=[],messages=new Map(),statuses={}; let serial=0;
const client={session:{get:async ({path:{id}})=>({data:sessions.find(s=>s.id===id)})}};
const plugin=await (await import(config.plugin[0])).default({client});
const auth='Basic '+Buffer.from('opencode:'+process.env.OPENCODE_SERVER_PASSWORD).toString('base64');
const json=(res,value,status=200)=>{res.writeHead(status,{'content-type':'application/json'});res.end(JSON.stringify(value));};
async function author(id,input) {
  const list=messages.get(id),work=path.join(process.env.CAD_CODE_WORKSPACE,id);
  try {
    const system={system:[config.agent[input.agent].prompt]};
    await plugin['experimental.chat.system.transform']({sessionID:id,model:{id:input.model.modelID,api:{id:input.model.modelID}}},system);
    record({event:'compiled',session:id,role:input.agent,system:system.system,runtime:process.env.CAD_CODE_RUNTIME});
    const ir=JSON.parse(fs.readFileSync(path.join(work,'input/assembly.ir.json')));
    const scaffold=fs.readFileSync(path.join(work,'out/product.py'),'utf8');
    const contextIndex=JSON.parse(fs.readFileSync(path.join(work,'input/assembly-context-index.json'),'utf8'));
    const adaptedParts=ir.unique_parts.map(part=>fs.readFileSync(path.join(work,'out/parts',part.id,'model.py'),'utf8')).join('\n');
    record({event:'scaffold',session:id,uses:(scaffold.match(/scad\.use\(/g)||[]).length,
      components:(scaffold.match(/scad\.add_component_rassembly\(/g)||[]).length,
      grounds:(scaffold.match(/scad\.ground_component_rassembly\(/g)||[]).length,
      fixed_constraints:(scaffold.match(/scad\.add_fixed_constraint_rassembly\(/g)||[]).length,
      source_occurrences:(scaffold.match(/"id":"instance-/g)||[]).length,
      connectors:(adaptedParts.match(/scad\.add_connector_rpart\(/g)||[]).length,
      context_index:contextIndex.schema_version,occurrences:contextIndex.counts.occurrences});
    const source=['# /// script','# requires-python = ">=3.10"','# dependencies = ["simplecadapi"]','# [tool.simplecadapi]','# id = "product"','# revision = "1.0.0"','# ///','import marimo','app = marimo.App()','with app.setup:','    import simplecadapi as scad','@app.cell','def _():'];
    for(const [index,part] of ir.unique_parts.entries())source.push('    p'+index+' = scad.use('+JSON.stringify('parts/'+part.id+'/model.py')+', id='+JSON.stringify(part.id)+')');
    source.push('    _assembly = scad.make_assembly_rassembly(assembly_id="product")');
    for(const instance of ir.instances){const i=ir.unique_parts.findIndex(p=>p.id===instance.part_id),p=instance.placement;source.push('    _assembly = scad.add_component_rassembly(_assembly, p'+i+', '+JSON.stringify(instance.id)+', scad.make_placement_rplacement('+JSON.stringify(p.origin)+', '+JSON.stringify(p.x_axis)+', '+JSON.stringify(p.y_axis)+'))');}
    source.push('    product = _assembly','    return (product,)','if __name__ == "__main__":','    app.run()','');
    const product=source.join('\n'),destination=path.join(work,'out/product.py');
    const patch=fs.existsSync(destination)
      ?'*** Begin Patch\n*** Update File: out/product.py\n@@\n'+fs.readFileSync(destination,'utf8').trimEnd().split('\n').map(line=>'-'+line).join('\n')+'\n'+product.trimEnd().split('\n').map(line=>'+'+line).join('\n')+'\n*** End Patch'
      :'*** Begin Patch\n*** Add File: out/product.py\n'+product.split('\n').map(line=>'+'+line).join('\n')+'\n*** End Patch';
    fs.mkdirSync(path.join(work,'out'),{recursive:true});
    fs.writeFileSync(path.join(work,'out/preview.png'),Buffer.from(process.env.MOCK_PNG,'base64'));
    const code='text(await tools.apply_patch('+JSON.stringify(patch)+')); image(await tools.view_image({path:"out/preview.png"}));';
    const callID='call_integration_'+serial;
    const output=await plugin.tool.exec.execute({code},{sessionID:id,callID,agent:input.agent,abort:new AbortController().signal,metadata:()=>{}});
    list.push({info:{id:'toolmsg_'+serial,role:'assistant',time:{created:Date.now(),completed:Date.now()},finish:'tool-calls'},parts:[{id:'toolpart_'+serial,type:'tool',tool:'exec',callID,state:{status:'completed',input:{code},output:output.output,metadata:output.metadata}}]});
    const provider=config.provider['cad-local'].options;
    const forwarded=await fetch(provider.baseURL+'/responses',{method:'POST',headers:{authorization:'Bearer '+provider.apiKey,'content-type':'application/json','x-cad-session-id':id},body:JSON.stringify({model:input.model.modelID,input:[{type:'function_call',call_id:callID,name:'exec',arguments:JSON.stringify({code})},{type:'function_call_output',call_id:callID,output:output.output}],stream:false})});
    if(!forwarded.ok)throw Error('Gateway rejected tool media: '+forwarded.status+' '+await forwarded.text());
    await forwarded.text();
    list.push({info:{id:'final_'+serial,role:'assistant',time:{created:Date.now(),completed:Date.now()},finish:'stop'},parts:[{type:'reasoning',text:''},{type:'text',text:'Fixture assembly code created. Independent evaluation is pending.'}]});
  }catch(error){record({event:'author_error',session:id,error:error.stack});list.push({info:{id:'error_'+serial,role:'assistant',time:{created:Date.now(),completed:Date.now()},error:{message:error.message}},parts:[]});}
  statuses[id]={type:'idle'};
}
const sockets=new Set();
const server=http.createServer(async(req,res)=>{
 try {
  if(req.headers.authorization!==auth)return json(res,{error:'unauthorized'},401);
  const route=new URL(req.url,'http://localhost').pathname;
  let raw='';for await(const chunk of req)raw+=chunk;const body=raw?JSON.parse(raw):null;
  record({event:'request',method:req.method,route,runtime:process.env.CAD_CODE_RUNTIME});
  if(route==='/event'){res.writeHead(200,{'content-type':'text/event-stream'});res.write('data: {"type":"server.connected"}\n\n');return;}
  if(route==='/global/health')return json(res,{healthy:true});
  if(route==='/session/status')return json(res,statuses);
  if(route==='/session'&&req.method==='POST'){const value={id:'ses_integration_'+process.pid+'_'+(++serial),title:body.title,time:{created:Date.now(),updated:Date.now()}};sessions.push(value);messages.set(value.id,[]);statuses[value.id]={type:'idle'};await plugin.event?.({event:{type:'session.created',properties:{info:value}}});return json(res,value);}
  if(route==='/session')return json(res,sessions);
  const match=route.match(/^\/session\/(ses_[\w-]+)(?:\/(.*))?$/);
  if(match){const [,id,action]=match;if(!messages.has(id))return json(res,{error:'missing'},404);
    if(!action)return json(res,sessions.find(s=>s.id===id));
    if(action==='message')return json(res,messages.get(id));
    if(action==='abort'){statuses[id]={type:'idle'};return json(res,true);}
    if(action==='prompt_async'){serial++;messages.get(id).push({info:{id:'user_'+serial,role:'user',time:{created:Date.now()}},parts:body.parts});statuses[id]={type:'busy'};setTimeout(()=>author(id,body),100);return json(res,true);}
  }
  return json(res,{error:'unknown route '+route},404);
 }catch(error){json(res,{error:error.stack},500);}
});
server.on('connection',s=>{sockets.add(s);s.on('close',()=>sockets.delete(s));});
server.listen(Number(argv[argv.indexOf('--port')+1]),'127.0.0.1');
process.on('SIGTERM',async()=>{await plugin.dispose?.();for(const socket of sockets)socket.destroy();server.close(()=>process.exit(0));setTimeout(()=>process.exit(0),300).unref();});
`;

async function ports(count) {
  const listeners=[];
  try {
    for(let i=0;i<count;i++){const listener=net.createServer();await new Promise(resolve=>listener.listen(0,'127.0.0.1',resolve));listeners.push(listener);}
    return listeners.map(listener=>listener.address().port);
  }finally{await Promise.all(listeners.map(listener=>new Promise(resolve=>listener.close(resolve))));}
}
async function until(check, timeout=20000) {
  const deadline=Date.now()+timeout;
  while(Date.now()<deadline){const result=await check();if(result)return result;await new Promise(resolve=>setTimeout(resolve,70));}
  throw Error('Timed out waiting for integration state');
}
function readJSON(file){return JSON.parse(fs.readFileSync(file,'utf8'));}

async function fixture(t) {
  const temporary=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'cad-multisolid-integration-')));
  const runtime=path.join(temporary,'runtime'),workspace=path.join(temporary,'workspace'),projects=path.join(temporary,'projects');
  fs.mkdirSync(runtime);fs.mkdirSync(workspace);fs.mkdirSync(projects);
  const record=path.join(temporary,'events.jsonl'),binary=path.join(temporary,'opencode-mock.mjs');
  fs.writeFileSync(binary,mockOpenCode,{mode:0o700});
  const fixtureCode=`import simplecadapi as s, simplecadapi._cpp as n\nfrom pathlib import Path\np=Path(${JSON.stringify(temporary)})\na=s.make_box_rsolid(2.,3.,4.)\nb=s.translate_shape(a,(10.,0.,0.))\nn.export_step([a],p/'single.step')\nn.export_step([a,b],p/'double.step')\n`;
  const generated=spawnSync(PYTHON,['-I','-c',fixtureCode],{encoding:'utf8'});
  assert.equal(generated.status,0,generated.stderr);
  const forwarded=[];
  const upstream=http.createServer(async(req,res)=>{let input='';for await(const chunk of req)input+=chunk;forwarded.push(JSON.parse(input));res.writeHead(200,{'content-type':'application/json'});res.end('{"id":"resp_mock","output":[]}');});
  await new Promise(resolve=>upstream.listen(0,'127.0.0.1',resolve));
  const credentials=path.join(temporary,'provider.json');
  fs.writeFileSync(credentials,JSON.stringify({baseURL:`http://127.0.0.1:${upstream.address().port}/v1`,apiKey:'INTEGRATION_MOCK_ONLY',model:'gpt-6.1-sol',thinking:true}),{mode:0o600});
  const pyInfo=spawnSync(PYTHON,['-I','-c','import json,sys;print(json.dumps({"library_roots":[sys.base_prefix]}))'],{encoding:'utf8'});
  assert.equal(pyInfo.status,0,pyInfo.stderr);fs.writeFileSync(path.join(runtime,'python-environment.json'),pyInfo.stdout);
  const [port,basePort,ocPort,gatewayPort]=await ports(4);
  const env={...process.env,CAD_CODE_RUNTIME:runtime,CAD_CODE_WORKSPACE:workspace,CAD_CODE_PYTHON:PYTHON,CAD_CODE_MULTISOLID_PROJECTS:projects,CAD_CODE_MULTI_PORT:String(port),PORT:String(basePort),CAD_CODE_OPENCODE_PORT:String(ocPort),CAD_CODE_GATEWAY_PORT:String(gatewayPort),CAD_CODE_CREDENTIALS:credentials,CAD_CODE_ASSEMBLY_SKILL:path.join(ROOT,'tools/assembly-skill'),OPENCODE_BIN:binary,MOCK_RECORD:record,MOCK_PNG:png};
  delete env.CAD_CODE_ASSEMBLY_CONTEXT_FILE;
  const running=[];
  function start(args){const child=spawn(process.execPath,args,{cwd:ROOT,env,stdio:['ignore','pipe','pipe']});const state={child,stdout:'',stderr:''};child.stdout.on('data',x=>state.stdout+=x);child.stderr.on('data',x=>state.stderr+=x);state.finished=new Promise(resolve=>child.once('close',code=>resolve({...state,code})));running.push(state);return state;}
  const server=start(['multi/server.mjs']);
  const events=()=>fs.existsSync(record)?fs.readFileSync(record,'utf8').trim().split('\n').filter(Boolean).map(JSON.parse):[];
  t.after(async()=>{
    for(const run of running)if(run.child.exitCode===null)run.child.kill('SIGTERM');
    const pids=new Set(events().filter(e=>e.event==='process').flatMap(e=>[e.pid,e.ppid]));
    for(const pid of pids)if(pid!==process.pid)try{process.kill(pid,'SIGTERM');}catch{}
    await Promise.race([Promise.all(running.map(r=>r.finished)),new Promise(resolve=>setTimeout(resolve,2000))]);
    await new Promise(resolve=>upstream.close(resolve));
    if(process.env.CAD_CODE_KEEP_INTEGRATION_TMP)t.diagnostic('Integration artifacts: '+temporary);
    else fs.rmSync(temporary,{recursive:true,force:true});
  });
  const base=`http://127.0.0.1:${port}`;
  await until(async()=>{if(server.child.exitCode!==null)throw Error(server.stderr);try{return (await fetch(base+'/api/config')).ok;}catch{return false;}});
  async function api(route,method='GET',body){const response=await fetch(base+route,{method,...(body===undefined?{}:{headers:{'content-type':'application/json'},body:JSON.stringify(body)})});return {status:response.status,body:await response.json()};}
  async function upload(file,name){const form=new FormData();form.append('step',new Blob([fs.readFileSync(file)]),name);const response=await fetch(base+'/api/projects',{method:'POST',body:form});return {status:response.status,body:await response.json()};}
  return {temporary,runtime,workspace,projects,record,env,start,events,forwarded,api,upload,base};
}

test('real multi HTTP + plugin + gateway + isolated evaluation + export integration', {skip: !fs.existsSync(PYTHON), timeout: 180000}, async t => {
  const f=await fixture(t);
  await t.test('malformed uploads fail without creating registered projects',async()=>{
    const invalid=await f.api('/api/projects','POST',{step:'not multipart'});
    assert.equal(invalid.status,400);assert.match(invalid.body.error,/multipart/);
    assert.equal((await f.api('/api/projects')).body.length,0);
  });
  await t.test('single-solid upload delegates the original file to an ordinary session',async()=>{
    const result=await f.upload(path.join(f.temporary,'single.step'),'single.step');
    assert.equal(result.status,201,JSON.stringify(result.body));
    assert.equal(result.body.kind,'single');
    assert.equal(sha(fs.readFileSync(path.join(f.workspace,result.body.session_id,'input/single.step'))),sha(fs.readFileSync(path.join(f.temporary,'single.step'))));
    assert.equal(readJSON(path.join(f.runtime,'opencode.json')).default_agent,'cad-code');
  });
  const uploaded=await f.upload(path.join(f.temporary,'double.step'),'double.step');
  assert.equal(uploaded.status,201,JSON.stringify(uploaded.body));
  const id=uploaded.body.project_id;
  const registration=readJSON(path.join(f.runtime,'multi/projects.json')).projects.find(row=>row.id===id);
  const projectRoot=registration.path;
  await t.test('multi-solid upload performs actual split, dedup and v6.3 IR preparation',()=>{
    assert.equal(uploaded.body.solid_count,2);
    assert.equal(uploaded.body.unique_parts.length,1);
    assert.equal(uploaded.body.unique_parts[0].stepir_version,'v6.3');
    assert.equal(uploaded.body.instances.length,2);
    assert.equal(sha(fs.readFileSync(path.join(projectRoot,'source/source.step'))),sha(fs.readFileSync(path.join(f.temporary,'double.step'))));
  });
  const originalHashes=new Map();
  let project=readProject(projectRoot);
  project=updateProject(projectRoot,project.revision,next=>{next.state='parts_queued';});
  project=updateProject(projectRoot,project.revision,next=>{next.state='parts_finished';});
  project=updateProject(projectRoot,project.revision,next=>{
    for(const part of next.unique_parts){const dir=`parts/${part.id}/attempt-fixture`;fs.mkdirSync(path.join(projectRoot,dir),{recursive:true});const notebook=path.join(dir,'model.py'),step=path.join(dir,'model.step');fs.writeFileSync(path.join(projectRoot,notebook),partSource);fs.copyFileSync(path.join(projectRoot,part.target_step),path.join(projectRoot,step));originalHashes.set(part.id,sha(partSource));part.status='completed';part.attempts=[{id:'attempt-fixture',status:'completed',session_id:'ses_fixture_child',deliverables:{model_py:notebook,model_step:step},verdict:{ok:true,riou:1}}];}
  });
  for(const part of project.unique_parts){
    const bounds=part.metrics.bbox_mm,size=part.metrics.bbox_size_mm;
    const center=bounds.min.map((value,index)=>(value+bounds.max[index])/2);
    const source=partSource.replace('box = scad.make_box_rsolid(2., 3., 4.)','box = scad.make_box_rsolid('+size.join(', ')+')\n    box = scad.translate_shape(box, ('+[center[0],center[1],bounds.min[2]].join(', ')+'))');
    fs.writeFileSync(path.join(projectRoot,part.attempts[0].deliverables.model_py),source);
    originalHashes.set(part.id,sha(source));
  }
  const parts=project.unique_parts.map(part=>({part_id:part.id,attempt_id:'attempt-fixture'}));
  await t.test('malformed selection and IR hash drift fail before creating an assembly',async()=>{
    const invalid=await f.api(`/api/projects/${id}/assemble`,'POST',{parts:[]});assert.equal(invalid.status,400);
    const part=project.unique_parts[0],file=path.join(projectRoot,part.stepir),before=fs.readFileSync(file);fs.appendFileSync(file,'\n');
    try{const drift=await f.api(`/api/projects/${id}/assemble`,'POST',{parts});assert.equal(drift.status,400);assert.match(drift.body.error,/hash mismatch/);}finally{fs.writeFileSync(file,before);}
    assert.equal(readProject(projectRoot).assembly_attempts.length,0);
  });
  await t.test('failed assembly without a session returns its saved error without contacting the stopped runtime',async()=>{
    let current=readProject(projectRoot);
    current=updateProject(projectRoot,current.revision,next=>next.assembly_attempts.push({id:'assembly-failed-fixture',status:'failed',session_id:null,attempt_dir:null,runtime_dir:'assembly/missing/runtime',error:'The operation was aborted due to timeout'}));
    const response=await f.api(`/api/projects/${id}/assembly/assembly-failed-fixture`);
    assert.equal(response.status,200,JSON.stringify(response.body));
    assert.equal(response.body.session_id,null);
    assert.deepEqual(response.body.messages,[]);
    assert.match(response.body.error,/aborted due to timeout/);
    current=readProject(projectRoot);
    updateProject(projectRoot,current.revision,next=>{next.assembly_attempts=next.assembly_attempts.filter(row=>row.id!=='assembly-failed-fixture');});
  });
  const started=await f.api(`/api/projects/${id}/assemble`,'POST',{parts});
  assert.equal(started.status,202,JSON.stringify(started.body));
  const attemptID=started.body.attempt_id;
  await t.test('repeated start cannot create duplicate active assembly conversations',async()=>{
    const again=await f.api(`/api/projects/${id}/assemble`,'POST',{parts});
    assert.notEqual(again.status,202,JSON.stringify(again.body));
    assert.equal(readProject(projectRoot).assembly_attempts.length,1);
  });
  await until(()=>f.events().some(e=>e.event==='compiled'&&e.role==='cad-assembly'),15000);
  await t.test('controller stages a bounded context index and complete deterministic source-pose scaffold',()=>{
    const scaffold=f.events().find(e=>e.event==='scaffold');
    assert.deepEqual({uses:scaffold.uses,components:scaffold.components,grounds:scaffold.grounds,fixed_constraints:scaffold.fixed_constraints,
      source_occurrences:scaffold.source_occurrences,connectors:scaffold.connectors,context_index:scaffold.context_index,occurrences:scaffold.occurrences},
      {uses:1,components:1,grounds:1,fixed_constraints:1,source_occurrences:2,connectors:2,
       context_index:'cad-code-assembly-context-index-v1',occurrences:2});
  });
  let completed;
  await until(async()=>{const response=await f.api(`/api/projects/${id}/assembly/${attemptID}`);assert.equal(response.status,200,JSON.stringify(response.body));if(['completed','failed'].includes(response.body.status)){completed=response.body;return true;}return false;},60000);
  project=readProject(projectRoot);
  const attempt=project.assembly_attempts.find(row=>row.id===attemptID),work=path.join(projectRoot,attempt.attempt_dir);
  await t.test('selected notebook identity changes only in the assembly copy and the plugin is actually loaded',()=>{
    for(const part of project.unique_parts){assert.equal(sha(fs.readFileSync(path.join(projectRoot,part.attempts[0].deliverables.model_py))),originalHashes.get(part.id));const adapted=fs.readFileSync(path.join(work,'out/parts',part.id,'model.py'),'utf8');assert.match(adapted,/part_id=scad\.notebook_id\(\)/);assert.equal((adapted.match(/scad\.add_connector_rpart\(/g)||[]).length,2);}
    const plan=readJSON(path.join(projectRoot,attempt.runtime_dir,'../static-scaffold-plan.json'));
    assert.equal(plan.strategy,'source_pose_fixed_spanning_star');assert.equal(plan.fixed_edges.length,1);
    const compiled=f.events().find(e=>e.event==='compiled'&&e.role==='cad-assembly');
    assert.ok(compiled.system.join('\n').includes('SimpleCADAPI 2.2.7'));
    assert.ok(!compiled.system.join('\n').includes('[CAD_CODE_ASSEMBLY_ROLE]'));
  });
  await t.test('independent evaluation verifies each occurrence and transitions project to evaluated',()=>{
    assert.equal(attempt.status,'completed',JSON.stringify({attempt,events:f.events().filter(e=>e.event==='author_error')},null,2));
    assert.equal(attempt.verdict?.ok,true,JSON.stringify(attempt.verdict,null,2));
    assert.equal(attempt.verdict.component_checks.length,2);
    assert.equal(project.state,'evaluated');
  });
  await t.test('assembly owns its gateway/media records and exports original tool image bytes',()=>{
    const trajectory=readJSON(path.join(projectRoot,attempt.deliverables.trajectory));
    assert.equal(trajectory.schema_version,'cad-code-session-v2');assert.equal(trajectory.id,attempt.session_id);
    assert.equal(trajectory.tool_media.length,1);
    assert.equal(trajectory.tool_media[0].content.find(p=>p.type==='input_image').image_url,'data:image/png;base64,'+png);
    assert.ok(f.forwarded.some(request=>request.input.some(item=>item.type==='function_call_output'&&Array.isArray(item.output)&&item.output.some(p=>p.type==='input_image'))));
    assert.equal(fs.existsSync(path.join(f.runtime,'tool-media')),false);
    assert.equal(readJSON(path.join(projectRoot,attempt.runtime_dir,'opencode.json')).default_agent,'cad-assembly');
  });
  await t.test('completed status polling does not evaluate the same turn again',async()=>{
    const before=fs.readdirSync(path.join(work,'evaluation')).sort();
    const status=await f.api(`/api/projects/${id}/assembly/${attemptID}?status_only=1`);assert.equal(status.status,200,JSON.stringify(status.body));
    assert.deepEqual(fs.readdirSync(path.join(work,'evaluation')).sort(),before);
  });
  await t.test('download serves checked product STEP and rejects outside paths',async()=>{
    const result=await fetch(f.base+`/api/projects/${id}/assembly/${attemptID}/file?path=out%2Fproduct.step`);
    assert.equal(result.status,200,await result.clone().text());
    assert.equal(sha(Buffer.from(await result.arrayBuffer())),sha(fs.readFileSync(path.join(projectRoot,attempt.deliverables.product_step))));
    const outside=await f.api(`/api/projects/${id}/assembly/${attemptID}/file?path=..%2F..%2Fproject.json`);assert.equal(outside.status,400);
  });
  await t.test('CLI export carries child sources, immutable inputs and exact trajectory without runtime secrets',async()=>{
    const output=path.join(f.temporary,'export');
    const result=await f.start(['multi/cli.mjs','export','--project',projectRoot,'--out',output]).finished;
    assert.equal(result.code,0,result.stderr);
    const exported=readJSON(path.join(output,'export-manifest.json'));
    assert.equal(exported.schema_version,'cad-code-project-export-v1');
    assert.ok(exported.files.some(row=>row.path.endsWith('out/product.py')));
    assert.ok(exported.files.some(row=>row.path.endsWith('input/assembly-inputs.json')));
    assert.ok(exported.files.every(row=>!/\/runtime\/|provider\.json|connection\.json/.test(row.path)));
    assert.equal(sha(fs.readFileSync(path.join(output,attempt.deliverables.trajectory))),sha(fs.readFileSync(path.join(projectRoot,attempt.deliverables.trajectory))));
  });
  await t.test('follow-up creates one new evaluation while preserving the previous verdict file',async()=>{
    const priorFile=path.join(projectRoot,attempt.deliverables.verdict), priorHash=sha(fs.readFileSync(priorFile));
    const before=fs.readdirSync(path.join(work,'evaluation')).length;
    const result=await f.api(`/api/projects/${id}/assembly/${attemptID}/send`,'POST',{text:'Keep both source occurrences at their required source poses.'});
    assert.equal(result.status,200,JSON.stringify(result.body));
    await until(()=>f.events().filter(e=>e.event==='compiled'&&e.role==='cad-assembly').length===2,15000);
    await until(async()=>{const r=await f.api(`/api/projects/${id}/assembly/${attemptID}?status_only=1`);assert.equal(r.status,200,JSON.stringify(r.body));return r.body.status==='completed'||r.body.status==='failed';},60000);
    const latest=readProject(projectRoot).assembly_attempts.find(row=>row.id===attemptID);
    assert.equal(latest.status,'completed',JSON.stringify(latest));
    assert.equal(latest.verdict.ok,true,JSON.stringify(latest.verdict));
    assert.equal(fs.readdirSync(path.join(work,'evaluation')).length,before+1);
    assert.equal(sha(fs.readFileSync(priorFile)),priorHash);
    const transcript=readJSON(path.join(projectRoot,latest.deliverables.trajectory));
    assert.equal(transcript.tool_media.length,2);
  });
});
