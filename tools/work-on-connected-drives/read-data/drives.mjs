// tools/work-on-connected-drives/read-data/drives.mjs
//
// PURPOSE
//   The drive tools a person's computer keeps (tool-rows.json, on placement:your-computer), each a plain function from
//   the tool's input to its answer: list the drives, read a drive's icon, kinds of file and folders, name what holds a
//   drive, list and pause/resume/stop the long file work on drives, copy or move between drives, and eject. The host
//   that keeps them (the Trillion app's computer/mac-tools.mjs) imports this module once and calls each exported function
//   as fn(input, context), so every tool shares one state: eject stops this computer's own transfers first, and
//   transfers paused or due to resume at a time are found again after a restart.
//
// NON-NEGOTIABLE INVARIANTS
//   1. Only a drive the Mac mounts under /Volumes, that Finder shows (not mounted nobrowse) and diskutil says is not
//      internal, is a drive here; the system disk never is. Every path a tool is given must be on such a drive
//      (tools/connected-drives/read-data/drive-folder.mjs driveOf).
//   2. Eject stops this Mac's own work on the drive at its next chunk first (drive-work.mjs stopHolding), asks every other
//      program holding it to quit, and only then runs `diskutil eject`; work paused before stays paused after.
//   3. A transfer copies, checks each copy by its BLAKE3 and only then names it (file-transfer.mjs); a move sends the
//      source to the Trash only after every copy was checked.
//   4. A failure carries `status` and words the person can read; the host answers it as `error`.
//   5. What only the host knows is handed in the context, never imported: `drive_sync` and `note_written` are
//      { module, export } (a module's file URL and the function it exports), so this folder reads no host file.
//
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { parseDiskIdentity, resolveDriveIdentity } from '../../connected-drives/read-data/drive-identity.mjs';
import { driveFileHolders, readProcessRows } from '../../connected-drives/read-data/drive-processes.mjs';
import { createDriveIcons, iconSize } from './drive-icon.mjs';
import { createDriveInventory } from './drive-inventory.mjs';
import { listFolder } from '../../connected-drives/read-data/drive-folder.mjs';
import { hiddenIn } from '../../connected-drives/read-data/drives.mjs';
import { createDriveWork } from './drive-work.mjs';
import { createTransfers } from './file-transfer.mjs';

const VOLUMES_ROOT = '/Volumes';
const fail = (status, message) => Object.assign(new Error(message), { status });

function collectSpawn(command, args = []) {
  return new Promise(resolve => {
    const child = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', chunk => { stdout += chunk; });
    child.stderr.on('data', chunk => { stderr += chunk; });
    child.on('error', error => resolve({ ok: false, code: error.code || null, stdout, stderr: error.message }));
    child.on('close', code => resolve({ ok: code === 0, code, stdout, stderr }));
  });
}

async function readProcessList() {
  const [commands, programs] = await Promise.all([collectSpawn('/bin/ps', ['-axww', '-o', 'pid=,command=']), collectSpawn('/bin/ps', ['-axww', '-o', 'pid=,comm='])]);
  return commands.ok ? readProcessRows(commands.stdout, programs.ok ? programs.stdout : '') : [];
}

// A mounted volume's identity (which disk, internal or not, ejectable) only changes when something else is mounted
// there, so it is read once per mount and kept while the mount point is the same directory on the same device.
const driveIdentities = new Map();
async function identifyDrive(device) {
  if (!device.mount) return readDriveIdentity(device);
  let seen = null;
  try { const stat = await fs.promises.stat(device.mount); seen = `${stat.dev}:${stat.ino}`; } catch {}
  const kept = driveIdentities.get(device.mount);
  if (seen && kept?.seen === seen) return { ...device, ...kept.found };
  const identity = await readDriveIdentity(device);
  const { canonical_mount, internal, solid_state, protocol, device_identifier, kind, ejectable } = identity;
  if (seen) driveIdentities.set(device.mount, { seen, found: { canonical_mount, internal, solid_state, protocol, device_identifier, kind, ejectable } });
  return identity;
}
function readDriveIdentity(device) {
  return resolveDriveIdentity(device, { volumesRoot: VOLUMES_ROOT, readDiskInfo: async mount => {
    const result = await collectSpawn('/usr/sbin/diskutil', ['info', '-plist', mount]);
    return result.ok ? parseDiskIdentity(result.stdout) : null;
  } });
}

