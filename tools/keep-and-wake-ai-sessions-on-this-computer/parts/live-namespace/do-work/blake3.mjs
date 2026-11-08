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
import { AllocationAwareBLAKE3, blake3 } from '../../../../content-identity/read-data/identity.mjs';
export { AllocationAwareBLAKE3, blake3 };

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
