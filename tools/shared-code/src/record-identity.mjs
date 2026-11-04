// tools/shared-code/src/record-identity.mjs
//
// The two pure helpers tools used to take from the computer's own decision store: the canonical text of a JSON value
// (keys sorted at every depth) and the `1f:` BLAKE3 identity of a text. Pure: no store, no file, no network. They
// moved here, byte for byte in what they answer, so that a tool reaching records through the door
// (tools/records-door) no longer imports the old JS record store copy to compute a receipt's identity.
import { blake3 } from '@noble/hashes/blake3.js';
import { bytesToHex } from '@noble/hashes/utils.js';
import { compiledByteIdentityNow } from '../parts/live-namespace/do-work/byte-identity.mjs';

const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
/** A value's JSON text with every object's keys in localeCompare order, as decision receipts have always been keyed. */
export const canonical = value => JSON.stringify(value, (key, item) => object(item) ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => a.localeCompare(b))) : item);
// Digested by the declared BLAKE3 owner's compiled build (crates/content-chunks) wherever the host installed it
// (src/namespace-identity-module.mjs), fed 1 MiB at a time; measured in workerd 2026-10-18, about 650 MB/s against
// 16 MB/s for the JavaScript hasher, which a host without it (and one whose engine trapped) still uses. Same identity.
const IDENTITY_WINDOW = 1024 * 1024;
/** The `1f:` identity of a text's UTF-8 bytes. */
export const identityOf = text => {
  const bytes = new TextEncoder().encode(text);
  let compiled = null;
  try {
    compiled = compiledByteIdentityNow();
    if (compiled) {
      for (let at = 0; at < bytes.byteLength; at += IDENTITY_WINDOW) compiled.update(bytes.subarray(at, at + IDENTITY_WINDOW));
      return `1f:${compiled.hex()}`;
    }
  } catch (error) {
    // A trapped engine is started again for its next caller (src/restartable-engine.mjs); this one is answered here.
    if (!(error instanceof WebAssembly.RuntimeError)) throw error;
  } finally { try { compiled?.free(); } catch {} }
  return `1f:${bytesToHex(blake3(bytes))}`;
};
