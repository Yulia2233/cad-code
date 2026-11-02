import assert from 'node:assert/strict';
import {test,after} from 'node:test';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {importFiles} from '../src/cli-input.mjs';
import {RUNTIME,sessionDir} from '../src/paths.mjs';

const prefix='ses_import_test_'+crypto.randomBytes(6).toString('hex');
const root=path.join(RUNTIME,'cli-import-test-'+crypto.randomBytes(6).toString('hex'));
fs.mkdirSync(root,{recursive:true});const sessions=[];
function fixture(name){const id=prefix+'_'+name;const work=sessionDir(id);sessions.push(work);return{id,work};}
after(()=>{fs.rmSync(root,{recursive:true,force:true});for(const p of sessions)fs.rmSync(p,{recursive:true,force:true});});

test('imports exact bytes with Unicode filenames, and preserves originals',()=>{
  const {id,work}=fixture('unicode'),source=path.join(root,'法兰 图.step'),bytes=Buffer.from([0,1,255,13,10,42]);fs.writeFileSync(source,bytes);
  assert.deepEqual(importFiles(id,[source]),['input/法兰 图.step']);
  assert.deepEqual(fs.readFileSync(path.join(work,'input/法兰 图.step')),bytes);
  assert.deepEqual(fs.readFileSync(source),bytes);
});
test('duplicate names receive explicit unique names without overwriting',()=>{
  const {id,work}=fixture('duplicates'),a=path.join(root,'first'),b=path.join(root,'second');fs.mkdirSync(a);fs.mkdirSync(b);
  fs.writeFileSync(path.join(a,'target.step'),'first');fs.writeFileSync(path.join(b,'target.step'),'second');
  assert.deepEqual(importFiles(id,[path.join(a,'target.step'),path.join(b,'target.step')]),['input/target.step','input/target-2.step']);
  assert.equal(fs.readFileSync(path.join(work,'input/target.step'),'utf8'),'first');
  assert.equal(fs.readFileSync(path.join(work,'input/target-2.step'),'utf8'),'second');
});
test('rejects traversal in session ID before writing',()=>{
  const source=path.join(root,'safe.txt');fs.writeFileSync(source,'safe');
  assert.throws(()=>importFiles('ses_../../outside',[source]),/Invalid session ID/);
});
test('rejects source files and source directories reached through symlinks',()=>{
  const {id}=fixture('source_symlink'),source=path.join(root,'original.txt');fs.writeFileSync(source,'private');
  const fileLink=path.join(root,'linked.txt'),dirLink=path.join(root,'linked_dir');fs.symlinkSync(source,fileLink);fs.symlinkSync(root,dirLink);
  assert.throws(()=>importFiles(id,[fileLink]),/Refusing symlink/);
  assert.throws(()=>importFiles(id,[path.join(dirLink,'original.txt')]),/Refusing symlink/);
});
test('rejects a symlinked input directory instead of writing outside session',()=>{
  const {id,work}=fixture('destination_symlink'),source=path.join(root,'target.step');fs.writeFileSync(source,'model');fs.mkdirSync(work,{recursive:true});
  const outside=path.join(root,'outside');fs.mkdirSync(outside);fs.symlinkSync(outside,path.join(work,'input'));
  assert.throws(()=>importFiles(id,[source]),/Refusing symlink/);assert.equal(fs.readdirSync(outside).length,0);
});
test('validates all sources and size before importing the batch',()=>{
  const {id,work}=fixture('invalid_batch'),source=path.join(root,'large.step');fs.writeFileSync(source,'12345678901');
  assert.throws(()=>importFiles(id,[source],{maxBytes:10}),/exceeds/);
  assert.throws(()=>importFiles(id,[source,root]),/regular file/);
  assert.equal(fs.existsSync(path.join(work,'input/large.step')),false);
});
