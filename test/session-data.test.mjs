import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import assert from 'node:assert/strict';
import {test} from 'node:test';
import {workspaceInventory,clearWorkspace,deleteTrajectoryFiles,belongsToSessions} from '../src/session-data.mjs';

function fixture(t){const root=fs.mkdtempSync(path.join(os.tmpdir(),'cad-session-data-')),runtime=path.join(root,'runtime'),workspace=path.join(root,'workspace');fs.mkdirSync(runtime);fs.mkdirSync(workspace);t.after(()=>fs.rmSync(root,{recursive:true,force:true}));return {root,runtime,workspace};}
function put(root,name,value='keep'){const p=path.join(root,name);fs.mkdirSync(path.dirname(p),{recursive:true});fs.writeFileSync(p,value);return p;}
const hash=id=>crypto.createHash('sha256').update(id).digest('hex');

test('inventory includes conversation-only sessions and workspace orphans, counting regular files without following links',t=>{
  const f=fixture(t);put(f.workspace,'ses_orphan/out/model.step','12345');put(f.workspace,'ses_both/.git/config','123');
  fs.symlinkSync(f.runtime,path.join(f.workspace,'ses_orphan/external'));
  const rows=workspaceInventory([{id:'ses_both',title:'Both',parentID:'ses_parent'},{id:'ses_only',title:'Only'}],f);
  assert.deepEqual(rows,[
    {id:'ses_both',title:'Both',parentID:'ses_parent',hasConversation:true,hasWorkspace:true,files:1,bytes:3},
    {id:'ses_only',title:'Only',parentID:null,hasConversation:true,hasWorkspace:false,files:0,bytes:0},
    {id:'ses_orphan',title:'ses_orphan',parentID:null,hasConversation:false,hasWorkspace:true,files:1,bytes:5}
  ]);
});

test('workspace clearing archives exact trajectory bytes and releases the whole workspace while preserving runtime records',t=>{
  const f=fixture(t),id='ses_clear';
  put(f.workspace,id+'/.cad-events.jsonl','events\n');put(f.workspace,id+'/.conversation.json','conversation');
  put(f.workspace,id+'/out/cache.bin','geometry');put(f.workspace,id+'/.git/config','git');
  const media=put(f.runtime,'tool-media/call/'+hash(id)+'.json','media');const requests=put(f.runtime,'model-requests/one/request.json','request');
  const result=clearWorkspace(id,f);
  assert.equal(result.cleared,true);assert.equal(fs.existsSync(path.join(f.workspace,id)),false);
  assert.equal(fs.readFileSync(path.join(result.archive,'.cad-events.jsonl'),'utf8'),'events\n');
  assert.equal(fs.readFileSync(path.join(result.archive,'.conversation.json'),'utf8'),'conversation');
  assert.equal(fs.readFileSync(media,'utf8'),'media');assert.equal(fs.readFileSync(requests,'utf8'),'request');
  assert.deepEqual(clearWorkspace(id,f),{id,cleared:false,archive:null});
  put(f.workspace,id+'/.cad-events.jsonl','new');assert.notEqual(clearWorkspace(id,f).archive,result.archive);
});

test('workspace operations reject invalid IDs and symlinked roots/sessions, preserving linked data',t=>{
  const f=fixture(t),outside=path.join(f.root,'outside');fs.mkdirSync(outside);put(outside,'model.step','safe');
  fs.symlinkSync(outside,path.join(f.workspace,'ses_link'));
  assert.throws(()=>clearWorkspace('ses_link',f),/symlink/);
  assert.throws(()=>workspaceInventory([{id:'ses_link'}],f),/symlink/);
  for(const id of ['../outside','ses_../x','bad',''])assert.throws(()=>clearWorkspace(id,f),/Invalid session/);
  const rootLink=path.join(f.root,'root-link');fs.symlinkSync(f.workspace,rootLink);
  assert.throws(()=>clearWorkspace('ses_ok',{...f,workspace:rootLink}),/symlink/);
  assert.equal(fs.readFileSync(path.join(outside,'model.step'),'utf8'),'safe');
});

