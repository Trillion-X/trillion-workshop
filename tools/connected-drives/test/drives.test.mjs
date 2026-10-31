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
