import { execFileSync } from 'node:child_process';
import { statfsSync, statSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const expand = (place, home = os.homedir()) => place.replace(/^~(?=\/|$)/, home);

const versionParts = text => String(text ?? '').split('.').map(part => Number.parseInt(part, 10) || 0);
const versionAtLeast = (have, want) => {
  const [a, b] = [versionParts(have), versionParts(want)];
  for (let index = 0; index < Math.max(a.length, b.length); index += 1) if ((a[index] ?? 0) !== (b[index] ?? 0)) return (a[index] ?? 0) > (b[index] ?? 0);
  return true;
};

/** What this computer is, for a row's `needs`: { arch, macos, memory_gb, free_disk_gb }. Each is read once and can be handed in. */
export function machineFacts({ home = os.homedir() } = {}) {
  let macos = '';
  try { macos = execFileSync('/usr/bin/sw_vers', ['-productVersion'], { encoding: 'utf8', timeout: 5_000 }).trim(); } catch { /* not macOS */ }
  let freeDisk = null;
  try { const disk = statfsSync(home); freeDisk = (disk.bavail * disk.bsize) / 1e9; } catch { /* unknown */ }
  return { arch: process.arch, macos, memory_gb: os.totalmem() / 2 ** 30, free_disk_gb: freeDisk };
}

/**
 * The eligibility gate of a program row (`needs`: { arch?, macos_min?, memory_gb?, free_disk_gb? }): whether this computer may run it,
 * and for each need it does not meet, a plain reason. A row with no `needs` is always eligible; a fact that cannot be read fails its need.
 */
export function gateOf(needs, facts) {
  if (!needs) return { ok: true, reasons: [] };
  const reasons = [];
  if (needs.arch && facts.arch !== needs.arch) reasons.push(`it needs ${needs.arch} (this is ${facts.arch})`);
  if (needs.macos_min && !(facts.macos && versionAtLeast(facts.macos, needs.macos_min))) reasons.push(`it needs macOS ${needs.macos_min} or newer (this is ${facts.macos || 'not macOS'})`);
  if (needs.memory_gb && !(facts.memory_gb >= needs.memory_gb)) reasons.push(`it needs ${needs.memory_gb} GB of memory`);
  if (needs.free_disk_gb && !(facts.free_disk_gb >= needs.free_disk_gb)) reasons.push(`it needs ${needs.free_disk_gb} GB free on the disk`);
  return { ok: reasons.length === 0, reasons };
}

/** Why no row of `rows` can run here: one sentence per row the gate refused ("<label>: <reason>, <reason>"), [] when none was refused by it. */
export function gateReasons(rows = [], facts = machineFacts()) {
  return rows.map(row => ({ row, gate: gateOf(row.needs, facts) })).filter(({ gate }) => !gate.ok).map(({ row, gate }) => `${row.label ?? row.id}: ${gate.reasons.join(', ')}`);
}

/**
 * The first program row whose check succeeds on this computer. Search each declared folder before PATH, and return
 * the matching executable with its folder first on PATH so the same installation is used by later commands. A row
 * whose `needs` this computer does not meet is passed over before its check runs, so nothing of it is fetched or run.
 * The found row carries `passed_over`: one plain sentence per row before it that was passed over and why (its `needs`,
 * or its `missing` words when its check failed). Its `next()` is the first of the rows after it that is here (found
 * once, when first asked), so a caller can hand work the found program does not take on to the next one
 * (keep-drive-files.mjs hearWith).
 */
export function hearingHere(rows = [], options = {}) {
  return lookHere(rows, options).found;
}

/** Why each row of `rows` is not used here, up to the first one that is: one plain sentence per row ("<label>: <why>"). */
export function hearingReasons(rows = [], options = {}) {
  return lookHere(rows, options).passed_over;
}

function lookHere(rows, options) {
  const { home = os.homedir(), facts = null, exists = place => { try { return statSync(place).isFile(); } catch { return false; } }, run = (command, args, env) => execFileSync(command, args, { env, stdio: 'ignore', timeout: 60_000 }) } = options;
  const searched = (process.env.PATH ?? '/usr/bin:/bin').split(':').filter(Boolean);
  const passedOver = [];
  let here = facts;
  for (const [index, row] of rows.entries()) {
    const label = row.label ?? row.id;
    if (row.needs) {
      here ??= machineFacts({ home });
      const gate = gateOf(row.needs, here);
      if (!gate.ok) { passedOver.push(`${label}: ${gate.reasons.join(', ')}`); continue; }
    }
    const [name, ...args] = row.check;
    for (const folder of [...new Set([...(row.search_path ?? []).map(place => expand(place, home)), ...searched])]) {
      const program = path.join(folder, name);
      if (!exists(program)) continue;
      const env = { ...process.env, PATH: [folder, ...(row.search_path ?? []).map(place => expand(place, home)), ...searched].join(':') };
      try { run(program, args, env); } catch { continue; }
      let after;
      return { found: { ...row, program, env, passed_over: passedOver, next: () => (after === undefined ? (after = hearingHere(rows.slice(index + 1), { ...options, facts: here })) : after) }, passed_over: passedOver };
    }
    passedOver.push(`${label}: ${row.missing ?? `its program (${name}) is not on this computer`}`);
  }
  return { found: null, passed_over: passedOver };
}
