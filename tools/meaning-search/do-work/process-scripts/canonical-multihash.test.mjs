import assert from 'node:assert/strict';
import test from 'node:test';
import { isCanonicalMultihash, mintCanonicalMultihashOfBytes, mintCanonicalMultihashOfText } from './canonical_multihash.mjs';

const abc = '1f:6437b3ac38465133ffb63b75273a8db548c558465d79db03fd359c6cd5bd9d85';
test('uses the shared BLAKE3 owner with known-answer bytes', () => {
  assert.equal(mintCanonicalMultihashOfText('abc'), abc);
  assert.equal(mintCanonicalMultihashOfBytes(new Uint8Array()), '1f:af1349b9f5f9a1a6a0404dea36dcc9499bcb25c9adc112b7cc9a93cae41f3262');
});
test('canonical search hashes exclude aliases, other algorithms and trailing characters', () => {
  assert.equal(isCanonicalMultihash(abc), true);
  for (const value of [abc+'\n', abc+'\r', abc.toUpperCase(), '001f:'+abc.slice(3), '12:'+abc.slice(3), '1f:aa', null]) {
    assert.equal(isCanonicalMultihash(value), false, String(value));
  }
});
test('rejects implicit input coercion', () => {
  assert.throws(() => mintCanonicalMultihashOfBytes('abc'), TypeError);
  assert.throws(() => mintCanonicalMultihashOfText(3), TypeError);
});
