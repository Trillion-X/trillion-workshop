import { tempFolder } from '../../../test-helpers/temp-folder.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFile, symlink, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { keepALocalFile } from '../do-work/keep-a-local-file.mjs';
import { LARGE_FILE } from '../../workflows/read-data/whole-file.mjs';

// A host whose files right records each call: pieces for a small write, and raw pieces (writeLarge) for a large one.
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
  const dir = tempFolder(join(tmpdir(), 'keep-local-'));
  const path = join(dir, 'clip.mp4');
  await writeFile(path, Buffer.alloc(100_000, 7));
  const door = fakeDoor();
  const answer = await keepALocalFile({ path, name: '/site/clip.mp4', media_type: 'video/mp4' }, door);
  assert.deepEqual(answer.refused, []);
  assert.equal(answer.kept[0].bytes, 100_000);
  assert.deepEqual(answer.kept[0].finished, { name: '/site/clip.mp4', state: 'written' });
  assert.equal(door.calls[0].op, 'write_file_start');
  assert.ok(door.calls.filter(call => call.op === 'write_file_piece').length >= 2);
});

for (const name of [
  '/workspace screens/before/2026-11-24 3.58.07 AM CST media loading.txt',
  '/notes/été/練習 🎾.txt',
  '/notes/.drafts/Café (first take) #1.txt',
]) {
  test(`keeps the exact printable Files name ${name}`, async () => {
    const dir = tempFolder(join(tmpdir(), 'keep-local-'));
    const path = join(dir, 'neutral fixture.txt');
    const bytes = Buffer.from('neutral fixture');
    await writeFile(path, bytes);
    const door = fakeDoor();
    const answer = await keepALocalFile({ path, name, media_type: 'text/plain' }, door);
    assert.deepEqual(answer.refused, []);
    assert.equal(answer.kept[0].name, name);
    assert.equal(answer.kept[0].finished.name, name);
    assert.ok(door.calls.every(call => call.args.name === name));
    const kept = Buffer.concat(door.calls.filter(call => call.op === 'write_file_piece').map(call => Buffer.from(call.args.content_base64, 'base64')));
    assert.deepEqual(kept, bytes);
  });
}

test('the Files name bound is 2048 UTF-8 bytes, not a count of JavaScript characters', async () => {
  const dir = tempFolder(join(tmpdir(), 'keep-local-'));
  const path = join(dir, 'neutral.txt');
  await writeFile(path, 'neutral');
  const name = `/${'é'.repeat(1023)}a`;
  assert.equal(Buffer.byteLength(name), 2048);
  const answer = await keepALocalFile({ path, name }, fakeDoor());
  assert.deepEqual(answer.refused, []);
  assert.equal(answer.kept[0].name, name);
});

for (const [kind, name] of [
  ['relative', 'notes/a.txt'],
  ['root', '/'],
  ['empty segment', '/notes//a.txt'],
  ['trailing slash', '/notes/'],
  ['dot segment', '/notes/./a.txt'],
  ['parent segment', '/notes/../a.txt'],
  ['leading parent', '/../a.txt'],
  ['NUL', '/notes/a\u0000.txt'],
  ['line break', '/notes/a\n.txt'],
  ['tab', '/notes/a\t.txt'],
  ['DEL', '/notes/a\u007f.txt'],
  ['C1 control', '/notes/a\u0085.txt'],
  ['too many ASCII bytes', `/${'a'.repeat(2048)}`],
  ['too many UTF-8 bytes', `/${'é'.repeat(1024)}`],
]) {
  test(`refuses a ${kind} Files name before reading a source or asking for files rights`, async () => {
    const door = fakeDoor();
    let stats = 0;
    door.stat = async () => { stats++; throw new Error('the source must not be read'); };
    const answer = await keepALocalFile({ path: '/fixture/neutral.txt', name }, door);
    assert.deepEqual(answer.kept, []);
    assert.equal(answer.refused[0].code, 'refused');
    assert.equal(answer.refused[0].reason, 'The name in Files is not a valid name.');
    assert.equal(stats, 0);
    assert.deepEqual(door.calls, []);
  });
}

test('a missing source is refused without starting a write', async () => {
  const dir = tempFolder(join(tmpdir(), 'keep-local-'));
  const door = fakeDoor();
  const answer = await keepALocalFile({ path: join(dir, 'missing.txt'), name: '/notes/missing.txt' }, door);
  assert.deepEqual(answer.kept, []);
  assert.equal(answer.refused[0].code, 'ENOENT');
  assert.deepEqual(door.calls, []);
});

test('a file above the whole-file threshold goes in raw pieces (writeLarge), not in base64 pieces', async () => {
  const dir = tempFolder(join(tmpdir(), 'keep-local-'));
  const path = join(dir, 'big.mov');
  await writeFile(path, Buffer.alloc(LARGE_FILE.threshold_bytes + 5, 1));
  const door = fakeDoor();
  const answer = await keepALocalFile({ path, name: '/films/big.mov' }, door);
  assert.equal(answer.kept[0].finished.state, 'uploaded');
  assert.deepEqual(door.calls.map(call => call.op), ['writeLarge']);
  assert.equal(door.calls[0].size, LARGE_FILE.threshold_bytes + 5);
});

