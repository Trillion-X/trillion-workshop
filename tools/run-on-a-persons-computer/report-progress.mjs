// computer/report-progress.mjs
//
// Purpose
//   Shows the person, in their Trillion, the work programs on this computer are doing: it reads the progress files the
//   rows in report-progress.json name and posts each as one report (POST /mcp/api/tell/progress, src/tell-the-person.mjs
//   report), so a drive being copied, a render or any other program's long work appears as one live card with moving
//   progress beside every other notification. It runs beside the connection as a handler of harness/wake-sessions.mjs
//   (it exports start). A row may also offer the person actions on the work (such as Pause, Resume or Stop): the
//   report names them and this computer's agent as the one that answers, and when the person presses one the account
//   sends this computer one event (src/tell-the-person.mjs act), which this module answers by writing or removing the
//   control file the row names beside the progress file, the program's own way of being paused or stopped.
//
// Non-negotiable invariants
//   1. Blind: nothing here names a program, a file or a kind of work; every path, word and kind is a row.
//   2. It only reads, except when the person presses an action a row offers: then it writes or removes exactly the
//      control file that row names, beside the progress file it read; programs are never signalled or slowed.
//   3. A file is reported only when what it says changed, at most every `every_seconds`, so a busy program costs the
//      person's store one small write per interval, never one per tick.
//   4. A report the account refuses or cannot take is tried again on the next read; nothing is queued or lost, since
//      the next read carries the newest state. Work still running is reported again every `resend_running_seconds`
//      even when nothing changed, so a long quiet stretch (one big file) never reads as stopped.
//
// Security
//   The account key comes from the helper (the Keychain item it was started with) and is only sent to the account's
//   own origin. Only paths a row names are read.
//
import { execFileSync } from 'node:child_process';
import { mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, hostname } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
export const settingsOf = () => JSON.parse(readFileSync(join(HERE, 'report-progress.json'), 'utf8'));

/** Every file `pattern` names: ~ is the home folder, and a * segment matches any one folder name (kept as `folder`). */
export function filesOf(pattern, home = homedir(), list = folder => readdirSync(folder)) {
  const parts = pattern.replace(/^~(?=\/)/, home).split('/');
  let found = [{ path: '', folder: null }];
  for (const part of parts) {
    if (part !== '*') { found = found.map(item => ({ ...item, path: item.path === '' && part === '' ? '/' : join(item.path, part) })); continue; }
    found = found.flatMap(item => {
      try { return list(item.path).filter(name => !name.startsWith('.')).map(name => ({ path: join(item.path, name), folder: name })); }
      catch { return []; }
    });
  }
  return found;
}

const at = (value, path) => path.reduce((here, step) => (here === null || here === undefined ? undefined : here[step]), value);
// Every value at `path`, where a "*" step is every item of a list there.
const allAt = (value, path) => {
  const star = path.indexOf('*');
  if (star === -1) return [at(value, path)];
  const list = at(value, path.slice(0, star));
  return Array.isArray(list) ? list.flatMap(item => allAt(item, path.slice(star + 1))) : [];
};
// A count read from one path, or the sum of several (a list of paths): undefined when any part is not a count.
const countAt = (value, spec) => {
  if (!Array.isArray(spec) || !spec.length) return undefined;
  const paths = Array.isArray(spec[0]) ? spec : [spec];
  const parts = paths.flatMap(path => allAt(value, path));
  return parts.every(part => typeof part === 'number' && Number.isFinite(part) && part >= 0) ? parts.reduce((sum, part) => sum + part, 0) : undefined;
};
const fill = (template, values) => String(template ?? '').replace(/\{(\w+)\}/g, (_, name) => (values[name] === undefined || values[name] === null ? '' : String(values[name])));
// A chip whose words name a value the file does not carry says nothing, so it is left out.
const chipsFrom = (templates, values) => (templates ?? []).flatMap(chip => {
  const text = typeof chip === 'string' ? chip : chip?.text;
  if (typeof text !== 'string') return [];
  const names = [...text.matchAll(/\{(\w+)\}/g)].map(match => match[1]);
  if (names.some(name => values[name] === undefined || values[name] === null)) return [];
  return [{ text: fill(text, values), ...(chip?.tone ? { tone: chip.tone } : {}) }];
});
const isCount = value => typeof value === 'number' && Number.isFinite(value) && value >= 0;

function alive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return true;
  try { process.kill(pid, 0); return true; } catch (error) { return error.code === 'EPERM'; }
}

