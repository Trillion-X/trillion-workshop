// Ported from old trillion test/decision-identity-compiled.test.mjs (tag old-trillion-before-worker-retire, b6ae0ebf81),
// deleted by Trillion-X/trillion #243. identityOf moved from src/decision-store.mjs into this tool's
// src/record-identity.mjs (decision-store still re-exports it), and its compiled byte identity is this tool's
// parts/live-namespace/do-work/byte-identity.mjs. The compiled build is tools/browse-and-upload-my-files loadChunking's
// `Identity` (the same crates/content-chunks build), loaded without the retired restartable wrapper
// (src/restartable-engine.mjs, scripts/compiled-modules.mjs). Every assertion is the old one.
// identityOf (src/decision-store.mjs) answers the same `1f:` identity from the JavaScript BLAKE3 before a host installs
// its compiled byte identity and from the real compiled build after, streamed a 1 MiB window at a time, and falls back
// to the JavaScript BLAKE3 for a call whose engine traps.
import test from 'node:test';
import assert from 'node:assert/strict';
import { blake3 } from '@noble/hashes/blake3.js';
import { bytesToHex } from '@noble/hashes/utils.js';
import { identityOf } from '../src/record-identity.mjs';
import { useCompiledByteIdentity } from '../parts/live-namespace/do-work/byte-identity.mjs';
import { loadChunking } from '../../browse-and-upload-my-files/do-work/content-chunks.mjs';

const WINDOW = 1024 * 1024;
const noble = text => `1f:${bytesToHex(blake3(new TextEncoder().encode(text)))}`;
const sized = (bytes, seed) => Array.from({ length: bytes }, (_, at) => String.fromCharCode(97 + ((at * seed + 7) % 26))).join('');
const CORPUS = {
  empty: '',
  unicode: 'naïve café — 東京 🧭 \u{1F469}\u{200D}\u{1F4BB} \u0000 end',
  one_mib: sized(WINDOW, 31),
  four_mib: sized(4 * WINDOW, 17),
  four_mib_and_unicode: `${sized(4 * WINDOW - 3, 13)}🧭`,
};

// The compiled build, as the old restartable owner handed it: `get()` gives its bindings.
async function compiledEngine() {
  const bindings = await loadChunking();
  return { get: () => bindings };
}

test('identityOf answers the same 1f: identity before and after the compiled owner is installed, streamed in 1 MiB windows', async () => {
  const before = Object.fromEntries(Object.entries(CORPUS).map(([name, text]) => [name, identityOf(text)]));
  for (const [name, text] of Object.entries(CORPUS)) assert.equal(before[name], noble(text), `${name} before the engine`);

  const engine = await compiledEngine();
  const seen = { made: 0, freed: 0, updates: [] };
  useCompiledByteIdentity(() => {
    const identity = new (engine.get().Identity)();
    seen.made += 1;
    return {
      update: bytes => { seen.updates.push(bytes.byteLength); identity.update(bytes); },
      hex: () => identity.hex(),
      free: () => { seen.freed += 1; identity.free(); },
    };
  });
  for (const [name, text] of Object.entries(CORPUS)) {
    seen.updates = [];
    assert.equal(identityOf(text), before[name], `${name} from the compiled owner`);
    const length = new TextEncoder().encode(text).byteLength;
    assert.deepEqual(seen.updates, Array.from({ length: Math.ceil(length / WINDOW) }, (_, at) => Math.min(WINDOW, length - at * WINDOW)), `${name} streamed in 1 MiB windows`);
  }
  assert.equal(seen.made, Object.keys(CORPUS).length, 'every identity came from the compiled owner');
  assert.equal(seen.freed, seen.made, 'every compiled identity is freed');
});

test('identityOf answers a trapped call from the JavaScript BLAKE3 and passes on any other failure', () => {
  let freed = 0;
  useCompiledByteIdentity(() => ({ update() { throw new WebAssembly.RuntimeError('unreachable'); }, hex() { throw new Error('not reached'); }, free() { freed += 1; } }));
  assert.equal(identityOf(CORPUS.unicode), noble(CORPUS.unicode));
  assert.equal(freed, 1);
  useCompiledByteIdentity(() => { throw new TypeError('engine refused'); });
  assert.throws(() => identityOf(CORPUS.unicode), /engine refused/);
});
