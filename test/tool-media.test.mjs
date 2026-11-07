import assert from 'node:assert/strict';
import {test} from 'node:test';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {spawnSync} from 'node:child_process';
import {ROOT} from '../src/paths.mjs';
import {restoreToolMedia,restoreResponsesToolMedia,defaultResponsesImageDetail,normalizeQwenResponsesHistory,mediaHash,mediaReceipt} from '../src/tool-media.mjs';

const imageA='data:image/png;base64,AAEC/w==',imageB='data:image/jpeg;base64,/9j/AA==';
const inputText=text=>({type:'input_text',text});
const inputImage=(image_url,detail)=>({type:'input_image',image_url,...(detail?{detail}:{})});
const chatText=text=>({type:'text',text});
const chatImage=(url,detail)=>({type:'image_url',image_url:{url,...(detail?{detail}:{})}});
const codeFor=id=>'text("tool '+id+'");';
const assistant=(...ids)=>({role:'assistant',content:'Inspecting actual artifacts.',tool_calls:ids.map(id=>({id,type:'function',function:{name:'exec',arguments:JSON.stringify({code:codeFor(id)})}}))});
const result=(id,content='Original visible text')=>({role:'tool',tool_call_id:id,content});
const synthetic=(...urls)=>({role:'user',content:[chatText('Attached media from tool result:'),...urls.map(url=>chatImage(url))]});
const record=(callID,content,{output='Original visible text',code=codeFor(callID),...extra}={})=>({version:1,sessionID:'ses_media_test',callID,tool:'exec',codeHash:mediaHash(code),outputHash:mediaHash(output),contentHash:mediaHash(JSON.stringify(content)),content,...extra});
const loadFrom=records=>callID=>records[callID]||null;

function ambiguousOrUntouched(messages,records){
  try{const restored=restoreToolMedia(messages,{sessionID:'ses_media_test',load:loadFrom(records)});assert.deepEqual(restored.messages,messages);}catch(e){assert.match(e.message,/ToolMediaAlignment|ToolMediaAmbiguous/);}
}

test('nonmedia conversations retain original array and object identity',()=>{
  const messages=[{role:'user',content:'Draw a cylinder'},assistant('plain'),result('plain')];
  const restored=restoreToolMedia(messages,{sessionID:'ses_media_test',load:()=>null});assert.strictEqual(restored.messages,messages);assert.deepEqual(restored.audit,[]);
});

test('text-only stored records leave prompt identity and original text untouched',()=>{
  const messages=[assistant('plain'),result('plain','Existing exact text')];
  const restored=restoreToolMedia(messages,{sessionID:'ses_media_test',load:loadFrom({plain:record('plain',[inputText('Stored text without an image')])})});assert.strictEqual(restored.messages,messages);
});

test('ordered text/image/text restores exact bytes and detail to its originating tool response',()=>{
  const messages=[assistant('mixed'),result('mixed')],original=structuredClone(messages);
  const content=[inputText('before\n圆柱'),inputImage(imageA,'high'),inputText('after')];
  const restored=restoreToolMedia(messages,{sessionID:'ses_media_test',load:loadFrom({mixed:record('mixed',content)})});
  assert.deepEqual(restored.messages,[original[0],{...original[1],content:[chatText('before\n圆柱'),chatImage(imageA,'high'),chatText('after')]}]);
  assert.deepEqual(messages,original);assert.equal(restored.audit.length,1);assert.equal(restored.audit[0].images[0].bytes,4);
  assert.equal(restored.audit[0].images[0].sha256,mediaHash(Buffer.from(imageA.split(',')[1],'base64')));
});

test('multiple equal images keep their multiplicity, order and distinct detail settings',()=>{
  const messages=[assistant('duplicate'),result('duplicate')],content=[inputImage(imageA,'high'),inputText('separator'),inputImage(imageA,'low')];
  const restored=restoreToolMedia(messages,{sessionID:'ses_media_test',load:loadFrom({duplicate:record('duplicate',content)})});
  assert.deepEqual(restored.messages[1].content,[chatImage(imageA,'high'),chatText('separator'),chatImage(imageA,'low')]);assert.equal(restored.messages.length,2);
});