/** One progress file as a report, or null when its state word is not one the row maps. */
export function reportOf(row, file, { folder = null, computer, agent = null, isAlive = alive, settledWithinMs = Infinity, stoppedAfterMs = 0, now = Date.now(), earlier = {} } = {}) {
  const values = { folder, computer };
  // A value the file no longer carries (a copy that finished names no file in flight) keeps what it said last time.
  for (const [name, spec] of Object.entries(row.values ?? {})) {
    let value = at(file, spec.path);
    if (typeof value === 'string' && spec.split) value = value.split(spec.split).filter(Boolean)[spec.pick ?? 0];
    values[name] = value === undefined || value === null ? earlier[name] : value;
  }
  const word = row.state ? at(file, row.state.path) : null;
  let state = row.state ? row.state.map[word] : 'running';
  if (!state) return null;
  let body = fill(row.body_by_state?.[word] ?? row.body, values);
  // A program gone while its file is still fresh is most likely being started again on the same work (the next one
  // rewrites the same file), so nothing is said until the file has been quiet for `stopped_after_seconds`.
  if (state === 'running' && row.pid && !isAlive(at(file, row.pid))) {
    if (row.updated && now - Date.parse(at(file, row.updated)) < stoppedAfterMs) return null;
    state = 'failed'; body = row.stopped_words ?? body;
  }
  if (state !== 'running' && row.updated && !(now - Date.parse(at(file, row.updated)) <= settledWithinMs)) return null;
  const done = countAt(file, row.done), total = countAt(file, row.total);
  const actions = state === 'running' && agent ? (row.actions ?? []).filter(action => !action.when || action.when.includes(word)).slice(0, 2).map(({ id, label }) => ({ id, label })) : [];
  return {
    key: fill(row.key, values), kind: row.kind, title: fill(row.title_by_state?.[word] ?? row.title, values).replace(/\s+/g, ' ').trim(), body, state, values,
    ...(row.source ? { source: fill(row.source, values) } : {}),
    ...(row.open ? { open: row.open } : {}),
    ...(isCount(done) && isCount(total) && done <= total ? { progress: { done, total, ...(row.unit ? { unit: row.unit } : {}) } } : {}),
    ...(actions.length ? { actions, answered_by: agent } : {}),
    ...(chipsFrom(row.chips_by_state?.[word] ?? row.chips, values).length ? { chips: chipsFrom(row.chips_by_state?.[word] ?? row.chips, values) } : {}),
  };
}

function computerName() {
  try { return execFileSync('scutil', ['--get', 'ComputerName'], { encoding: 'utf8', timeout: 5000 }).trim() || hostname(); }
  catch { return hostname(); }
}

/** Writes (atomically) or removes the control file an action names, in the folder of the progress file it was read from. */
export function applyAction(action, progressPath, now = new Date()) {
  const folder = dirname(progressPath);
  if (action.remove) { rmSync(join(folder, action.remove), { force: true }); return { removed: action.remove }; }
  const file = join(folder, action.write.file);
  const value = { ...action.write.value, ...(action.write.stamp ? { [action.write.stamp]: now.toISOString() } : {}) };
  mkdirSync(folder, { recursive: true });
  const partial = `${file}.${process.pid}.partial`;
  writeFileSync(partial, JSON.stringify(value, null, 2));
  renameSync(partial, file);
  return { wrote: action.write.file };
}

/**
 * Reads every row's files and posts what changed (and running work again every `resend_running_seconds`).
 * post(report) -> true when the account took it. `agent` is this computer's agent, which answers the actions a report
 * offers. Answers { tick, stop, knows(key), act(key, action id) }; `timers` false leaves ticking to the caller (tests).
 */
export function startReporting({ settings = settingsOf(), post, computer = computerName(), agent = null, read = path => JSON.parse(readFileSync(path, 'utf8')), list, home, isAlive, timers = true, log = () => {}, clock = () => Date.now(), write = applyAction } = {}) {
  const sent = new Map();
  const seen = new Map();
  const remembered = new Map();
  let busy = false;
  async function tick() {
    if (busy) return;
    busy = true;
    try {
      for (const row of settings.rows) {
        for (const { path, folder } of filesOf(row.files, home, list)) {
          let file;
          try { file = read(path); } catch { continue; }
          const found = reportOf(row, file, { folder, computer, agent, isAlive, settledWithinMs: settings.settled_within_minutes * 60_000, stoppedAfterMs: (settings.stopped_after_seconds ?? 0) * 1000, earlier: remembered.get(path) });
          if (!found?.key || !found.title) continue;
          const { values, ...report } = found;
          remembered.set(path, values);
          seen.set(report.key, { row, path });
          const text = JSON.stringify(report);
          const last = sent.get(report.key);
          const due = report.state === 'running' && last && clock() - last.at >= settings.resend_running_seconds * 1000;
          if (last?.text === text && !due) continue;
          if (await post(report)) sent.set(report.key, { text, at: clock() });
          else log(`report-progress: the account did not take ${report.key}`);
        }
      }
    } finally { busy = false; }
  }
  const timer = timers ? setInterval(() => { tick().catch(error => log(`report-progress: ${error.message}`)); }, settings.every_seconds * 1000) : null;
  if (timers) tick().catch(error => log(`report-progress: ${error.message}`));
  // The person pressed an action the report for `key` offered: write its control file, then report at once.
  async function act(key, actionId) {
    const found = seen.get(key);
    const action = found?.row.actions?.find(item => item.id === actionId);
    if (!action) throw new Error(`No work here offers ${actionId} for ${key}.`);
    const done = write(action, found.path);
    sent.delete(key);
    await tick();
    return { key, action: actionId, ...done };
  }
  return { tick, stop: () => clearInterval(timer), knows: key => seen.has(key), act };
}

/** The account's door for reports: true when it took one. */
export const accountPost = (origin, key, fetchImpl = fetch) => async report => {
  try {
    const answer = await fetchImpl(`${origin.replace(/\/$/, '')}/mcp/api/tell/progress`, { method: 'POST', headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' }, body: JSON.stringify(report), signal: AbortSignal.timeout(30_000) });
    return answer.ok;
  } catch { return false; }
};

// The reporting running beside the helper; events for it are the actions the person pressed on its reports.
let running = null;
export const wants = ({ event, helper } = {}) => Boolean(running && helper && event?.refs?.action && running.knows(event.refs.key));
export const handle = ({ event }) => running.act(event.refs.key, event.refs.action);
// Pressing a button writes one small file, so it is answered as it arrives, never behind an AI's turn.
export const answers_at_once = true;
export const start = ({ key, origin, log, helper }) => {
  running = startReporting({ post: accountPost(origin ?? settingsOf().origin, key), agent: helper?.agent_id ?? null, log });
  return running;
};
