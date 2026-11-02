import {StringDecoder} from 'node:string_decoder';
// Retain partial UTF-8 characters and partial SSE frames across network chunks.
export function sseDecoder(onData) {
  const decoder=new StringDecoder('utf8');let buffer='';
  function parse(text){buffer+=text;let m;while((m=/\r?\n\r?\n/.exec(buffer))){const frame=buffer.slice(0,m.index);buffer=buffer.slice(m.index+m[0].length);const data=frame.split(/\r?\n/).filter(x=>x.startsWith('data:')).map(x=>x.slice(5).trimStart()).join('\n');if(data)onData(data);}}
  return {write:chunk=>parse(decoder.write(chunk)),end:()=>parse(decoder.end())};
}
// Log the stream byte-for-byte except an exact credential, including chunk boundaries.
export function secretRedactor(secret,write) {
  const needle=Buffer.from(secret),replacement=Buffer.from('[REDACTED]');let pending=Buffer.alloc(0);
  function drain(final){let i;while((i=pending.indexOf(needle))>=0){if(i)write(pending.subarray(0,i));write(replacement);pending=pending.subarray(i+needle.length);}const n=final?pending.length:Math.max(0,pending.length-needle.length+1);if(n){write(pending.subarray(0,n));pending=pending.subarray(n);}}
  return {write:chunk=>{pending=Buffer.concat([pending,chunk]);drain(false);},end:()=>drain(true)};
}
