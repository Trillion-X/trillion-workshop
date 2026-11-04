import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { enumerateDevices, getADriveIcon, hiddenIn, listConnectedDrives, listDriveFolder, nameWhatHoldsADrive, seeWhatIsOnADrive, walkDrive } from '../read-data/drives.mjs';

const rows = JSON.parse(readFileSync(new URL('../tool-rows.json', import.meta.url), 'utf8')).records.map(record => record.payload);

// A pretend /Volumes: one external drive with a folder in it, and one hidden (nobrowse) volume.
function pretendMac() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'connected-drives-')));
  const drive = join(root, 'SAMPLE DRIVE');
  mkdirSync(join(drive, 'DCIM', 'Day 2'), { recursive: true });
  writeFileSync(join(drive, 'DCIM', 'clip-10.mov'), 'xx');
  writeFileSync(join(drive, 'DCIM', 'clip-9.mov'), 'x');
  writeFileSync(join(drive, 'DCIM', '.hidden'), '');
  mkdirSync(join(root, 'Simulator'));
  const outside = join(root, '..', `outside-${Date.now()}`);
  mkdirSync(outside, { recursive: true });
  symlinkSync(outside, join(drive, 'escape'));
  const answers = {
    '/sbin/mount': `/dev/disk9s1 on ${drive} (exfat, local, nodev)\n/dev/disk8s1 on ${join(root, 'Simulator')} (apfs, local, nobrowse)\n`,
    '/usr/sbin/diskutil': `<key>Internal</key><false/><key>SolidState</key><true/><key>MountPoint</key><string>${drive}</string><key>DeviceIdentifier</key><string>disk9s1</string><key>BusProtocol</key><string>USB</string>`,
    '/usr/sbin/lsof': 'p4242\ncSampleEditor\nn/x\np1\ncshould-skip\n',
  };
  const calls = [];
  const exec = async (command, args) => { calls.push([command, ...args]); return { ok: true, stdout: answers[command] ?? '' }; };
  return { root, drive, outside, deps: { exec, root, ownPid: 99 }, calls };
}

test('every row runs on the person\'s computer with only the drive capability, and changes nothing', () => {
  assert.deepEqual(rows.map(row => row.id), ['tool:list-connected-drives', 'tool:list-a-drive-folder', 'tool:name-what-holds-a-drive', 'tool:see-what-is-on-a-drive', 'tool:get-a-drive-icon']);
  for (const row of rows) {
    assert.equal(row.invoke.kind, 'computer');
    assert.deepEqual(row.invoke.capabilities, ['see-connected-drives']);
    assert.equal(row.invoke.records, undefined, 'no door: these read only the Mac');
    assert.notEqual(row.invoke.internet, true);
    assert.equal(row.result_selector, '$.result');
  }
});

test('lists the drives Finder shows, with their identity, and never a hidden volume', async () => {
  const mac = pretendMac();
  const devices = await enumerateDevices(mac.deps);
  assert.deepEqual(devices.map(device => device.name), ['SAMPLE DRIVE']);
  const { devices: shown } = await listConnectedDrives({}, {}, mac.deps);
  assert.equal(shown[0].mount, mac.drive);
  assert.equal(shown[0].internal, false);
  assert.equal(shown[0].kind, 'External SSD');
  assert.deepEqual(hiddenIn(`/dev/a on /Volumes/sample-one (apfs, nobrowse)\n/dev/b on /Volumes/sample-two (apfs, local)`), new Set(['/Volumes/sample-one']));
});

test('lists one folder on a drive, folders first and numbers in order, and refuses any path off the drives', async () => {
  const mac = pretendMac();
  const folder = await listDriveFolder({ path: join(mac.drive, 'DCIM') }, {}, mac.deps);
  assert.deepEqual(folder.entries.map(entry => entry.name), ['Day 2', 'clip-9.mov', 'clip-10.mov']);
  assert.equal(folder.entries[1].file_kind, 'video');
  assert.equal(folder.total, 3, 'hidden names are left out');
  await assert.rejects(listDriveFolder({ path: join(mac.drive, 'escape') }, {}, mac.deps), /not on a connected drive/);
  await assert.rejects(listDriveFolder({ path: mac.outside }, {}, mac.deps), /not on a connected drive/);
  await assert.rejects(listDriveFolder({}, {}, mac.deps), /Say which folder/);
});

test('names the programs holding a drive from the open files lsof reports, never itself or launchd', async () => {
  const mac = pretendMac();
  assert.deepEqual(await nameWhatHoldsADrive({ mount: mac.drive }, {}, mac.deps), { mount: mac.drive, processes: [{ pid: 4242, name: 'SampleEditor' }] });
  await assert.rejects(nameWhatHoldsADrive({ mount: '/Volumes/NOT-HERE' }, {}, mac.deps), /not connected/);
});

test('tells what is on a drive by kind, and says when its bounds stopped the look', async () => {
  const mac = pretendMac();
  const seen = await seeWhatIsOnADrive({ mount: mac.drive }, {}, mac.deps);
  assert.equal(seen.complete, true);
  assert.equal(seen.files, 3);
  assert.deepEqual(seen.kinds.map(row => [row.kind, row.files]), [['video', 2], ['other', 1]]);
  assert.equal(seen.largest[0].path, join(mac.drive, 'DCIM', 'clip-10.mov'));
  const cut = await walkDrive(mac.drive, { most_files: 1, most_ms: 60_000, largest_kept: 10 });
  assert.equal(cut.complete, false);
  assert.equal(cut.files, 1);
  await assert.rejects(seeWhatIsOnADrive({ mount: mac.outside }, {}, mac.deps), /not connected/);
});

