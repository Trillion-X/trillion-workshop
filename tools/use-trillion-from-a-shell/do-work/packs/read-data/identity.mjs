// tools/content-identity/read-data/identity.mjs
//
// The one BLAKE3 identity of exact bytes, `1f:` and 64 hex digits, from the bytes at once or from ordered chunks
// without collecting them, and the identity of a JSON value whatever order its keys were written in. Pure: no file,
// account or network operation; a reader hands in bytes, chunks or a value.
import { blake3 } from '@noble/hashes/blake3.js';
import { bytesToHex } from '@noble/hashes/utils.js';

/** A JSON value's text with every object's keys in code-point order and no spaces: one text per value. */
export function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(item => canonicalJson(item ?? null)).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    const keys = Object.keys(value).filter(key => value[key] !== undefined).sort();
    return `{${keys.map(key => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`;
  }
  if (typeof value === 'number' && !Number.isFinite(value)) throw new TypeError('A JSON identity cannot hold NaN or Infinity.');
  if (value === undefined || typeof value === 'function' || typeof value === 'symbol' || typeof value === 'bigint') {
    throw new TypeError('A JSON identity takes JSON values only: objects, lists, text, finite numbers, true, false and null.');
  }
  return JSON.stringify(value);
}

/** The identity of a JSON value: of the UTF-8 bytes of its canonical text, so key order never changes it. */
export function makeHashCodeHexFromJson(value) {
  return makeHashCodeHexFromBytes(new TextEncoder().encode(canonicalJson(value)));
}

/** Canonical internal identity for exact bytes. */
export function makeHashCodeHexFromBytes(bytes) {
  if (!(bytes instanceof Uint8Array)) throw new TypeError('Content identity requires bytes.');
  return `1f:${bytesToHex(blake3(bytes))}`;
}

// The engine takes a request key of at most this many bytes (trillion-rust src/mcp/settings.json `request_key_bytes`: Stripe's
// idempotency-key floor, 255 characters).
const REQUEST_KEY_BYTES = 255;
/** The request key the engine takes: a key within the bound unchanged; a longer one as its own identity, so the same key always
 * gives the same name, two keys never share one, and a retry is answered as the first call was. */
export function requestKeyForEngine(key) {
  const bytes = new TextEncoder().encode(key);
  return bytes.length <= REQUEST_KEY_BYTES ? key : `key:${makeHashCodeHexFromBytes(bytes)}`;
}

/**
 * The same identity fed piece by piece as the pieces arrive (a file stream, a socket), without collecting them:
 * `update(bytes)` as often as needed, then `identity()` once.
 */
export function makeHashCodeHasher() {
  const hash = blake3.create();
  return {
    update(chunk) {
      if (!(chunk instanceof Uint8Array)) throw new TypeError('Content identity requires byte chunks.');
      hash.update(chunk);
      return this;
    },
    identity: () => `1f:${bytesToHex(hash.digest())}`,
  };
}

/**
 * BLAKE3 in its keyed mode over bytes, as 64 hex digits: a message code that only a holder of the 32-byte key can
 * make, never a content identity (the same bytes give a different code under every key).
 */
export function makeKeyedHashHexFromBytes(key, bytes) {
  if (!(key instanceof Uint8Array) || key.length !== 32) throw new TypeError('A keyed hash requires a 32-byte key.');
  if (!(bytes instanceof Uint8Array)) throw new TypeError('A keyed hash requires bytes.');
  return bytesToHex(blake3(bytes, { key }));
}

/** Same identity from ordered byte chunks, without collecting the input. */
export function makeHashCodeHexFromChunks(chunks) {
  const hash = blake3.create();
  for (const chunk of chunks) {
    if (!(chunk instanceof Uint8Array)) throw new TypeError('Content identity requires byte chunks.');
    hash.update(chunk);
  }
  return `1f:${bytesToHex(hash.digest())}`;
}
