// One local Chromium at a time across every Trillion checkout and process.
// Browser admission is independent of the build/test admission slot.
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { createProcessAdmissionQueue, identityOf, UNKNOWN_LIVE } from '../process-session/do-work/process-admission.mjs';
import { computerCacheFolder } from '../process-session/do-work/computer-cache-folder.mjs';
import ADMISSION from './admission.json' with { type: 'json' };
const QUEUE_ROOT = join(computerCacheFolder(), 'headless-browser-admission');
const PROBE_OPTIONS = { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 2000, killSignal: 'SIGKILL' };
// The outside-browser scan reads the whole process list, which takes about 0.7 s on a busy Mac and more under load; a 2 s limit made
// every scan inconclusive (Nov 21 2026: a run waited the full 600 s, "the process list could not be read"). Still bounded.
const LEGACY_PROBE_OPTIONS = { ...PROBE_OPTIONS, timeout: 10000 };
const BROWSER_PROGRAM = /(?:Google Chrome|Chromium|chrome-for-testing|chromium_headless_shell|chrome-headless-shell)/i;
export { ADMISSION };
// DATA (admission.json): how long an outside headless browser may hold local browser work before it stops blocking it.
// The outside browsers already logged this process, so each is logged once and not on every poll.

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

// The outside headless browsers running now: rows { pid, ppid, process_started, command }, [] when there are none. When the
// process list cannot be read the answer is { unreadable: code } instead, with the code the read gave (EPERM, EACCES,
// ETIMEDOUT, ...): outsideBrowserBlocks decides what that means.
export function legacyHeadlessRoots({ run = execFileSync, inspect = identityOf } = {}) {
  try {
    // Reading every process's argv can hang on a busy computer. First inspect only
    // executable names; request arguments only for actual browser candidates.
    const programs = run('ps', ['-axo', 'pid=,comm='], LEGACY_PROBE_OPTIONS);
    const candidates = String(programs).split('\n').flatMap(line => {
      const match = line.match(/^\s*(\d+)\s+(.+)$/);
      return match && BROWSER_PROGRAM.test(match[2]) ? [match[1]] : [];
    });
    if (!candidates.length) return [];
    const rows = run('ps', ['-p', candidates.join(','), '-o', 'pid=,ppid=,lstart=,command='], LEGACY_PROBE_OPTIONS);
    return parseLegacyHeadlessRoots(rows, (pid, started) => {
      const current = inspect(pid);
      return current === UNKNOWN_LIVE || current === started;
    });
  } catch (error) {
    // A computer with no process list program has nothing to read; the queue's own probes still decide.
    if (error?.code === 'ENOENT') return [];
    return { unreadable: error?.code ?? (error?.signal ? 'timeout' : 'unknown') };
  }
}

// What a sandboxed run cannot see is not a busy browser: a denied list (EPERM, EACCES) means outside browsers are not visible
// from here, so they are not waited on. Any other unreadable answer holds admission only for this bound, then grants with its reason.
const DENIED = new Set(['EPERM', 'EACCES']);
const UNREADABLE_BOUND_MS = 60000;
const OUTSIDE = { logged: new Set(), deniedLogged: false, unreadableSince: null, unreadableLogged: false };

// Whether the outside browsers (legacyHeadlessRoots' answer) hold local browser work. A browser older than the DATA wait stops
// holding it and is logged once; a younger one, or one whose start time cannot be read, holds it. An unreadable list holds it
// for UNREADABLE_BOUND_MS, then grants with the reason logged; a denied list is not checked at all, and is logged once.
export function outsideBrowserBlocks(scan, { now = Date.now(), waitMs = ADMISSION.outside_browser_wait_minutes * 60000, log = line => process.stderr.write(`${line}\n`), state = OUTSIDE } = {}) {
  if (!Array.isArray(scan)) {
    const code = scan.unreadable;
    if (DENIED.has(code)) {
      if (!state.deniedLogged) {
        state.deniedLogged = true;
        log(`process list denied in this sandbox (${code}); outside browsers not checked`);
      }
      return false;
    }
    state.unreadableSince ??= now;
    if (now - state.unreadableSince < UNREADABLE_BOUND_MS) return true;
    if (!state.unreadableLogged) {
      state.unreadableLogged = true;
      log(`process list unreadable (${code}) for ${UNREADABLE_BOUND_MS / 1000} s; granting local browser work without it`);
    }
    return false;
  }
  state.unreadableSince = null;
  let held = false;
  for (const root of scan) {
    const since = Date.parse(root.process_started);
    if (Number.isFinite(since) && now - since >= waitMs) {
      if (!state.logged.has(root.pid)) {
        state.logged.add(root.pid);
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
  const holder = !Array.isArray(roots) ? `the process list could not be read (${roots.unreadable})`
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
