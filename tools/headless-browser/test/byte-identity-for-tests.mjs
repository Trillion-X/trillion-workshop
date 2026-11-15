// test/byte-identity-for-tests.mjs
// The `1f:` identity of bytes a test made itself, from the committed compiled Namespace hasher
// (parts/live-namespace/built-stored-bytes/content-chunks, the same Rust BLAKE3 a deployed Worker streams through).
// A test that hashes many megabytes spends most of its time in JavaScript BLAKE3; this answers the same identity
// without it. It is checked against the JavaScript BLAKE3 once on load, so a different hasher can never pass silently.
import { readFileSync } from 'node:fs';
import { blake3 } from '@noble/hashes/blake3.js';
import { bytesToHex } from '@noble/hashes/utils.js';
import { Identity, initSync } from 'trillion-workshop/tools/browse-and-upload-my-files/built-stored-bytes/content-chunks/content_chunks.js';

initSync({ module: readFileSync(new URL(import.meta.resolve('trillion-workshop/tools/browse-and-upload-my-files/built-stored-bytes/content-chunks/content_chunks_bg.wasm'))) });

// Fed a window at a time, so the compiled memory grows by one window, never by the whole input.
const WINDOW = 1024 * 1024;

export function byteIdentity(bytes) {
  const identity = new Identity();
  try {
    for (let offset = 0; offset < bytes.byteLength; offset += WINDOW) identity.update(bytes.subarray(offset, offset + WINDOW));
    return `1f:${identity.hex()}`;
  } finally { identity.free(); }
}

const probe = new Uint8Array(3 * WINDOW + 17).map((_, index) => (index * 31 + 7) & 0xff);
for (const bytes of [new Uint8Array(0), probe.subarray(0, 1), probe.subarray(0, 1025), probe]) {
  if (byteIdentity(bytes) !== `1f:${bytesToHex(blake3(bytes))}`) throw new Error('The compiled hasher does not answer BLAKE3.');
}
