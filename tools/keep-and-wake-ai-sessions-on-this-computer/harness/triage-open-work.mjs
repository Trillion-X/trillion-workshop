// harness/triage-open-work.mjs
//
// Purpose
//   The step before take-open-work.mjs gives a job a full AI run. Most waiting work is a message the person wrote in a
//   chat, recorded as a job, that the chat itself already acted on; running a full AI on each costs far more than it
//   finds. Here a cheap model reads each job the computer's AI may take now, with what was said in its chat after it
//   arrived, and sorts it by the outcome rows in take-open-work.json `triage`: close it with a one-line reason, gather
//   it into one digest job with the other information, or pass it to the full run (take-open-work.mjs plan() runs only
//   jobs sorted to `take`, within max_concurrent and daily_cap).
//   Pure parts: candidates(), laterMessages(), verdictOf(). Runner: runTriage(). Standalone:
//     node harness/triage-open-work.mjs --once [--dry-run] [--origin <url>] [--keychain-item <name>]
//
// Non-negotiable invariants
//   1. A job is sorted once on this computer (<state>/triaged/<handoff_id>.json, created exclusively), and a digest this
//      step made is never sorted: it goes straight to the full run.
//   2. Only work this computer's AI may take now is sorted: handed to no agent by name, not held, not waiting on other
//      work, and either not from a chat or past its chat's first turn (the account's anyone_from) with no chat of its
//      own published to take it.
//   3. No model, AI app, chat app or outcome is named here: the command, the outcomes and what each does (`then`), the
//      limits and every word are DATA in take-open-work.json. An answer naming no outcome counts as when_unsure.
//   4. The model run retains provider settings, with tools, hooks and saved sessions disabled, so sorting is never itself recorded as
//      something the person wrote.
//
//   5. A job is sorted by what the person said or sent, not by the standing words every job of its kind carries: the
//      job's own `said` (the person's words as the job shows them) and the text files the job's input names (`attached`
//      in take-open-work.json: which input keys name a file) are given to the model beside the job.
//   6. Every sort keeps which parts of the job it read (`sorted_by`: the placeholders of triage.prompt). When the prompt
//      gains a part, a job sorted to `take` without it is sorted once more if that part holds anything for the job, and
//      is only marked otherwise, so a backlog of identical-looking jobs (every recording says "work through my
//      recording", every old message job says "turn it into content") is never all left for the full run.
//   7. A model row that answers nothing says why (its exit, its time running out, the end of what it printed), and a
//      pass that stops for want of an answer logs those reasons, so a stopped sorter is never a silent one.
//   8. A model row's program is found the way take-open-work.mjs finds every program (resolveProgram: this PATH, then the
//      program_paths folders, then the login shell), because the Mac app's helper has a short PATH. A row whose program is
//      not installed where Trillion looks answers nothing ("<program> is not installed where Trillion looks (...)"), so the
//      next chosen row answers instead, exactly as for a row that fails.
//
import { execFile } from 'node:child_process';
import { closeSync, fstatSync, mkdirSync, openSync, readFileSync, readSync, readdirSync, realpathSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { accountCaller, chatOf, childEnv, computerName, matchFiles, notTakeable, programMissingWords, readPage, readSettings, resolveProgram } from './take-open-work.mjs';
import inboundWords from '../src/inbound-words.json' with { type: 'json' };
import { toolConfigSwitches } from './tool-config-switches.mjs';
import { requireAccountKey } from './account-key.mjs';

const fill = (template, values) => String(template ?? '').replace(/\{(\w+)\}/g, (whole, name) => (Object.hasOwn(values, name) ? String(values[name]) : whole));
const home = path => String(path).replace(/^~(?=\/|$)/, homedir());
const at = (row, path) => path.reduce((value, key) => (value && typeof value === 'object' ? value[key] : undefined), row);
const textOf = value => (typeof value === 'string' ? value : Array.isArray(value) ? value.map(part => (typeof part === 'string' ? part : typeof part?.text === 'string' ? part.text : '')).filter(Boolean).join('\n') : '');

/** The parts of a job the sorter gives the model: the placeholders of settings.triage.prompt. Pure. */
export const promptParts = settings => [...new Set([...String(settings.triage.prompt).matchAll(/\{(\w+)\}/g)].map(found => found[1]))];

// The parts a sort read. A record from before sorts kept them read the job, its chat and, when marked, its files.
const sortedBy = record => record.sorted_by ?? ['handed_at', 'job', 'later', ...(record.attached_read ? ['attached'] : [])];

/** The parts of the prompt a kept sort did not read. Pure. */
export const unread = (settings, record) => promptParts(settings).filter(part => !sortedBy(record).includes(part));

// A record sorted to the full run without a part the prompt now gives is sorted once more.
const resortable = (settings, record) => record?.then === 'take' && !record.closed_at && unread(settings, record).length > 0;

/** The person's own words as the job shows them (its `said`, or what arrived with it). Pure. */
export const saidOf = item => [item.said, item.input?.said].find(value => typeof value === 'string' && value.trim())?.trim() ?? '';

/** The file names a job's input points at: every text value under a key matching settings.triage.attached.key_pattern,
 *  at any depth, each once. Pure. */
export function attachedNames(settings, item) {
  const pattern = new RegExp(settings.triage.attached?.key_pattern ?? '(?!)');
  const found = new Set();
  const walk = value => {
    if (Array.isArray(value)) { value.forEach(walk); return; }
    if (!value || typeof value !== 'object') return;
    for (const [key, inner] of Object.entries(value)) {
      if (typeof inner === 'string' && pattern.test(key) && inner.trim()) found.add(inner.trim());
      else walk(inner);
    }
  };
  walk(item.input);
  return [...found];
}

/** Work this computer's AI may take now and has not sorted yet. Pure. */
export function candidates({ open, agents, settings, triaged, started, now }) {
  const owned = new Set(agents.filter(card => card.takes_work && card.source_id).map(card => card.source_id));
  // A digest this step made is never sorted again (it would only fold into another digest).
  // What the person sent themselves that no chat owns (a share from their phone) is never sorted away: it goes to the
  // full run first (take-open-work.mjs plan).
  return open.filter(item => item.state !== 'finished' && !item.to_agent && !notTakeable(item, now, settings.trillion_marks_as)
    && !String(item.from_agent ?? '').startsWith(settings.triage.agent_id_prefix)
    && !((item.priority ?? 0) >= inboundWords.priority.from_person && !item.input?.arrived?.source_id)
    && (!triaged.has(item.handoff_id) || resortable(settings, triaged.get(item.handoff_id))) && !started.has(item.handoff_id)
    && (!item.input?.arrived?.source_id || (!owned.has(item.input.arrived.source_id) && typeof item.anyone_from === 'string' && item.anyone_from <= now)))
    .sort((a, b) => String(a.handed_at).localeCompare(String(b.handed_at)));
}

// The first line starting at or after a byte offset, and its time (lines are appended in time order).
function lineAt(fd, size, offset, timePath) {
  const buffer = Buffer.alloc(Math.min(1 << 20, size - offset));
  readSync(fd, buffer, 0, buffer.length, offset);
  const text = buffer.toString('utf8');
  const from = offset === 0 ? 0 : text.indexOf('\n') + 1;
  if (from <= 0 && offset !== 0) return null;
  const end = text.indexOf('\n', from);
  try { const when = at(JSON.parse(text.slice(from, end < 0 ? undefined : end)), timePath); return typeof when === 'string' ? when : null; } catch { return null; }
}

// The byte offset near the first line after `since`, found by halving: a long transcript is never read whole.
function offsetAfter(fd, size, since, timePath) {
  let low = 0;
  let high = size;
  while (high - low > 1 << 20) {
    const middle = Math.floor((low + high) / 2);
    const when = lineAt(fd, size, middle, timePath);
    if (when === null || when <= since) low = middle; else high = middle;
  }
  return low;
}

const readRange = (fd, offset, length) => { const buffer = Buffer.alloc(Math.max(0, length)); readSync(fd, buffer, 0, buffer.length, offset); return buffer.toString('utf8'); };

/**
 * What was said in the job's own chat on this computer after it arrived, newest last: at most later_chars, its first
 * and latest halves. Only the part of the transcript right after the job arrived and its end are read (read_bytes each).
 */
export function laterMessages(settings, item) {
  const source_id = item.input?.arrived?.source_id;
  const since = item.input?.arrived?.at ?? item.handed_at;
  const chat = source_id && chatOf(settings, source_id);
  if (!chat?.row.later) return '';
  const file = matchFiles(home(fill(chat.row.session_file, { session: chat.session })))[0];
  if (!file) return '';
  const said = rows => {
    const found = [];
    for (const line of rows.split('\n')) {
      if (!line.trim()) continue;
      let row;
      try { row = JSON.parse(line); } catch { continue; }
      const when = at(row, chat.row.later.time_path);
      const role = at(row, chat.row.later.role_path);
      if (typeof when !== 'string' || when <= since || !chat.row.later.roles.includes(role)) continue;
      const text = textOf(at(row, chat.row.later.text_path)).trim();
      if (text) found.push(`${role}: ${text}`);
    }
    return found.join('\n\n');
  };
  const half = Math.floor(settings.triage.later_chars / 2);
  const fd = openSync(file, 'r');
  try {
    const size = fstatSync(fd).size;
    const read = settings.triage.read_bytes;
    const from = offsetAfter(fd, size, since, chat.row.later.time_path);
    if (size - from <= 2 * read) {
      // Its first part shows whether the chat took the job up; its latest part whether that chat ever got it done.
      const all = said(readRange(fd, from, size - from));
      return all.length > settings.triage.later_chars ? `${all.slice(0, half)}\n\n......\n\n${all.slice(-half)}` : all;
    }
    const first = said(readRange(fd, from, read)).slice(0, half);
    const latest = said(readRange(fd, size - read, read)).slice(-half);
    return `${first}\n\n......\n\n${latest}`;
  } finally { closeSync(fd); }
}

/** The outcome a model's answer names, or when_unsure. */
export function verdictOf(settings, answer) {
  const found = String(answer ?? '').match(/\{[\s\S]*\}/);
  let said = null;
  try { said = found ? JSON.parse(found[0]) : null; } catch { said = null; }
  const row = settings.triage.outcomes.find(item => item.id === said?.outcome) ?? settings.triage.outcomes.find(item => item.id === settings.triage.when_unsure);
  const line = value => (typeof value === 'string' && value.trim() ? value.trim().slice(0, 300) : null);
  return { outcome: row.id, then: row.then, reason: line(said?.reason) ?? '(no reason given)', meaning: line(said?.meaning), understood: row.id === said?.outcome };
}

/** The words the model is given for one job. */
export function askFor(settings, item, later, attached = '') {
  const triage = settings.triage;
  const system = fill(triage.system, { outcomes: triage.outcomes.map(row => `- ${row.id}: ${row.means}`).join('\n'), when_unsure: triage.when_unsure });
  const job = String(item.job ?? '').slice(0, triage.job_chars);
  const said = saidOf(item).slice(0, triage.job_chars);
  return { system, prompt: fill(triage.prompt, { handed_at: item.handed_at, job, said, later, attached }) };
}

/** The text of the files a job points at, each under its name, within settings.triage.attached.chars in all; a file
 *  that is not text, or cannot be read, is named with what it is instead. read(name) → { encoding, content } */
export async function attachedText(settings, item, read) {
  const names = attachedNames(settings, item);
  if (!names.length || !read) return '';
  const room = settings.triage.attached.chars;
  const parts = [];
  for (const name of names) {
    let got = null;
    try { got = await read(name); } catch { got = null; }
    const words = got && got.encoding !== 'base64' && typeof got.content === 'string' ? got.content : null;
    parts.push(`${name}:\n${words === null ? settings.triage.attached.unreadable : words.slice(0, Math.max(0, Math.floor(room / names.length)))}`);
  }
  return parts.join('\n\n');
}

// Why a row's run gave no answer, in a line: its time ran out, or its exit and the end of what it printed.
const whyNone = (error, stdout, stderr) => (error?.killed ? 'ran out of time'
  : `${error ? `exit ${error.code ?? error.signal ?? 'error'}` : 'printed nothing'}: ${String(stderr || stdout || '').trim().split('\n').slice(-2).join(' ').slice(0, 240)}`);

// Runs one model row's command with its stdin (the row's `stdin` template over system and prompt); resolves its text,
// or { none: why } when it fails, says nothing or runs out of time (a usage limit reached, for example).
export const modelCommand = (row, { system }, options = {}) => {
  const command = row.command.map(part => fill(part, { system }));
  if (row.isolate_tool_config) command.splice(command.length - 1, 0, ...toolConfigSwitches(options));
  return command;
};
const runRow = (settings, cwd, row, { system, prompt }) => new Promise(resolve => {
  const [command, ...args] = modelCommand(row, { system });
  const program = resolveProgram(command);
  if (!program) { resolve({ none: programMissingWords(command) }); return; }
  const child = execFile(program, args, { cwd, env: childEnv(), timeout: settings.triage.timeout_seconds * 1000, maxBuffer: 1 << 20 }, (error, stdout, stderr) => resolve(error || !String(stdout).trim() ? { none: whyNone(error, stdout, stderr) } : stdout));
  child.stdin.end(fill(row.stdin ?? '{prompt}', { system, prompt }));
});

// The model rows of the person's chosen AIs, in the order they chose them (settings.ai_order, else [settings.use_ai]).
// A row of any other AI is never asked, so a failing row never hands the work to an AI the person did not choose.
const chosenRows = settings => (settings.ai_order ?? (settings.use_ai ? [settings.use_ai] : []))
  .flatMap(ai => settings.triage.models.filter(row => row.ai === ai));

// Asks the chosen model rows (see chosenRows) in order: a row that has answered nothing give_up_after times in a row
// is not asked again this pass, and the next chosen row answers instead. With no chosen row, or none that answers,
// it answers null. No answer from any row is never taken as a verdict.
// `why` holds each row's latest reason for answering nothing (a run resolves text, null, or { none: why }).
export const runModels = (settings, cwd, run = runRow) => {
  const silent = new Map();
  const why = {};
  const model = async words => {
    for (const row of chosenRows(settings)) {
      if ((silent.get(row.id) ?? 0) >= settings.triage.give_up_after) continue;
      const answer = await run(settings, cwd, row, words);
      if (typeof answer === 'string') { silent.set(row.id, 0); return answer; }
      why[row.id] = answer?.none ?? 'no answer';
      silent.set(row.id, (silent.get(row.id) ?? 0) + 1);
    }
    return null;
  };
  model.why = why;
  return model;
};

/** Local sorted records: one file per handoff, created exclusively. */
export function triagedRecords(folder) {
  const dir = join(folder, 'triaged');
  mkdirSync(dir, { recursive: true });
  const path = id => join(dir, `${id.replace(/[^A-Za-z0-9_-]/g, '_')}.json`);
  return {
    all() {
      const found = new Map();
      for (const name of readdirSync(dir)) {
        if (!name.endsWith('.json')) continue;
        try { const record = JSON.parse(readFileSync(join(dir, name), 'utf8')); found.set(record.handoff_id, record); } catch { /* being written */ }
      }
      return found;
    },
    keep(record) {
      let fd;
      try { fd = openSync(path(record.handoff_id), 'wx'); } catch { return false; }
      writeFileSync(fd, JSON.stringify(record));
      closeSync(fd);
      return true;
    },
    update(id, change) { writeFileSync(path(id), JSON.stringify({ ...JSON.parse(readFileSync(path(id), 'utf8')), ...change })); },
  };
}

const localDay = iso => { const when = new Date(iso); return `${when.getFullYear()}-${when.getMonth() + 1}-${when.getDate()}`; };

/**
 * One pass: sort the work this computer's AI may take now, close and gather what needs no run.
 *   call(path, body) → the account's /mcp/api answer;  ask({ system, prompt }) → the model's text
 * → { sorted: { outcome: count }, closed: [handoff_id], digests: [{ into, count }], problems, verdicts }
 */
// `listed` (optional) is the open work the caller already read this pass ({ work, agents }), so one pass reads it once.
export async function runTriage({ settings, call, computer, ask = null, read = call?.readFile ?? null, log = () => {}, now = () => new Date(), dryRun = false, onlyHandoffId = null, listed = null }) {
  const folder = home(settings.state_folder);
  const records = triagedRecords(folder);
  const nowIso = now().toISOString();
  const open = [];
  let agents = [];
  let after = null;
  if (onlyHandoffId) {
    const named = (await call('/handoffs/read', { handoff_id: onlyHandoffId }))?.handoff;
    if (named) open.push(named);
  } else if (listed) {
    open.push(...listed.work);
    agents = listed.agents;
  } else do {
    const page = await readPage(call, { after, limit: 50 }, { backoff_seconds: settings.page_retry?.backoff_seconds });
    if (!Array.isArray(page?.work)) throw new Error('The account did not return its open work.');
    open.push(...page.work);
    agents = page.agents ?? agents;
    after = page.next_after ?? null;
  } while (after);
  const triaged = records.all();
  const startedDir = join(folder, 'started');
  const started = new Set((() => { try { return readdirSync(startedDir); } catch { return []; } })().map(name => name.replace(/\.json$/, '')));
  const sortedToday = [...triaged.values()].filter(record => localDay(record.at) === localDay(nowIso)).length;
  const room = Math.max(0, Math.min(settings.triage.per_pass, settings.triage.daily_cap - sortedToday));
  // The page carries only what picks the work; each job is read whole (its words, who handed it, what arrived).
  const picked = candidates({ open, agents, settings, triaged, started: { has: id => started.has(id.replace(/[^A-Za-z0-9_-]/g, '_')) }, now: nowIso }).slice(0, room);
  const todo = [];
  for (const item of picked) {
    // A failed account read is a retryable service failure, never a verdict that
    // there was no work to sort. Let the receiver keep the event for a retry.
    const whole = (await call('/handoffs/read', { handoff_id: item.handoff_id }))?.handoff;
    if (whole && !String(whole.from_agent ?? '').startsWith(settings.triage.agent_id_prefix)) todo.push({ ...whole, anyone_from: item.anyone_from });
  }
  // A job sorted to the full run without a part the prompt now gives, where that part holds nothing for it, keeps its
  // sort and is marked as read in full; one where it holds something is sorted once more.
  const parts = promptParts(settings);
  const holds = { said: item => Boolean(saidOf(item)), attached: item => attachedNames(settings, item).length > 0 };
  const worthSortingAgain = item => unread(settings, triaged.get(item.handoff_id)).some(part => (holds[part] ?? (() => true))(item));
  for (const item of todo) if (triaged.has(item.handoff_id) && !worthSortingAgain(item) && !dryRun) records.update(item.handoff_id, { sorted_by: parts });
  todo.splice(0, todo.length, ...todo.filter(item => !triaged.has(item.handoff_id) || worthSortingAgain(item)));
  const attachedOf = new Map();
  for (const item of todo) attachedOf.set(item.handoff_id, await attachedText(settings, item, read));
  log({ did: 'sorting', open: open.length, sorting: todo.length, sorting_again: todo.filter(item => triaged.has(item.handoff_id)).length });
  const model = ask ?? runModels(settings, folder);
  let done_unsorted = 0;
  const verdicts = [];
  for (let i = 0; i < todo.length; i += settings.triage.at_once) {
    const batch = todo.slice(i, i + settings.triage.at_once);
    const answers = await Promise.all(batch.map(item => model(askFor(settings, item, laterMessages(settings, item), attachedOf.get(item.handoff_id) ?? ''))));
    // A model that answered nothing for a whole batch is not asked again this pass; nothing it did not answer is kept.
    if (answers.every(answer => answer === null)) { done_unsorted += todo.length - i; log({ did: 'model gave no answer', stopped_at: i, of: todo.length, why: { ...(model.why ?? {}) } }); break; }
    batch.forEach((item, index) => {
      if (answers[index] === null) { done_unsorted += 1; return; }
      const verdict = verdictOf(settings, answers[index]);
      verdicts.push({ item, ...verdict });
      const record = { handoff_id: item.handoff_id, outcome: verdict.outcome, then: verdict.then, reason: verdict.reason, meaning: verdict.meaning, understood: verdict.understood, at: nowIso, job: String(item.job ?? '').slice(0, 300), sorted_by: parts };
      if (!dryRun) { if (triaged.has(item.handoff_id)) records.update(item.handoff_id, record); else records.keep(record); }
    });
    log({ did: 'sorted', done: Math.min(i + settings.triage.at_once, todo.length), of: todo.length });
  }
  const sorted = verdicts.reduce((counts, verdict) => ({ ...counts, [verdict.outcome]: (counts[verdict.outcome] ?? 0) + 1 }), {});
  // Jobs sorted earlier to be closed or gathered that are still open (the account could not close them then) are
  // closed again now, on their earlier verdict.
  const stillOpen = new Set(open.map(item => item.handoff_id));
  for (const record of triaged.values()) {
    if (record.then === 'take' || record.closed_at || record.folded_into || !stillOpen.has(record.handoff_id) || dryRun) continue;
    const whole = (await call('/handoffs/read', { handoff_id: record.handoff_id }).catch(() => null))?.handoff;
    if (whole && !whole.to_agent) verdicts.push({ item: whole, outcome: record.outcome, then: record.then, reason: record.reason, meaning: record.meaning ?? null, again: true });
  }
  const done = { sorted, unsorted: done_unsorted, closed: [], digests: [], problems: [], verdicts: verdicts.map(({ item, outcome, reason, meaning }) => ({ handoff_id: item.handoff_id, outcome, reason, meaning, job: String(item.job ?? '').slice(0, 1200) })) };
  if (dryRun || !verdicts.some(verdict => verdict.then !== 'take')) return done;
  // Everything sorted to close or gather is sent to the account batch_size at a time (POST /handoffs/close-many), which
  // finishes each, decides a message job's decision and gathers information into one digest per call.
  const agent_id = `${settings.triage.agent_id_prefix}${computer.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')}`;
  const closing = verdicts.filter(verdict => verdict.then !== 'take');
  for (let i = 0; i < closing.length; i += settings.triage.batch_size) {
    const batch = closing.slice(i, i + settings.triage.batch_size);
    const items = batch.map(verdict => ({ handoff_id: verdict.item.handoff_id, outcome: settings.triage.outcomes.find(row => row.id === verdict.outcome).closes_as, reason: verdict.reason, ...(verdict.meaning ? { meaning: verdict.meaning } : {}) }));
    let answer;
    try { answer = await call('/handoffs/close-many', { by: agent_id, items }); }
    catch (error) { for (const item of items) done.problems.push({ handoff_id: item.handoff_id, problem: error.message }); continue; }
    const at = now().toISOString();
    for (const closed of answer.closed ?? []) {
      done.closed.push(closed.handoff_id);
      records.update(closed.handoff_id, answer.digest && closed.outcome === 'digest' ? { folded_into: answer.digest.into, closed_at: at } : { closed_at: at });
    }
    for (const handoff_id of answer.repeated ?? []) records.update(handoff_id, { closed_at: at });
    if (answer.digest) done.digests.push(answer.digest);
    done.problems.push(...(answer.problems ?? []));
    log({ did: 'closed', done: Math.min(i + settings.triage.batch_size, closing.length), of: closing.length, problems: (answer.problems ?? []).length });
  }
  return done;
}

async function main(argv) {
  const settings = readSettings();
  const pairs = Object.fromEntries(argv.flatMap((value, index) => (value.startsWith('--') ? [[value.slice(2), argv[index + 1]?.startsWith('--') ? 'true' : argv[index + 1] ?? 'true']] : [])));
  if (!pairs.once) throw new Error('Run one pass with --once (add --dry-run to only see what it would sort).');
  const key = requireAccountKey({ item: pairs['keychain-item'] ?? settings.keychain_item, timeout: 0 });
  const log = entry => process.stdout.write(`${JSON.stringify({ at: new Date().toISOString(), ...entry })}\n`);
  const origin = pairs.origin ?? settings.origin;
  const result = await runTriage({ settings, call: accountCaller(origin, key), computer: computerName(), log, dryRun: pairs['dry-run'] === 'true' });
  log({ did: 'pass done', ...result });
}

const isEntryScript = () => {
  try {
    return realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
};
if (isEntryScript()) {
  main(process.argv.slice(2)).catch(error => { process.stderr.write(`${error.stack ?? error}\n`); process.exit(1); });
}
