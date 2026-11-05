import assert from 'node:assert/strict';
import {test} from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import {spawn} from 'node:child_process';
import {ROOT} from '../src/paths.mjs';

const key='ASK_TEST_ONLY_PRIVATE_KEY';
const completed=(text='单轮结果')=>({id:'resp_test',status:'completed',output:[
  {type:'reasoning',content:[{type:'reasoning_text',text:'接口返回的思考'}],summary:[]},
  {type:'message',role:'assistant',status:'completed',content:[{type:'output_text',text}]}]});

async function fixture(t,{reply=completed(),status=200,type='application/json',delay=0}={}){
  const directory=fs.mkdtempSync(path.join(os.tmpdir(),'cad-ask-')),
    runtime=path.join(directory,'runtime'),workspace=path.join(directory,'workspace'),
    credentials=path.join(directory,'provider.json'),requests=[],children=[];
  const upstream=http.createServer(async(req,res)=>{
    let raw='';for await(const chunk of req)raw+=chunk;
    requests.push({path:req.url,body:JSON.parse(raw),authorization:req.headers.authorization});
    if(delay)await new Promise(resolve=>setTimeout(resolve,delay));
    if(res.destroyed)return;
    res.writeHead(status,{'content-type':type});res.end(typeof reply==='string'?reply:JSON.stringify(reply));
  });
  await new Promise(resolve=>upstream.listen(0,'127.0.0.1',resolve));
  const provider={baseURL:`http://127.0.0.1:${upstream.address().port}/v1`,apiKey:key,model:'qwen-v8',thinking:true};
  fs.writeFileSync(credentials,JSON.stringify(provider),{mode:0o600});
  const env={...process.env,CAD_CODE_RUNTIME:runtime,CAD_CODE_WORKSPACE:workspace,
    CAD_CODE_CREDENTIALS:credentials,CAD_CODE_WIRE_API:'responses',
    OPENCODE_BIN:path.join(directory,'opencode-must-not-run'),PORT:'9',CAD_CODE_OPENCODE_PORT:'9',CAD_CODE_GATEWAY_PORT:'9'};
  function start(args,{stdin='',overrides={}}={}){
    const child=spawn(path.join(ROOT,'cad-code'),['ask',...args],{cwd:directory,env:{...env,...overrides},stdio:['pipe','pipe','pipe']});
    children.push(child);let stdout='',stderr='';
    child.stdout.setEncoding('utf8');child.stderr.setEncoding('utf8');
    child.stdout.on('data',x=>stdout+=x);child.stderr.on('data',x=>stderr+=x);
    const finished=new Promise((resolve,reject)=>{child.once('error',reject);child.once('close',(code,signal)=>resolve({stdout,stderr,code,signal}));});
    child.stdin.end(stdin);
    return {child,finished};
  }
  async function run(args,options){
    const {child,finished}=start(args,options),timer=setTimeout(()=>child.kill('SIGKILL'),10000);
    try{return await finished;}finally{clearTimeout(timer);}
  }
  t.after(async()=>{
    for(const child of children)if(child.exitCode===null)child.kill('SIGKILL');
    upstream.closeAllConnections();await new Promise(resolve=>upstream.close(resolve));
    fs.rmSync(directory,{recursive:true,force:true});
  });
  return {directory,runtime,workspace,credentials,requests,provider,run,start};
}

test('ask sends exactly one user input directly, prints only the answer and creates no backend files',async t=>{
  const f=await fixture(t),question='请回答：STEP 是什么？\n保留这一行。';
  // These files must never be included in the request.
  fs.writeFileSync(path.join(f.directory,'AGENTS.md'),'DO_NOT_INJECT_AGENTS');
  fs.writeFileSync(path.join(f.directory,'SKILL.md'),'DO_NOT_INJECT_SKILL');
  const before=fs.readdirSync(f.directory).sort();
  const result=await f.run([question],{stdin:'DO_NOT_APPEND_STDIN'});
  assert.equal(result.code,0,result.stderr);assert.equal(result.stdout,'单轮结果\n');assert.equal(result.stderr,'');
  assert.equal(f.requests.length,1);
  assert.deepEqual(f.requests[0],{path:'/v1/responses',authorization:'Bearer '+key,body:{
    model:'qwen-v8',temperature:1,stream:false,store:false,chat_template_kwargs:{enable_thinking:true},
    input:[{role:'user',content:[{type:'input_text',text:question}]}],max_output_tokens:16384,reasoning:{effort:'medium'}}});
  assert.deepEqual(fs.readdirSync(f.directory).sort(),before);
  assert.equal(fs.existsSync(f.runtime),false);assert.equal(fs.existsSync(f.workspace),false);
});

