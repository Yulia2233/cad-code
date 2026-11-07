import {StringDecoder} from 'node:string_decoder';
import crypto from 'node:crypto';

// vLLM emits full reasoning_text; the OpenAI provider inside OpenCode consumes
// reasoning_summary_text. This is a protocol adaptation: preserve every text
// character and item/index association, without generating a summary.
function reasoningItem(item){
  if(item?.type!=='reasoning'||item.summary?.length||!Array.isArray(item.content))return item;
  const parts=item.content.filter(p=>p.type==='reasoning_text'&&typeof p.text==='string');
  return parts.length?{...item,summary:parts.map(p=>({type:'summary_text',text:p.text}))}:item;
}
export function normalizeQwenReasoningEvent(event){
  if(!event||typeof event!=='object')return event;
  const index=event.content_index??0;
  if(['response.reasoning_text.delta','response.reasoning_text.done'].includes(event.type)){
    const {content_index,...rest}=event;
    return {...rest,type:event.type.replace('reasoning_text','reasoning_summary_text'),summary_index:index};
  }
  if(['response.content_part.added','response.content_part.done'].includes(event.type)&&event.part?.type==='reasoning_text'){
    const {content_index,...rest}=event;
    return {...rest,type:event.type.replace('content_part','reasoning_summary_part'),summary_index:index,part:{...event.part,type:'summary_text'}};
  }
  if(event.item?.type==='reasoning'){
    const item=reasoningItem(event.item);return item===event.item?event:{...event,item};
  }
  if(Array.isArray(event.response?.output)){
    const output=event.response.output.map(reasoningItem);
    return output.some((item,i)=>item!==event.response.output[i])?{...event,response:{...event.response,output}}:event;
  }
  return event;
}

export function qwenReasoningStream(write,onAudit=()=>{}){
  const decoder=new StringDecoder('utf8');let pending='';
  function emit(frame,separator){
    const lines=frame.split(/\r?\n/),data=lines.filter(x=>x.startsWith('data:')).map(x=>x.slice(5).trimStart()).join('\n');
    let original;try{original=JSON.parse(data);}catch{write(Buffer.from(frame+separator));return;}
    const normalized=normalizeQwenReasoningEvent(original);
    if(normalized===original){write(Buffer.from(frame+separator));return;}
    const text=typeof original.delta==='string'?original.delta:typeof original.text==='string'?original.text:original.part?.text;
    onAudit({from:original.type,to:normalized.type,item_id:original.item_id||original.item?.id||null,
      index:original.content_index??null,text_chars:typeof text==='string'?text.length:null,
      text_sha256:typeof text==='string'?crypto.createHash('sha256').update(text).digest('hex'):null});
    const output=[];let inserted=false;
    for(const line of lines){
      if(line.startsWith('data:')){if(!inserted){output.push('data: '+JSON.stringify(normalized));inserted=true;}}
      else if(line.startsWith('event:'))output.push('event: '+normalized.type);
      else output.push(line);
    }
    write(Buffer.from(output.join('\n')+separator));
  }
  function parse(text){pending+=text;let boundary;while((boundary=/\r?\n\r?\n/.exec(pending))){const frame=pending.slice(0,boundary.index);pending=pending.slice(boundary.index+boundary[0].length);emit(frame,boundary[0]);}}
  return {write:chunk=>parse(decoder.write(chunk)),end:()=>{parse(decoder.end());if(pending){write(Buffer.from(pending));pending='';}}};
}
