import assert from 'node:assert/strict';
import {test} from 'node:test';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {spawnSync} from 'node:child_process';
import {ROOT,PYTHON,SKILL} from '../src/paths.mjs';

// Each scenario imports the actual plugin in a new process, before paths.mjs is
// cached, so prompt snapshots and initialized Git sessions are fully isolated.
async function scenario(t,source){
  const directory=path.join(ROOT,'.runtime','plugin-prompt-test-'+crypto.randomBytes(7).toString('hex'));
  fs.mkdirSync(directory,{recursive:true});t.after(()=>fs.rmSync(directory,{recursive:true,force:true}));
  const runtime=path.join(directory,'runtime'),workspace=path.join(directory,'workspace');
  const prefix=`
    import assert from 'node:assert/strict';
    import fs from 'node:fs';
    import path from 'node:path';
    import CADCodePlugin from ${JSON.stringify(new URL('../src/plugin.mjs',import.meta.url).href)};
    import {MAIN_PROMPT_MARKER,REVIEW_PROMPT_MARKER,promptRole,compileSessionPrompts} from ${JSON.stringify(new URL('../src/prompts.mjs',import.meta.url).href)};
    import {RUNTIME,WORKSPACE,sessionDir} from ${JSON.stringify(new URL('../src/paths.mjs',import.meta.url).href)};
    const model={id:'gpt-6.1-sol',providerID:'cad-test',api:{id:'served-gpt-test'}};
  `;
  const r=spawnSync(process.execPath,['--input-type=module','-e',prefix+source],{cwd:ROOT,encoding:'utf8',timeout:8000,env:{...process.env,CAD_CODE_RUNTIME:runtime,CAD_CODE_WORKSPACE:workspace,CAD_CODE_PYTHON:PYTHON,CAD_CODE_SKILL:SKILL}});
  assert.equal(r.status,0,(r.error?.message||'')+'\n'+r.stdout+'\n'+r.stderr);
}

test('main plugin hook replaces marker and automatic OpenCode tails with exactly two live template segments',async t=>{
  await scenario(t,`
    let lookups=0;const hooks=await CADCodePlugin({client:{session:{get:async()=>{lookups++;throw Error('main agent must not request parent metadata');}}}});
    const system=[MAIN_PROMPT_MARKER+'\\nOLD_AUTOMATIC_ENVIRONMENT_TAIL','OLD_PROVIDER_MODEL_TAIL'];const originalArray=system;
    await hooks['experimental.chat.system.transform']({sessionID:'ses_hook_main',model},{system});
    assert.strictEqual(system,originalArray);assert.equal(system.length,2);assert.equal(lookups,0);
    assert.match(system[0],/You are CAD Code/);assert.match(system[0],/cad-test\\/gpt-6\\.1-sol/);assert.match(system[0],/served-gpt-test/);
    assert.ok(system[0].includes(sessionDir('ses_hook_main')));assert.ok(system[1].includes(sessionDir('ses_hook_main')));
    assert.match(system[0],/Is directory a git repo: yes/);assert.equal(fs.existsSync(path.join(sessionDir('ses_hook_main'),'.git')),true);
    assert.doesNotMatch(system.join('\\n'),/OLD_AUTOMATIC_ENVIRONMENT_TAIL|OLD_PROVIDER_MODEL_TAIL|CAD_CODE_TEMPLATE_ROLE|\\{\\{[A-Z_]+\\}\\}/);
    const snapshots=fs.readdirSync(path.join(RUNTIME,'prompt-snapshots/ses_hook_main'));assert.equal(snapshots.length,1);
    const snapshot=JSON.parse(fs.readFileSync(path.join(RUNTIME,'prompt-snapshots/ses_hook_main',snapshots[0])));assert.deepEqual(snapshot.segments,system);assert.equal(snapshot.agent,'cad-code');
    await hooks.dispose();
  `);
});

test('unmarked compaction/system prompts keep the exact array and content without session side effects',async t=>{
  await scenario(t,`
    const hooks=await CADCodePlugin({client:{session:{get:async()=>{throw Error('unexpected lookup');}}}}),system=['Summarize this conversation for compaction.','Keep all original constraints.'];
    const before=structuredClone(system),out={system};await hooks['experimental.chat.system.transform']({model},out);
    assert.strictEqual(out.system,system);assert.deepEqual(out.system,before);assert.equal(fs.existsSync(WORKSPACE),false);assert.equal(fs.existsSync(path.join(RUNTIME,'prompt-snapshots')),false);
    await hooks.dispose();
  `);
});

test('quoted markers and later-line markers never opt unrelated prompts into replacement',async t=>{
  await scenario(t,`
    const hooks=await CADCodePlugin({client:{session:{get:async()=>{throw Error('unexpected lookup');}}}});
    for(const text of ['Quoted marker: '+MAIN_PROMPT_MARKER,'> '+MAIN_PROMPT_MARKER,'"'+REVIEW_PROMPT_MARKER+'"','Some instructions\\n'+MAIN_PROMPT_MARKER]){
      const system=[text],before=structuredClone(system);assert.equal(promptRole(system),null);
      await hooks['experimental.chat.system.transform']({model},{system});assert.deepEqual(system,before);
    }
    assert.equal(fs.existsSync(WORKSPACE),false);await hooks.dispose();
  `);
});

