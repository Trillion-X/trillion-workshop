import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { keepALocalFile } from '../do-work/keep-a-local-file.mjs';

// A door that records each call, answers a write as the records door does, and never sees a path.
function fakeDoor() {
  const calls = [];
  return {
    calls,
    async files(op, args) {
      calls.push({ op, args });
      if (op === 'write_file_start') return { next_offset: 0 };
      if (op === 'write_file_finish') return { name: args.name, state: 'written' };
      return {};
    },
  };
}

test('keeps a regular file in pieces and answers the door finish', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'keep-local-'));
  const path = join(dir, 'clip.mp4');
  const data = Buffer.alloc(100_000, 7);
  await writeFile(path, data);
  const door = fakeDoor();
  const answer = await keepALocalFile({ path, name: 'site/clip.mp4', media_type: 'video/mp4' }, { door });
  assert.equal(answer.bytes, 100_000);
  assert.deepEqual(answer.finished, { name: 'site/clip.mp4', state: 'written' });
  assert.equal(door.calls[0].op, 'write_file_start');
  assert.equal(door.calls[0].args.byte_length, 100_000);
  assert.ok(door.calls.filter(call => call.op === 'write_file_piece').length >= 2);
});

test('refuses a link, a folder, a relative path and a bad name, with the reason', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'keep-local-'));
  const real = join(dir, 'real.txt');
  await writeFile(real, 'x');
  const link = join(dir, 'link.txt');
  await symlink(real, link);
  const door = fakeDoor();
  await assert.rejects(keepALocalFile({ path: link, name: 'a.txt' }, { door }), { code: 'refused', message: 'A link is not kept; name the file itself.' });
  await assert.rejects(keepALocalFile({ path: dir, name: 'a.txt' }, { door }), { code: 'refused', message: 'Only a regular file can be kept.' });
  await assert.rejects(keepALocalFile({ path: 'relative.txt', name: 'a.txt' }, { door }), { code: 'refused' });
  await assert.rejects(keepALocalFile({ path: real, name: '../escape.txt' }, { door }), { code: 'refused' });
  assert.equal(door.calls.length, 0);
});