test('draws a drive icon at an allowed size only, through osascript with the path as an argument', async () => {
  const mac = pretendMac();
  const drawn = [];
  const exec = async (command, args) => {
    if (command !== '/usr/bin/osascript') return mac.deps.exec(command, args);
    drawn.push(args);
    writeFileSync(args.at(-1), 'png-bytes');
    return { ok: true, stdout: '' };
  };
  const icon = await getADriveIcon({ mount: mac.drive, size: 64 }, {}, { ...mac.deps, exec });
  assert.deepEqual([icon.media_type, Buffer.from(icon.base64, 'base64').toString()], ['image/png', 'png-bytes']);
  assert.deepEqual(drawn[0].slice(3, 5), [mac.drive, '64']);
  await assert.rejects(getADriveIcon({ mount: mac.drive, size: 4 }, {}, { ...mac.deps, exec }), /from 32 to 512/);
});

test('a process is named the way the person knows it: a script by its script, a program by its whole name', async () => {
  const { readProcessRows } = await import('../read-data/drive-processes.mjs');
  const rows = readProcessRows(
    ' 41 /usr/local/bin/node /Volumes/Card/Copy Tools/copy-cards.mjs --to Backup\n 52 /Applications/Long Program Name.app/Contents/MacOS/Long Program Name\n',
    ' 41 /usr/local/bin/node\n 52 /Applications/Long Program Name.app/Contents/MacOS/Long Program Name\n');
  assert.deepEqual(rows.map(row => [row.pid, row.name]), [[41, 'copy-cards.mjs'], [52, 'Long Program Name']]);
});

// A pretend place with no diskutil: a kernel mount table and one mount root holding one drive.
function pretendMountTable() {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'mount-table-')));
  const media = join(base, 'media');
  const drive = join(media, 'CARD ONE');
  mkdirSync(join(drive, 'DCIM'), { recursive: true });
  writeFileSync(join(drive, 'DCIM', 'clip-1.mov'), 'xyz');
  const elsewhere = join(base, 'elsewhere');
  mkdirSync(elsewhere);
  const esc = value => value.replace(/ /g, '\\040');
  const table = join(base, 'mountinfo');
  writeFileSync(table, [
    '22 1 259:2 / / rw,relatime shared:1 - ext4 /dev/nvme0n1p2 rw',
    `90 22 8:17 / ${esc(drive)} rw,nosuid,nodev shared:50 - exfat /dev/sdb1 rw,uid=1000`,
    `91 22 8:17 / ${esc(drive)} rw,nosuid,nodev shared:50 - exfat /dev/sdb1 rw,uid=1000`,
    `92 22 0:40 / ${esc(join(media, 'scratch'))} rw - tmpfs tmpfs rw`,
    `93 22 8:33 / ${esc(elsewhere)} rw - ext4 /dev/sdc1 rw`,
    'not a mountinfo line',
  ].join('\n') + '\n');
  const calls = [];
  const exec = async (command, args) => { calls.push([command, ...args]); return { ok: true, stdout: 'p4242\ncSampleEditor\nn/x\n' }; };
  const reader = { id: 'mount-table', at: table, mount_roots: [media], lsof: '/usr/bin/lsof' };
  return { drive, elsewhere, calls, deps: { reader, exec, ownPid: 99 } };
}

test('the second reader lists block-device mounts inside its mount roots from a kernel mount table, without diskutil', async () => {
  const place = pretendMountTable();
  const { devices } = await listConnectedDrives({}, {}, place.deps);
  assert.deepEqual(devices, [{ name: 'CARD ONE', mount: place.drive, size_bytes: devices[0].size_bytes, free_bytes: devices[0].free_bytes,
    kind: 'Storage device', internal: false, ejectable: false, state: 'connected' }]);
  const folder = await listDriveFolder({ path: join(place.drive, 'DCIM') }, {}, place.deps);
  assert.deepEqual(folder.entries.map(entry => entry.name), ['clip-1.mov']);
  await assert.rejects(listDriveFolder({ path: place.elsewhere }, {}, place.deps), /not on a connected drive/);
  const seen = await seeWhatIsOnADrive({ mount: place.drive }, {}, place.deps);
  assert.equal(seen.files, 1);
  const held = await nameWhatHoldsADrive({ mount: place.drive }, {}, place.deps);
  assert.deepEqual(held.processes.map(process => process.name), ['SampleEditor']);
  assert.equal(place.calls[0][0], '/usr/bin/lsof', 'the place\'s own lsof, from its reader row');
  const icon = await getADriveIcon({ mount: place.drive }, {}, place.deps);
  assert.equal(icon.icon, 'none', 'a reader with no icon way answers no icon');
  assert.ok(!place.calls.some(([command]) => command.includes('osascript') || command.includes('diskutil')));
});

test('the reader is chosen by which reader path the place has, never by what kind of machine it is', async () => {
  const { chooseReader } = await import('../read-data/drives.mjs');
  const settings = JSON.parse(readFileSync(new URL('../read-data/drives.json', import.meta.url), 'utf8'));
  assert.deepEqual(settings.readers.map(reader => reader.id), ['finder-volumes', 'mount-table']);
  assert.equal(chooseReader({ exists: at => at === '/usr/sbin/diskutil' }).id, 'finder-volumes');
  assert.equal(chooseReader({ exists: at => at === '/proc/self/mountinfo' }).id, 'mount-table');
  assert.equal(chooseReader({ exists: () => false }), null);
  assert.deepEqual(await enumerateDevices({ reader: { id: 'mount-table', at: '/no/such/table', mount_roots: ['/media'] } }), []);
  const source = readFileSync(new URL('../read-data/drives.mjs', import.meta.url), 'utf8');
  assert.ok(!/process\.platform/.test(source));
});
