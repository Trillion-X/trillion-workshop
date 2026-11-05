import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { seal, open, keyBytes, keyText } from '../do-work/erasable.mjs';

test('bounded byte conversion retains the existing deterministic encrypted format', () => {
  const key=Uint8Array.from({length:32},(_,i)=>i),value={text:'\u0000é🦊雪'.repeat(8192),items:[null,false,0,'']};
  const sealed=seal(key,'synthetic:sealed','json',value);
  // Frozen from the pre-change owner at11c35ba7, including nonce and associated-data binding.
  assert.equal(createHash('sha256').update(JSON.stringify(sealed)).digest('hex'),'3a8643b77819178ee0084f8e758131fe70a0089b74a121414b72242ad38f95c9');
  assert.deepEqual(open(key,'synthetic:sealed','json',sealed),value);
  assert.equal(open(key,'synthetic:other','json',sealed),undefined);
  assert.equal(open(key,'synthetic:sealed','other',sealed),undefined);
});

test('multi-megabyte byte conversion equals the standard base64 representation', () => {
  const bytes=new Uint8Array(4*1024*1024+17);
  for(let at=0;at<bytes.length;at++)bytes[at]=(at*131+17)%256;
  const text=Buffer.from(bytes).toString('base64');
  assert.equal(keyText(bytes),text);assert.deepEqual(keyBytes(text),bytes);
});
