import assert from 'node:assert/strict';
import {test,after} from 'node:test';
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import crypto from 'node:crypto';
import {executeCode,stopWorkers,stopSession} from '../src/executor.mjs';
import {sessionDir,ROOT} from '../src/paths.mjs';

const prefix='ses_test_'+crypto.randomBytes(6).toString('hex');
const created=[];
function fixture(suffix){const id=prefix+'_'+suffix;const dir=sessionDir(id);fs.mkdirSync(dir,{recursive:true});created.push(dir);return {id,dir};}
const quoted=JSON.stringify;
after(async()=>{stopWorkers();await new Promise(r=>setTimeout(r,250));for(const p of created)fs.rmSync(p,{recursive:true,force:true});});

test('exec sequences dependent commands and retains JavaScript/source newlines',async()=>{
  const {id,dir}=fixture('sequence');
  const patch='*** Begin Patch\n*** Add File: 输入.txt\n+圆柱 Ø12\n+line two\n*** End Patch';
  const code=`const r = await tools.apply_patch(${quoted(patch)});\ntext(r.output);\nconst read = await tools.exec_command({cmd:"cat 输入.txt"});\ntext(read.output);`;
  const result=await executeCode(id,code);
  assert.equal(result.error,undefined);
  assert.match(result.output,/Wrote 输入.txt\n圆柱 Ø12\nline two/);
  assert.equal(fs.readFileSync(path.join(dir,'输入.txt'),'utf8'),'圆柱 Ø12\nline two\n');
  const events=fs.readFileSync(path.join(dir,'.cad-events.jsonl'),'utf8').trim().split('\n').map(JSON.parse);
  assert.equal(events.find(e=>e.kind==='exec_start').code,code);
});

test('Unicode remains intact when a multibyte character crosses stdout chunks',async()=>{
  const {id}=fixture('utf8');
  const command="printf '\\344'; sleep 0.08; printf '\\270\\255'; sleep 0.08; printf '\\360\\237'; sleep 0.08; printf '\\224\\247\\n'";
  const result=await executeCode(id,`const r=await tools.exec_command({cmd:${quoted(command)},yield_time_ms:1000});text(r.output);`);
  assert.equal(result.output,'中🔧\n');
});

test('tool exceptions are returned and a later exec can recover',async()=>{
  const {id}=fixture('recover');
  const failed=await executeCode(id,'await tools.exec_command({});');
  assert.equal(failed.error,true);assert.match(failed.output,/requires cmd:string/);
  const recovered=await executeCode(id,'text(await tools.exec_command({cmd:"printf recovered"}));');
  assert.equal(JSON.parse(recovered.output).output,'recovered');
  assert.equal(JSON.parse(recovered.output).exit_code,0);
});

test('ALL_TOOLS discovery and shell failures preserve real observations',async()=>{
  const {id}=fixture('observations');
  const result=await executeCode(id,'text(ALL_TOOLS.filter(x=>/exec_command/.test(x.name))); const r=await tools.exec_command({cmd:"printf diagnostic >&2; exit 7"});text(r);');
  const [catalog,line]=result.output.split('\n');
  assert.equal(JSON.parse(catalog)[0].name,'exec_command');
  const failure=JSON.parse(line);assert.equal(failure.exit_code,7);assert.equal(failure.output,'diagnostic');
  assert.equal(result.error,undefined);
});

test('persistent process IDs can be polled across independent exec calls',async()=>{
  const {id}=fixture('poll');
  const first=await executeCode(id,'text(await tools.exec_command({cmd:"printf started; sleep 0.25; printf finished",yield_time_ms:5}));');
  const job=JSON.parse(first.output);assert.equal(typeof job.session_id,'number');assert.equal(job.exit_code,null);
  const second=await executeCode(id,`text(await tools.write_stdin({session_id:${job.session_id},yield_time_ms:1000}));`);
  const done=JSON.parse(second.output);assert.equal(done.exit_code,0);
  assert.equal(job.output+done.output,'startedfinished');
});

