// tools/running-programs/do-work/programs-left-running.mjs
//
// PURPOSE
//   The deciding and stopping steps of workflow:stop-programs-left-running (tools/workflows/recipes): which running
//   programs were left behind by a session that ended, judged only by the rule rows the person keeps, and stopping each
//   one by asking it to end and waiting. Functions run by tools/workflows' run-a-function:
//   - `tool:choose-programs-left-running` (chooseProgramsLeftRunning) reads nothing and changes nothing: it is given the
//     programs (tool:list-running-programs with commands) and the person's two lists of rows, and answers which to stop
//     and why;
//   - `tool:stop-programs-left-running` (stopProgramsLeftRunning) asks each chosen program to end (SIGTERM), waits up to
//     its grace time, and answers one stop per program and at most one notice for the sweep.
//
// NON-NEGOTIABLE INVARIANTS
//   1. Every judgment is the person's rows. A left-behind row says how a program is left behind (its parent, or a session
//      whose owner ended), how old it must be, optionally how busy (its share of one processor over its whole life), and
//      its command or its name by pattern, every condition holding at once. A pattern is required: a program the system
//      itself started (a service) also has the first process as its parent and leads its own session. A never-stop row names a command or a name by
//      pattern. Nothing here names a program.
//   2. A guard cannot be skipped by leaving its input out: a never-stop or left-behind list not given is refused in plain
//      words, never read as empty; an empty list is taken only when given, and the answer says how many rows it read.
//   3. A field a row may not hold is refused, so a misspelt condition never widens what is stopped.
//   4. Kept whatever the rows say: the system's first process and below, this run and its parent, a program whose
//      session's owner is alive (the session's leader still has a parent other than the system's first process), and a
//      program the rows cannot be judged on (its session, start or processor time unreadable, a session whose leader is
//      absent from a list that was cut short, or a command a never-stop pattern needs that could not be read).
//   5. A stop is only a request to end (SIGTERM), sent only to the same program that was chosen (same process id and the
//      same start time, read again just before), and nothing is forced.
//
import fs from 'node:fs';
import { readPrograms } from '../read-data/running-programs.mjs';

const settings = JSON.parse(fs.readFileSync(new URL('./programs-left-running.json', import.meta.url), 'utf8'));
const fail = message => new Error(message);
const text = value => typeof value === 'string' && value.trim().length > 0;
const pattern = (value, where) => {
  if (!text(value)) throw fail(`${where} must be a pattern written as text.`);
  try { return new RegExp(value); } catch { throw fail(`${where} is not a pattern that can be read: ${value}`); }
};
const shown = command => (command === null || command === undefined ? null : String(command).slice(0, settings.command_shown));

/** A list the caller had to read and give: refused when not given, never read as empty. */
function listGiven(rows, name, what) {
  if (rows === undefined || rows === null) {
    throw fail(`The ${what} list was not given. Read the person's ${what} rows and give them as ${name}; give [] only when the person keeps none.`);
  }
  if (!Array.isArray(rows)) throw fail(`${name} must be a list of the person's ${what} rows.`);
  return rows;
}

/** One rule row checked against the fields its list allows: id and why as text, and every other field it holds. */
function ruleOf(row, at, name, allowed) {
  const where = `${name}[${at}]`;
  if (!row || typeof row !== 'object' || Array.isArray(row)) throw fail(`${where} must be one rule row.`);
  const extra = Object.keys(row).filter(field => !allowed.includes(field));
  if (extra.length) throw fail(`${where} holds ${extra.join(', ')}, which a ${name} row may not hold; it takes ${allowed.join(', ')}.`);
  if (!text(row.id) || !text(row.why)) throw fail(`${where} needs an id and a why, each as text.`);
  const rule = { id: row.id, why: row.why };
  if (row.command_pattern !== undefined) rule.command = pattern(row.command_pattern, `${where}.command_pattern`);
  if (row.name_pattern !== undefined) rule.name = pattern(row.name_pattern, `${where}.name_pattern`);
  return rule;
}