async function statVolume(mount) {
  try {
    const stat = await fs.promises.statfs(mount);
    return { size_bytes: stat.blocks * stat.bsize, free_bytes: stat.bavail * stat.bsize };
  } catch {
    return { size_bytes: null, free_bytes: null };
  }
}

// macOS hardware profiling can take many seconds, so the drives list is enriched from the latest snapshot and the
// snapshot is refreshed without holding the list or an eject open.
const HARDWARE_PROFILE_MAX_AGE_MS = 5 * 60 * 1000;
let hardwareProfileSnapshot = { at: 0, devices: [] };
let hardwareProfileRefresh = null;
function refreshHardwareProfile() {
  if (hardwareProfileRefresh) return hardwareProfileRefresh;
  hardwareProfileRefresh = collectSpawn('/usr/sbin/system_profiler', ['-json', 'SPUSBDataType', 'SPStorageDataType'])
    .then(profile => {
      if (!profile.ok) return;
      try { hardwareProfileSnapshot = { at: Date.now(), devices: flattenProfilerItems(Object.values(JSON.parse(profile.stdout)).flat()) }; } catch {}
    })
    .finally(() => { hardwareProfileRefresh = null; });
  return hardwareProfileRefresh;
}

function flattenProfilerItems(items, found = []) {
  for (const item of items || []) {
    if (!item || typeof item !== 'object') continue;
    const name = item._name || item.device_name || item.volume_name || null;
    const text = `${name || ''} ${item.device_type || ''} ${item.vendor_id || ''} ${item.protocol || ''}`;
    const isPhone = /iphone|ipad/i.test(text);
    const isStorage = Boolean(item.mount_point || item.size_in_bytes || item.physical_drive || /storage|ssd|flash|usb/i.test(text));
    if (name && (isPhone || isStorage)) {
      found.push({
        id: item.serial_num || item.bsd_name || item.device_identifier || name,
        name,
        mount: item.mount_point || null,
        size_bytes: Number(item.size_in_bytes) || null,
        free_bytes: Number(item.free_space_in_bytes) || null,
        protocol: item.protocol || item.device_type || null,
        vendor: item.vendor_id || null,
        internal: item.internal === 'yes' || item.internal === true,
        kind: isPhone ? 'iPhone' : null,
      });
    }
    for (const value of Object.values(item)) if (Array.isArray(value)) flattenProfilerItems(value, found);
  }
  return found;
}

// The mount points macOS hides from Finder (mounted `nobrowse`): tools/connected-drives' one reading of `mount`.
export { hiddenIn };

async function hiddenMounts() {
  const result = await collectSpawn('/sbin/mount');
  return result.ok ? hiddenIn(result.stdout) : new Set();
}

/** Every drive the Mac knows: each mounted volume under /Volumes that Finder shows, enriched from the hardware
 *  profile, one per disk. */
export async function enumerateDevices() {
  const hidden = await hiddenMounts();
  let volumeEntries = [];
  try { volumeEntries = await fs.promises.readdir(VOLUMES_ROOT, { withFileTypes: true }); } catch {}
  const mounted = [];
  for (const entry of volumeEntries) {
    if (!entry.isDirectory() && !entry.isSymbolicLink()) continue;
    const mount = path.join(VOLUMES_ROOT, entry.name);
    if (hidden.has(mount)) continue;
    mounted.push({ id: mount, name: entry.name, mount, ...(await statVolume(mount)) });
  }
  const extra = hardwareProfileSnapshot.devices.filter(device => !hidden.has(device.mount));
  if (Date.now() - hardwareProfileSnapshot.at >= HARDWARE_PROFILE_MAX_AGE_MS) void refreshHardwareProfile();
  const byKey = new Map();
  for (const device of [...mounted, ...extra]) {
    const key = device.mount || String(device.name || device.id).toLowerCase();
    const current = byKey.get(key) || {};
    byKey.set(key, {
      ...device,
      ...current,
      mount: current.mount || device.mount || null,
      internal: current.internal === true || device.internal === true,
      size_bytes: current.size_bytes ?? device.size_bytes ?? null,
      free_bytes: current.free_bytes ?? device.free_bytes ?? null,
    });
  }
  const identified = await Promise.all([...byKey.values()].map(identifyDrive));
  const canonical = new Map();
  for (const device of identified) {
    const key = device.canonical_mount || device.mount || device.id;
    const current = canonical.get(key);
    if (!current || device.mount === device.canonical_mount) canonical.set(key, device);
  }
  return [...canonical.values()].sort((a, b) => String(a.name).localeCompare(String(b.name)));
}

