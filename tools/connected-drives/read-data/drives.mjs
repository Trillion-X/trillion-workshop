// tools/connected-drives/read-data/drives.mjs
//
// PURPOSE
//   The drives connected to the person's Mac, what is in one folder on one of them, what is on one by kind of file,
//   the icon Finder shows for one, and which programs are using one. Functions run by tools/records-door's
//   run-an-export as `computer` rows that hold the `see-connected-drives` capability: the Mac's drive and icon
//   services, the `mount`, `diskutil`, `lsof` and `osascript` commands, and reads under /Volumes only.
//
// NON-NEGOTIABLE INVARIANTS
//   1. Only a volume mounted under /Volumes that Finder shows (not mounted `nobrowse`) is listed, and only one diskutil
//      says is not internal is a drive a folder or holder call may name; the system disk never is.
//   2. Every path a call is given must really be on such a drive: its real path (every link resolved) lies inside a
//      drive's real mount (drive-folder.mjs `driveOf`).
//   3. Nothing is changed: no file is written, no program is stopped, nothing is ejected.
//   4. A refusal says what to do, in words the person can read.
//   5. Every call ends inside one run's time: a look at what is on a drive stops at its bounds (read-data/drives.json)
//      and says how far it got.
//
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileKinds, kindOf, kindLabel } from './file-kinds.mjs';
import { parseDiskIdentity, resolveDriveIdentity } from './drive-identity.mjs';
import { driveFileHolders } from './drive-processes.mjs';
import { listFolder } from './drive-folder.mjs';

const VOLUMES_ROOT = '/Volumes';
const settings = JSON.parse(fs.readFileSync(new URL('./drives.json', import.meta.url), 'utf8'));
const DRAW_ICON = new URL('./draw-icon.js', import.meta.url).pathname;
const fail = message => new Error(message);

const run = (command, args) => new Promise(resolve => execFile(command, args, { timeout: 20_000, maxBuffer: 16 * 1024 * 1024 },
  (error, stdout) => resolve({ ok: !error, stdout: String(stdout ?? '') })));

/** The mount points macOS hides from Finder in `mount`'s output (mounted `nobrowse`): never a drive here. */
export function hiddenIn(mountOutput) {
  const hidden = new Set();
  for (const line of String(mountOutput).split('\n')) {
    const found = /^.+? on (.+) \(([^)]*)\)$/.exec(line);
    if (found && found[2].split(',').map(flag => flag.trim()).includes('nobrowse')) hidden.add(found[1]);
  }
  return hidden;
}

async function statVolume(mount) {
  try {
    const stat = await fs.promises.statfs(mount);
    return { size_bytes: stat.blocks * stat.bsize, free_bytes: stat.bavail * stat.bsize };
  } catch {
    return { size_bytes: null, free_bytes: null };
  }
}

/** Every volume under /Volumes that Finder shows, each with its identity from diskutil, one per disk, by name. */
export async function enumerateDevices({ exec = run, root = VOLUMES_ROOT } = {}) {
  const mounted = await exec('/sbin/mount', []);
  const hidden = mounted.ok ? hiddenIn(mounted.stdout) : new Set();
  let entries = [];
  try { entries = await fs.promises.readdir(root, { withFileTypes: true }); } catch {}
  const devices = [];
  for (const entry of entries) {
    if (!entry.isDirectory() && !entry.isSymbolicLink()) continue;
    const mount = path.join(root, entry.name);
    if (hidden.has(mount)) continue;
    const device = { id: mount, name: entry.name, mount, ...(await statVolume(mount)) };
    devices.push(await resolveDriveIdentity(device, { volumesRoot: root, readDiskInfo: async place => {
      const info = await exec('/usr/sbin/diskutil', ['info', '-plist', place]);
      return info.ok ? parseDiskIdentity(info.stdout) : null;
    } }));
  }
  const canonical = new Map();
  for (const device of devices) {
    const key = device.canonical_mount || device.mount;
    const current = canonical.get(key);
    if (!current || device.mount === device.canonical_mount) canonical.set(key, device);
  }
  return [...canonical.values()].sort((a, b) => String(a.name).localeCompare(String(b.name)));
}

const shown = ({ name, mount, size_bytes, free_bytes, kind, internal, ejectable }) => ({ name, mount, size_bytes, free_bytes, kind, internal, ejectable, state: 'connected' });

/** `tool:list-connected-drives`: every drive the Mac shows, the system disk marked internal. */
export async function listConnectedDrives(_input, _context, deps = {}) {
  return { devices: (await enumerateDevices(deps)).map(shown) };
}

