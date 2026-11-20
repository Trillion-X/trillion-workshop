// Ported from bitfield-packages packages/model-response (ebf06ab600) to node:test.
// The old test read a fixture image from another package tree that this
// repository does not carry, so the bytes here are generated in place. The
// materializer reads through an injected readFile, so no file is needed.

import { blake3 } from '@noble/hashes/blake3.js';
import assert from 'node:assert/strict';
import test from 'node:test';
import { materializeAddressedContentParts } from '../do-work/materialize-addressed-content-parts.mjs';

const bytes = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from('one-pixel-fixture')]);
const mountedPath = 'content.bin';
const readFile = (path) => {
  if (path === mountedPath) return bytes;
  throw new Error(`no such mounted file: ${path}`);
};
const digest = `1f:${Buffer.from(blake3(new Uint8Array(bytes))).toString('hex')}`;
const makePart = (overrides = {}) => ({
  kind: 'addressed-content', address: 'evidence:meal-1', content_kind: 'vision', mounted_path: mountedPath,
  mime_type: 'image/png', byte_length: bytes.length, integrity_hash: digest, delivery: { kind: 'inline-base64' }, ...overrides,
});
const policy = { accepted_content_kinds: ['vision'], content_kind_wire_types: { vision: 'image' }, max_bytes: 1024, max_inline_bytes: 1024 };

test('materializes the exact mounted bytes into typed inline content', () => {
  const output = materializeAddressedContentParts({ policy, parts: [{ kind: 'text', text: 'identify this' }, makePart()] }, { readFile });
  assert.equal(output.parts[1].data, bytes.toString('base64'));
  assert.equal(output.parts[1].type, 'image');
  assert.equal(Buffer.from(blake3(new Uint8Array(Buffer.from(output.parts[1].data, 'base64')))).toString('hex'), digest.slice(3));
});

test('altered bytes, missing bytes and oversize bytes deny before an adapter request can be built', () => {
  const alteredRead = () => Buffer.concat([bytes, Buffer.from([1])]);
  const cases = [
    ['altered bytes', makePart({ byte_length: bytes.length + 1 }), { policy, readFile: alteredRead }],
    ['missing bytes', makePart({ mounted_path: 'missing.bin' }), { policy, readFile }],
    ['oversize bytes', makePart(), { policy: { ...policy, max_bytes: bytes.length - 1 }, readFile }],
  ];
  for (const [name, part, { policy: localPolicy, readFile: localRead }] of cases) {
    assert.throws(() => materializeAddressedContentParts({ policy: localPolicy, parts: [part] }, { readFile: localRead }), /MR_CONTENT_/, name);
  }
});

test('MIME, declared integrity, and unsupported kinds deny materialization', () => {
  for (const part of [
    makePart({ mime_type: 'not a MIME' }),
    makePart({ integrity_hash: '1f:bad' }),
    makePart({ content_kind: 'audio' }),
  ]) {
    assert.throws(() => materializeAddressedContentParts({ policy, parts: [part] }, { readFile }), /MR_CONTENT_/);
  }
});

test('rejects a BLAKE3 digest mislabeled with a sha256 prefix', () => {
  assert.throws(
    () => materializeAddressedContentParts({ policy, parts: [makePart({ integrity_hash: `sha256:${digest.slice(3)}` })] }, { readFile }),
    /MR_CONTENT_0004_INTEGRITY_MISMATCH/,
  );
});
