// tools/content-identity/test/identity.test.mjs
// The identity is BLAKE3-256 of the bytes (the published empty-input and "abc" vectors), and ordered chunks give the
// identity of the whole at every split; anything but bytes is refused.
import test from 'node:test';
import assert from 'node:assert/strict';
import { canonicalJson, makeHashCodeHasher, makeHashCodeHexFromBytes, makeHashCodeHexFromChunks, makeHashCodeHexFromJson, makeKeyedHashHexFromBytes } from '../read-data/identity.mjs';

test('a hasher fed pieces as they arrive gives the identity of the whole, and refuses anything but bytes', () => {
  const bytes = Uint8Array.from({ length: 70000 }, (_, index) => index % 251);
  const hasher = makeHashCodeHasher();
  for (let at = 0; at < bytes.length; at += 4096) hasher.update(bytes.subarray(at, at + 4096));
  assert.equal(hasher.identity(), makeHashCodeHexFromBytes(bytes));
  assert.equal(makeHashCodeHasher().identity(), makeHashCodeHexFromBytes(new Uint8Array()));
  assert.throws(() => makeHashCodeHasher().update('text'), /byte chunks/);
});

test('the keyed hash is BLAKE3 keyed mode (the published empty-input vector), differs by key, and needs a 32-byte key', () => {
  const key = new TextEncoder().encode('whats the Elvish word for friend');
  assert.equal(makeKeyedHashHexFromBytes(key, new Uint8Array()), '92b2b75604ed3c761f9d6f62392c8a9227ad0ea3f09573e783f1498a4ed60d26');
  const other = new Uint8Array(32).fill(7);
  assert.notEqual(makeKeyedHashHexFromBytes(key, new Uint8Array([1])), makeKeyedHashHexFromBytes(other, new Uint8Array([1])));
  assert.notEqual(`1f:${makeKeyedHashHexFromBytes(key, new Uint8Array())}`, makeHashCodeHexFromBytes(new Uint8Array()));
  assert.throws(() => makeKeyedHashHexFromBytes(new Uint8Array(16), new Uint8Array()), /32-byte key/);
  assert.throws(() => makeKeyedHashHexFromBytes(key, 'text'), /requires bytes/);
});

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

test('a JSON value has one identity whatever order its keys were written in, and it is the identity of its canonical text', () => {
  const one = { b: [1, { y: 'x', x: null }], a: 'text' };
  const other = { a: 'text', b: [1, { x: null, y: 'x' }] };
  assert.equal(canonicalJson(one), '{"a":"text","b":[1,{"x":null,"y":"x"}]}');
  assert.equal(makeHashCodeHexFromJson(one), makeHashCodeHexFromJson(other));
  assert.equal(makeHashCodeHexFromJson(one), makeHashCodeHexFromBytes(new TextEncoder().encode(canonicalJson(one))));
  assert.notEqual(makeHashCodeHexFromJson([1, 2]), makeHashCodeHexFromJson([2, 1]));
  assert.equal(canonicalJson({ kept: 1, dropped: undefined }), '{"kept":1}');
  assert.throws(() => canonicalJson(Number.NaN), /NaN or Infinity/);
  assert.throws(() => canonicalJson(undefined), /JSON values only/);
});