test('original image detail maps explicitly to API high without changing original image bytes',()=>{
  const messages=[assistant('original'),result('original')];
  const restored=restoreToolMedia(messages,{sessionID:'ses_media_test',load:loadFrom({original:record('original',[inputImage(imageA,'original')])})});
  assert.deepEqual(restored.messages[1].content,[chatImage(imageA,'high')]);assert.equal(restored.audit[0].images[0].requestedDetail,'original');assert.equal(restored.audit[0].images[0].forwardedDetail,'high');
});

test('parallel batch restores images to their own tool calls even when results arrive out of order',()=>{
  const messages=[assistant('a','b'),result('b','second'),result('a','first')];
  const restored=restoreToolMedia(messages,{sessionID:'ses_media_test',load:loadFrom({a:record('a',[inputText('first'),inputImage(imageA)],{output:'first'}),b:record('b',[inputImage(imageB),inputText('second')],{output:'second'})})});
  assert.deepEqual(restored.messages,[messages[0],{...messages[1],content:[chatImage(imageB),chatText('second')]},{...messages[2],content:[chatText('first'),chatImage(imageA)]}]);
});

test('genuine user images remain unchanged including the same exact image URL',()=>{
  const user={role:'user',content:[chatText('这是我上传的新参考图'),chatImage(imageA)]};
  const messages=[assistant('a'),result('a'),user];
  const restored=restoreToolMedia(messages,{sessionID:'ses_media_test',load:loadFrom({a:record('a',[inputImage(imageA)])})});assert.strictEqual(restored.messages.at(-1),user);assert.equal(restored.messages.length,3);
});

test('legacy synthetic attachment messages are rejected instead of guessed or deleted',()=>{
  for(const messages of [[assistant('a'),result('a'),synthetic(imageA)],[assistant('a','b'),result('a'),result('b'),synthetic(imageA,imageB)]]){
    const original=structuredClone(messages);ambiguousOrUntouched(messages,{a:record('a',[inputImage(imageA)]),b:record('b',[inputImage(imageB)])});assert.deepEqual(messages,original);
  }
});

test('similar synthetic prefixes with genuine additional user instructions remain untouched',()=>{
  const user={role:'user',content:[chatText('Attached media from tool result: please use this uploaded image'),chatImage(imageA)]},messages=[assistant('a'),result('a'),user];
  const restored=restoreToolMedia(messages,{sessionID:'ses_media_test',load:loadFrom({a:record('a',[inputImage(imageA)])})});assert.strictEqual(restored.messages.at(-1),user);
});

test('missing assistant association, wrong tool name and malformed arguments are alignment errors',()=>{
  const variations=[[result('a')],[{...assistant('a'),tool_calls:[{...assistant('a').tool_calls[0],function:{name:'bash',arguments:JSON.stringify({code:codeFor('a')})}}]},result('a')],[{...assistant('a'),tool_calls:[{...assistant('a').tool_calls[0],function:{name:'exec',arguments:'invalid json'}}]},result('a')]];
  for(const messages of variations)assert.throws(()=>restoreToolMedia(messages,{sessionID:'ses_media_test',load:loadFrom({a:record('a',[inputImage(imageA)])})}),/ToolMediaAlignmentError/);
});

test('session, code or observed output mismatches stop restoration',()=>{
  const messages=[assistant('a'),result('a')];
  for(const change of [{sessionID:'ses_wrong'},{codeHash:mediaHash('wrong code')},{outputHash:mediaHash('wrong observed result')}]){
    assert.throws(()=>restoreToolMedia(messages,{sessionID:'ses_media_test',load:loadFrom({a:record('a',[inputImage(imageA)],change)})}),/ToolMediaAlignmentError/);
  }
});