test('review hook verifies its parent and injects read-only scope for that actual child only',async t=>{
  await scenario(t,`
    const calls=[];const hooks=await CADCodePlugin({client:{session:{get:async args=>{calls.push(args);return{data:{id:'ses_hook_review',parentID:'ses_hook_parent'}};}}}});
    const system=[REVIEW_PROMPT_MARKER,'OLD_REVIEW_TAIL'];await hooks['experimental.chat.system.transform']({sessionID:'ses_hook_review',model},{system});
    assert.deepEqual(calls,[{path:{id:'ses_hook_review'}}]);assert.equal(system.length,2);
    assert.ok(system[0].includes(sessionDir('ses_hook_review')));assert.ok(system[1].includes(path.join(sessionDir('ses_hook_parent'),'out')));
    assert.match(system[1],/Independent review session/);assert.match(system[1],/read-only/);assert.match(system[1],/Do not start a new modeling workflow/);assert.match(system[1],/ask the user questions, or delegate another task/);
    assert.doesNotMatch(system.join('\\n'),/OLD_REVIEW_TAIL|CAD_CODE_TEMPLATE_ROLE/);
    const main=[MAIN_PROMPT_MARKER];await hooks['experimental.chat.system.transform']({sessionID:'ses_hook_second_main',model},{system:main});
    assert.equal(calls.length,1);assert.doesNotMatch(main[1],/Independent review session/);assert.ok(!main[1].includes('ses_hook_parent'));
    await hooks.dispose();
  `);
});

test('recognized role without required session rejects before sending an unresolved sentinel',async t=>{
  await scenario(t,`
    let lookups=0;const hooks=await CADCodePlugin({client:{session:{get:async()=>{lookups++;return{data:{parentID:'ses_never'}};}}}});
    for(const marker of [MAIN_PROMPT_MARKER,REVIEW_PROMPT_MARKER]){
      const system=[marker];await assert.rejects(hooks['experimental.chat.system.transform']({model},{system}),/session context missing/);assert.deepEqual(system,[marker]);
    }
    assert.equal(lookups,0);assert.equal(fs.existsSync(WORKSPACE),false);await hooks.dispose();
  `);
});

test('unverifiable review parent rejects instead of compiling a main-agent or bare-marker fallback',async t=>{
  await scenario(t,`
    for(const response of [{error:{message:'backend error'}},{data:{id:'ses_hook_orphan'}}]){
      const hooks=await CADCodePlugin({client:{session:{get:async()=>response}}}),system=[REVIEW_PROMPT_MARKER];
      await assert.rejects(hooks['experimental.chat.system.transform']({sessionID:'ses_hook_orphan',model},{system}),/verified parent session/);
      assert.deepEqual(system,[REVIEW_PROMPT_MARKER]);assert.equal(fs.existsSync(path.join(RUNTIME,'prompt-snapshots/ses_hook_orphan')),false);await hooks.dispose();
    }
    const hooks=await CADCodePlugin({client:{session:{get:async()=>{throw Error('session lookup unavailable');}}}}),system=[REVIEW_PROMPT_MARKER];
    await assert.rejects(hooks['experimental.chat.system.transform']({sessionID:'ses_hook_network_failure',model},{system}),/lookup unavailable/);assert.deepEqual(system,[REVIEW_PROMPT_MARKER]);await hooks.dispose();
  `);
});

test('ambiguous role markers reject before filesystem or parent-lookup side effects',async t=>{
  await scenario(t,`
    let lookups=0;const hooks=await CADCodePlugin({client:{session:{get:async()=>{lookups++;return{data:{parentID:'ses_never'}};}}}});
    const system=[MAIN_PROMPT_MARKER,REVIEW_PROMPT_MARKER],before=structuredClone(system);
    assert.throws(()=>promptRole(system),/ambiguous agent markers/);
    await assert.rejects(hooks['experimental.chat.system.transform']({sessionID:'ses_hook_ambiguous',model},{system}),/ambiguous agent markers/);
    assert.deepEqual(system,before);assert.equal(lookups,0);assert.equal(fs.existsSync(WORKSPACE),false);await hooks.dispose();
  `);
});

test('marked requests without actual model identity fail without a prompt snapshot or marker leakage',async t=>{
  await scenario(t,`
    const hooks=await CADCodePlugin({client:{session:{get:async()=>{throw Error('unexpected lookup');}}}}),system=[MAIN_PROMPT_MARKER];
    await assert.rejects(hooks['experimental.chat.system.transform']({sessionID:'ses_hook_no_model'},{system}),/actual model identity/);
    assert.deepEqual(system,[MAIN_PROMPT_MARKER]);assert.equal(fs.existsSync(path.join(RUNTIME,'prompt-snapshots/ses_hook_no_model')),false);await hooks.dispose();
  `);
});
