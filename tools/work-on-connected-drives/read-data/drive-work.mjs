// computer/drive-tools/drive-work.mjs (carried over unchanged from an earlier standalone app)
//
// Purpose: all the work running on this Mac's drives in one list, each with what the person can do about it (pause,
// resume, stop, or resume at a chosen time), and the part of ejecting a drive that stops that work gracefully first.
//
//   const work = createDriveWork({ cloud, cards, transfers, drives, findHolders });
//   await work.list()                          -> [{ id, title, detail, state, progress, resume_at, controls, holds }]
//   await work.control(id, action, resume_at)  -> the item after the change
//   await work.stopHolding(mount)              -> { stopped: [{ work_id, name, how }], restore() }
//   await work.holdersOf(mount)                -> [{ name, work_id, controls }]
//   work.armResumes()                          -> re-arms every saved "resume at" after the server starts
//
// Where the work comes from (each passed in by the server, so this module names no folder of its own):
//   cloud      the cloud copier: { stateDir, pid(), progress(), start(), reads() -> the paths it reads from }
//   cards      each card's own cloud copy: () => [{ id, name, stateDir, path, attached, start() }]
//   transfers  file-transfer.mjs createTransfers()
//   drives     () => the connected drives (enumerateDevices(), system disk excluded)
//   findHolders(mount) -> [{ pid, name }] every program with a file open on that drive
// A program holding a drive that is none of the above is listed too, titled by its readable name, and can only be
// stopped (it is asked to quit with SIGTERM).
//
// state: running | paused | stopped | waiting. Pause, stop and resume go through work-control.mjs (<state>/control.json),
// which each worker honours at its next chunk or file; a resume starts a job that is not running again. A "resume at"
// is kept in that file, so a server restart re-arms it here (one timer per job, never a repeating timer).
//
// Invariants:
// - A job the person paused or stopped is never started again except by resume, a "resume at", or eject restoring it.
// - Only a program that holds a connected drive right now can be stopped from here.
import fs from 'node:fs';
import path from 'node:path';
import { heldByControl, isAlive, readControl, readPid, writeControl } from './work-control.mjs';

const ACTIONS = new Set(['pause', 'resume', 'stop']);
const LONGEST_TIMER_MS = 2 ** 31 - 1;
const EJECT_WAIT_MS = 20000;
const fail = (status, message) => Object.assign(new Error(message), { status });
const CONTROLS = { running: ['pause', 'stop'], paused: ['resume', 'stop'], stopped: ['resume'], waiting: ['stop'] };
const COPY_WAITING = { 'waiting-for-the-service': 'Waiting for your cloud space to answer', 'waiting-for-the-drive': 'Waiting for the drive to be connected', 'not-signed-in': 'Waiting for this Mac to be signed in', incomplete: 'Some recordings will be tried again', refused: 'Your cloud space is full or refused a recording' };

const stateOf = ({ running, control, progressState }) => {
  if (control?.action === 'stop') return 'stopped';
  if (control?.action === 'pause' || progressState === 'paused') return 'paused';
  return running ? 'running' : null;
};
const progressOf = value => {
  if (!value) return null;
  if (Number.isFinite(value.bytes_total) && value.bytes_total > 0) return { done: value.bytes_done ?? 0, total: value.bytes_total, unit: 'bytes' };
  if (Number.isFinite(value.files_total) && value.files_total > 0) return { done: value.files_done ?? 0, total: value.files_total, unit: 'files' };
  return null;
};