test('stdin is preserved byte-for-byte as UTF-8 and successive calls carry no history',async t=>{
  const f=await fixture(t),first='  原文\n第二行\n',second='第二个问题';
  assert.equal((await f.run([],{stdin:first})).code,0);
  assert.equal((await f.run([second])).code,0);
  assert.deepEqual(f.requests.map(x=>x.body.input),[first,second].map(text=>[{role:'user',content:[{type:'input_text',text}]}]));
  for(const {body} of f.requests){
    for(const field of ['instructions','tools','previous_response_id','conversation','metadata'])assert.equal(field in body,false);
  }
});

test('per-call model and thinking overrides do not change saved configuration; thinking is opt-in on stderr',async t=>{
  const f=await fixture(t),before=fs.readFileSync(f.credentials);
  let result=await f.run(['--model','Qwen/custom','--thinking','off','question']);
  assert.equal(result.code,0,result.stderr);assert.equal(result.stderr,'');
  assert.equal(f.requests[0].body.model,'Qwen/custom');assert.equal(f.requests[0].body.chat_template_kwargs.enable_thinking,false);
  assert.equal(f.requests[0].body.reasoning.effort,'low');
  result=await f.run(['--show-thinking','--max-output-tokens','512','question']);
  assert.equal(result.code,0,result.stderr);assert.equal(result.stdout,'单轮结果\n');assert.equal(result.stderr,'接口返回的思考\n');
  assert.equal(f.requests[1].body.max_output_tokens,512);assert.equal(f.requests[1].body.chat_template_kwargs.enable_thinking,true);
  assert.deepEqual(fs.readFileSync(f.credentials),before);assert.equal(fs.existsSync(f.runtime),false);
});

test('credentials precedence is explicit file, environment, then saved pointer, without contacting a live backend',async t=>{
  const f=await fixture(t),explicit=path.join(f.directory,'explicit.json');
  fs.writeFileSync(explicit,JSON.stringify({...f.provider,model:'Qwen/explicit'}));
  fs.mkdirSync(f.runtime);
  const saved=path.join(f.runtime,'provider.json');
  fs.writeFileSync(saved,JSON.stringify({...f.provider,model:'Qwen/saved'}));
  fs.writeFileSync(path.join(f.runtime,'connection.json'),JSON.stringify({credentialFile:saved}));
  fs.writeFileSync(path.join(f.runtime,'cli-connection.json'),JSON.stringify({pid:process.pid,url:'http://127.0.0.1:9',password:key}));
  const before=fs.readdirSync(f.runtime).map(name=>[name,fs.readFileSync(path.join(f.runtime,name),'utf8')]);
  assert.equal((await f.run(['--credentials',explicit,'question'])).code,0);
  assert.equal((await f.run(['question'])).code,0);
  assert.equal((await f.run(['question'],{overrides:{CAD_CODE_CREDENTIALS:''}})).code,0);
  assert.deepEqual(f.requests.map(x=>x.body.model),['Qwen/explicit','qwen-v8','Qwen/saved']);
  assert.deepEqual(fs.readdirSync(f.runtime).map(name=>[name,fs.readFileSync(path.join(f.runtime,name),'utf8')]),before);
});

