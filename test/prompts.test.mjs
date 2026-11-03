import assert from 'node:assert/strict';
import {test,after} from 'node:test';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {ROOT} from '../src/paths.mjs';
import {renderTemplate,extractRuntimeTemplates,compileSessionPrompts} from '../src/prompts.mjs';

const fixtureRoot=path.join(ROOT,'.runtime','prompt-test-'+crypto.randomBytes(7).toString('hex'));
fs.mkdirSync(fixtureRoot,{recursive:true});
after(()=>fs.rmSync(fixtureRoot,{recursive:true,force:true}));
function fixture(name){
  const root=path.join(fixtureRoot,name),runtime=path.join(root,'runtime'),workspace=path.join(root,'workspace'),templateDir=path.join(root,'docs');
  for(const p of [runtime,workspace,templateDir])fs.mkdirSync(p,{recursive:true});
  for(const file of ['system-prompt.en.md','runtime-prompt.md'])fs.copyFileSync(path.join(ROOT,'docs',file),path.join(templateDir,file));
  const python=path.join(root,'python/bin/python'),skill=path.join(root,'skills/simplecadapi');
  return {root,runtime,workspace,templateDir,python,skill};
}
const model={id:'gpt-6.1-sol',providerID:'cad-local',api:{id:'gpt-6.1-sol'}};
const now=new Date('2026-11-03T13:24:00.000Z');
const compile=(f,extra={})=>compileSessionPrompts({...f,sessionID:'ses_prompt_default',model,now,...extra});
const noPlaceholders=text=>assert.doesNotMatch(text,/\{\{[^}]*\}\}/);

test('renderTemplate substitutes every occurrence literally without interpreting replacement metacharacters',()=>{
  const value='a $& $` $\' \\ " \n /Users/名字';
  assert.equal(renderTemplate('before {{PATH}} middle {{PATH}} after',{PATH:value}),'before '+value+' middle '+value+' after');
});

test('renderTemplate preserves ordinary JavaScript braces and never executes strings',()=>{
  const payload='globalThis.__cadPromptExecuted = true; $(touch /tmp/never)';
  const before=globalThis.__cadPromptExecuted;
  const template='const r = await tools.exec_command({cmd: "pwd"});\n{{CODE}}';
  assert.equal(renderTemplate(template,{CODE:payload}),'const r = await tools.exec_command({cmd: "pwd"});\n'+payload);
  assert.equal(globalThis.__cadPromptExecuted,before);
});

test('renderTemplate rejects missing/unknown placeholders rather than silently dropping them',()=>{
  assert.throws(()=>renderTemplate('cwd={{MISSING}}',{}),/missing|unknown|placeholder/i);
  assert.throws(()=>renderTemplate('cwd={{WORKDIR}}',{OTHER:'x'}),/missing|unknown|placeholder/i);
  assert.throws(()=>renderTemplate('{{1 + 1}}',{}),/invalid|missing|unknown|placeholder/i);
});

