// The drive work tools over pretend drives in a temporary folder: what Finder hides is never a drive, every row names a
// function run-an-export can call with the capabilities the engine's sandbox gives it, and a copy is checked and named.
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

// drives.mjs keeps a run's transfers under the run's home folder from the moment it loads, so the home is a temporary one first.
const home = await mkdtemp(path.join(os.tmpdir(), 'work-on-drives-home-'));
process.env.HOME = home;
const drives = await import('../read-data/drives.mjs');
const { hiddenIn } = await import('../../connected-drives/read-data/drives.mjs');
const { runTransfer } = await import('../read-data/file-transfer.mjs');
const rows = JSON.parse(await readFile(new URL('../tool-rows.json', import.meta.url), 'utf8')).records.map(record => record.payload);
test.after(() => rm(home, { recursive: true, force: true }));

test('a volume Finder hides (mounted nobrowse, like a simulator runtime) is never a drive', () => {
  const hidden = hiddenIn([
    '/dev/disk3s1s1 on / (apfs, sealed, local, read-only, journaled)',
    '/dev/disk7s1 on /Volumes/iOS 26.5 Simulator (apfs, sealed, local, nodev, nosuid, read-only, journaled, noatime, nobrowse)',
    '/dev/disk9s1 on /Volumes/Proof Backup (apfs, local, nodev, nosuid, journaled, noowners, mounted by someone)',
  ].join('\n'));
  assert.deepEqual([...hidden], ['/Volumes/iOS 26.5 Simulator']);
});

test('every tool the rows name is a function run-an-export can call', async () => {
  const places = await import('../read-data/file-places.mjs');
  for (const name of ['listDriveWork', 'controlDriveWork', 'copyOrMoveBetweenDrives', 'ejectADrive']) assert.equal(typeof drives[name], 'function', name);
  assert.equal(typeof places.findEveryPlaceAFileIs, 'function');
  for (const row of rows) {
    const [, , file, name] = row.invoke.argv;
    const module = await import(path.join(import.meta.dirname, '..', 'read-data', path.basename(file)));
    assert.equal(typeof module[name], 'function', `${row.id} ${name}`);
  }
});

test('every row is a computer row seeing connected drives, and only transfer may change a folder', () => {
  assert.deepEqual(rows.map(row => row.id).sort(), ['tool:trillion-media-eject', 'tool:trillion-media-file-places', 'tool:trillion-media-transfer', 'tool:trillion-media-work', 'tool:trillion-media-work-control']);
  for (const row of rows) {
    assert.equal(row.invoke.kind, 'computer', row.id);
    assert.equal(row.invoke.workdir, '/opt/work-on-connected-drives');
    assert.deepEqual(row.invoke.capabilities, row.id === 'tool:trillion-media-transfer' ? ['see-connected-drives', 'change-a-folder'] : ['see-connected-drives'], row.id);
    assert.ok(row.invoke.files.package_files.some(item => item.package === 'connected-drives'), row.id);
  }
});

test('a copy is checked and named, and a second copy to the same folder gets the next free name', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'work-on-drives-copy-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const from = path.join(root, 'Card'), to = path.join(root, 'Backup');
  await mkdir(from); await mkdir(to);
  await writeFile(path.join(from, 'clip.mov'), 'synthetic bytes');
  const noted = [];
  for (const name of ['first', 'second']) {
    const stateDir = path.join(root, name);
    await mkdir(stateDir);
    await writeFile(path.join(stateDir, 'job.json'), JSON.stringify({ id: name, sources: [path.join(from, 'clip.mov')], destinations: [to], mode: 'copy', created_at: new Date().toISOString() }));
    const progress = await runTransfer({ stateDir, pollMs: 5, noteWritten: file => noted.push(file) });
    assert.equal(progress.state, 'finished');
  }
  assert.equal(await readFile(path.join(to, 'clip.mov'), 'utf8'), 'synthetic bytes');
  assert.equal(await readFile(path.join(to, 'clip 2.mov'), 'utf8'), 'synthetic bytes');
  assert.deepEqual(noted.sort(), [path.join(to, 'clip 2.mov'), path.join(to, 'clip.mov')].sort(), 'the callback sees each verified file only after its final name is in place');
});

test('a same-drive move notes the final path after its rename', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'work-on-drives-rename-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const from = path.join(root, 'Card'), to = path.join(root, 'Backup'), source = path.join(from, 'clip.mov');
  await mkdir(from); await mkdir(to);
  await writeFile(source, 'synthetic bytes');
  const stateDir = path.join(root, 'move');
  await mkdir(stateDir);
  await writeFile(path.join(stateDir, 'job.json'), JSON.stringify({ id: 'move', sources: [source], destinations: [to], mode: 'move', created_at: new Date().toISOString() }));
  const noted = [];
  const progress = await runTransfer({ stateDir, pollMs: 5, noteWritten: file => noted.push(file) });
  assert.equal(progress.state, 'finished');
  assert.equal(await readFile(path.join(to, 'clip.mov'), 'utf8'), 'synthetic bytes');
  assert.deepEqual(noted, [path.join(to, 'clip.mov')]);
});