test('chat mode also sends only one user message and keeps reasoning off stdout',async t=>{
  const f=await fixture(t,{reply:{choices:[{finish_reason:'stop',message:{role:'assistant',content:'CHAT_OK',reasoning_content:'实际思考'}}]}});
  const result=await f.run(['--show-thinking','question'],{overrides:{CAD_CODE_WIRE_API:'chat'}});
  assert.equal(result.code,0,result.stderr);assert.equal(result.stdout,'CHAT_OK\n');assert.equal(result.stderr,'实际思考\n');
  assert.deepEqual(f.requests[0],{path:'/v1/chat/completions',authorization:'Bearer '+key,body:{
    model:'qwen-v8',temperature:1,stream:false,store:false,chat_template_kwargs:{enable_thinking:true},
    messages:[{role:'user',content:'question'}],max_tokens:16384,reasoning_effort:'medium'}});
});

test('ask help and invalid arguments never contact API or create a runtime',async t=>{
  const f=await fixture(t);
  const help=await f.run(['--help'],{overrides:{CAD_CODE_CREDENTIALS:''}});
  assert.equal(help.code,0);assert.match(help.stdout,/independent single-turn/);
  for(const args of [[],[' '],['one','two'],['--thinking','maybe','question'],['--timeout','0','question'],['--timeout','Infinity','question'],['--max-output-tokens','1.5','question'],['--file','target.step','question'],['--credentials']]){
    const result=await f.run(args);assert.equal(result.code,1,JSON.stringify({args,...result}));assert.equal(result.stdout,'');assert.ok(result.stderr);
  }
  assert.equal(f.requests.length,0);assert.equal(fs.existsSync(f.runtime),false);
});

test('literal option-like question and an answer larger than a pipe buffer are preserved',async t=>{
  const text='大段内容\n'.repeat(30000),f=await fixture(t,{reply:completed(text)});
  const result=await f.run(['--','--help']);
  assert.equal(result.code,0,result.stderr);assert.equal(result.stdout,text);
  assert.equal(f.requests[0].body.input[0].content[0].text,'--help');
});

test('HTTP failures and malformed provider data produce a nonzero exit without exposing response secrets',async t=>{
  for(const options of [{status:401,reply:{error:{message:key}}},{type:'text/plain',reply:key},{reply:'invalid JSON '+key}]){
    await t.test(JSON.stringify({status:options.status,type:options.type}),async t=>{
      const f=await fixture(t,options),result=await f.run(['question']);
      assert.equal(result.code,1);assert.equal(result.stdout,'');assert.ok(result.stderr);
      assert.equal(result.stderr.includes(key),false);assert.equal(result.stderr.includes('Bearer'),false);
    });
  }
});

test('incomplete, failed, tool-only and empty responses are never reported as successful answers',async t=>{
  const cases=[{...completed(),status:'incomplete'}, {...completed(),status:'failed'},
    {...completed(),status:undefined}, {...completed(),output:[]},
    {...completed(),output:[{type:'function_call',name:'exec',arguments:'{}'}]},
    {...completed(),error:{message:key}}, {choices:[{finish_reason:'length',message:{role:'assistant',content:'partial'}}]}];
  for(const [i,reply] of cases.entries())await t.test('invalid result '+i,async t=>{
    const f=await fixture(t,{reply}),result=await f.run(['question'],{overrides:{CAD_CODE_WIRE_API:i===cases.length-1?'chat':'responses'}});
    assert.equal(result.code,1);assert.equal(result.stdout,'');assert.ok(result.stderr);assert.equal(result.stderr.includes(key),false);
  });
});

test('timeout and cancellation abort the one request and do not start a retry',async t=>{
  const f=await fixture(t,{delay:1000});
  const timeout=await f.run(['--timeout','0.1','question']);
  assert.equal(timeout.code,1);assert.equal(timeout.stdout,'');assert.match(timeout.stderr,/timed out/);
  const {child,finished}=f.start(['question']);
  const deadline=Date.now()+3000;
  while(f.requests.length<2&&Date.now()<deadline)await new Promise(resolve=>setTimeout(resolve,10));
  assert.equal(f.requests.length,2);child.kill('SIGINT');
  const cancelled=await finished;assert.equal(cancelled.code,130);assert.equal(cancelled.stdout,'');assert.match(cancelled.stderr,/cancelled/);
  assert.equal(f.requests.length,2);assert.equal(fs.existsSync(f.runtime),false);
});