test('runtime extraction selects only English fenced templates, excluding Chinese and source commentary',()=>{
  const document=fs.readFileSync(path.join(ROOT,'docs/runtime-prompt.md'),'utf8');
  const templates=extractRuntimeTemplates(document);
  assert.deepEqual(Object.keys(templates).sort(),['base','inputFiles','review']);
  assert.match(templates.base,/CAD runtime for this session:/);
  assert.match(templates.inputFiles,/Files explicitly supplied for this session:/);
  assert.match(templates.review,/Independent review session/);
  for(const text of Object.values(templates)){
    assert.doesNotMatch(text,/[\u4e00-\u9fff]/);
    assert.doesNotMatch(text,/This document records|## Source|not itself the source|```/);
  }
});

test('runtime extraction rejects missing or duplicated required English sections',()=>{
  const document=fs.readFileSync(path.join(ROOT,'docs/runtime-prompt.md'),'utf8');
  for(const heading of ['## English','### Explicitly supplied session files','### Independent cad-review session']){
    const absent=document.replace(heading,heading.replace(/English|Explicitly|Independent/, 'Removed'));
    assert.throws(()=>extractRuntimeTemplates(absent),/missing|section|template|English/i);
  }
  assert.throws(()=>extractRuntimeTemplates(document+'\n## English\n```text\nDUPLICATE\n```\n'),/duplicate|multiple|section|template/i);
});

test('compiled prompts use real session workspace, current model/date and contain no unresolved placeholders',()=>{
  const f=fixture('baseline'),compiled=compile(f);
  assert.equal(typeof compiled.system,'string');assert.equal(typeof compiled.runtime,'string');
  const expected=path.join(f.workspace,'ses_prompt_default');
  assert.match(compiled.system,/gpt-6\.1-sol/);assert.ok(compiled.system.includes('Working directory: '+expected));
  assert.ok(compiled.system.includes('Workspace root folder: '+f.workspace));
  assert.equal(compiled.values.CURRENT_DATE,'Tue Nov 03 2026');assert.ok(compiled.system.includes("Today's date: "+compiled.values.CURRENT_DATE));
  assert.ok(compiled.runtime.includes(expected));assert.ok(compiled.runtime.includes(f.python));assert.ok(compiled.runtime.includes(f.skill+'/SKILL.md'));
  assert.ok(compiled.runtime.includes(path.join(f.root,'tools/cad.py')));
  noPlaceholders(compiled.system);noPlaceholders(compiled.runtime);
  assert.ok(compiled.values);assert.ok(compiled.templateHashes);
  assert.doesNotMatch(compiled.runtime,/This document records|本文记录|基础 agent|## Source/);
});

test('different sessions remain independent and no other workspace path leaks into prompts',()=>{
  const f=fixture('sessions'),a=compile(f,{sessionID:'ses_prompt_a'}),b=compile(f,{sessionID:'ses_prompt_b'});
  assert.ok(a.system.includes(path.join(f.workspace,'ses_prompt_a')));assert.ok(b.system.includes(path.join(f.workspace,'ses_prompt_b')));
  assert.ok(!a.system.includes('ses_prompt_b'));assert.ok(!b.runtime.includes('ses_prompt_a'));
  assert.equal(a.templateHashes.system,b.templateHashes.system);
});

test('input-file additions are discovered afresh for only the current session',()=>{
  const f=fixture('inputs'),id='ses_prompt_input',input=path.join(f.workspace,id,'input');fs.mkdirSync(input,{recursive:true});
  const before=compile(f,{sessionID:id});assert.doesNotMatch(before.runtime,/Files explicitly supplied for this session:/);
  fs.writeFileSync(path.join(input,'target.step'),'STEP');fs.writeFileSync(path.join(input,'reference.png'),'PNG');
  const after=compile(f,{sessionID:id});assert.match(after.runtime,/Files explicitly supplied for this session:/);assert.ok(after.runtime.includes('input/target.step'));assert.ok(after.runtime.includes('input/reference.png'));
  const other=compile(f,{sessionID:'ses_prompt_no_input'});assert.doesNotMatch(other.runtime,/Files explicitly supplied for this session:/);
  assert.equal(after.system,before.system);noPlaceholders(after.runtime);
});

test('parent review instructions are specific to a cad-review child session',()=>{
  const f=fixture('review'),parentID='ses_prompt_parent';
  const review=compile(f,{sessionID:'ses_prompt_review',parentID,agent:'cad-review'});
  const expected=path.join(f.workspace,parentID,'out');assert.ok(review.runtime.includes(expected));assert.match(review.runtime,/Independent review session/);assert.match(review.runtime,/read-only/);
  const ordinary=compile(f,{sessionID:'ses_prompt_ordinary',parentID,agent:'cad-code'});assert.doesNotMatch(ordinary.runtime,/Independent review session/);assert.ok(!ordinary.runtime.includes(expected));
  const parent=compile(f,{sessionID:parentID,agent:'cad-code'});assert.doesNotMatch(parent.runtime,/Independent review session/);
});

test('a changed model and date replace previous values without changing document hashes',()=>{
  const f=fixture('dynamic'),a=compile(f),b=compile(f,{model:{id:'qwen-test-next',providerID:'local-next',api:{id:'served-next'}},now:new Date('2026-11-04T13:24:00.000Z')});
  assert.match(b.system,/qwen-test-next|served-next/);assert.doesNotMatch(b.system,/gpt-6\.1-sol/);assert.match(b.system,/Wed Nov 04 2026/);assert.doesNotMatch(b.system,/Tue Nov 03 2026/);
  assert.deepEqual(a.templateHashes,b.templateHashes);noPlaceholders(b.system);
});

test('prompt documents reload on each compile and malformed edits fail visibly',()=>{
  const f=fixture('reload'),a=compile(f),systemFile=path.join(f.templateDir,'system-prompt.en.md');
  fs.appendFileSync(systemFile,'\nHot reload marker from edited document.\n');
  const b=compile(f);assert.match(b.system,/Hot reload marker/);assert.notDeepEqual(a.templateHashes,b.templateHashes);
  fs.appendFileSync(systemFile,'\nUnknown {{UNRECOGNIZED_VALUE}}\n');
  assert.throws(()=>compile(f),/missing|unknown|placeholder/i);
  fs.rmSync(systemFile);assert.throws(()=>compile(f),/ENOENT|missing|not found/i);
});

test('runtime document edits reload while translated/reference sections do not become prompt text',()=>{
  const f=fixture('runtime_reload'),file=path.join(f.templateDir,'runtime-prompt.md'),a=compile(f),s=fs.readFileSync(file,'utf8');
  fs.writeFileSync(file,s.replace('CAD runtime for this session:','CAD runtime for this session:\nEnglish hot reload marker.'));
  const b=compile(f);assert.match(b.runtime,/English hot reload marker/);assert.notDeepEqual(a.templateHashes,b.templateHashes);
  assert.doesNotMatch(b.runtime,/当前会话的 CAD|本文记录|本会话显式提供的文件：|Source \/ 来源/);
});

test('current date follows Shanghai time rather than the execution host timezone',()=>{
  const f=fixture('timezone'),compiled=compile(f,{now:new Date('2026-11-03T18:00:00.000Z')});
  assert.equal(compiled.values.CURRENT_DATE,'Wed Nov 04 2026');assert.match(compiled.system,/Wed Nov 04 2026/);
});

test('git status is checked at the actual session execution directory on every compile',()=>{
  const f=fixture('git'),id='ses_prompt_git',cwd=path.join(f.workspace,id);fs.mkdirSync(cwd,{recursive:true});
  const before=compile(f,{sessionID:id});assert.equal(before.values.IS_GIT_REPO,'no');
  fs.mkdirSync(path.join(cwd,'.git'));const after=compile(f,{sessionID:id});assert.equal(after.values.IS_GIT_REPO,'yes');assert.match(after.system,/Is directory a git repo: yes/);
});

test('document tool-call JSON examples are valid native argument objects',()=>{
  const document=fs.readFileSync(path.join(ROOT,'docs/system-prompt.en.md'),'utf8');
  const blocks=[...document.matchAll(/```json\n([\s\S]*?)\n```/g)];assert.ok(blocks.length>=4);
  for(const [,text] of blocks)assert.equal(typeof JSON.parse(text),'object');
});
