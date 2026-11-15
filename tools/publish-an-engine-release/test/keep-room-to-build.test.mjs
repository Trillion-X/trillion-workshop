// A publish run keeps room for its build: a made-up work folder on a made-up disk (a statfs stand-in: the disk's size less
// the bytes the folder holds), so the bound, the order of removal and the refusal are checked with no real disk to fill.
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { keepRoom, NoRoom, targetsFolderOf } from '../do-work/keep-room-to-build.mjs';
import { settings } from '../do-work/release-feed.mjs';
import { makeKey, publisherWith } from '../do-work/publish-an-engine-release.mjs';

const HOST = 'x86_64-unknown-linux-gnu', ZIG = 'aarch64-unknown-linux-gnu', MAC = 'aarch64-apple-darwin';
const folder = () => mkdtempSync(join(tmpdir(), 'keep-room-'));
const bytesUnder = path => (statSync(path).isDirectory() ? readdirSync(path).reduce((sum, name) => sum + bytesUnder(join(path, name)), 0) : statSync(path).size);
// A folder that holds `bytes` bytes in one file and was last used `daysAgo` days ago.
const fill = (path, bytes, daysAgo = 0) => {
  mkdirSync(path, { recursive: true });
  const file = join(path, 'object.o');
  writeFileSync(file, Buffer.alloc(bytes));
  const when = new Date(Date.now() - daysAgo * 86_400_000);
  utimesSync(file, when, when);
  utimesSync(path, when, when);
};
// A work folder: three target folders of 1000 bytes (the host's the oldest), the retired layout's two of 500, and a folder the tool never made.
const builderWork = () => {
  const work = join(folder(), 'work'), targets = targetsFolderOf(work);
  fill(join(targets, HOST), 1000, 9);
  fill(join(targets, ZIG), 1000, 5);
  fill(join(targets, MAC), 1000, 7);
  fill(join(targets, 'release'), 500, 30);
  fill(join(targets, 'icu4c'), 500, 30);
  fill(join(work, 'target-windows'), 3000, 20);
  return work;
};
// A disk of `size` bytes that holds only the work folder.
const disk = (work, size) => () => size - bytesUnder(work);
const still = (work, ...names) => names.map(name => existsSync(join(work, name)));
const RETIRED = ['target/release', 'target/icu4c'];

test('under the bound, the retired layout goes, then the targets the longest unused first, and the host target stays', () => {
  const work = builderWork();
  // 7000 bytes of folders on a 8000-byte disk: 1000 free, a bound of 2500 needs the retired 1000 and one more target.
  const room = keepRoom({ work, keep: [HOST], freeBytes: disk(work, 8000), bound: 2500, retired: RETIRED });
  assert.deepEqual(room.removed.map(one => one.folder), ['target/release', 'target/icu4c', `target/${MAC}`]);
  assert.deepEqual(still(work, `target/${HOST}`, `target/${ZIG}`, `target/${MAC}`), [true, true, false]);
  assert.equal(room.free_bytes_before, 1000);
  assert.equal(room.free_bytes, 3000);
  assert.deepEqual(room.removed.map(one => one.freed_bytes), [500, 500, 1000]);
});

test('above the bound nothing is removed but the retired layout, and a folder the tool never made is never touched', () => {
  const work = builderWork();
  const room = keepRoom({ work, keep: [HOST], freeBytes: disk(work, 70_000), bound: 2500, retired: RETIRED });
  assert.deepEqual(room.removed.map(one => one.folder), ['target/release', 'target/icu4c']);
  assert.deepEqual(still(work, `target/${HOST}`, `target/${ZIG}`, `target/${MAC}`, 'target-windows'), [true, true, true, true]);
});

test('with nothing retired and room to spare, nothing is removed at all', () => {
  const work = builderWork();
  const room = keepRoom({ work, keep: [HOST], freeBytes: disk(work, 70_000), bound: 2500, retired: [] });
  assert.deepEqual(room.removed, []);
  assert.deepEqual(still(work, 'target/release', 'target/icu4c'), [true, true]);
});

