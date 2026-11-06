// Ported from old trillion test/blake3-allocation-compat.test.mjs (tag old-trillion-before-worker-retire, b6ae0ebf81),
// deleted by Trillion-X/trillion #243. The compiled identity is tools/browse-and-upload-my-files loadChunking's
// `Identity` (the same crates/content-chunks build the old parts/live-namespace/built-stored-bytes held), loaded without
// the retired restartable wrapper (scripts/compiled-modules.mjs, src/restartable-engine.mjs); readHandoffResultSource is
// tools/shared-code's, so the compiled identity is installed in its byte-identity copy too. Every assertion is the old one.
import assert from 'node:assert/strict';
import test from 'node:test';
import { blake3 as nobleBlake3 } from '@noble/hashes/blake3.js';
import { blake3 } from '../parts/live-namespace/do-work/blake3.mjs';
import { createByteIdentity, useCompiledByteIdentity } from '../parts/live-namespace/do-work/byte-identity.mjs';
import { useCompiledByteIdentity as useCompiledSharedByteIdentity } from '../../shared-code/parts/live-namespace/do-work/byte-identity.mjs';
import { loadChunking } from '../../browse-and-upload-my-files/do-work/content-chunks.mjs';
import { readHandoffResultSource } from '../../shared-code/src/handoff-result-source.mjs';
import { bytesToHex } from '@noble/hashes/utils.js';

const bytes = length => Uint8Array.from({ length }, (_, index) => (index * 131 + 17) & 0xff);

test('allocation-aware BLAKE3 matches noble across block and tree boundaries', () => {
  for (const length of [0, 1, 63, 64, 65, 1023, 1024, 1025, 2047, 2048, 2049, 4097]) {
    const input = bytes(length);
    assert.deepEqual(blake3(input), nobleBlake3(input), `length ${length}`);
  }
});

test('allocation-aware BLAKE3 matches noble for split updates and keyed truncated output', () => {
  const input = bytes(3 * 1024 + 77);
  const split = blake3.create().update(input.subarray(0, 17)).update(input.subarray(17, 2048)).update(input.subarray(2048));
  assert.deepEqual(split.digest(), nobleBlake3(input));
  const key = bytes(32), keyedInput = bytes(2049);
  assert.deepEqual(blake3(keyedInput, { key, dkLen: 24 }), nobleBlake3(keyedInput, { key, dkLen: 24 }));
});

test('allocation-aware BLAKE3 preserves context derivation, clones, and XOF output', () => {
  const input = bytes(2100), context = new TextEncoder().encode('trillion allocation compatibility');
  assert.deepEqual(blake3(input, { context, dkLen: 24 }), nobleBlake3(input, { context, dkLen: 24 }));

  const actual = blake3.create().update(input.subarray(0, 1300));
  const expected = nobleBlake3.create().update(input.subarray(0, 1300));
  const actualCopy = actual.clone();
  assert.notEqual(actual.compressScratch, actualCopy.compressScratch);
  const actualClone = actualCopy.update(input.subarray(1300));
  const expectedClone = expected.clone().update(input.subarray(1300));
  assert.deepEqual(actualClone.digest(), expectedClone.digest());
  assert.deepEqual(actual.digest(), expected.digest());

  const actualXof = blake3.create().update(input).xof(137);
  const expectedXof = nobleBlake3.create().update(input).xof(137);
  assert.deepEqual(actualXof, expectedXof);
});

test('native byte identity permits repeated prefix reads and further streaming updates', async () => {
  const input = bytes(4097), digest = await createByteIdentity();
  try {
    digest.update(input.subarray(0, 65));
    const prefix = bytesToHex(nobleBlake3(input.subarray(0, 65)));
    assert.equal(digest.hex(), prefix); assert.equal(digest.hex(), prefix);
    digest.update(input.subarray(65));
    assert.equal(digest.hex(), bytesToHex(nobleBlake3(input)));
  } finally { digest.free(); }
});

let compiledFreed = 0;
test('compiled Namespace byte identity preserves split, offset and interleaved stream identities', async () => {
  const { Identity } = await loadChunking();
  const compiled = () => {
    const identity = new Identity();
    return { update: value => identity.update(value), hex: () => identity.hex(), free: () => { compiledFreed++; identity.free(); } };
  };
  useCompiledByteIdentity(compiled);
  useCompiledSharedByteIdentity(compiled);
  for (const length of [0, 1, 63, 64, 65, 1023, 1024, 1025, 2049, 4097, 4 * 1024 * 1024]) {
    const storage = bytes(length + 11), input = storage.subarray(7, 7 + length);
    const digest = await createByteIdentity(), other = await createByteIdentity();
    try {
      digest.update(input.subarray(0, 17));
      const prefix = bytesToHex(nobleBlake3(input.subarray(0, 17)));
      assert.equal(digest.hex(), prefix); assert.equal(digest.hex(), prefix);
      other.update(input);
      for (let at = 17; at < input.length; at += 4096) digest.update(input.subarray(at, at + 4096));
      const expected = bytesToHex(nobleBlake3(input));
      assert.equal(digest.hex(), expected, `split length ${length}`);
      assert.equal(other.hex(), expected, `interleaved length ${length}`);
    } finally { digest.free(); other.free(); }
  }
});

test('compiled result identity is freed after success, failed verification and stream setup refusal', async () => {
  const content = new TextEncoder().encode('{"text":"complete"}');
  const source = { identity: `1f:${bytesToHex(nobleBlake3(content))}`, byte_length: content.length, format: 'application/json' };
  const options = { privateReach: true, admit: () => {}, open: async () => ({ byte_length: content.length, stream: () => new Blob([content]).stream() }) };
  let before = compiledFreed;
  assert.deepEqual(await readHandoffResultSource(source, options), { text: 'complete' });
  assert.equal(compiledFreed, before + 1);
  before = compiledFreed;
  await assert.rejects(readHandoffResultSource({ ...source, identity: '1f:' + '0'.repeat(64) }, options), /immutable identity/);
  assert.equal(compiledFreed, before + 1);
  before = compiledFreed;
  await assert.rejects(readHandoffResultSource(source, { ...options, open: async () => ({ byte_length: content.length, stream: () => { throw Error('Synthetic stream setup refusal'); } }) }), /Synthetic stream setup refusal/);
  assert.equal(compiledFreed, before + 1);
});