test('trajectory deletion removes only selected ownership and preserves geometry, git, credentials and unrelated records',t=>{
  const f=fixture(t),ids=['ses_parent','ses_child'];
  for(const id of [...ids,'ses_other']){
    put(f.workspace,id+'/.cad-events.jsonl','events');put(f.workspace,id+'/.conversation.json','conversation');
    put(f.workspace,id+'/out/model.step','model');put(f.workspace,id+'/.git/config','git');
    put(f.runtime,'tool-media/call/'+hash(id)+'.json',JSON.stringify({sessionID:id}));
    put(f.runtime,'prompt-snapshots/'+id+'/prompt.json','prompt');put(f.runtime,'trajectory-archives/'+id+'/old/.cad-events.jsonl','archive');put(f.runtime,'cancel/'+id,'cancel');
    put(f.runtime,'model-requests/'+id+'/request.json',JSON.stringify({sessionID:id}));
    put(f.runtime,'model-requests/'+id+'/response.sse','response');
  }
  const forwarded=put(f.runtime,'model-requests/forwarded-only/forwarded-request.json',JSON.stringify({sessionID:'ses_child'}));
  const secret=put(f.runtime,'provider.json','SECRET'),shared=put(f.runtime,'opencode.log','shared');
  const otherEvent=JSON.stringify({event:{type:'message.updated',properties:{info:{sessionID:'ses_other',parentID:'ses_parent'}}}})+'\n';
  const unrelated=JSON.stringify({event:{type:'log',properties:{message:'ses_parent'}}})+'\n';
  const bad='{broken\n';
  put(f.runtime,'events.jsonl',JSON.stringify({event:{type:'session.deleted',properties:{info:{id:'ses_parent'}}}})+'\n'+JSON.stringify({event:{type:'message.part.updated',properties:{part:{sessionID:'ses_child'}}}})+'\n'+otherEvent+unrelated+bad);
  const result=deleteTrajectoryFiles(ids,f);
  for(const id of ids){
    assert.equal(fs.existsSync(path.join(f.workspace,id+'/.cad-events.jsonl')),false);
    assert.equal(fs.existsSync(path.join(f.workspace,id+'/.conversation.json')),false);
    assert.equal(fs.readFileSync(path.join(f.workspace,id+'/out/model.step'),'utf8'),'model');
    assert.equal(fs.readFileSync(path.join(f.workspace,id+'/.git/config'),'utf8'),'git');
    for(const area of ['prompt-snapshots','trajectory-archives','cancel','model-requests'])assert.equal(fs.existsSync(path.join(f.runtime,area,id)),false);
    assert.equal(fs.existsSync(path.join(f.runtime,'tool-media/call/'+hash(id)+'.json')),false);
  }
  assert.equal(fs.existsSync(forwarded),false);
  assert.equal(fs.existsSync(path.join(f.runtime,'tool-media/call/'+hash('ses_other')+'.json')),true);
  assert.equal(fs.existsSync(path.join(f.workspace,'ses_other/.conversation.json')),true);
  assert.equal(fs.readFileSync(path.join(f.runtime,'events.jsonl'),'utf8'),otherEvent+unrelated+bad);
  assert.equal(result.unknown.length,2);assert.equal(fs.readFileSync(secret,'utf8'),'SECRET');assert.equal(fs.readFileSync(shared,'utf8'),'shared');
  assert.deepEqual(workspaceInventory([{id:'ses_other'}],f).map(x=>[x.id,x.hasConversation]),[['ses_child',false],['ses_other',true],['ses_parent',false]]);
});

test('corrupt, conflicting and missing request ownership is retained and reported; symlinks never traverse',t=>{
  const f=fixture(t),id='ses_selected';
  const damaged=put(f.runtime,'model-requests/damaged/request.json','{bad');
  put(f.runtime,'model-requests/conflict/request.json',JSON.stringify({sessionID:id}));
  put(f.runtime,'model-requests/conflict/forwarded-request.json',JSON.stringify({sessionID:'ses_other'}));
  const unknown=put(f.runtime,'model-requests/unknown/response.json','{}');
  const badMedia=put(f.runtime,'tool-media/call/'+hash('ses_damaged')+'.json','{bad');
  const outside=path.join(f.root,'outside');fs.mkdirSync(outside);put(outside,'evidence','keep');
  fs.mkdirSync(path.join(f.workspace,id));fs.symlinkSync(outside,path.join(f.workspace,id+'/.conversation.json'));
  fs.mkdirSync(path.join(f.runtime,'prompt-snapshots'));fs.symlinkSync(outside,path.join(f.runtime,'prompt-snapshots',id));
  const result=deleteTrajectoryFiles([id],f);
  assert.ok(result.unknown.length>=5);assert.equal(fs.existsSync(damaged),true);assert.equal(fs.existsSync(unknown),true);
  assert.ok(result.unknown.some(x=>x.path===badMedia));assert.equal(fs.existsSync(badMedia),true);
  assert.equal(fs.existsSync(path.join(f.runtime,'model-requests/conflict')),true);assert.equal(fs.readFileSync(path.join(outside,'evidence'),'utf8'),'keep');
  assert.throws(()=>deleteTrajectoryFiles(['../outside'],f),/Invalid session/);
});

test('ownership matching uses event schema rather than incidental IDs or parent references',()=>{
  const ids=new Set(['ses_pick']);
  for(const value of [{sessionID:'ses_pick'},{event:{type:'session.updated',properties:{info:{id:'ses_pick'}}}},{event:{type:'message.updated',properties:{info:{sessionID:'ses_pick'}}}},{type:'session.status',properties:{sessionID:'ses_pick'}}])assert.equal(belongsToSessions(value,ids),true);
  for(const value of [null,{}, {id:'ses_pick'}, {parentID:'ses_pick'}, {event:{type:'message.updated',properties:{info:{id:'ses_pick',sessionID:'ses_other'}}}}, {sessionID:'ses_other',body:{sessionID:'ses_pick'}}])assert.equal(belongsToSessions(value,ids),false);
});
