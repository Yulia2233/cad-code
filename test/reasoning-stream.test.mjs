import assert from 'node:assert/strict';
import {test} from 'node:test';
import {normalizeQwenReasoningEvent,qwenReasoningStream} from '../src/reasoning-stream.mjs';
import {sseDecoder} from '../src/streams.mjs';

const reasoning='检查圆柱 🔧，保留每一个字符。';
const frames=[
  {type:'response.output_item.added',output_index:0,item:{type:'reasoning',id:'rs_a',summary:[],content:null}},
  {type:'response.content_part.added',item_id:'rs_a',content_index:0,part:{type:'reasoning_text',text:''}},
  {type:'response.reasoning_text.delta',item_id:'rs_a',output_index:0,content_index:0,delta:reasoning},
  {type:'response.reasoning_text.done',item_id:'rs_a',content_index:0,text:reasoning},
  {type:'response.content_part.done',item_id:'rs_a',content_index:0,part:{type:'reasoning_text',text:reasoning}},
  {type:'response.output_item.done',output_index:0,item:{type:'reasoning',id:'rs_a',summary:[],content:[{type:'reasoning_text',text:reasoning}]}},
  {type:'response.output_text.delta',item_id:'msg_a',content_index:0,delta:'OK'},
  {type:'response.completed',response:{output:[{type:'reasoning',id:'rs_a',summary:[],content:[{type:'reasoning_text',text:reasoning}]}],usage:{output_tokens_details:{reasoning_tokens:12}}}}
];
test('Qwen full reasoning becomes provider-readable events without summarizing or changing text',()=>{
  const before=structuredClone(frames),out=frames.map(normalizeQwenReasoningEvent);
  assert.equal(out[1].type,'response.reasoning_summary_part.added');assert.equal(out[1].summary_index,0);
  assert.equal(out[2].type,'response.reasoning_summary_text.delta');assert.equal(out[2].delta,reasoning);assert.equal(out[2].item_id,'rs_a');
  assert.equal(out[4].type,'response.reasoning_summary_part.done');assert.equal(out[5].item.summary[0].text,reasoning);
  assert.strictEqual(out[6],frames[6]);assert.equal(out[7].response.output[0].summary[0].text,reasoning);
  assert.deepEqual(out[7].response.usage,frames[7].response.usage);assert.deepEqual(frames,before);
});
test('SSE reasoning adaptation handles every UTF8/frame boundary and preserves unrelated frames',()=>{
  const source=Buffer.from(': keepalive\r\n\r\n'+frames.map(x=>'event: '+x.type+'\r\ndata: '+JSON.stringify(x)+'\r\n\r\n').join('')+'data: [DONE]\n\n');
  for(let i=0;i<=source.length;i++){
    const chunks=[],audit=[],adapter=qwenReasoningStream(b=>chunks.push(b),e=>audit.push(e));adapter.write(source.subarray(0,i));adapter.write(source.subarray(i));adapter.end();
    const text=Buffer.concat(chunks).toString(),events=[],decoder=sseDecoder(x=>{if(x!=='[DONE]')events.push(JSON.parse(x));});decoder.write(Buffer.from(text));decoder.end();
    assert.deepEqual(events,frames.map(normalizeQwenReasoningEvent),'boundary '+i);
    assert.ok(text.startsWith(': keepalive\r\n\r\n'));assert.ok(text.endsWith('data: [DONE]\n\n'));
    assert.equal(audit.find(x=>x.from==='response.reasoning_text.delta').text_chars,reasoning.length);
  }
});
test('standard summary events, function calls and errors pass through unchanged',()=>{
  for(const event of [{type:'response.reasoning_summary_text.delta',item_id:'a',summary_index:0,delta:'already supported'},
    {type:'response.function_call_arguments.delta',item_id:'b',delta:'{}'}, {type:'error',error:{message:'bad'}}]){
    assert.strictEqual(normalizeQwenReasoningEvent(event),event);
    const raw='event: '+event.type+'\ndata: '+JSON.stringify(event)+'\n\n';let text='';const adapter=qwenReasoningStream(b=>text+=b.toString());adapter.write(Buffer.from(raw));adapter.end();assert.equal(text,raw);
  }
});
