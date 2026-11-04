// tools/work-on-connected-drives/read-data/drives.mjs
//
// PURPOSE
//   The drive tools that change things on a person's computer (tool-rows.json, `computer` rows run by
//   tools/records-door's run-an-export, one process per run): list and pause/resume/stop the long file work on drives,
//   copy or move between drives, and eject. Each is a plain function from the tool's input to its answer. What a drive
//   is (the listing, its identity, the programs holding it) is tools/connected-drives' one copy.
//
// NON-NEGOTIABLE INVARIANTS
//   1. Only a drive the Mac mounts under /Volumes, that Finder shows (not mounted nobrowse) and diskutil says is not
//      internal, is a drive here; the system disk never is. Every path a tool is given must be on such a drive
//      (tools/connected-drives/read-data/drive-folder.mjs driveOf).
//   2. Eject stops this run's own work on the drive at its next chunk first (drive-work.mjs stopHolding), asks every
//      other program holding it to quit, and only then runs `diskutil eject`; work paused before stays paused after.
//   3. A transfer copies, checks each copy by its BLAKE3 and only then names it (file-transfer.mjs); a move sends the
//      source to the Trash only after every copy was checked.
//   4. A failure carries `status` and words the person can read; run-an-export answers it as `error`.
//   5. Nothing outlives its run: a transfer runs inside the run that starts it (see README "Not yet").
//
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { driveFileHolders, readProcessRows } from '../../connected-drives/read-data/drive-processes.mjs';
import { enumerateDevices } from '../../connected-drives/read-data/drives.mjs';
import { createDriveWork } from './drive-work.mjs';
import { createTransfers } from './file-transfer.mjs';

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

// Where a run keeps its drive work: the run's own home folder (HOME), which the engine gives each run and removes
// when it ends, so a transfer's state lasts as long as the run that does it.
const transfers = createTransfers({ folder: path.join(os.homedir(), 'transfers') });
const driveWork = createDriveWork({ cloud: null, cards: () => [], transfers, drives: connectedDrives, findHolders: findDriveProcesses });

async function ejectDrive(mount) {
  const current = mount ? (await connectedDrives()).find(device => device.mount === mount) : null;
  if (!current?.ejectable) return { ok: false, state: 'blocked', message: 'This drive cannot be ejected safely.', mount, stopped: [], remaining: [] };
  const canonical = current.canonical_mount || current.mount;
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

/** Each drive tool, by its short name: (input, context) -> its answer. The exports below are what rows call. */
export const driveTools = {
  async work() { return { work: await driveWork.list() }; },
  async workControl({ id, action, resume_at, check }) {
    if (typeof id !== 'string') throw fail(400, 'Choose the work to change.');
    if (check === true) {
      const work = (await driveWork.list()).find(item => item.id === id);
      return { id, action, ready: Boolean(work?.controls?.includes(action)) };
    }
    return driveWork.control(id, action, resume_at ?? null);
  },
  async transfer({ sources, destinations, mode, check }) {
    const request = { sources, destinations, mode, devices: await connectedDrives() };
    return check === true ? transfers.preview(request) : transfers.start(request);
  },
  async eject({ mount, check }) {
    if (check === true) { const device = await connectedDrive(String(mount ?? '')); return { mount: device.mount, holders: await driveWork.holdersOf(device.mount) }; }
    return ejectDrive(String(mount ?? ''));
  },
};

// run-an-export calls each tool by its exported name, as fn(input) (tool-rows.json names which).
export const listDriveWork = () => driveTools.work();
export const controlDriveWork = (input = {}) => driveTools.workControl(input);
export const copyOrMoveBetweenDrives = (input = {}) => driveTools.transfer(input);
export const ejectADrive = (input = {}) => driveTools.eject(input);
