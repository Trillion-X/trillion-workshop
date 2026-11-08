// tools/content-identity/read-data/identity.mjs
//
// The one BLAKE3 identity of exact bytes, `1f:` and 64 hex digits, from the bytes at once or from ordered chunks
// without collecting them, and the identity of a JSON value whatever order its keys were written in. Pure: no file,
// account or network operation; a reader hands in bytes, chunks or a value.
// Tuple-free BLAKE3 compression for the Worker hot path.
// @noble/hashes MIT attribution: Copyright (c) 2022 Paul Miller (https://paulmillr.com).
// Permission is hereby granted, free of charge, to any person obtaining a copy of this software and associated
// documentation files (the "Software"), to deal in the Software without restriction, including without limitation
// the rights to use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies of the Software, and to
// permit persons to whom the Software is furnished to do so, subject to the following conditions: the above copyright
// notice and this permission notice shall be included in all copies or substantial portions of the Software.
// THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO
// THE WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
// AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT,
// TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
// SOFTWARE.
// The subclass leaves noble's tree, key, context, digest and XOF owners intact.
import { _BLAKE3 } from '@noble/hashes/blake3.js';
import { createHasher, clean } from '@noble/hashes/utils.js';
import { bytesToHex } from '@noble/hashes/utils.js';

const IV0 = 0x6a09e667, IV1 = 0xbb67ae85, IV2 = 0x3c6ef372, IV3 = 0xa54ff53a;
const PERMUTATION = Uint8Array.from([2, 6, 3, 10, 7, 0, 4, 13, 1, 11, 12, 5, 9, 14, 15, 8]);
const SCHEDULE = new Uint8Array(7 * 16);
for (let i = 0; i < 16; i++) SCHEDULE[i] = i;
for (let round = 1; round < 7; round++) {
  const previous = (round - 1) * 16, current = round * 16;
  for (let i = 0; i < 16; i++) SCHEDULE[current + i] = SCHEDULE[previous + PERMUTATION[i]];
}
const rotr = (value, bits) => (value >>> bits) | (value << (32 - bits));

// Mutate the four selected words directly. Noble's generic compressor returns a new object
// from each half-round; this keeps the compression loop allocation-free after construction.
function g(v, a, b, c, d, x, y) {
  v[a] = (v[a] + v[b] + x) | 0;
  v[d] = rotr(v[d] ^ v[a], 16);
  v[c] = (v[c] + v[d]) | 0;
  v[b] = rotr(v[b] ^ v[c], 12);
  v[a] = (v[a] + v[b] + y) | 0;
  v[d] = rotr(v[d] ^ v[a], 8);
  v[c] = (v[c] + v[d]) | 0;
  v[b] = rotr(v[b] ^ v[c], 7);
}

export class AllocationAwareBLAKE3 extends _BLAKE3 {
  compressScratch = new Uint32Array(16);

  b2Compress(counter, flags, buf, bufPos = 0) {
    const v = this.compressScratch;
    const s = this.state;
    v[0] = s[0]; v[1] = s[1]; v[2] = s[2]; v[3] = s[3];
    v[4] = s[4]; v[5] = s[5]; v[6] = s[6]; v[7] = s[7];
    v[8] = IV0; v[9] = IV1; v[10] = IV2; v[11] = IV3;
    v[12] = counter >>> 0;
    v[13] = Math.floor(counter / 0x100000000) >>> 0;
    v[14] = this.pos;
    v[15] = flags;

    for (let round = 0, at = 0; round < 7; round++, at += 16) {
      g(v, 0, 4, 8, 12, buf[bufPos + SCHEDULE[at]], buf[bufPos + SCHEDULE[at + 1]]);
      g(v, 1, 5, 9, 13, buf[bufPos + SCHEDULE[at + 2]], buf[bufPos + SCHEDULE[at + 3]]);
      g(v, 2, 6, 10, 14, buf[bufPos + SCHEDULE[at + 4]], buf[bufPos + SCHEDULE[at + 5]]);
      g(v, 3, 7, 11, 15, buf[bufPos + SCHEDULE[at + 6]], buf[bufPos + SCHEDULE[at + 7]]);
      g(v, 0, 5, 10, 15, buf[bufPos + SCHEDULE[at + 8]], buf[bufPos + SCHEDULE[at + 9]]);
      g(v, 1, 6, 11, 12, buf[bufPos + SCHEDULE[at + 10]], buf[bufPos + SCHEDULE[at + 11]]);
      g(v, 2, 7, 8, 13, buf[bufPos + SCHEDULE[at + 12]], buf[bufPos + SCHEDULE[at + 13]]);
      g(v, 3, 4, 9, 14, buf[bufPos + SCHEDULE[at + 14]], buf[bufPos + SCHEDULE[at + 15]]);
    }

    s[0] = v[0] ^ v[8]; s[1] = v[1] ^ v[9]; s[2] = v[2] ^ v[10]; s[3] = v[3] ^ v[11];
    s[4] = v[4] ^ v[12]; s[5] = v[5] ^ v[13]; s[6] = v[6] ^ v[14]; s[7] = v[7] ^ v[15];
  }

  destroy() {
    super.destroy();
    clean(this.compressScratch);
  }
}

export const blake3 = createHasher(opts => new AllocationAwareBLAKE3(opts));

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

/** BLAKE3 derive-key mode: a 32-byte key bound to its protocol context, without a content-identity prefix. */
export function makeDerivedKeyBytes(bytes, context) {
  if (!(bytes instanceof Uint8Array) || !(context instanceof Uint8Array) || !context.length) throw new TypeError('Key derivation requires bytes and a nonempty byte context.');
  return blake3(bytes, { context });
}