const connectedDrives = async deps => (await enumerateDevices(deps)).filter(device => device.mount && !device.internal);

/** `tool:list-a-drive-folder`: one folder on a connected drive, a page at a time. */
export async function listDriveFolder({ path: target, offset, limit, hidden } = {}, _context, deps = {}) {
  if (typeof target !== 'string' || !target) throw fail('Say which folder: a full path on a connected drive, like /Volumes/Drive/DCIM.');
  try {
    return await listFolder({ target, devices: await connectedDrives(deps), offset: Number(offset) || 0, limit: Number(limit) || 200,
      hidden: hidden === true || hidden === '1' });
  } catch (error) {
    throw fail(error.message);
  }
}

/** `tool:name-what-holds-a-drive`: the programs with files open on one connected drive, which would stop an eject. */
export async function nameWhatHoldsADrive({ mount } = {}, _context, deps = {}) {
  const exec = deps.exec ?? run;
  const device = await connectedDrive(mount, deps);
  const open = await exec('/usr/sbin/lsof', ['-Fpcn', '+f', '--', device.canonical_mount || device.mount]);
  const processes = driveFileHolders(open.stdout, [], deps.ownPid ?? process.pid).map(({ pid, name }) => ({ pid, name }));
  return { mount: device.mount, processes };
}

const connectedDrive = async (mount, deps) => {
  const device = (await connectedDrives(deps)).find(candidate => candidate.mount === mount);
  if (!device) throw fail('This drive is not connected. List the drives and name one by its mount, like /Volumes/Drive.');
  return device;
};

/** What is under `mount` by kind of file, reading at most `most_files` files for at most `most_ms`. */
export async function walkDrive(mount, { most_files, most_ms, largest_kept } = settings.kinds, clock = () => performance.now()) {
  const started = clock();
  const skip = new Set(fileKinds.skip_folders);
  const totals = new Map();
  const largest = [];
  let files = 0, bytes = 0, complete = true;
  const folders = [mount];
  walk: while (folders.length) {
    const folder = folders.pop();
    let directory;
    try { directory = await fs.promises.opendir(folder); } catch { continue; }
    for await (const entry of directory) {
      if (files >= most_files || clock() - started >= most_ms) { complete = false; break walk; }
      const full = path.join(folder, entry.name);
      if (entry.isDirectory()) { if (!(folder === mount && skip.has(entry.name))) folders.push(full); continue; }
      if (!entry.isFile()) continue;
      let size;
      try { size = (await fs.promises.lstat(full)).size; } catch { continue; }
      files += 1; bytes += size;
      const kind = kindOf(entry.name);
      const row = totals.get(kind) ?? { kind, label: kindLabel(kind), files: 0, bytes: 0 };
      row.files += 1; row.bytes += size;
      totals.set(kind, row);
      if (largest.length < largest_kept || size > largest[largest.length - 1].bytes) {
        largest.push({ path: full, bytes: size });
        largest.sort((left, right) => right.bytes - left.bytes);
        if (largest.length > largest_kept) largest.pop();
      }
    }
  }
  return { mount, files, bytes, complete, kinds: [...totals.values()].sort((left, right) => right.bytes - left.bytes), largest };
}

/** `tool:see-what-is-on-a-drive`: what is on one connected drive by kind of file, with its largest files. */
export async function seeWhatIsOnADrive({ mount } = {}, _context, deps = {}) {
  const device = await connectedDrive(mount, deps);
  return walkDrive(device.canonical_mount || device.mount, deps.bounds ?? settings.kinds);
}

/** `tool:get-a-drive-icon`: the icon Finder shows for one connected drive, as a square PNG of `size` pixels. */
export async function getADriveIcon({ mount, size } = {}, _context, deps = {}) {
  const { smallest, largest, default: usual } = settings.icon;
  const pixels = size === undefined || size === null || size === '' ? usual : Number(size);
  if (!Number.isInteger(pixels) || pixels < smallest || pixels > largest) throw fail(`Choose an icon size from ${smallest} to ${largest}.`);
  const device = await connectedDrive(mount, deps);
  const out = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'icon-')), 'icon.png');
  const drawn = await (deps.exec ?? run)('/usr/bin/osascript', ['-l', 'JavaScript', DRAW_ICON, device.mount, String(pixels), out]);
  if (!drawn.ok || !fs.existsSync(out)) throw fail('The drive icon could not be drawn.');
  return { mount: device.mount, media_type: 'image/png', base64: fs.readFileSync(out).toString('base64') };
}
