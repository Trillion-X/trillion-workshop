// tools/running-programs/read-data/running-programs.mjs
//
// PURPOSE
//   The programs running on the person's computer (any computer that reports them) and how much memory each one uses, for an AI to see what is running, what
//   is growing, or whether one program is still there. Each program also carries its parent, its session, when it started
//   and how much processor time it has used, and, only when asked (`commands`), its command line. A function run by tools/workflows' run-a-function as a
//   `computer` row holding the `read-processes` capability: the system's list of processes and each one's name and
//   memory, read-only.
//
// NON-NEGOTIABLE INVARIANTS
//   1. Nothing is changed: no program is stopped, signalled or started (besides the one reader below).
//   2. No privileged program is started: ps and top are setuid and a sandboxed run may not start them, so the list comes
//      from the system's process information, by the first reader in running-programs.json this computer has: a process
//      table folder read directly, or libproc read by read-programs.js through osascript.
//   3. Memory is the physical footprint the computer reports (libproc's phys_footprint, or a process table's private
//      memory, RssAnon plus VmSwap) and the resident bytes; a program the person may not read (another user's) is
//      listed with null memory, never a guess.
//   4. One answer is bounded: at most `most` programs (running-programs.json), the largest first.
//   5. A command line is its arguments only, never its environment, read from at most `command_bytes` bytes; one the
//      person may not read is null, never a guess.
//
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const settings = JSON.parse(fs.readFileSync(new URL('./running-programs.json', import.meta.url), 'utf8'));
const READER = fileURLToPath(new URL('./read-programs.js', import.meta.url));
const fail = message => new Error(message);

const run = (command, args) => new Promise(resolve => execFile(command, args, { timeout: 20_000, maxBuffer: 32 * 1024 * 1024 },
  (error, stdout) => resolve({ ok: !error, stdout: String(stdout ?? '') })));

const cannotRead = () => fail('The programs running here could not be read. Grant this tool the right to see the programs running on this computer and try again.');

const readText = file => { try { return fs.readFileSync(file, 'utf8'); } catch { return null; } };

/** The `stat` line's parent, session, start and processor time: the fields after the name's closing bracket, the start
 *  counted in clock ticks from the boot time the folder's own `stat` names. */
function statOf(line, bootSeconds, ticks) {
  const fields = line === null ? [] : line.slice(line.lastIndexOf(')') + 2).trim().split(/\s+/).map(Number);
  const known = fields.length >= 20 && Number.isFinite(bootSeconds);
  return {
    parent_pid: known ? fields[1] : null,
    session_id: known && fields[3] > 0 ? fields[3] : null,
    started_at_ms: known ? Math.round(bootSeconds * 1000 + fields[19] * 1000 / ticks) : null,
    cpu_ms: known ? Math.round((fields[11] + fields[12]) * 1000 / ticks) : null,
  };
}

/** A process table folder's programs: one folder per pid, its name in `comm`, its memory in `status`, in KiB, its
 *  parent, session, start and processor time in `stat`, and, asked for `commands`, its arguments in `cmdline`. */
export function readProcessTable(folder, { kib = settings.kib, ticks = settings.clock_ticks_per_second, commands = false, commandBytes = settings.command_bytes } = {}) {
  let pids;
  try { pids = fs.readdirSync(folder).filter(entry => /^[1-9][0-9]*$/.test(entry)).map(Number); } catch { throw cannotRead(); }
  const boot = (readText(path.join(folder, 'stat')) ?? '').match(/^btime\s+(\d+)$/m);
  const bootSeconds = boot ? Number(boot[1]) : NaN;
  const programs = [];
  for (const pid of pids) {
    let name, status;
    try { name = fs.readFileSync(path.join(folder, String(pid), 'comm'), 'utf8').replace(/\n$/, ''); } catch { continue; }
    try { status = fs.readFileSync(path.join(folder, String(pid), 'status'), 'utf8'); } catch { status = ''; }
    const field = key => { const found = status.match(new RegExp(`^${key}:\\s+(\\d+) kB$`, 'm')); return found ? Number(found[1]) * kib : null; };
    const resident = field('VmRSS'), own = field('RssAnon');
    const program = { pid, name: name || null, footprint_bytes: own === null ? null : own + (field('VmSwap') ?? 0), resident_bytes: resident,
      ...statOf(readText(path.join(folder, String(pid), 'stat')), bootSeconds, ticks) };
    if (commands) {
      const words = (readText(path.join(folder, String(pid), 'cmdline')) ?? '').slice(0, commandBytes).split('\0').filter(Boolean);
      program.command = words.length ? words.join(' ') : null;
    }
    programs.push(program);
  }
  return programs;
}

/** libproc's programs, as read-programs.js printed them through the osascript at `at`. */
async function readThroughOsascript(at, exec, { commands = false, commandBytes = settings.command_bytes } = {}) {
  const read = await exec(at, ['-l', 'JavaScript', READER, ...(commands ? ['commands', String(commandBytes)] : [])]);
  const line = read.ok ? read.stdout.trim().split('\n').at(-1) : '';
  let answer;
  try { answer = JSON.parse(line); } catch { answer = null; }
  if (!answer?.listed) throw cannotRead();
  return answer.programs;
}

const READERS = {
  'process-table-folder': ({ at }, _exec, asked) => readProcessTable(at, asked),
  'libproc-through-osascript': ({ at }, exec, asked) => readThroughOsascript(at, exec, asked),
};

/** Every program the first reader this computer has saw: the place is known only by which reader's `at` it has. With
 *  `commands`, each program carries its command line. */
export async function readPrograms({ exec = run, readers = settings.readers, has = fs.existsSync, commands = false } = {}) {
  const reader = readers.find(row => READERS[row.reads] && has(row.at));
  if (!reader) throw cannotRead();
  return READERS[reader.reads](reader, exec, { commands });
}

const bySize = (left, right) => (right.footprint_bytes ?? -1) - (left.footprint_bytes ?? -1) || left.pid - right.pid;

/** `tool:list-running-programs`: the running programs, largest memory first, optionally only those whose name has `name`,
 *  each with its command line when `commands` is true. */
export async function listRunningPrograms({ name, most, commands } = {}, _context, deps = {}) {
  const limit = most === undefined || most === null || most === '' ? settings.most.default : Number(most);
  if (!Number.isInteger(limit) || limit < 1 || limit > settings.most.largest) throw fail(`Ask for 1 to ${settings.most.largest} programs.`);
  if (name !== undefined && name !== null && typeof name !== 'string') throw fail('Name the program by text, like a part of its name.');
  if (commands !== undefined && commands !== null && typeof commands !== 'boolean') throw fail('Say commands as true or false.');
  const wanted = name ? name.toLowerCase() : null;
  const programs = (await readPrograms({ ...deps, commands: commands === true })).filter(program => !wanted || String(program.name ?? '').toLowerCase().includes(wanted));
  const shown = [...programs].sort(bySize).slice(0, limit);
  return { total: programs.length, programs: shown, complete: shown.length === programs.length };
}