const connectedDrives = async () => (await enumerateDevices()).filter(device => device.mount && !device.internal);

async function findDriveProcesses(mount) {
  const result = await collectSpawn('/usr/sbin/lsof', ['-Fpcn', '+f', '--', mount]);
  return driveFileHolders(result.stdout, await readProcessList(), process.pid);
}

async function parentWholeDisk(mount) {
  const result = await collectSpawn('/usr/sbin/diskutil', ['info', '-plist', mount]);
  const match = result.stdout.match(/<key>ParentWholeDisk<\/key>\s*<string>([^<]+)<\/string>/);
  return match ? match[1] : mount;
}

// Where this Mac keeps its drive work: transfers (their progress files are what computer/report-progress.json's
// drive-transfer row reads), drive icons and what is on each drive by kind.
const STATE = path.join(os.homedir(), '.trillion', 'computer-sources');
const transfers = createTransfers({ folder: path.join(STATE, 'transfers') });
const driveIcons = createDriveIcons({ folder: path.join(STATE, 'drive-icons') });
const driveInventory = createDriveInventory({ folder: path.join(STATE, 'drive-inventory') });
const driveWork = createDriveWork({ cloud: null, cards: () => [], transfers, drives: connectedDrives, findHolders: findDriveProcesses });
driveWork.armResumes().catch(() => {});

async function ejectDrive(mount) {
  // Ejection names one exact mount, so only that target is resolved and checked (never a whole hardware scan).
  const current = mount ? await identifyDrive({ id: mount, name: path.basename(mount), mount, ejectable: true }) : null;
  if (!current?.ejectable) return { ok: false, state: 'blocked', message: 'This drive cannot be ejected safely.', mount, stopped: [], remaining: [] };
  const canonical = current.canonical_mount;
  const work = await driveWork.stopHolding(canonical);
  try { return await ejectAfterWorkStopped(canonical, work.stopped); } finally { work.restore(); }
}

async function ejectAfterWorkStopped(mount, workStopped) {
  const holdersBefore = await findDriveProcesses(mount);
  const stopped = [...workStopped];
  for (const processInfo of holdersBefore) {
    let ok = true;
    try { process.kill(processInfo.pid, 'SIGTERM'); } catch { ok = false; }
    stopped.push({ pid: processInfo.pid, name: processInfo.name || path.basename(processInfo.command || 'Running task'), how: 'stopped', stopped: ok });
  }
  if (holdersBefore.length) await new Promise(resolve => setTimeout(resolve, 1500));
  const remaining = await findDriveProcesses(mount);
  if (remaining.length) return { ok: false, state: 'busy', message: `Could not eject — ${remaining.map(processInfo => processInfo.name || processInfo.pid).join(', ')} still using it`, mount, stopped, remaining };
  let ejectResult = await collectSpawn('/usr/sbin/diskutil', ['eject', mount]);
  if (!ejectResult.ok) {
    const wholeDisk = await parentWholeDisk(mount);
    const unmountResult = await collectSpawn('/usr/sbin/diskutil', ['unmount', mount]);
    if (unmountResult.ok) ejectResult = await collectSpawn('/usr/sbin/diskutil', ['eject', wholeDisk]);
  }
  return { ok: ejectResult.ok, state: ejectResult.ok ? 'safe' : 'failed', message: ejectResult.ok ? 'Safe to remove' : `Could not eject — ${ejectResult.stderr?.trim() || 'the drive did not respond'}`, mount, stopped, remaining: [] };
}