test('multimodal restoration requires an explicit session context even for a unique call ID',()=>{
  const messages=[assistant('a'),result('a')];
  assert.throws(()=>restoreToolMedia(messages,{load:loadFrom({a:record('a',[inputImage(imageA)])})}),/session|Session|SESSION/);
});

test('duplicate call IDs and duplicate tool results are not guessed',()=>{
  const variations=[[assistant('a'),result('a'),assistant('a'),result('a')],[assistant('a'),result('a'),result('a')]];
  for(const messages of variations)assert.throws(()=>restoreToolMedia(messages,{sessionID:'ses_media_test',load:loadFrom({a:record('a',[inputImage(imageA)])})}),/ToolMediaAmbiguous|ToolMediaAlignmentError/);
});

test('restoring an already aligned prompt is idempotent and does not duplicate images',()=>{
  const messages=[assistant('a'),result('a')],records={a:record('a',[inputText('before'),inputImage(imageA),inputText('after')])};
  const first=restoreToolMedia(messages,{sessionID:'ses_media_test',load:loadFrom(records)}),second=restoreToolMedia(first.messages,{sessionID:'ses_media_test',load:loadFrom(records)});
  assert.deepEqual(second.messages,first.messages);assert.equal(second.audit[0].alreadyAligned,true);
});

test('failed tool result retains its error text and image evidence together',()=>{
  const output='Error: exported geometry failed verification',messages=[assistant('failed'),result('failed',output)];
  const restored=restoreToolMedia(messages,{sessionID:'ses_media_test',load:loadFrom({failed:record('failed',[inputText(output),inputImage(imageA)],{failed:true,output})})});
  assert.deepEqual(restored.messages[1].content,[chatText(output),chatImage(imageA)]);
});

const responseCall=id=>({type:'function_call',call_id:id,name:'exec',arguments:JSON.stringify({code:codeFor(id)})});
const responseOutput=(id,output='Original visible text')=>({type:'function_call_output',call_id:id,output});

test('Responses native tool output preserves ordered text/image/text, exact URLs and image detail',()=>{
  const content=[inputText('before\n圆柱'),inputImage(imageA,'high'),inputText('after')],input=[responseCall('r'),responseOutput('r')],original=structuredClone(input);
  const restored=restoreResponsesToolMedia(input,{sessionID:'ses_media_test',load:loadFrom({r:record('r',content)})});
  assert.deepEqual(restored.input,[input[0],{...input[1],output:content}]);assert.deepEqual(input,original);assert.equal(restored.audit[0].mode,'responses_function_call_output_original');
});

test('Responses restores only present results and retains genuine user images and reasoning items',()=>{
  const user={role:'user',content:[inputText('actual uploaded reference'),inputImage(imageA)]},reasoning={type:'reasoning',id:'rs_1',summary:[{type:'summary_text',text:'Visible summary'}]};
  const input=[user,reasoning,responseCall('a'),responseOutput('a')];
  const restored=restoreResponsesToolMedia(input,{sessionID:'ses_media_test',load:loadFrom({a:record('a',[inputImage(imageA)]),not_in_prompt:record('not_in_prompt',[inputImage(imageB)])})});
  assert.strictEqual(restored.input[0],user);assert.strictEqual(restored.input[1],reasoning);assert.equal(restored.input.length,input.length);assert.equal(restored.audit.length,1);
});

test('Responses parallel calls restore their own results in observed order, including identical images',()=>{
  const input=[responseCall('a'),responseCall('b'),responseOutput('b','b-output'),responseOutput('a','a-output')];
  const a=[inputImage(imageA,'high'),inputText('a'),inputImage(imageA,'low')],b=[inputImage(imageB),inputText('b')];
  const restored=restoreResponsesToolMedia(input,{sessionID:'ses_media_test',load:loadFrom({a:record('a',a,{output:'a-output'}),b:record('b',b,{output:'b-output'})})});
  assert.deepEqual(restored.input,[input[0],input[1],{...input[2],output:b},{...input[3],output:a}]);
});

