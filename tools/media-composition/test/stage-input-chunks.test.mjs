import test from 'node:test';
import assert from 'node:assert/strict';
import { closeSync, mkdtempSync, openSync, readFileSync, writeFileSync, writeSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { stageInputChunks } from '../do-work/stage-reuse.mjs';

test('stage input reads stay bounded and read a later mutation after the first chunk', () => {
  const dir = mkdtempSync(join(tmpdir(), 'stream-')), path = join(dir, 'large-input.bin');
  const bytes = Buffer.alloc(2 * 1024 * 1024 + 17, 7);
  writeFileSync(path, bytes);
  let count = 0, largest = 0;
  const read = [];
  for (const chunk of stageInputChunks(path, 65536)) {
    count++; largest = Math.max(largest, chunk.length);
    if (count === 1) {
      const descriptor = openSync(path, 'r+');
      try { writeSync(descriptor, Buffer.from([9]), 0, 1, bytes.length - 1); }
      finally { closeSync(descriptor); }
    }
    read.push(Buffer.from(chunk));
  }
  const streamed = Buffer.concat(read);
  assert.equal(largest, 65536); assert.ok(count > 32);
  assert.ok(streamed.equals(readFileSync(path)));
  assert.equal(streamed.at(-1), 9, 'the reader did not eagerly buffer the later input');
  assert.throws(() => [...stageInputChunks(path, 0)], /positive whole chunk/);
});
