// The drive tools over pretend drives in a temporary folder: what Finder hides is never a drive, a copy is checked
// and tells the host each path it wrote, and the host's own facts arrive only as the functions it hands in.
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { pathToFileURL } from 'node:url';

// drives.mjs keeps its state under the home folder from the moment it loads, so the home is a temporary one first.
const home = await mkdtemp(path.join(os.tmpdir(), 'work-on-drives-home-'));
process.env.HOME = home;
const drives = await import('../read-data/drives.mjs');
const { runTransfer } = await import('../read-data/file-transfer.mjs');
const host = pathToFileURL(path.join(import.meta.dirname, 'fixtures', 'host.mjs')).href;
test.after(() => rm(home, { recursive: true, force: true }));

test('a volume Finder hides (mounted nobrowse, like a simulator runtime) is never a drive', () => {
  const hidden = drives.hiddenIn([
    '/dev/disk3s1s1 on / (apfs, sealed, local, read-only, journaled)',
    '/dev/disk7s1 on /Volumes/iOS 26.5 Simulator (apfs, sealed, local, nodev, nosuid, read-only, journaled, noatime, nobrowse)',
    '/dev/disk9s1 on /Volumes/Proof Backup (apfs, local, nodev, nosuid, journaled, noowners, mounted by someone)',
  ].join('\n'));
  assert.deepEqual([...hidden], ['/Volumes/iOS 26.5 Simulator']);
});

test('every tool the rows name is a function the host can call', async () => {
  const places = await import('../read-data/file-places.mjs');
  for (const name of ['listDrives', 'getADriveIcon', 'seeWhatKindsOfFileADriveHolds', 'listADriveFolder', 'nameWhatHoldsThisDrive',
    'listDriveWork', 'controlDriveWork', 'copyOrMoveBetweenDrives', 'ejectADrive']) assert.equal(typeof drives[name], 'function', name);
  assert.equal(typeof places.findEveryPlaceAFileIs, 'function');
});

test('the drives list carries the host\'s sync status only when the host hands its function in', async () => {
  const handed = await drives.listDrives({}, { drive_sync: { module: host, export: 'driveSync' } });
  assert.ok(Array.isArray(handed.devices));
  assert.deepEqual(handed.trillion_drive, { state: 'synced', said: 'Up to date', moving: { count: 0, bytes: 0 } });
  assert.equal(Object.hasOwn(await drives.listDrives({}, {}), 'trillion_drive'), false);
});

test('a handed function must be a file on this computer, and one the host does not offer is refused', async () => {
  assert.throws(() => drives.handedFunction({ module: 'https://example.com/host.mjs', export: 'driveSync' }), error => error.status === 400);
  assert.equal(drives.handedFunction(undefined), null);
  await assert.rejects(() => drives.listDrives({}, { drive_sync: { module: host, export: 'notThere' } }), error => error.status === 500);
});

test('a copy is checked, named, and tells the host each path it wrote; with no host function it notes nothing', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'work-on-drives-copy-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const from = path.join(root, 'Card'), to = path.join(root, 'Backup'), notes = path.join(root, 'notes.txt');
  await mkdir(from); await mkdir(to);
  await writeFile(path.join(from, 'clip.mov'), 'synthetic bytes');
  process.env.WORK_ON_DRIVES_NOTES = notes;
  for (const [name, note_written] of [['noted', { module: host, export: 'noteWritten' }], ['plain', undefined]]) {
    const stateDir = path.join(root, name);
    await mkdir(stateDir);
    await writeFile(path.join(stateDir, 'job.json'), JSON.stringify({ id: name, sources: [path.join(from, 'clip.mov')], destinations: [to], mode: 'copy', created_at: new Date().toISOString(), ...(note_written ? { note_written } : {}) }));
    const progress = await runTransfer({ stateDir, pollMs: 5 });
    assert.equal(progress.state, 'finished');
  }
  assert.equal(await readFile(path.join(to, 'clip.mov'), 'utf8'), 'synthetic bytes');
  assert.equal(await readFile(path.join(to, 'clip 2.mov'), 'utf8'), 'synthetic bytes');
  const noted = (await readFile(notes, 'utf8')).trim().split('\n');
  assert.equal(noted.length, 1);
  assert.equal(path.basename(noted[0]), 'clip.mov');
});
