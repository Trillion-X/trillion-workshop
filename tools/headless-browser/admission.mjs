// One local Chromium at a time across every Trillion checkout and process.
// Browser admission is independent of the build/test admission slot.
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { createProcessAdmissionQueue, identityOf, UNKNOWN_LIVE } from '../process-session/do-work/process-admission.mjs';
import { computerCacheFolder } from '../process-session/do-work/computer-cache-folder.mjs';
import ADMISSION from './admission.json' with { type: 'json' };
const QUEUE_ROOT = join(computerCacheFolder(), 'headless-browser-admission');
const PROBE_OPTIONS = { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 2000, killSignal: 'SIGKILL' };
const BROWSER_PROGRAM = /(?:Google Chrome|Chromium|chrome-for-testing|chromium_headless_shell|chrome-headless-shell)/i;
export { ADMISSION };
// DATA (admission.json): how long an outside headless browser may hold local browser work before it stops blocking it.
// The outside browsers already logged this process, so each is logged once and not on every poll.
const logged = new Set();

export function parseLegacyHeadlessRoots(rows, isLive = () => true) {
  const processes = [];
  for (const line of String(rows ?? '').split('\n')) {
    const match = line.match(/^\s*(\d+)\s+(\d+)\s+(.{24})\s+(.+)$/);
    if (!match) continue;
    const [, pidText, ppidText, started, command] = match;
    if (!BROWSER_PROGRAM.test(command)
      || !/(?:^|\s)--headless(?:[=\s]|$)/.test(command)) continue;
    const pid = Number(pidText), ppid = Number(ppidText), process_started = started.trim();
    if (isLive(pid, process_started)) processes.push({ pid, ppid, process_started, command: command.slice(0, 180) });
  }
  const matched = new Set(processes.map(row => row.pid));
  return processes.filter(row => !matched.has(row.ppid));
}

// The outside headless browsers running now: rows { pid, ppid, process_started, command }, [] when there are none, and null when
// the process list cannot be read (an inconclusive probe, which keeps admission closed).
export function legacyHeadlessRoots({ run = execFileSync, inspect = identityOf } = {}) {
  try {
    // Reading every process's argv can hang on a busy computer. First inspect only
    // executable names; request arguments only for actual browser candidates.
    const programs = run('ps', ['-axo', 'pid=,comm='], PROBE_OPTIONS);
    const candidates = String(programs).split('\n').flatMap(line => {
      const match = line.match(/^\s*(\d+)\s+(.+)$/);
      return match && BROWSER_PROGRAM.test(match[2]) ? [match[1]] : [];
    });
    if (!candidates.length) return [];
    const rows = run('ps', ['-p', candidates.join(','), '-o', 'pid=,ppid=,lstart=,command='], PROBE_OPTIONS);
    return parseLegacyHeadlessRoots(rows, (pid, started) => {
      const current = inspect(pid);
      return current === UNKNOWN_LIVE || current === started;
    });
  } catch (error) {
    // A computer with no process list program has nothing to read; the queue's own probes still decide.
    if (error?.code === 'ENOENT') return [];
    return null; // An inconclusive probe keeps browser admission closed.
  }
}

// Whether the outside browsers (legacyHeadlessRoots' rows, or null when that probe was inconclusive) hold local browser work.
// A browser older than the DATA wait stops holding it and is logged once; a younger one, or one whose start time cannot be read, holds it.
export function outsideBrowserBlocks(roots, { now = Date.now(), waitMs = ADMISSION.outside_browser_wait_minutes * 60000, log = line => process.stderr.write(`${line}\n`) } = {}) {
  if (roots === null) return true;
  let held = false;
  for (const root of roots) {
    const since = Date.parse(root.process_started);
    if (Number.isFinite(since) && now - since >= waitMs) {
      if (!logged.has(root.pid)) {
        logged.add(root.pid);
        log(`outside browser pid ${root.pid} since ${root.process_started} no longer holds local browser work (over ${ADMISSION.outside_browser_wait_minutes} minutes)`);
      }
      continue;
    }
    held = true;
  }
  return held;
}

/** Internal fixture factory; production callers cannot choose the browser queue root. */
export const createBrowserAdmissionQueue = (root, options = {}) =>
  createProcessAdmissionQueue(root, { ...options, resource: 'the local browser' });

const localQueue = createBrowserAdmissionQueue(QUEUE_ROOT, { isBlocked: () => outsideBrowserBlocks(legacyHeadlessRoots()) });

/** Hold exclusive local-browser access across arbitrary work; larger numeric priorities go first. */
// A wait that ran out names who holds the browser: the outside headless browsers the scan sees (pid, start time, command), so a
// caller is told what it waits for rather than a bare timeout. The queue's own holder is a process of this checkout and is named
// by its ticket only when no outside browser is seen.
export function namedHolderError(error, roots = legacyHeadlessRoots()) {
  if (!/^Timed out/.test(error?.message ?? '')) return error;
  const holder = roots === null ? 'the process list could not be read'
    : roots.length === 0 ? 'no outside headless browser is running; another run of this queue holds it'
      : roots.map(row => `pid ${row.pid} since ${row.process_started}: ${row.command}`).join('; ');
  return Object.assign(new Error(`${error.message} Held by: ${holder}`), { code: 'browser_held', holder });
}

async function acquireNamed(options) {
  try { return await localQueue.acquire(options); }
  catch (error) { throw namedHolderError(error); }
}

export async function withBrowserAdmission(work, options = {}) {
  const release = await acquireNamed(options);
  try { return await work(); }
  finally { await release(); }
}

export async function acquireBrowserAdmission(options = {}) {
  return acquireNamed(options);
}