test('the target being built is kept when every other target is gone and the bound still fails: the run is refused with the numbers', () => {
  const work = builderWork();
  const bound = 9000;
  assert.throws(() => keepRoom({ work, keep: [HOST], freeBytes: disk(work, 8000), bound, retired: RETIRED }), error => {
    assert.ok(error instanceof NoRoom);
    assert.equal(error.exit, 5);
    assert.equal(error.room.free_bytes, 4000);
    assert.deepEqual(error.room.removed.map(one => one.folder), ['target/release', 'target/icu4c', `target/${MAC}`, `target/${ZIG}`]);
    assert.match(error.message, /not enough room to build/);
    assert.match(error.message, /4000 bytes/);
    assert.match(error.message, /target\/aarch64-apple-darwin/);
    return true;
  });
  assert.equal(existsSync(join(work, 'target', HOST)), true);
});

test('only folders named like a rust target are taken from work/target, and the retired list stays under the work folder', () => {
  const work = builderWork();
  fill(join(targetsFolderOf(work), 'not-a-target folder'), 1000, 40);
  fill(join(targetsFolderOf(work), 'kept'), 1000, 40);
  assert.throws(() => keepRoom({ work, keep: [HOST], freeBytes: disk(work, 9000), bound: 100_000, retired: [] }), NoRoom);
  assert.deepEqual(still(work, `target/${HOST}`, `target/${ZIG}`, `target/${MAC}`, 'target/not-a-target folder', 'target/kept', 'target/release', 'target/icu4c', 'target-windows'),
    [true, false, false, true, true, true, true, true]);
});

test('a retired name that leaves the work folder is refused', () => {
  const work = builderWork();
  for (const name of ['../elsewhere', '/var/lib', 'target//release', '', 'target/./release']) assert.throws(() => keepRoom({ work, keep: [], freeBytes: () => 1e12, bound: 1, retired: [name] }), /retired_work_folders/);
});

test('the shipped settings name the bound and the retired layout the tool made before 2026-11-11', () => {
  assert.equal(settings.build_free_bytes_at_least, 10 * 2 ** 30);
  assert.deepEqual(settings.retired_work_folders, ['target/release', 'target/icu4c']);
});

test('a publish run with no room is refused before git is touched, and feed-status.json says so for every target', async () => {
  const top = folder(), work = join(top, 'work'), feed = join(top, 'feed');
  mkdirSync(feed, { recursive: true });
  writeFileSync(join(feed, 'feed.json'), '{"releases":[]}\n');
  fill(join(targetsFolderOf(work), HOST), 1000, 1);
  const request = { repository: join(top, 'no-such-repository.git'), branch: 'main', base_url: 'https://releases.example.com/engine-releases/', work_folder: work, feed_folder: feed, key_file: join(top, 'key', 'release-signing.key') };
  makeKey(request.key_file);
  // The real disk has room for this made-up folder, so the bound is higher than any disk has free.
  const { publish } = publisherWith([]);
  const original = settings.build_free_bytes_at_least;
  settings.build_free_bytes_at_least = Number.MAX_SAFE_INTEGER;
  try {
    await assert.rejects(() => publish(request, { commit: 'a'.repeat(40) }), error => error instanceof NoRoom && error.exit === 5);
  } finally { settings.build_free_bytes_at_least = original; }
  const status = JSON.parse(readFileSync(join(feed, 'feed-status.json'), 'utf8'));
  assert.equal(status.commit, 'a'.repeat(40));
  for (const target of [HOST, ZIG, MAC]) {
    assert.equal(status.targets[target].state, 'gap');
    assert.match(status.targets[target].cause, /not enough room to build/);
  }
  assert.equal(existsSync(join(work, 'source')), false);
});