test('stopSession terminates already-returned background commands before delayed writes',async()=>{
  const {id,dir}=fixture('cancel');
  const result=await executeCode(id,'text(await tools.exec_command({cmd:"sleep 0.6; printf escaped > delayed.txt",yield_time_ms:5}));');
  assert.equal(typeof JSON.parse(result.output).session_id,'number');
  stopSession(id);
  await new Promise(r=>setTimeout(r,800));
  assert.equal(fs.existsSync(path.join(dir,'delayed.txt')),false);
  const resumed=await executeCode(id,'text("new worker ready");');
  assert.equal(resumed.output,'new worker ready');
});

test('cancellation also kills a background command that ignores SIGTERM',async()=>{
  const {id,dir}=fixture('cancel_trap');
  const result=await executeCode(id,'text(await tools.exec_command({cmd:"trap \'\' TERM; sleep 0.6; printf escaped > trapped.txt",yield_time_ms:5}));');
  assert.equal(typeof JSON.parse(result.output).session_id,'number');
  stopSession(id);
  await new Promise(r=>setTimeout(r,800));
  assert.equal(fs.existsSync(path.join(dir,'trapped.txt')),false);
  const resumed=await executeCode(id,'text("new worker after trapped command");');
  assert.equal(resumed.output,'new worker after trapped command');
});

test('unawaited subtool calls fail visibly, terminate their work, and allow worker recovery',async()=>{
  const {id,dir}=fixture('unawaited');
  const failed=await executeCode(id,'tools.exec_command({cmd:"sleep 0.6; printf escaped > unawaited.txt",yield_time_ms:1000});text("not awaited");');
  assert.equal(failed.error,true);assert.match(failed.output,/Unawaited subtool calls/);
  const resumed=await executeCode(id,'text("worker restarted");');
  assert.equal(resumed.output,'worker restarted');
  await new Promise(r=>setTimeout(r,800));
  assert.equal(fs.existsSync(path.join(dir,'unawaited.txt')),false);
});

test('timers scoped to a completed exec cannot create later file mutations',async()=>{
  const {id,dir}=fixture('scoped_timer');
  const patch='*** Begin Patch\n*** Add File: late.txt\n+late mutation\n*** End Patch';
  const result=await executeCode(id,`setTimeout(()=>tools.apply_patch(${quoted(patch)}),50);text("timer scheduled");`);
  assert.equal(result.output,'timer scheduled');
  await new Promise(r=>setTimeout(r,150));
  assert.equal(fs.existsSync(path.join(dir,'late.txt')),false);
  const next=await executeCode(id,'text("next exec is clean");');
  assert.equal(next.output,'next exec is clean');
});

test('noninteractive shell stdin is EOF, while a heredoc still works',async()=>{
  const {id}=fixture('eof');
  const result=await executeCode(id,'const r=await tools.exec_command({cmd:"read value; printf eof=$?; cat <<\'DONE\'\\n\\nDONE",yield_time_ms:1000});text(r);');
  const r=JSON.parse(result.output);assert.equal(r.exit_code,0);assert.match(r.output,/eof=1/);assert.equal(r.session_id,undefined);
});

test('standard Update File patch accepts End of File and preserves exact context',async()=>{
  const {id,dir}=fixture('patch');fs.writeFileSync(path.join(dir,'model.py'),'before\n');
  const patch='*** Begin Patch\n*** Update File: model.py\n@@\n-before\n+after\n*** End of File\n*** End Patch';
  const result=await executeCode(id,`text(await tools.apply_patch(${quoted(patch)}));`);
  assert.equal(result.error,undefined);assert.equal(fs.readFileSync(path.join(dir,'model.py'),'utf8'),'after\n');
});

test('view_image emits a model-visible attachment without inserting base64 into text',async()=>{
  const {id,dir}=fixture('image');
  const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a9j0AAAAASUVORK5CYII=','base64');
  fs.writeFileSync(path.join(dir,'preview.png'),png);
  const result=await executeCode(id,'image(await tools.view_image({path:"preview.png"}));text("rendered");');
  assert.equal(result.output,'rendered');assert.equal(result.attachments.length,1);
  assert.equal(result.attachments[0].mime,'image/png');
  assert.deepEqual(Buffer.from(result.attachments[0].url.split(',')[1],'base64'),png);
});

