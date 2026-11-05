import test from 'node:test';
import assert from 'node:assert/strict';
import { base64Of } from '../do-work/base64.mjs';

test('byte encoder preserves standard padding, every byte and offset views', () => {
  const storage = Uint8Array.from({length:1031}, (_, index) => index & 255);
  for (const length of [0,1,2,3,4,5,63,64,65,255,256,257,1025]) {
    const bytes = storage.subarray(3,3+length);
    assert.equal(base64Of(bytes),Buffer.from(bytes).toString('base64'),`length ${length}`);
  }
});

test('byte encoder does not iterate multi-megabyte inputs', () => {
  const bytes = new Uint8Array(4*1024*1024+17);
  for (let at=0;at<bytes.length;at++) bytes[at]=(at*131+17)&255;
  const expected = Buffer.from(bytes).toString('base64');
  bytes[Symbol.iterator] = () => { throw Error('Byte encoding must not create iterator results'); };
  assert.equal(base64Of(bytes),expected);
});