function leftBehindRule(row, at) {
  const rule = ruleOf(row, at, 'left_behind', settings.left_behind_fields);
  const where = `left_behind[${at}]`;
  if (row.parent_pid !== undefined && !(Number.isInteger(row.parent_pid) && row.parent_pid >= 0)) throw fail(`${where}.parent_pid must be a process id.`);
  if (row.session_owner_gone !== undefined && row.session_owner_gone !== true) throw fail(`${where}.session_owner_gone is written only as true.`);
  if (row.parent_pid === undefined && row.session_owner_gone === undefined) throw fail(`${where} must say how a program is left behind: parent_pid, session_owner_gone, or both.`);
  if (!rule.command && !rule.name) throw fail(`${where} must name a command_pattern, a name_pattern, or both: a program the system itself started also has the first process as its parent and its own session.`);
  if (!(typeof row.older_than_minutes === 'number' && row.older_than_minutes > 0)) throw fail(`${where}.older_than_minutes must be a number of minutes above 0.`);
  if (row.cpu_share_at_least !== undefined && !(typeof row.cpu_share_at_least === 'number' && row.cpu_share_at_least >= 0)) throw fail(`${where}.cpu_share_at_least must be a number from 0 (1 is one whole processor).`);
  return { ...rule, parent: row.parent_pid, olderMs: row.older_than_minutes * 60_000, busy: row.cpu_share_at_least };
}

function neverStopRule(row, at) {
  const rule = ruleOf(row, at, 'never_stop', settings.never_stop_fields);
  if (!rule.command && !rule.name) throw fail(`never_stop[${at}] must name a command_pattern, a name_pattern, or both.`);
  return rule;
}

/** Whether the session of `program` still has an owner, or cannot be judged (both keep it). */
function sessionOwned(program, byPid, complete, first) {
  if (!Number.isInteger(program.session_id)) return true;
  const leader = byPid.get(program.session_id);
  if (!leader) return !complete;
  return !Number.isInteger(leader.parent_pid) || leader.parent_pid !== first;
}

/** The value a pattern is judged on: undefined when the rule names none, null when the program's could not be read. */
const fits = (regex, value) => (regex ? (value === null || value === undefined ? null : regex.test(value)) : undefined);

/** A left-behind row fits when every condition it names holds; one judged on a value that could not be read does not.
 *  The session's owner having ended is already known here: a program whose session is owned never reaches the rows. */
function leftBehindBy(rule, program, ageMs) {
  if (rule.parent !== undefined && program.parent_pid !== rule.parent) return false;
  if (ageMs === null || ageMs < rule.olderMs) return false;
  if (rule.busy !== undefined && (!Number.isFinite(program.cpu_ms) || ageMs <= 0 || program.cpu_ms / ageMs < rule.busy)) return false;
  return [fits(rule.command, program.command), fits(rule.name, program.name)].every(fit => fit === undefined || fit === true);
}

/** A never-stop row keeps a program when every pattern it names fits, or when a pattern's value could not be read. */
function keptBy(rule, program) {
  return [fits(rule.command, program.command), fits(rule.name, program.name)].every(fit => fit === undefined || fit === null || fit === true);
}

/** `tool:choose-programs-left-running`: the programs the person's rows say were left behind, each with the row that
 *  says so, and the ones a never-stop row kept. */
export function chooseProgramsLeftRunning({ programs, complete, left_behind, never_stop } = {}, _context, { now = Date.now, self = [process.pid, process.ppid] } = {}) {
  const neverStop = listGiven(never_stop, 'never_stop', 'never-stop').map(neverStopRule);
  const leftBehind = listGiven(left_behind, 'left_behind', 'left-behind').map(leftBehindRule);
  if (!Array.isArray(programs)) throw fail('Give programs: the list tool:list-running-programs answered, read with commands.');
  if (typeof complete !== 'boolean') throw fail('Give complete as the list answered it, true or false: a list cut short cannot show that a session ended.');
  const first = settings.first_process_pid;
  const byPid = new Map(programs.map(program => [program.pid, program]));
  const at = now();
  const picked = [], kept = [];
  for (const program of programs) {
    if (!Number.isInteger(program.pid) || program.pid <= first || self.includes(program.pid)) continue;
    if (sessionOwned(program, byPid, complete, first)) continue;
    const ageMs = Number.isFinite(program.started_at_ms) ? at - program.started_at_ms : null;
    const rule = leftBehind.find(one => leftBehindBy(one, program, ageMs));
    if (!rule) continue;
    const keeper = neverStop.find(one => keptBy(one, program));
    const which = { pid: program.pid, name: program.name ?? null, command: shown(program.command), rule: rule.id };
    if (keeper) { kept.push({ ...which, kept_by: keeper.id }); continue; }
    picked.push({ ...which, started_at_ms: program.started_at_ms, why: rule.why, age_minutes: Math.floor(ageMs / 60_000),
      cpu_share: Number.isFinite(program.cpu_ms) ? Math.round((program.cpu_ms / ageMs) * 100) / 100 : null });
  }
  const said = `Read ${leftBehind.length} left-behind rule${leftBehind.length === 1 ? '' : 's'} and ${neverStop.length} never-stop rule${neverStop.length === 1 ? '' : 's'}${neverStop.length ? '' : ' (the person keeps none)'}; ${picked.length} to stop, ${kept.length} kept by a never-stop rule.`;
  return { read: { left_behind: leftBehind.length, never_stop: neverStop.length }, picked, kept, said };
}

