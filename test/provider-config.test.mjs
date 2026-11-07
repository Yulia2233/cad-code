import assert from 'node:assert/strict';
import {test} from 'node:test';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {PassThrough} from 'node:stream';
import {validateProvider,loadProviderFile,providerSummary,saveProvider,savedProviderFile} from '../src/provider-config.mjs';
import {readHiddenKey} from '../src/config-cli.mjs';

const key='TEST_PROVIDER_KEY_NOT_A_REAL_SECRET';
function fixture(t){const dir=fs.mkdtempSync(path.join(os.tmpdir(),'cad-provider-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));return dir;}
test('provider URLs validate and normalize while blank key preserves the previous secret',()=>{
  const a=validateProvider({base_url:' https://example.test/api/v1/ ',api_key:key});
  assert.deepEqual(a,{baseURL:'https://example.test/api/v1',apiKey:key,model:'qwen-v8',thinking:true});
  assert.deepEqual(validateProvider({base_url:'http://127.0.0.1:18097/v1',api_key:''},{previous:a}),{baseURL:'http://127.0.0.1:18097/v1',apiKey:key,model:'qwen-v8',thinking:true});
  assert.deepEqual(providerSummary(a),{base_url:a.baseURL,model:'qwen-v8',thinking:true,api_key_configured:true,configured:true});
  assert.equal(JSON.stringify(providerSummary(a)).includes(key),false);
});
test('provider validation rejects malformed addresses and secrets without echoing them',()=>{
  for(const base of ['file:///tmp/a','javascript:foo','https://user:password@example.test/v1','https://example.test/v1?token=x','https://example.test/#secret','bad']){
    assert.throws(()=>validateProvider({base_url:base,api_key:key}),/Base URL/);
  }
  for(const secret of ['',null,12,'a\nb','Bearer key','x'.repeat(8193)])assert.throws(()=>validateProvider({base_url:'https://example.test/v1',api_key:secret}),/API key/);
});
test('model IDs allow provider namespaces and survive partial updates',()=>{
  const previous=validateProvider({baseURL:'https://example.test/v1',apiKey:key,model:'Qwen/Qwen3.8-27B'});
  assert.equal(validateProvider({apiKey:'REPLACED_TEST_KEY'},{previous}).model,'Qwen/Qwen3.8-27B');
  assert.equal(validateProvider({model:'gpt-6.1-sol'},{previous}).model,'gpt-6.1-sol');
  for(const model of ['',null,23,'a b','a\nb','x'.repeat(257)]){
    if(model===null)continue;
    assert.throws(()=>validateProvider({model},{previous}),/Model ID/);
  }
});
test('thinking is a persisted boolean and unsupported GPT-6 disabling fails explicitly',()=>{
  const a=validateProvider({baseURL:'https://example.test/v1',apiKey:key,model:'qwen-v8',thinking:false});
  assert.equal(a.thinking,false);assert.equal(validateProvider({model:'Qwen/another'},{previous:a}).thinking,false);
  for(const thinking of ['false',0,1])assert.throws(()=>validateProvider({thinking},{previous:a}),/Thinking/);
  assert.throws(()=>validateProvider({model:'gpt-6.1-sol',thinking:false},{previous:a}),/does not support/);
});
test('managed provider storage is private, persistent and does not mutate an imported credential file',t=>{
  const runtime=fixture(t),external=path.join(runtime,'external.json');
  fs.writeFileSync(external,JSON.stringify({ccvibe:{settings:{base_url:'https://example.test/v1',api_key:key}}}));
  const previous=loadProviderFile(external),before=fs.readFileSync(external);
  const file=saveProvider({...previous,baseURL:'https://second.test/v1'},{runtime});
  assert.equal(fs.statSync(file).mode&0o777,0o600);assert.equal(fs.statSync(path.join(runtime,'connection.json')).mode&0o777,0o600);
  assert.equal(savedProviderFile(runtime),file);assert.equal(loadProviderFile(file).apiKey,key);assert.deepEqual(fs.readFileSync(external),before);
  saveProvider({baseURL:'https://third.test/v1',apiKey:'OTHER_TEST_KEY'},{runtime});assert.equal(loadProviderFile(file).apiKey,'OTHER_TEST_KEY');
  assert.equal(fs.readdirSync(runtime).some(n=>n.endsWith('.tmp')),false);
});
test('provider writes reject symlinked runtime and destination files',t=>{
  const dir=fixture(t),real=path.join(dir,'real'),link=path.join(dir,'link');fs.mkdirSync(real);fs.symlinkSync(real,link);
  const provider={baseURL:'https://example.test/v1',apiKey:key};assert.throws(()=>saveProvider(provider,{runtime:link}),/symlink/);
  const outside=path.join(dir,'outside');fs.writeFileSync(outside,'untouched');fs.symlinkSync(outside,path.join(real,'provider.json'));
  assert.throws(()=>saveProvider(provider,{runtime:real}),/regular file/);assert.equal(fs.readFileSync(outside,'utf8'),'untouched');
});
test('hidden key prompt never echoes typed or pasted secret characters and restores terminal state',async()=>{
  const input=new PassThrough(),output=new PassThrough();let printed='';output.on('data',c=>printed+=c);
  input.isTTY=true;input.isRaw=false;input.setRawMode=function(value){this.isRaw=value;};input.pause();
  const result=readHiddenKey(input,output);input.write('secretX\u007f');input.write('123\r');
  assert.equal(await result,'secret123');assert.equal(input.isRaw,false);assert.equal(input.isPaused(),true);assert.equal(printed.includes('secret'),false);
});
test('hidden key prompt restores terminal on cancellation',async()=>{
  const input=new PassThrough(),output=new PassThrough();input.isTTY=true;input.isRaw=false;input.setRawMode=function(v){this.isRaw=v;};
  const result=readHiddenKey(input,output);input.write('\u0003');await assert.rejects(result,/cancelled/);assert.equal(input.isRaw,false);
});
