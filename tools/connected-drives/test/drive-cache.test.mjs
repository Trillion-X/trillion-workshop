// The drive icon cache, the walk's progress file and its lock. Temp folders and fake draws and walks; no real drive is touched.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createIconCache, createDriveWalks, iconSize, volumeKey } from '../read-data/drive-cache.mjs';

const folder = () => mkdtempSync(join(tmpdir(), 'drive-cache-'));

test('an icon is drawn once per exact volume and size, then read back from the cache', async () => {
  const dir = folder();
  let draws = 0;
  const cache = createIconCache({ folder: dir, draw: async (mount, size, out) => { draws += 1; writeFileSync(out, `png-${size}`); } });
  const key = volumeKey({ identifier: 'disk9s1', dev: 16, ino: 2 });
  const first = await cache.png({ mount: '/Volumes/X', key, size: 256 });
  const again = await cache.png({ mount: '/Volumes/X', key, size: 256 });
  assert.equal(first.toString(), 'png-256');
  assert.equal(again.toString(), 'png-256');
  assert.equal(draws, 1);
  await cache.png({ mount: '/Volumes/X', key, size: 64 });
  assert.equal(draws, 2);
  const other = await cache.png({ mount: '/Volumes/X', key: volumeKey({ identifier: 'disk9s1', dev: 16, ino: 3 }), size: 256 });
  assert.equal(draws, 3, 'a different volume at the same place is drawn afresh');
  assert.equal(other.toString(), 'png-256');
});

test('an icon size is refused outside 32 to 512 whole pixels', () => {
  assert.equal(iconSize(undefined), 256);
  assert.equal(iconSize('64'), 64);
  assert.equal(iconSize(31), null);
  assert.equal(iconSize(513), null);
  assert.equal(iconSize(40.5), null);
});

test('a walk keeps its progress file while it reads, removes it and its lock after, and keeps the result', async () => {
  const dir = folder();
  const seen = [];
  const walks = createDriveWalks({
    folder: dir,
    walk: async (mount, { onProgress }) => { onProgress(7); seen.push(existsSync(join(dir, 'k.lock'))); return { mount, files: 7 }; },
  });
  const result = await walks.read('/Volumes/X', 'k');
  assert.deepEqual(result, { mount: '/Volumes/X', files: 7 });
  assert.equal(seen[0], true, 'the lock is held during the walk');
  assert.equal(existsSync(join(dir, 'k.lock')), false, 'the lock is removed after');
  assert.equal(existsSync(join(dir, 'k.progress.json')), false, 'the progress file is removed after');
  assert.deepEqual(JSON.parse(readFileSync(join(dir, 'k.json'), 'utf8')), { mount: '/Volumes/X', files: 7 });
});

test('a second ask while a live walk holds the lock is answered as reading, not walked again', async () => {
  const dir = folder();
  let walked = 0;
  const walks = createDriveWalks({ folder: dir, walk: async () => { walked += 1; return {}; } });
  writeFileSync(join(dir, 'k.lock'), String(process.pid));
  writeFileSync(join(dir, 'k.progress.json'), JSON.stringify({ files_seen: 42 }));
  const answer = await walks.read('/Volumes/X', 'k');
  assert.deepEqual(answer, { reading: true, progress: { files_seen: 42 } });
  assert.equal(walked, 0);
});

test('a stale lock whose walk is gone is taken over', async () => {
  const dir = folder();
  let walked = 0;
  const walks = createDriveWalks({ folder: dir, walk: async () => { walked += 1; return { ok: true }; } });
  writeFileSync(join(dir, 'k.lock'), '999999999');
  const answer = await walks.read('/Volumes/X', 'k');
  assert.deepEqual(answer, { ok: true });
  assert.equal(walked, 1);
});

test('the walk reports progress about once a second, not per file', async () => {
  const { walkDrive, PROGRESS_EVERY_MS } = await import('../read-data/drives.mjs');
  assert.equal(PROGRESS_EVERY_MS, 1000);
  const dir = folder();
  for (let n = 0; n < 5; n++) writeFileSync(join(dir, `f${n}.txt`), 'x');
  const bounds = { most_files: 100, most_ms: 1e9, largest_kept: 2 };
  const still = [];
  await walkDrive(dir, bounds, () => 0, files => still.push(files));
  assert.deepEqual(still, [], 'no report while the clock has not moved a second');
  const ticking = [];
  let t = 0;
  await walkDrive(dir, bounds, () => (t += 400), files => ticking.push(files));
  assert.equal(ticking.length >= 1 && ticking.length <= 3, true, `reports: ${ticking.length}`);
  assert.ok(ticking.length < 5, 'fewer reports than files');
});