test('Responses media receipts are replaced by original content and missing sidecars fail closed',()=>{
  const content=[inputText('rendered'),inputImage(imageA)],receipt=mediaReceipt('a',content),output='rendered\n'+receipt;
  const input=[responseCall('a'),responseOutput('a',output)];
  const restored=restoreResponsesToolMedia(input,{sessionID:'ses_media_test',load:loadFrom({a:record('a',content,{output})})});
  assert.deepEqual(restored.input[1].output,content);assert.doesNotMatch(JSON.stringify(restored.input),/CAD_TOOL_MEDIA_V1/);
  assert.throws(()=>restoreResponsesToolMedia(input,{sessionID:'ses_media_test',load:()=>null}),/missing/);
});

test('Chat array text containing a media receipt fails closed when its sidecar is missing',()=>{
  const receipt=mediaReceipt('a',[inputImage(imageA)]),messages=[assistant('a'),result('a',[chatText('rendered'),chatText(receipt)])];
  assert.throws(()=>restoreToolMedia(messages,{sessionID:'ses_media_test',load:()=>null}),/recorded image content is missing/);
});

test('Responses output array containing a media receipt fails closed when its sidecar is missing',()=>{
  const receipt=mediaReceipt('a',[inputImage(imageA)]),input=[responseCall('a'),responseOutput('a',[inputText('rendered'),inputText(receipt)])];
  assert.throws(()=>restoreResponsesToolMedia(input,{sessionID:'ses_media_test',load:()=>null}),/recorded image content is missing/);
});

test('Responses already aligned native content is idempotent and does not duplicate or resurrect media',()=>{
  const content=[inputText('before'),inputImage(imageA,'high'),inputText('after')],input=[responseCall('a'),responseOutput('a')],load=loadFrom({a:record('a',content)});
  const first=restoreResponsesToolMedia(input,{sessionID:'ses_media_test',load}),second=restoreResponsesToolMedia(first.input,{sessionID:'ses_media_test',load});
  assert.deepEqual(second.input,first.input);assert.equal(second.audit[0].alreadyAligned,true);
  const noOutput=[responseCall('a')],untouched=restoreResponsesToolMedia(noOutput,{sessionID:'ses_media_test',load});assert.strictEqual(untouched.input,noOutput);assert.deepEqual(untouched.audit,[]);
});

test('Responses text-only input retains exact identity without a sidecar',()=>{
  const input=[{role:'user',content:[inputText('question')]},responseCall('a'),responseOutput('a','plain result')];
  const restored=restoreResponsesToolMedia(input,{sessionID:'ses_media_test',load:()=>null});assert.strictEqual(restored.input,input);assert.deepEqual(restored.audit,[]);
});

test('Qwen Responses image defaults add high detail metadata without changing image bytes',()=>{
  const input=[{role:'user',content:[inputText('read the render'),inputImage(imageA)]},responseCall('a'),responseOutput('a',[inputText('rendered'),inputImage(imageB,'low')])];
  const result=defaultResponsesImageDetail(input,{detail:'high'});
  assert.equal(result.input[0].content[1].detail,'high');assert.equal(result.input[0].content[1].image_url,imageA);
  assert.equal(result.input[2].output[1].detail,'low');assert.equal(result.input[2].output[1].image_url,imageB);
  assert.equal(result.audit.length,1);assert.equal(result.audit[0].location,'input[0].content[1]');assert.deepEqual(input[0].content[1],inputImage(imageA));assert.equal(input[2].output[1].detail,'low');
});

test('image detail adapter leaves text-only and already-detailed Responses unchanged',()=>{
  const input=[{role:'user',content:[inputText('no image')]},responseOutput('a',[inputImage(imageA,'low')])],result=defaultResponsesImageDetail(input);
  assert.strictEqual(result.input,input);assert.deepEqual(result.audit,[]);
});

