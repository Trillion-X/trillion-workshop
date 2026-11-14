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

// Unkeyed incremental content identities can cross a durable bounded-work
// boundary without retaining/re-reading the message prefix. Never exports a
// keyed/MAC hasher or a finished output stream.
export function checkpointBlake3(hash) {
  if (!(hash instanceof AllocationAwareBLAKE3) || hash.flags !== 0 || hash.finished || hash.destroyed)
    throw new TypeError('Only an active unkeyed content-identity hasher can be checkpointed.');
  return { schema: 'trillion.blake3-content-checkpoint/v1', length: hash.length, pos: hash.pos,
    chunk_pos: hash.chunkPos, chunks_done: hash.chunksDone, buffer: Array.from(hash.buffer),
    state: Array.from(hash.state), stack: hash.stack.map(words => Array.from(words)) };
}
export function resumeBlake3(checkpoint) {
  const integers = (value, length, max) => Array.isArray(value) && value.length === length && value.every(word => Number.isInteger(word) && word >= 0 && word <= max);
  if (checkpoint?.schema !== 'trillion.blake3-content-checkpoint/v1'
    || !Number.isSafeInteger(checkpoint.length) || checkpoint.length < 0
    || !Number.isInteger(checkpoint.pos) || checkpoint.pos < 0 || checkpoint.pos > 64
    || !Number.isInteger(checkpoint.chunk_pos) || checkpoint.chunk_pos < 0 || checkpoint.chunk_pos > 15
    || !Number.isSafeInteger(checkpoint.chunks_done) || checkpoint.chunks_done < 0
    || !integers(checkpoint.buffer, 64, 255) || !integers(checkpoint.state, 8, 0xffffffff)
    || !Array.isArray(checkpoint.stack) || checkpoint.stack.length > 53 || checkpoint.stack.some(words => !integers(words, 8, 0xffffffff)))
    throw new TypeError('The durable BLAKE3 content checkpoint is invalid.');
  const hash = blake3.create(); hash.length = checkpoint.length; hash.pos = checkpoint.pos;
  hash.chunkPos = checkpoint.chunk_pos; hash.chunksDone = checkpoint.chunks_done;
  hash.buffer.set(checkpoint.buffer); hash.state.set(checkpoint.state);
  hash.stack = checkpoint.stack.map(words => Uint32Array.from(words));
  return hash;
}
