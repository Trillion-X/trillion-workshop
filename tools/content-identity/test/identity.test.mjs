// tools/content-identity/test/identity.test.mjs
// The identity is BLAKE3-256 of the bytes (the published empty-input and "abc" vectors), and ordered chunks give the
// identity of the whole at every split; anything but bytes is refused.
import test from 'node:test';
import assert from 'node:assert/strict';
import { makeHashCodeHexFromBytes, makeHashCodeHexFromChunks } from '../read-data/identity.mjs';

test('the identity is 1f: and BLAKE3-256 of the bytes', () => {
  assert.equal(makeHashCodeHexFromBytes(new Uint8Array()), '1f:af1349b9f5f9a1a6a0404dea36dcc9499bcb25c9adc112b7cc9a93cae41f3262');
  assert.equal(makeHashCodeHexFromBytes(new TextEncoder().encode('abc')), '1f:6437b3ac38465133ffb63b75273a8db548c558465d79db03fd359c6cd5bd9d85');
  assert.throws(() => makeHashCodeHexFromBytes('abc'), /requires bytes/);
});

test('ordered chunk identities equal the canonical byte identity across empty and split inputs', () => {
  for (const size of [0, 1, 63, 64, 65, 1024, 1025, 1048593]) {
    const bytes = Uint8Array.from({ length: size }, (_, index) => index % 251);
    function* pieces() { for (let at = 0; at < bytes.length; at += 113) yield bytes.subarray(at, at + 113); }
    assert.equal(makeHashCodeHexFromChunks(pieces()), makeHashCodeHexFromBytes(bytes), `size ${size}`);
  }
  assert.throws(() => makeHashCodeHexFromChunks(['not bytes']), /byte chunks/);
  assert.notEqual(makeHashCodeHexFromChunks([new Uint8Array([1]), new Uint8Array([2])]), makeHashCodeHexFromChunks([new Uint8Array([2]), new Uint8Array([1])]));
});
