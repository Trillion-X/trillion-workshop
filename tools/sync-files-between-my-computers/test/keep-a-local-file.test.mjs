import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, symlink, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { keepALocalFile } from '../do-work/keep-a-local-file.mjs';
import { LARGE_FILE } from '../../records-door/read-data/whole-file.mjs';

// A door that records each call: pieces for a small write, and the lease road for a large one.
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
    async writeLarge(name, source, options) {
      calls.push({ op: 'writeLarge', name, size: source.size, options });
      return { state: 'uploaded', identity: '1f:fake', byte_length: source.size };
    },
  };
}

test('keeps a regular file in pieces and answers the door finish', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'keep-local-'));
  const path = join(dir, 'clip.mp4');
  await writeFile(path, Buffer.alloc(100_000, 7));
  const door = fakeDoor();
  const answer = await keepALocalFile({ path, name: 'site/clip.mp4', media_type: 'video/mp4' }, { door });
  assert.deepEqual(answer.refused, []);
  assert.equal(answer.kept[0].bytes, 100_000);
  assert.deepEqual(answer.kept[0].finished, { name: 'site/clip.mp4', state: 'written' });
  assert.equal(door.calls[0].op, 'write_file_start');
  assert.ok(door.calls.filter(call => call.op === 'write_file_piece').length >= 2);
});

test('a file above the whole-file threshold goes over the lease road, not in pieces', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'keep-local-'));
  const path = join(dir, 'big.mov');
  await writeFile(path, Buffer.alloc(LARGE_FILE.threshold_bytes + 5, 1));
  const door = fakeDoor();
  const answer = await keepALocalFile({ path, name: 'films/big.mov' }, { door });
  assert.equal(answer.kept[0].finished.state, 'uploaded');
  assert.deepEqual(door.calls.map(call => call.op), ['writeLarge']);
  assert.equal(door.calls[0].size, LARGE_FILE.threshold_bytes + 5);
});

test('a list keeps each file in order and names each refusal, and one refusal does not stop the others', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'keep-local-'));
  const real = join(dir, 'real.txt');
  await writeFile(real, 'x');
  const link = join(dir, 'link.txt');
  await symlink(real, link);
  const folder = join(dir, 'folder');
  await mkdir(folder);
  const door = fakeDoor();
  const answer = await keepALocalFile({ files: [
    { path: link, name: 'a/link.txt' },
    { path: folder, name: 'a/folder' },
    { path: 'relative.txt', name: 'a/rel.txt' },
    { path: real, name: '../escape.txt' },
    { path: real, name: 'a/real.txt' },
  ] }, { door });
  assert.deepEqual(answer.kept.map(file => file.name), ['a/real.txt']);
  assert.deepEqual(answer.refused.map(row => row.reason), [
    'A link is not kept; name the file itself.',
    'Only a regular file can be kept.',
    'The local file must be named by its full path.',
    'The name in Files is not a valid name.',
  ]);
  assert.ok(answer.refused.every(row => row.code === 'refused'));
});

test('a run over the most files is refused before anything is sent', async () => {
  const door = fakeDoor();
  const files = Array.from({ length: 300 }, (_, index) => ({ path: `/tmp/x${index}`, name: `a/${index}` }));
  await assert.rejects(keepALocalFile({ files }, { door }), { code: 'refused' });
  assert.equal(door.calls.length, 0);
});
