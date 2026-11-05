import assert from 'node:assert/strict';
import {test} from 'node:test';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import http from 'node:http';
import crypto from 'node:crypto';
import {spawn} from 'node:child_process';
import {ROOT} from '../src/paths.mjs';

const sessionID='ses_recovery_test';
const part=(id,index,text='')=>({type:'reasoning',id,messageID:'msg_test',sessionID,text,
  metadata:{openai:{itemId:'rs_test',...(index===undefined?{}:{summaryIndex:index})}}});
const done=(index,text)=>({type:'response.reasoning_text.done',item_id:'rs_test',content_index:index,text});
const sha=value=>crypto.createHash('sha256').update(value).digest('hex');

async function fixture(t,parts,sources){
  const runtime=fs.mkdtempSync(path.join(os.tmpdir(),'cad-recover-test-')),patches=[];
  const server=http.createServer(async(req,res)=>{
    let body='';for await(const chunk of req)body+=chunk;
    res.setHeader('content-type','application/json');
    if(req.headers.authorization!=='Basic '+Buffer.from('opencode:MOCK_ONLY').toString('base64')){res.statusCode=401;res.end('{}');return;}
    if(req.method==='GET'&&req.url===`/session/${sessionID}/message`){res.end(JSON.stringify([{parts}]));return;}
    if(req.method==='PATCH'){patches.push({url:req.url,part:JSON.parse(body)});res.end('{}');return;}
    res.statusCode=404;res.end('{}');
  });
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  fs.writeFileSync(path.join(runtime,'cli-connection.json'),JSON.stringify({url:`http://127.0.0.1:${server.address().port}`,password:'MOCK_ONLY'}));
  fs.mkdirSync(path.join(runtime,'model-requests'));
  const streams=[];
  for(const [index,source] of sources.entries()){
    const dir=path.join(runtime,'model-requests','request-'+index);fs.mkdirSync(dir);
    fs.writeFileSync(path.join(dir,'forwarded-request.json'),JSON.stringify({sessionID:source.sessionID||sessionID}));
    const stream=path.join(dir,'response.sse'),bytes=source.events.map(event=>'data: '+JSON.stringify(event)+'\n\n').join('');
    fs.writeFileSync(stream,bytes);streams.push({stream,bytes});
  }
  let child;
  t.after(async()=>{if(child?.exitCode===null)child.kill('SIGKILL');server.closeAllConnections();await new Promise(resolve=>server.close(resolve));fs.rmSync(runtime,{recursive:true,force:true});});
  async function run(){
    child=spawn(process.execPath,[path.join(ROOT,'scripts/recover-reasoning.mjs'),sessionID],{env:{...process.env,CAD_CODE_RUNTIME:runtime},stdio:['ignore','pipe','pipe']});
    let stdout='',stderr='';child.stdout.on('data',chunk=>stdout+=chunk);child.stderr.on('data',chunk=>stderr+=chunk);
    const timer=setTimeout(()=>child.kill('SIGKILL'),10000);
    try{const code=await new Promise((resolve,reject)=>{child.once('error',reject);child.once('close',resolve);});assert.equal(code,0,stderr);return JSON.parse(stdout);}finally{clearTimeout(timer);}
  }
  return {runtime,patches,streams,run};
}

test('recovery matches multiple content indexes precisely instead of taking the last done event',async t=>{
  const a=part('p0',0),b=part('p1',undefined);b.metadata.openai.contentIndex=1;
  const f=await fixture(t,[a,b],[{events:[done(0,'first block'),done(1,'second block')]}]);
  const result=await f.run();assert.equal(result.recovered_parts,2);
  assert.deepEqual(f.patches.map(x=>[x.part.id,x.part.text,x.part.metadata.cadCodeReasoningRecovery.contentIndex]),[['p0','first block',0],['p1','second block',1]]);
});

test('duplicate done events in one file or multiple sources are ambiguous and skipped',async t=>{
  for(const sources of [[{events:[done(0,'one'),done(0,'one')]}],[{events:[done(0,'one')]},{events:[done(0,'one')]}]]){
    await t.test('source count '+sources.length,async t=>{
      const f=await fixture(t,[part('p0',0)],sources);assert.equal((await f.run()).recovered_parts,0);assert.deepEqual(f.patches,[]);assert.equal(fs.existsSync(path.join(f.runtime,'reasoning-recovery')),false);
    });
  }
});

test('missing, malformed or conflicting part indexes and missing event indexes are never guessed',async t=>{
  const parts=[part('missing',undefined),part('string','0'),part('negative',-1),part('fraction',0.5),part('null',null),part('conflict',0)];
  parts.at(-1).metadata.openai.contentIndex=1;
  const f=await fixture(t,parts,[{events:[done(0,'one'),done(1,'two')]}]);
  assert.equal((await f.run()).recovered_parts,0);assert.deepEqual(f.patches,[]);
  await t.test('event without index',async t=>{const g=await fixture(t,[part('p0',0)],[{events:[done(undefined,'unknown')]}]);assert.equal((await g.run()).recovered_parts,0);assert.deepEqual(g.patches,[]);});
});

test('existing nonempty parts remain untouched and cross-session/item sources cannot supply content',async t=>{
  const f=await fixture(t,[part('nonempty',0,'already saved'),part('empty',1)],[
    {events:[done(0,'replacement'),{...done(1,'wrong item'),item_id:'rs_other'}]},
    {sessionID:'ses_other',events:[done(1,'wrong session')]}
  ]);
  assert.equal((await f.run()).recovered_parts,0);assert.deepEqual(f.patches,[]);
});

test('one uniquely matched source restores exact text with a backup and source/text hashes',async t=>{
  const original=part('p0',0),text='synthetic UTF-8 恢复 🔧\nline two';
  const f=await fixture(t,[original],[{events:[done(0,text)]}]);
  const result=await f.run();assert.equal(result.recovered_parts,1);assert.equal(f.patches.length,1);
  assert.equal(f.patches[0].url,`/session/${sessionID}/message/msg_test/part/p0`);
  assert.equal(f.patches[0].part.text,text);
  const archives=fs.readdirSync(path.join(f.runtime,'reasoning-recovery'));assert.equal(archives.length,1);
  const archive=path.join(f.runtime,'reasoning-recovery',archives[0]);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(archive,'before.json'),'utf8')),original);
  const proof=JSON.parse(fs.readFileSync(path.join(archive,'proof.json'),'utf8'));
  assert.equal(proof.sessionID,sessionID);assert.equal(proof.itemID,'rs_test');assert.equal(proof.contentIndex,0);
  assert.equal(proof.source,f.streams[0].stream);assert.equal(proof.source_sha256,sha(f.streams[0].bytes));assert.equal(proof.text_sha256,sha(text));
  assert.deepEqual(f.patches[0].part.metadata.cadCodeReasoningRecovery,proof);
});