test('the next run of an unchanged file goes on with the same upload, and a changed file starts a new one', async () => {
  const dir = tempFolder(join(tmpdir(), 'keep-local-'));
  const path = join(dir, 'card.mp4');
  await writeFile(path, Buffer.alloc(LARGE_FILE.threshold_bytes + 5, 1));
  const first = fakeDoor();
  const second = fakeDoor();
  await keepALocalFile({ path, name: '/cards/card.mp4' }, first);
  await keepALocalFile({ path, name: '/cards/card.mp4' }, second);
  const id = first.calls[0].options.uploadId;
  assert.match(id, /^[0-9a-f]{32}$/);
  assert.equal(second.calls[0].options.uploadId, id);
  const renamed = fakeDoor();
  await keepALocalFile({ path, name: '/cards/other.mp4' }, renamed);
  assert.notEqual(renamed.calls[0].options.uploadId, id);
  await writeFile(path, Buffer.alloc(LARGE_FILE.threshold_bytes + 6, 1));
  const changed = fakeDoor();
  await keepALocalFile({ path, name: '/cards/card.mp4' }, changed);
  assert.notEqual(changed.calls[0].options.uploadId, id);
  const small = join(dir, 'note.txt');
  await writeFile(small, 'hello');
  const a = fakeDoor(); const b = fakeDoor();
  await keepALocalFile({ path: small, name: '/cards/note.txt' }, a);
  await keepALocalFile({ path: small, name: '/cards/note.txt' }, b);
  assert.equal(a.calls[0].args.upload_id, b.calls[0].args.upload_id);
});

test('a file kept again under its own upload id answers the finished upload and sends nothing', async () => {
  const dir = tempFolder(join(tmpdir(), 'keep-local-'));
  const path = join(dir, 'grid.jpg');
  await writeFile(path, Buffer.alloc(500, 3));
  const finished = { name: '/a/grid.jpg', state: 'finished', identity: '1f:kept', version: 1 };
  const calls = [];
  const door = { async files(op, args) { calls.push(op); return op === 'write_file_start' ? { ...finished, upload_id: args.upload_id } : {}; } };
  const answer = await keepALocalFile({ path, name: '/a/grid.jpg' }, door);
  assert.deepEqual(answer.refused, []);
  assert.equal(answer.kept[0].finished.state, 'finished');
  assert.deepEqual(calls, ['write_file_start']);
});

test('a list keeps each file in order and names each refusal, and one refusal does not stop the others', async () => {
  const dir = tempFolder(join(tmpdir(), 'keep-local-'));
  const real = join(dir, 'real.txt');
  await writeFile(real, 'x');
  const link = join(dir, 'link.txt');
  await symlink(real, link);
  const folder = join(dir, 'folder');
  await mkdir(folder);
  const door = fakeDoor();
  const answer = await keepALocalFile({ files: [
    { path: link, name: '/a/link.txt' },
    { path: folder, name: '/a/folder' },
    { path: 'relative.txt', name: '/a/rel.txt' },
    { path: real, name: '/../escape.txt' },
    { path: real, name: '/a/real.txt' },
  ] }, door);
  assert.deepEqual(answer.kept.map(file => file.name), ['/a/real.txt']);
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
  await assert.rejects(keepALocalFile({ files }, door), { code: 'refused' });
  assert.equal(door.calls.length, 0);
});


test('a refused keep onto a name that holds the same bytes answers that file as kept; other bytes keep the refusal', async () => {
  const dir = tempFolder(join(tmpdir(), 'keep-local-'));
  const path = join(dir, 'shot.png');
  const bytes = Buffer.from('the same shot');
  await writeFile(path, bytes);
  const { makeHashCodeHexFromBytes } = await import('../../content-identity/read-data/identity.mjs');
  const refusing = held => ({
    async files(op) {
      if (op === 'find_file') return held;
      throw Object.assign(new Error('The files tool refused write_file_start: upload id cannot be reused.'), { code: 'original_input_refused' });
    },
  });
  const same = await keepALocalFile({ path, name: '/shots/shot.png', media_type: 'image/png' },
    refusing({ identity: makeHashCodeHexFromBytes(bytes), byte_length: bytes.length }));
  assert.deepEqual(same.refused, []);
  assert.deepEqual(same.kept[0].finished, { state: 'finished', already_kept: true, identity: makeHashCodeHexFromBytes(bytes), name: '/shots/shot.png', byte_length: bytes.length });
  const other = await keepALocalFile({ path, name: '/shots/shot.png', media_type: 'image/png' },
    refusing({ identity: makeHashCodeHexFromBytes(Buffer.from('another shot!')), byte_length: bytes.length }));
  assert.equal(other.refused[0].code, 'original_input_refused');
  assert.match(other.refused[0].reason, /write_file_start: upload id cannot be reused/);
});
