import assert from 'node:assert/strict';
import {test} from 'node:test';
import {sseDecoder,secretRedactor} from '../src/streams.mjs';

test('SSE decoder handles every byte boundary, CRLF frames, Chinese and emoji',()=>{
  const data=Buffer.from(': keepalive\r\nevent: message\r\ndata: {"text":"圆柱🔧"}\r\n\r\ndata: [DONE]\n\n');
  for(let boundary=0;boundary<=data.length;boundary++){
    const frames=[],decode=sseDecoder(value=>frames.push(value));
    decode.write(data.subarray(0,boundary));decode.write(data.subarray(boundary));decode.end();
    assert.deepEqual(frames,['{"text":"圆柱🔧"}','[DONE]'],`boundary ${boundary}`);
  }
});

test('SSE decoder accepts multiple data lines and withholds incomplete frames',()=>{
  const frames=[],decode=sseDecoder(value=>frames.push(value));
  decode.write(Buffer.from('data: first\ndata: second\n'));
  assert.deepEqual(frames,[]);
  decode.write(Buffer.from('\ndata: last\n\n'));
  assert.deepEqual(frames,['first\nsecond','last']);
  decode.end();assert.deepEqual(frames,['first\nsecond','last']);
});

test('credential redactor catches secrets split at every byte boundary without changing other bytes',()=>{
  const secret='TEST_CREDENTIAL_非真实_α',source=Buffer.from('中文🔧 before '+secret+' middle '+secret+' end');
  const expected=Buffer.from(source.toString().split(secret).join('[REDACTED]'));
  for(let boundary=0;boundary<=source.length;boundary++){
    const chunks=[],redact=secretRedactor(secret,value=>chunks.push(Buffer.from(value)));
    redact.write(source.subarray(0,boundary));redact.write(source.subarray(boundary));redact.end();
    assert.deepEqual(Buffer.concat(chunks),expected,`boundary ${boundary}`);
  }
});

test('credential redactor preserves arbitrary binary data, partial matches and repeated adjacent secrets',()=>{
  const secret='abcd',source=Buffer.concat([Buffer.from([0,255,254]),Buffer.from('abcXabcdabcdabc')]);
  const expected=Buffer.concat([Buffer.from([0,255,254]),Buffer.from('abcX[REDACTED][REDACTED]abc')]);
  const chunks=[],redact=secretRedactor(secret,value=>chunks.push(Buffer.from(value)));
  for(const byte of source)redact.write(Buffer.from([byte]));
  redact.end();assert.deepEqual(Buffer.concat(chunks),expected);
});