const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const stillThere = pid => { try { process.kill(pid, 0); return true; } catch (error) { return error.code === 'EPERM'; } };

/** `tool:stop-programs-left-running`: ask each chosen program to end, wait, and answer one stop per program (what, why,
 *  when, and what happened) and at most one notice for the sweep. */
export async function stopProgramsLeftRunning({ programs, grace_ms } = {}, _context, deps = {}) {
  const { read = () => readPrograms(), signal = (pid, name) => process.kill(pid, name), alive = stillThere, now = Date.now, sleep = pause } = deps;
  if (!Array.isArray(programs)) throw fail('Give programs: the picked list tool:choose-programs-left-running answered.');
  const grace = grace_ms === undefined || grace_ms === null ? settings.grace_ms.default : grace_ms;
  if (!Number.isInteger(grace) || grace < 0 || grace > settings.grace_ms.largest) throw fail(`Give grace_ms from 0 to ${settings.grace_ms.largest}.`);
  for (const [at, one] of programs.entries()) {
    if (!one || !Number.isInteger(one.pid) || one.pid <= settings.first_process_pid || !Number.isFinite(one.started_at_ms)) throw fail(`programs[${at}] needs the pid and started_at_ms it was chosen with.`);
  }
  if (!programs.length) return { stops: [], notices: [] };
  const iso = ms => new Date(ms).toISOString();
  const same = (list, one) => list.some(program => program.pid === one.pid && program.started_at_ms === one.started_at_ms);
  const before = await read();
  const stops = programs.map(one => ({ address: `program-stopped:${one.pid}:${one.started_at_ms}`, pid: one.pid, started_at_ms: one.started_at_ms,
    name: one.name ?? null, command: shown(one.command), rule: one.rule ?? null, why: one.why ?? null, asked_at: null, ended_at: null, outcome: null }));
  for (const stop of stops) {
    if (!before.some(program => program.pid === stop.pid)) { stop.outcome = 'already-gone'; continue; }
    if (!same(before, stop)) { stop.outcome = 'not-the-same-program'; continue; }
    stop.asked_at = iso(now());
    try { signal(stop.pid, 'SIGTERM'); } catch (error) { stop.outcome = error.code === 'ESRCH' ? 'already-gone' : 'not-allowed'; }
  }
  const waiting = () => stops.filter(stop => stop.asked_at && !stop.outcome);
  const until = now() + grace;
  while (waiting().length) {
    for (const stop of waiting()) if (!alive(stop.pid)) { stop.outcome = 'ended'; stop.ended_at = iso(now()); }
    if (!waiting().length || now() >= until) break;
    await sleep(settings.look_every_ms);
  }
  if (waiting().length) {
    const after = await read();
    for (const stop of waiting()) {
      if (same(after, stop)) stop.outcome = 'still-running';
      else { stop.outcome = 'ended'; stop.ended_at = iso(now()); }
    }
  }
  const ended = stops.filter(stop => stop.outcome === 'ended');
  const notices = ended.length ? [{
    title: `Stopped ${ended.length} program${ended.length === 1 ? '' : 's'} left running`,
    body: ended.map(stop => `${stop.name ?? 'a program'} (${stop.pid}), started ${iso(stop.started_at_ms)}: ${stop.why}`),
    kind: settings.notice_kind,
    key: `programs-stopped:${ended.map(stop => `${stop.pid}@${stop.started_at_ms}`).join(',')}`,
  }] : [];
  return { stops, notices };
}