test('Qwen continuation converts prior assistant output_text to input_text and preserves other transcript items',()=>{
  const oldAssistant={role:'assistant',content:[{type:'output_text',text:'I will inspect the model.',annotations:[],logprobs:null}]};
  const user={role:'user',content:[inputText('continue')]},call={type:'function_call',call_id:'a',name:'exec',arguments:'{}'};
  const output={type:'function_call_output',call_id:'a',output:[inputText('tool result')]};
  const input=[user,oldAssistant,call,output],result=normalizeQwenResponsesHistory(input);
  assert.deepEqual(result.input,[user,{role:'assistant',content:[inputText('I will inspect the model.')]},call,output]);
  assert.deepEqual(input[1],oldAssistant);assert.equal(result.audit.length,1);assert.equal(result.audit[0].from,'output_text');
  const again=normalizeQwenResponsesHistory(result.input);assert.strictEqual(again.input,result.input);assert.deepEqual(again.audit,[]);
});

test('persistent storage survives restart, scopes duplicate calls by session, and refuses overwrite',t=>{
  const directory=path.join(ROOT,'.runtime','media-test-'+crypto.randomBytes(6).toString('hex'));fs.mkdirSync(directory,{recursive:true});t.after(()=>fs.rmSync(directory,{recursive:true,force:true}));
  const moduleURL=new URL('../src/tool-media.mjs',import.meta.url).href,env={...process.env,CAD_CODE_RUNTIME:directory};
  const execute=source=>{const r=spawnSync(process.execPath,['--input-type=module','-e',source],{env,encoding:'utf8',timeout:5000});assert.equal(r.status,0,r.stderr);return JSON.parse(r.stdout);};
  const content=[inputText('保存时的错误输出'),inputImage(imageA,'high')],first={sessionID:'ses_media_first',content,code:'first code',output:'first output',failed:true};
  const saved=execute(`import {saveToolMedia} from ${JSON.stringify(moduleURL)};console.log(JSON.stringify(saveToolMedia('persist_call',${JSON.stringify(first)})));`);
  const loaded=execute(`import {loadToolMedia} from ${JSON.stringify(moduleURL)};console.log(JSON.stringify(loadToolMedia('persist_call')));`);assert.deepEqual(loaded,saved);assert.deepEqual(loaded.content,content);assert.equal(loaded.failed,true);
  const duplicate=execute(`import {saveToolMedia} from ${JSON.stringify(moduleURL)};console.log(JSON.stringify(saveToolMedia('persist_call',${JSON.stringify(first)})));`);assert.deepEqual(duplicate,saved);
  const conflict=execute(`import {saveToolMedia,loadToolMedia} from ${JSON.stringify(moduleURL)};let rejected=false;try{saveToolMedia('persist_call',{...${JSON.stringify(first)},output:'changed'});}catch{rejected=true;}console.log(JSON.stringify({rejected,record:loadToolMedia('persist_call')}));`);assert.equal(conflict.rejected,true);assert.deepEqual(conflict.record,saved);
  const scoped=execute(`import {saveToolMedia,loadToolMedia} from ${JSON.stringify(moduleURL)};saveToolMedia('persist_call',{sessionID:'ses_media_second',content:[{type:'input_image',image_url:${JSON.stringify(imageB)}}],code:'second code',output:'second output'});let ambiguous=false;try{loadToolMedia('persist_call');}catch{ambiguous=true;}console.log(JSON.stringify({ambiguous,first:loadToolMedia('persist_call',{sessionID:'ses_media_first'}),second:loadToolMedia('persist_call',{sessionID:'ses_media_second'})}));`);
  assert.equal(scoped.ambiguous,true);assert.deepEqual(scoped.first,saved);assert.equal(scoped.second.content[0].image_url,imageB);
});