export function createDriveWork({ cloud, cards, transfers, drives, findHolders, stopProgram = pid => process.kill(pid, 'SIGTERM'), now = Date.now }) {
  const timers = new Map();

  function holdsOf(devices, paths) {
    return [...new Set(paths.filter(Boolean).flatMap(file => devices.filter(device => file === device.mount || file.startsWith(device.mount + path.sep)).map(device => device.mount)))];
  }

  // Every declared job: { id, stateDir, pid, running, item, start() }.
  async function jobs(devices) {
    const found = [];
    if (cloud) {
      const pid = cloud.pid(), running = Boolean(pid), control = readControl(cloud.stateDir), value = cloud.progress();
      const state = stateOf({ running, control, progressState: value?.state }) ?? (COPY_WAITING[value?.state] ? 'waiting' : null);
      if (state) found.push({
        id: 'cloud-copy', stateDir: cloud.stateDir, pid, running, start: cloud.start,
        item: { title: 'Saving recordings to your cloud space', detail: state === 'waiting' ? COPY_WAITING[value.state] : value?.current?.name ? `Sending ${path.posix.basename(value.current.name)}` : null, state, progress: progressOf(value), resume_at: control?.resume_at ?? null, holds: holdsOf(devices, cloud.reads()) },
      });
    }
    for (const card of cards()) {
      const pid = readPid(card.stateDir, 'copier.lock'), running = isAlive(pid), control = readControl(card.stateDir);
      let value = null;
      try { value = JSON.parse(fs.readFileSync(path.join(card.stateDir, 'progress.json'), 'utf8')); } catch {}
      const state = stateOf({ running, control, progressState: value?.state });
      if (state) found.push({
        id: `card:${path.basename(card.stateDir)}`, stateDir: card.stateDir, pid: running ? pid : null, running, start: card.attached ? card.start : null,
        item: { title: `Saving ${card.name} to your cloud space`, detail: value?.current?.name ? `Sending ${path.posix.basename(value.current.name)}` : null, state, progress: progressOf(value), resume_at: control?.resume_at ?? null, holds: holdsOf(devices, [card.path]) },
      });
    }
    for (const transfer of transfers.list()) {
      const control = readControl(transfer.stateDir), value = transfer.progress;
      if (value?.state === 'finished') continue;
      const state = stateOf({ running: transfer.running, control, progressState: value?.state }) ?? 'stopped';
      const verb = transfer.job.mode === 'move' ? 'Moving' : 'Copying';
      const things = transfer.job.sources.length === 1 ? path.basename(transfer.job.sources[0]) : `${transfer.job.sources.length} items`;
      const failed = value?.state === 'failed' ? value.errors?.at(-1)?.error : null;
      found.push({
        id: `transfer:${transfer.id}`, stateDir: transfer.stateDir, pid: transfer.running ? readPid(transfer.stateDir, 'worker.pid') : null, running: transfer.running, start: () => transfers.restart(transfer.id),
        item: { title: `${verb} ${things} to ${transfer.job.destinations.map(folder => path.basename(folder)).join(', ')}`, detail: failed ?? (value?.current ? path.basename(value.current) : null), state, progress: progressOf(value), resume_at: control?.resume_at ?? null, holds: holdsOf(devices, [...transfer.job.sources, ...transfer.job.destinations]) },
      });
    }
    return found;
  }

  // Programs holding a connected drive that no declared job accounts for, one row each.
  async function programs(devices, declared) {
    const known = new Set(declared.map(job => job.pid).filter(Boolean));
    const rows = new Map();
    for (const device of devices) {
      for (const holder of await findHolders(device.mount)) {
        if (known.has(holder.pid)) continue;
        const row = rows.get(holder.pid) ?? { id: `program:${holder.pid}`, pid: holder.pid, title: holder.name || 'A program', holds: [] };
        row.holds.push(device.mount);
        rows.set(holder.pid, row);
      }
    }
    return [...rows.values()];
  }

  const shape = job => ({ id: job.id, ...job.item, controls: CONTROLS[job.item.state] });

  async function list() {
    const devices = await drives();
    const declared = await jobs(devices);
    const others = await programs(devices, declared);
    return [...declared.map(shape), ...others.map(row => ({ id: row.id, title: row.title, detail: 'Using this drive', state: 'running', progress: null, resume_at: null, controls: ['stop'], holds: row.holds }))];
  }

  function arm(job) {
    clearTimeout(timers.get(job.id));
    timers.delete(job.id);
    const control = readControl(job.stateDir);
    if (!control?.resume_at) return;
    const wait = Date.parse(control.resume_at) - now();
    const timer = setTimeout(() => {
      timers.delete(job.id);
      if (Date.parse(control.resume_at) > now()) { arm(job); return; }
      control_(job.id, 'resume').catch(error => process.stderr.write(`Could not resume ${job.item.title}: ${error.message}\n`));
    }, Math.max(0, Math.min(wait, LONGEST_TIMER_MS)));
    timer.unref?.();
    timers.set(job.id, timer);
  }

  async function control_(id, action, resume_at = null) {
    if (!ACTIONS.has(action)) throw fail(400, 'Choose pause, resume or stop.');
    if (resume_at !== null && (typeof resume_at !== 'string' || !Number.isFinite(Date.parse(resume_at)))) throw fail(400, 'Choose a time to resume at.');
    if (resume_at !== null && action === 'resume') throw fail(400, 'Choose pause or stop with a time to resume at.');
    const devices = await drives();
    if (String(id).startsWith('program:')) {
      if (action !== 'stop') throw fail(400, 'This program can only be stopped.');
      const pid = Number(String(id).slice('program:'.length));
      const row = (await programs(devices, await jobs(devices))).find(candidate => candidate.pid === pid);
      if (!row) throw fail(404, 'That program is no longer using a drive.');
      try { stopProgram(pid); } catch { throw fail(409, `${row.title} could not be stopped.`); }
      return { id, title: row.title, detail: 'Asked to stop', state: 'stopped', progress: null, resume_at: null, controls: [], holds: row.holds };
    }
    const job = (await jobs(devices)).find(candidate => candidate.id === id) ?? await pausable(id, devices);
    if (!job) throw fail(404, 'That work is no longer running.');
    if (action === 'resume') {
      writeControl(job.stateDir, { action: null });
      if (!job.running) {
        if (!job.start) throw fail(409, 'Connect its drive to resume it.');
        await job.start();
      }
    } else writeControl(job.stateDir, { action, resume_at });
    arm(job);
    const after = (await jobs(devices)).find(candidate => candidate.id === id);
    return after ? shape(after) : { id, title: job.item.title, detail: null, state: action === 'resume' ? 'running' : action === 'pause' ? 'paused' : 'stopped', progress: null, resume_at, controls: [], holds: job.item.holds };
  }

  // A job that is not in the list (a finished cloud copy, a card between runs) can still be paused ahead of time.
  async function pausable(id, devices) {
    if (id === 'cloud-copy' && cloud) return { id, stateDir: cloud.stateDir, running: false, start: cloud.start, item: { title: 'Saving recordings to your cloud space', holds: holdsOf(devices, cloud.reads()) } };
    const card = cards().find(row => `card:${path.basename(row.stateDir)}` === id);
    return card ? { id, stateDir: card.stateDir, running: false, start: card.attached ? card.start : null, item: { title: `Saving ${card.name} to your cloud space`, holds: holdsOf(devices, [card.path]) } } : null;
  }

  async function holdersOf(mount) {
    const devices = await drives();
    const declared = (await jobs(devices)).filter(job => job.running && job.item.holds.includes(mount));
    const others = (await programs(devices.filter(device => device.mount === mount), declared));
    return [...declared.map(job => ({ name: job.item.title, work_id: job.id, controls: CONTROLS[job.item.state] })), ...others.map(row => ({ name: row.title, work_id: row.id, controls: ['stop'] }))];
  }

  // Before a drive is ejected: every declared job using it is asked to stop at its next chunk, and waited for (up to
  // 20 s). A job that was paused is reported as paused and stays paused after (restore()); a running one is stopped
  // for the eject only, so restore() lets it continue once its drive is back.
  async function stopHolding(mount, { waitMs = EJECT_WAIT_MS } = {}) {
    const devices = await drives();
    const holding = (await jobs(devices)).filter(job => job.running && job.item.holds.includes(mount));
    const before = holding.map(job => ({ job, control: readControl(job.stateDir) }));
    for (const { job } of before) writeControl(job.stateDir, { action: 'stop', by: 'eject' });
    const deadline = now() + waitMs;
    while (before.some(({ job }) => isAlive(job.pid)) && now() < deadline) await new Promise(resolve => setTimeout(resolve, 250));
    const stopped = before.map(({ job, control }) => ({ work_id: job.id, name: job.item.title, how: job.item.state === 'paused' ? 'paused' : 'stopped', exited: !isAlive(job.pid), control }));
    return {
      stopped: stopped.map(({ work_id, name, how }) => ({ work_id, name, how })),
      restore() {
        for (const row of stopped) {
          const job = before.find(entry => entry.job.id === row.work_id).job;
          if (readControl(job.stateDir)?.by !== 'eject') continue;
          if (row.control) writeControl(job.stateDir, row.control); else writeControl(job.stateDir, { action: null });
        }
      },
    };
  }

  // After a start, a saved "resume at" arms its timer again; one that has passed resumes now.
  async function armResumes() {
    const devices = await drives();
    const all = [...await jobs(devices), ...(cloud ? [await pausable('cloud-copy', devices)] : []), ...cards().map(card => ({ id: `card:${path.basename(card.stateDir)}`, stateDir: card.stateDir, item: { title: `Saving ${card.name} to your cloud space` } }))];
    const seen = new Set();
    for (const job of all) {
      if (!job || seen.has(job.id)) continue;
      seen.add(job.id);
      if (readControl(job.stateDir)?.resume_at) { if (heldByControl(job.stateDir, now())) arm(job); else await control_(job.id, 'resume').catch(() => {}); }
    }
  }

  return { list, control: control_, stopHolding, holdersOf, armResumes };
}
