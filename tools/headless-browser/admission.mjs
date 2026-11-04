// One local Chromium at a time across every Trillion checkout and process.
// Browser admission is independent of the build/test admission slot.
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { createProcessAdmissionQueue, identityOf, UNKNOWN_LIVE } from '../process-session/do-work/process-admission.mjs';
import { placeCacheFolder } from '../process-session/do-work/place-cache-folder.mjs';
const QUEUE_ROOT = join(placeCacheFolder(), 'headless-browser-admission');
const PROBE_OPTIONS = { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 2000, killSignal: 'SIGKILL' };
const BROWSER_PROGRAM = /(?:Google Chrome|Chromium|chrome-for-testing|chromium_headless_shell|chrome-headless-shell)/i;

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

export function legacyHeadlessRoots({ run = execFileSync, inspect = identityOf } = {}) {
  try {
    // Reading every process's argv can hang on a busy place. First inspect only
    // executable names; request arguments only for actual browser candidates.
    const programs = run('ps', ['-axo', 'pid=,comm='], PROBE_OPTIONS);
    const candidates = String(programs).split('\n').flatMap(line => {
      const match = line.match(/^\s*(\d+)\s+(.+)$/);
      return match && BROWSER_PROGRAM.test(match[2]) ? [match[1]] : [];
    });
    if (!candidates.length) return false;
    const rows = run('ps', ['-p', candidates.join(','), '-o', 'pid=,ppid=,lstart=,command='], PROBE_OPTIONS);
    return parseLegacyHeadlessRoots(rows, (pid, started) => {
      const current = inspect(pid);
      return current === UNKNOWN_LIVE || current === started;
    }).length > 0;
  } catch (error) {
    // A place with no process list program has nothing to read; the queue's own probes still decide.
    if (error?.code === 'ENOENT') return false;
    return true; // An inconclusive probe keeps browser admission closed.
  }
}

/** Internal fixture factory; production callers cannot choose the browser queue root. */
export const createBrowserAdmissionQueue = (root, options = {}) =>
  createProcessAdmissionQueue(root, { ...options, resource: 'the local browser' });

const localQueue = createBrowserAdmissionQueue(QUEUE_ROOT, { isBlocked: () => legacyHeadlessRoots() });

/** Hold exclusive local-browser access across arbitrary work; larger numeric priorities go first. */
export async function withBrowserAdmission(work, options = {}) {
  const release = await localQueue.acquire(options);
  try { return await work(); }
  finally { await release(); }
}

export async function acquireBrowserAdmission(options = {}) {
  return localQueue.acquire(options);
}
