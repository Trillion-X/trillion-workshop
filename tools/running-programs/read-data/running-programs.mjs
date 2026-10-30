// tools/running-programs/read-data/running-programs.mjs
//
// PURPOSE
//   The programs running on the person's Mac and how much memory each one uses, for an AI to see what is running, what
//   is growing, or whether one program is still there. A function run by tools/records-door's run-an-export as a
//   `computer` row holding the `read-processes` capability: the system's list of processes and each one's name and
//   memory, read-only.
//
// NON-NEGOTIABLE INVARIANTS
//   1. Nothing is changed: no program is stopped, signalled or started (besides the one reader below).
//   2. No privileged program is started: ps and top are setuid and a sandboxed run may not start them, so the list comes
//      from the system's process information, read by read-programs.js through osascript.
//   3. Memory is the physical footprint macOS reports (what Activity Monitor shows as Memory) and the resident bytes;
//      a program the person may not read (another user's) is listed with null memory, never a guess.
//   4. One answer is bounded: at most `most` programs (running-programs.json), the largest first.
//
import { execFile } from 'node:child_process';
import fs from 'node:fs';

const settings = JSON.parse(fs.readFileSync(new URL('./running-programs.json', import.meta.url), 'utf8'));
const READER = new URL('./read-programs.js', import.meta.url).pathname;
const fail = message => new Error(message);

const run = (command, args) => new Promise(resolve => execFile(command, args, { timeout: 20_000, maxBuffer: 32 * 1024 * 1024 },
  (error, stdout) => resolve({ ok: !error, stdout: String(stdout ?? '') })));

/** Every program the reader saw, as it printed them. */
export async function readPrograms({ exec = run } = {}) {
  const read = await exec('/usr/bin/osascript', ['-l', 'JavaScript', READER]);
  const line = read.ok ? read.stdout.trim().split('\n').at(-1) : '';
  let answer;
  try { answer = JSON.parse(line); } catch { answer = null; }
  if (!answer?.listed) throw fail('The programs on this Mac could not be read. Grant this tool "See the programs running on this Mac" and try again.');
  return answer.programs;
}

const bySize = (left, right) => (right.footprint_bytes ?? -1) - (left.footprint_bytes ?? -1) || left.pid - right.pid;

/** `tool:list-running-programs`: the running programs, largest memory first, optionally only those whose name has `name`. */
export async function listRunningPrograms({ name, most } = {}, _context, deps = {}) {
  const limit = most === undefined || most === null || most === '' ? settings.most.default : Number(most);
  if (!Number.isInteger(limit) || limit < 1 || limit > settings.most.largest) throw fail(`Ask for 1 to ${settings.most.largest} programs.`);
  if (name !== undefined && name !== null && typeof name !== 'string') throw fail('Name the program by text, like a part of its name.');
  const wanted = name ? name.toLowerCase() : null;
  const programs = (await readPrograms(deps)).filter(program => !wanted || String(program.name ?? '').toLowerCase().includes(wanted));
  const shown = [...programs].sort(bySize).slice(0, limit);
  return { total: programs.length, programs: shown, complete: shown.length === programs.length };
}
