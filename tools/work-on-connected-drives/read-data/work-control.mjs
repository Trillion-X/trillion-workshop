// computer/drive-tools/work-control.mjs (carried over unchanged from an earlier standalone app)
//
// Purpose: the one way a person pauses, stops or resumes long-running work (the cloud copy, a card's copy, a file
// transfer). Every such job keeps its own state folder; this module owns one file in it, <state>/control.json:
//
//   { "action": "pause" | "stop", "resume_at": ISO time | null, "set_at": ISO time, "by": "person" | "eject" }
//
// No file means the job may run. A worker calls `createCheckpoint(stateDir)` and awaits the returned function at every
// chunk or file boundary:
//   - pause: the checkpoint holds (the worker keeps its files open and its place) until the file changes;
//   - stop:  the checkpoint throws WorkStopped, so the worker finishes the chunk in flight, closes its files and exits;
//            its own ledger lets the next start continue where it stopped;
//   - resume: the file is removed and the checkpoint returns.
// A supervisor asks `heldByControl(stateDir)` before starting a job, so a job the person paused or stopped is never
// restarted behind their back. A `resume_at` that has passed releases the hold (the file is removed) on that read.
//
// Invariants:
// - The file is written atomically (temporary name, then rename), so a reader never sees half a choice.
// - The worker reads it at most every `pollMs`, never per small chunk.
// - Nothing here knows what the job is; the file shape is the whole contract.
import fs from 'node:fs';
import path from 'node:path';

export const CONTROL_FILE = 'control.json';
const ACTIONS = new Set(['pause', 'stop']);

export class WorkStopped extends Error {
  constructor() { super('The work was stopped.'); this.name = 'WorkStopped'; }
}

/** The current choice for a job, or null. An unreadable or unknown file reads as no choice. */
export function readControl(stateDir) {
  try {
    const value = JSON.parse(fs.readFileSync(path.join(stateDir, CONTROL_FILE), 'utf8'));
    if (!ACTIONS.has(value?.action)) return null;
    const resumeAt = typeof value.resume_at === 'string' && Number.isFinite(Date.parse(value.resume_at)) ? value.resume_at : null;
    return { action: value.action, resume_at: resumeAt, set_at: typeof value.set_at === 'string' ? value.set_at : null, by: value.by === 'eject' ? 'eject' : 'person' };
  } catch { return null; }
}

/** Saves a choice; `action` null (resume) removes it. Returns what is now in force. */
export function writeControl(stateDir, { action, resume_at = null, by = 'person' } = {}) {
  const file = path.join(stateDir, CONTROL_FILE);
  if (!action) { fs.rmSync(file, { force: true }); return null; }
  if (!ACTIONS.has(action)) throw new Error('Choose pause, stop or resume.');
  if (resume_at !== null && !Number.isFinite(Date.parse(resume_at))) throw new Error('Choose a time to resume at.');
  fs.mkdirSync(stateDir, { recursive: true });
  const value = { action, resume_at: resume_at === null ? null : new Date(resume_at).toISOString(), set_at: new Date().toISOString(), by };
  const temporary = `${file}.${process.pid}.partial`;
  fs.writeFileSync(temporary, JSON.stringify(value, null, 2));
  fs.renameSync(temporary, file);
  return value;
}

/** The choice that holds a job right now, or null. A `resume_at` in the past ends the hold and removes the file. */
export function heldByControl(stateDir, now = Date.now()) {
  const control = readControl(stateDir);
  if (!control) return null;
  if (control.resume_at && Date.parse(control.resume_at) <= now) { writeControl(stateDir, { action: null }); return null; }
  return control;
}

/**
 * A worker's boundary check. `onState(state)` is told 'paused' when a pause starts holding and 'running' when it lets
 * go, so the worker can say so in its own progress file.
 */
export function createCheckpoint(stateDir, { pollMs = 500, onState = () => {} } = {}) {
  let readAt = 0, holding = null, stopped = false;
  const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
  // Every caller waits on the one pause in force, so parallel senders all hold, and all stop together.
  const hold = async control => {
    if (control.action === 'pause') {
      await onState('paused');
      while (control?.action === 'pause') { await sleep(pollMs); control = heldByControl(stateDir); }
      if (control?.action !== 'stop') await onState('running');
    }
    if (control?.action === 'stop') { stopped = true; throw new WorkStopped(); }
  };
  return async function checkpoint() {
    if (stopped) throw new WorkStopped();
    if (holding) return holding;
    if (Date.now() - readAt < pollMs) return;
    readAt = Date.now();
    const control = heldByControl(stateDir);
    if (!control) return;
    holding = hold(control);
    try { await holding; } finally { holding = null; }
  };
}

/** Whether a process id is alive (0 or unreadable reads as not alive). */
export function isAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; } catch (error) { return error.code === 'EPERM'; }
}

/** The pid named in a lock or pid file in `stateDir`, or null. */
export function readPid(stateDir, name) {
  try { const pid = Number(fs.readFileSync(path.join(stateDir, name), 'utf8').trim()); return Number.isInteger(pid) && pid > 0 ? pid : null; } catch { return null; }
}