const connectedDrive = async mount => {
  const device = (await connectedDrives()).find(candidate => candidate.mount === mount);
  if (!device) throw fail(404, 'This drive is not connected.');
  return device;
};

/** A host function the context names ({ module, export }), or null when it names none. */
export function handedFunction(given) {
  if (!given || typeof given.module !== 'string' || typeof given.export !== 'string') return null;
  if (!given.module.startsWith('file:')) throw fail(400, 'A handed function must be a file on this computer.');
  return { module: given.module, export: given.export };
}
/** What a host function the context names answers now, or undefined when the context names none. */
async function handed(given) {
  const named = handedFunction(given);
  if (!named) return undefined;
  const fn = (await import(named.module))[named.export];
  if (typeof fn !== 'function') throw fail(500, `${named.export} is not a function the host offers.`);
  return fn();
}

/** Each drive tool, by its short name: (input, context) -> its answer. The exports below are what rows call. */
export const driveTools = {
  async drives(_input, context = {}) {
    const [listed, trillion_drive] = await Promise.all([enumerateDevices(), handed(context.drive_sync)]);
    const devices = listed.map(device => ({ ...device, state: device.mount ? 'connected' : 'disconnected' }));
    return { generated_at: new Date().toISOString(), devices, ...(trillion_drive === undefined ? {} : { trillion_drive }) };
  },
  async icon({ mount, size }) {
    const device = await connectedDrive(String(mount ?? ''));
    const pixels = iconSize(size);
    if (pixels === null) throw fail(400, 'Choose an icon size from 32 to 512.');
    const stat = await fs.promises.stat(device.mount);
    const png = await driveIcons.png({ mount: device.mount, key: `${device.device_identifier || device.name}-${stat.dev}-${stat.ino}`, size: pixels });
    return { mount: device.mount, media_type: 'image/png', base64: png.toString('base64') };
  },
  async kinds({ mount }) { return driveInventory.read(await connectedDrive(String(mount ?? ''))); },
  async folder({ path: target, offset, limit, hidden }) {
    return listFolder({ target: String(target ?? ''), devices: await connectedDrives(), offset: Number(offset) || 0, limit: Number(limit) || 200, hidden: hidden === true || hidden === '1' });
  },
  async holders({ mount }) {
    const device = await connectedDrive(String(mount ?? ''));
    const processes = (await findDriveProcesses(device.canonical_mount || device.mount)).map(processInfo => ({ pid: processInfo.pid, name: processInfo.name || 'Running task' }));
    return { mount: device.mount, processes };
  },
  async work() { return { work: await driveWork.list() }; },
  async workControl({ id, action, resume_at, check }) {
    if (typeof id !== 'string') throw fail(400, 'Choose the work to change.');
    if (check === true) {
      const work = (await driveWork.list()).find(item => item.id === id);
      return { id, action, ready: Boolean(work?.controls?.includes(action)) };
    }
    return driveWork.control(id, action, resume_at ?? null);
  },
  async transfer({ sources, destinations, mode, check }, context = {}) {
    const request = { sources, destinations, mode, devices: await connectedDrives(), note_written: handedFunction(context.note_written) };
    return check === true ? transfers.preview(request) : transfers.start(request);
  },
  async eject({ mount, check }) {
    if (check === true) { const device = await connectedDrive(String(mount ?? '')); return { mount: device.mount, holders: await driveWork.holdersOf(device.mount) }; }
    return ejectDrive(String(mount ?? ''));
  },
};

// The host calls each tool by its exported name, as fn(input, context) (tool-rows.json names which).
export const listDrives = (input = {}, context) => driveTools.drives(input, context);
export const getADriveIcon = (input = {}) => driveTools.icon(input);
export const seeWhatKindsOfFileADriveHolds = (input = {}) => driveTools.kinds(input);
export const listADriveFolder = (input = {}) => driveTools.folder(input);
export const nameWhatHoldsThisDrive = (input = {}) => driveTools.holders(input);
export const listDriveWork = () => driveTools.work();
export const controlDriveWork = (input = {}) => driveTools.workControl(input);
export const copyOrMoveBetweenDrives = (input = {}, context) => driveTools.transfer(input, context);
export const ejectADrive = (input = {}) => driveTools.eject(input);
