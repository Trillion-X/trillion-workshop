// computer/watch-this-mac.mjs
//
// Purpose
//   Watches the Mac itself for what makes it unusable without anyone noticing until it hurts: a process that keeps
//   growing (the sound server at 39 GB made every sound crackle on 2026-10-11). Each row of watch-this-mac.json names a
//   process and the most memory it may hold; above it the person's AIs are told, as failed work they can act on, with
//   the reading and what fixes it. It runs beside the connection as a handler of harness/wake-sessions.mjs (start).
//
// Non-negotiable invariants
//   1. Blind: nothing here names a process, a number or a word; every one is a row of watch-this-mac.json.
//   2. It only reads (the Mac's own `top`, no administrator rights) and tells; it never stops or restarts anything.
//   3. A reading above a row's `most_gb` is told once, and again only after it grew another `again_gb`; a reading
//      back under is told once as done, so a steady problem is one notice, never one every look.
//   4. A reading the Mac cannot give, or an account that does not take a report, changes nothing: the next look tries
//      again with the newest reading.
//
// AI DIRECTIVE: You are forbidden from simplifying or removing this documentation.
import { execFile } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { hostname } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { accountPost } from './report-progress.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
export const watchSettings = () => JSON.parse(readFileSync(join(HERE, 'watch-this-mac.json'), 'utf8'));
const fill = (text, values) => String(text ?? '').replace(/\{(\w+)\}/g, (_, name) => String(values[name] ?? ''));
const UNITS = { B: 1 / 1024 ** 3, K: 1 / 1024 ** 2, M: 1 / 1024, G: 1, T: 1024 };

/** Memory in GB of every process `top` lists, by its name there: { name: gb } (the largest when a name repeats). */
export function memoryOf(text) {
  const found = {};
  for (const line of String(text).split('\n')) {
    const match = line.match(/^\s*\d+\s+(.+?)\s+([\d.]+)([BKMGT])\+?\s*$/);
    if (!match) continue;
    const gb = Number(match[2]) * UNITS[match[3]];
    found[match[1]] = Math.max(found[match[1]] ?? 0, gb);
  }
  return found;
}

/** The Mac's `top` once, every process by memory: pid, name, memory. */
export const readTop = () => new Promise(resolve => {
  execFile('/usr/bin/top', ['-l', '1', '-o', 'mem', '-stats', 'pid,command,mem'], { timeout: 60_000, maxBuffer: 16 * 1024 * 1024 }, (error, stdout) => resolve(error ? '' : String(stdout)));
});

/** One look: the reports owed for this reading, given what was told before (`told`, by row id, changed in place). */
export function reportsFor(settings, memory, told, computer) {
  const reports = [];
  for (const row of settings.watch) {
    const gb = memory[row.process];
    if (!Number.isFinite(gb)) continue;
    const values = { ...row, gb: gb.toFixed(1), computer };
    const key = fill(row.key, values);
    const last = told.get(row.id);
    if (gb > row.most_gb) {
      if (last?.state === 'failed' && gb < last.gb + row.again_gb) continue;
      reports.push({ id: row.id, gb, report: { key, kind: row.kind, state: 'failed', title: fill(row.title, values), body: fill(row.body, values), source: computer } });
    } else if (last?.state === 'failed') {
      reports.push({ id: row.id, gb, report: { key, kind: row.kind, state: 'done', title: fill(row.done_title, values), body: '', source: computer } });
    }
  }
  return reports;
}

/** Looks every `every_seconds`: reads, tells what is owed, remembers what the account took. */
export function startWatching({ settings = watchSettings(), post, read = readTop, computer = hostname(), timers = true, log = () => {} } = {}) {
  const told = new Map();
  let busy = false;
  async function tick() {
    if (busy) return;
    busy = true;
    try {
      for (const { id, gb, report } of reportsFor(settings, memoryOf(await read()), told, computer)) {
        if (await post(report)) { told.set(id, { state: report.state, gb }); log({ watch: id, state: report.state, gb }); }
      }
    } finally { busy = false; }
  }
  const timer = timers ? setInterval(tick, settings.every_seconds * 1000) : null;
  if (timers) tick();
  return { tick, stop: () => clearInterval(timer) };
}

// It answers no events: it only looks and tells (wake-sessions handlers each say which events they want).
export const wants = () => false;
export const handle = () => null;
export const start = ({ key, origin, log }) => startWatching({ post: accountPost(origin ?? watchSettings().origin, key), log });