test('sandbox blocks shell reads/writes and symlink access to another workspace',async()=>{
  const own=fixture('isolation'),other=fixture('other');
  fs.writeFileSync(path.join(other.dir,'private.txt'),'PRIVATE_SENTINEL');
  fs.symlinkSync(other.dir,path.join(own.dir,'link'));
  const read=await executeCode(own.id,`text(await tools.exec_command({cmd:${quoted('cat '+JSON.stringify(path.join(other.dir,'private.txt')))}}));`);
  const r=JSON.parse(read.output);assert.notEqual(r.exit_code,0);assert.doesNotMatch(r.output,/PRIVATE_SENTINEL/);
  const write=await executeCode(own.id,`text(await tools.exec_command({cmd:${quoted('printf unsafe > '+JSON.stringify(path.join(other.dir,'escape.txt')))}}));`);
  assert.notEqual(JSON.parse(write.output).exit_code,0);assert.equal(fs.existsSync(path.join(other.dir,'escape.txt')),false);
  const patch='*** Begin Patch\n*** Add File: link/escape.txt\n+unsafe\n*** End Patch';
  const escaped=await executeCode(own.id,`await tools.apply_patch(${quoted(patch)});`);
  assert.equal(escaped.error,true);assert.match(escaped.output,/Symlink outside workspace|Operation not permitted|not permitted|EACCES|EPERM/);
  assert.equal(fs.existsSync(path.join(other.dir,'escape.txt')),false);
});

test('sandbox cannot read runtime credential/config files',async()=>{
  const {id}=fixture('secret');const sentinelFile=path.join(ROOT,'.runtime',prefix+'-private.json');
  fs.mkdirSync(path.dirname(sentinelFile),{recursive:true});fs.writeFileSync(sentinelFile,'PRIVATE_CREDENTIAL_SENTINEL',{mode:0o600});
  try{
    const result=await executeCode(id,`text(await tools.exec_command({cmd:${quoted('cat '+JSON.stringify(sentinelFile))}}));`);
    const r=JSON.parse(result.output);assert.notEqual(r.exit_code,0);assert.doesNotMatch(r.output,/PRIVATE_CREDENTIAL_SENTINEL/);
  }finally{fs.unlinkSync(sentinelFile);}
});

test('explicit parent read-only grants permit review but do not permit edits',async()=>{
  const child=fixture('readonly_child'),parent=fixture('readonly_parent');
  const source=path.join(parent.dir,'model.py');fs.writeFileSync(source,'parent source\n');
  const result=await executeCode(child.id,`text(await tools.exec_command({cmd:${quoted('cat '+JSON.stringify(source))}}));`,undefined,[parent.dir]);
  assert.equal(JSON.parse(result.output).output,'parent source\n');
  const write=await executeCode(child.id,`text(await tools.exec_command({cmd:${quoted('printf changed > '+JSON.stringify(source))}}));`,undefined,[parent.dir]);
  assert.notEqual(JSON.parse(write.output).exit_code,0);assert.equal(fs.readFileSync(source,'utf8'),'parent source\n');
});

test('sandbox denies network even when a local listener is reachable to the host',async()=>{
  const {id}=fixture('network');let requests=0;
  const listener=http.createServer((req,res)=>{requests++;res.end('NETWORK_SENTINEL');});
  await new Promise(resolve=>listener.listen(0,'127.0.0.1',resolve));
  try{
    const address=listener.address();
    const command=`/usr/bin/curl --silent --show-error --connect-timeout 1 --max-time 2 http://127.0.0.1:${address.port}`;
    const result=await executeCode(id,`text(await tools.exec_command({cmd:${quoted(command)},yield_time_ms:3000}));`);
    const r=JSON.parse(result.output);assert.notEqual(r.exit_code,0);assert.equal(requests,0);assert.doesNotMatch(r.output,/NETWORK_SENTINEL/);
  }finally{await new Promise(resolve=>listener.close(resolve));}
});
