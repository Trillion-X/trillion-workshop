// harness/take-open-work.mjs
//
// Purpose
//   Part of the Trillion helper on a person's own computer (a client program like carry-connections.mjs, extension/ and
//   ios/, never part of the hosted service). Work handed to "whichever of my AIs takes it first" waits on the account
//   until an AI takes it; Trillion runs no agent of its own, so this gets it done by the AI the person chose:
//     - work handed to nobody in particular is claimed by id for this computer's agent card, then the chosen AI runs
//       headless with a prompt telling it to take that exact task, do it, and finish it;
//     - work that came from one of the person's chats stays with that chat (only that chat's agent may take it), so
//       when that chat is idle on this computer it is resumed headless with a prompt to take, do and finish it.
//   Two layers: plan() is pure (open work, agent cards, settings, today's count → what to start now), and the runner
//   (runPass) reads the account, claims, spawns and records.
//   Programs: a command's first word is found by resolveProgram() before anything is claimed or started, because the Mac
//   app starts this helper under launchd with a short PATH (/usr/bin:/bin:/usr/sbin:/sbin) where an AI's program (codex,
//   claude) is usually not. It is looked for on this PATH, then in the folders take-open-work.json program_paths names,
//   then by the person's login shell. The same finding serves the taker, its chats and the sorting step (triage).
//
//   Helper seam: export default handle(event, agents, options), one pass that returns once the runs are started.
//   Standalone: node harness/take-open-work.mjs --once
//               (every account call goes through the source `account.credential` names, pinned: account-call.mjs)
//               one pass that waits for the runs it started to end, printing one JSON line per thing that happened.
//
// Non-negotiable invariants
//   1. Never start a task twice: a task's local record (<state>/started/<handoff_id>.json) is created exclusively before
//      anything runs, a task with a record is never planned again, and the account's take-by-id is the claim.
//   2. Never more than max_concurrent runs alive and never more than daily_cap started in one local day. What the
//      person said themselves goes first, newest first, and is held only by max_concurrent, never by daily_cap. What they
//      said themselves is decided by src/own-work.mjs: an arrival from the person, or a priority at or above
//      src/inbound-words.json from_person, whatever priority the rule that handed it gave it.
//   3. A chat's work goes only to that same chat, resumed only when it has been idle chat_idle_minutes and its transcript
//      is at most chat_largest_bytes (a longer chat costs more to resume than the task is worth), one run per chat at a
//      time; a chat with a published agent card takes its own work and is left alone.
//   4. No AI, chat app or product is named in this file: commands, prompts, limits and words are DATA in
//      take-open-work.json. A kept key (the keychain source) is read at each call and sent only in the Authorization header.
//   5. Before a claim, the exact Trillion MCP bridge the AI will receive must initialize successfully. A run that ends
//      without finishing its claimed task gives it back immediately with the log and exit code, never silently.
//   6. One announced task costs one read by its id (and one page of open work for the agent cards when the caller has
//      none), never a listing of every open task.
//   7. A program that is installed nowhere Trillion looks is a wall, never a crash: no task is claimed or taken for the AI
//      that needs it, the AI's taker card line says "<program> is not installed where Trillion looks (<folders tried>)"
//      (words.program_missing_trouble), and the next of the person's AIs whose program is installed runs instead. A chat
//      whose AI's program is missing waits (its work is left, not claimed). The card clears when the program is found.
//
import { randomUUID } from 'node:crypto';
import { execFileSync, spawn } from 'node:child_process';
import { accessSync, closeSync, constants, mkdirSync, openSync, readFileSync, readSync, readdirSync, realpathSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { homedir, hostname } from 'node:os';
import { isAbsolute, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { aiOrder, chosenAi as chosenAiOnThisComputer, computerSettings } from './chosen-ai.mjs';
import { isOwnWork, takingOrder } from '../src/own-work.mjs';
import { accountWithWord, operationCaller } from './account-call.mjs';

// The account as this computer's settings name it: the command's brand placeholder filled from the marks word the settings keep.
export const accountOfSettings = settings => accountWithWord(settings.account, settings.trillion_marks_as);
import { runTaskMove, stateOfWord, tasksIn, wordsOfStates } from '../../plan-tasks-and-todo-lists/run-a-task-move.mjs';
import { requestedOutcome } from '../../plan-tasks-and-todo-lists/task-moves.mjs';
import { answerIssue, UnsupportedSchema } from './answer-shape.mjs';

const fill = (template, values) => String(template ?? '').replace(/\{(\w+)\}/g, (whole, name) => (Object.hasOwn(values, name) ? String(values[name]) : whole));
// The receipt field keeps its name (job_contract): a receipt written before this change keeps its attempt count.
const taskContract = (task, settings) => Object.fromEntries((settings.tasks?.revision_fields ?? []).map(field => [field, task?.[field] ?? null]));
const home = path => String(path).replace(/^~(?=\/|$)/, homedir());
// The file a task run writes its answer to ({result, evidence}); this computer checks it and finishes the task (finishFromAnswer).
export const resultFileOf = (settings, handoff_id) => join(home(settings.state_folder), 'results', `${encodeURIComponent(handoff_id)}.json`);

// Programs. A helper the Mac app starts has a short PATH, so a program a command names is looked for on this PATH, then in
// the folders take-open-work.json program_paths names (~ expanded), then by the person's login shell. A program found is
// kept for this process; one not found is looked for again on the next pass, so one installed since runs at once.
const takerData = JSON.parse(readFileSync(new URL('./take-open-work.json', import.meta.url), 'utf8'));
const taskRules = JSON.parse(readFileSync(new URL('../../plan-tasks-and-todo-lists/task-moves.json', import.meta.url), 'utf8'));
// A task's stored status word read as its declared state, then as the state this worker names it by (settings.tasks.worker_states).
const workerStateOf = (status, settings) => settings.tasks.worker_states[stateOfWord(status)];
// The taking order reads priority as a number: the declared words, most urgent highest. The person's own words start at
// from_person (src/inbound-words.json), above every task word, so a task is never taken as the person's own words.
const priorityNumber = word => taskRules.priorities.length - taskRules.priorities.indexOf(word ?? taskRules.default_priority);
const PROGRAM_NAME = /^[A-Za-z0-9._+-]+$/;
const resolvedPrograms = new Map();
const isRunnableFile = path => { try { accessSync(path, constants.X_OK); return statSync(path).isFile(); } catch { return false; } };
/** The folders the data names where a program may be installed, ~ expanded, in the order looked in. */
export const programFolders = () => (takerData.program_paths ?? []).map(home);
/** The folders of a PATH (this process's by default), in order. */
export const pathFolders = (env = process.env) => String(env.PATH ?? '').split(':').filter(Boolean);
/** The folders Trillion looks in for a program, in order, without repeats (the words that say a program is missing name them). */
export const foldersTried = (env = process.env) => [...new Set([...pathFolders(env), ...programFolders()])];
/** The program's path as the person's login shell finds it: `$SHELL -lc 'command -v <name>'` with a short timeout (zsh when
 * SHELL is unset). Only the last line counts, and only when it is an absolute, runnable file; null otherwise. */
export function loginShellLookup(name, env = process.env) {
  if (typeof name !== 'string' || !PROGRAM_NAME.test(name)) return null;
  try {
    const said = execFileSync(env.SHELL || '/bin/zsh', ['-lc', 'command -v "$1"', 'sh', name], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 3000 });
    const last = said.trim().split('\n').at(-1)?.trim() ?? '';
    return isAbsolute(last) && isRunnableFile(last) ? last : null;
  } catch { return null; }
}
function findProgram(name, { env = process.env, exists = isRunnableFile, shellLookup = program => (takerData.login_shell_lookup ? loginShellLookup(program, env) : null), folders = programFolders() } = {}) {
  if (typeof name !== 'string' || !name) return null;
  if (isAbsolute(name)) return name;
  if (name.includes('/')) return null;
  for (const folder of [...pathFolders(env), ...folders]) {
    const candidate = join(folder, name);
    if (exists(candidate)) return candidate;
  }
  return shellLookup(name) ?? null;
}
/**
 * The absolute path of the program a command names (argv[0]), or null when it is installed nowhere Trillion looks:
 *   1. an absolute name is itself; 2. a PATH folder holds it; 3. a program_paths folder holds it; 4. the person's login
 *   shell finds it. With options ({ env, exists(path), shellLookup(name), folders }) it is pure; without them a found
 *   path is kept for this process.
 */
export function resolveProgram(name, options) {
  if (options) return findProgram(name, options);
  if (resolvedPrograms.has(name)) return resolvedPrograms.get(name);
  const program = findProgram(name);
  if (program) resolvedPrograms.set(name, program);
  return program;
}
/** Whether a settings row's program (its command's first word) is installed where Trillion looks. */
export const programReady = (row, locate = resolveProgram) => Boolean(locate(row.command[0]));
/** The words a program that is installed nowhere Trillion looks is shown with (words.program_missing_trouble). */
export const programMissingWords = (program, env = process.env) => fill(takerData.words.program_missing_trouble, { program, folders: foldersTried(env).join(', ') });
/** The environment a program Trillion starts gets: this one's, with PATH naming the folders above too, so a program that
 * starts another (a script run by `env node`) finds it as it would in a terminal. */
export const childEnv = (env = process.env) => ({ ...env, PATH: foldersTried(env).join(':') });

const bridgePath = settings => fileURLToPath(new URL(settings.work_mcp.bridge, import.meta.url));

/** Adds the authenticated Trillion MCP bridge to one AI command. The bridge reads the account key from Keychain itself;
 * no key is put in argv, a config file, the child environment or a log. The insertion point and arguments are DATA on
 * the AI row because different command-line hosts place their MCP arguments differently. */
export function withWorkMcp(job, command, settings, folder, options = {}) {
  if (!settings.work_mcp || !job.work_mcp) return command;
  const runtime = options.runtime ?? process.execPath;
  const bridge = options.bridge ?? bridgePath(settings);
  const safe = job.handoff_id.replace(/[^A-Za-z0-9_-]/g, '_');
  const config = join(folder, 'runs', `${safe}.mcp.json`);
  writeFileSync(config, JSON.stringify({ mcpServers: { trillion: { command: runtime, args: [bridge] } } }), { mode: 0o600 });
  const values = { mcp_config: config, runtime_toml: JSON.stringify(runtime), bridge_toml: JSON.stringify(bridge) };
  const added = job.work_mcp.args.map(part => fill(part, values));
  const at = job.work_mcp.insert_at;
  if (!Number.isInteger(at) || at < 1 || at > command.length) throw new Error(`Invalid work_mcp.insert_at for ${job.ai_id}.`);
  return [...command.slice(0, at), ...added, ...command.slice(at)];
}

/** Starts the same stdio bridge (account-mcp-bridge.mjs) the AI will receive and completes an MCP initialize round trip. */
export async function preflightTrillion(settings, { launch = spawn, runtime = process.execPath, bridge = bridgePath(settings) } = {}) {
  const timeoutMs = (settings.work_mcp?.preflight_timeout_seconds ?? 10) * 1000;
  return new Promise((resolve, reject) => {
    let child;
    try { child = launch(runtime, [bridge], { env: childEnv(), stdio: ['pipe', 'pipe', 'pipe'] }); }
    catch (error) { reject(error); return; }
    let settled = false, output = '';
    const finish = error => {
      if (settled) return;
      settled = true; clearTimeout(timer); child.kill?.('SIGTERM');
      if (error) reject(error); else resolve(true);
    };
    const timer = setTimeout(() => finish(new Error('Trillion MCP preflight timed out.')), timeoutMs);
    child.on?.('error', error => finish(error));
    child.on?.('close', code => { if (!settled) finish(new Error(`Trillion MCP preflight ended before initialize (exit ${code}).`)); });
    child.stdout?.on?.('data', chunk => {
      output += chunk.toString();
      const lineEnd = output.indexOf('\n');
      if (lineEnd < 0) return;
      let reply;
      try { reply = JSON.parse(output.slice(0, lineEnd)); } catch { finish(new Error('Trillion MCP preflight returned unreadable output.')); return; }
      if (reply?.id !== 'trillion-preflight' || reply.error || !reply.result) finish(new Error(reply?.error?.message ?? 'Trillion MCP initialize was refused.'));
      else finish();
    });
    child.stdin?.end(`${JSON.stringify({ jsonrpc: '2.0', id: 'trillion-preflight', method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'take-open-work-preflight', version: '1' } } })}\n`);
  });
}
// Why a task cannot be taken now, or null when it can: held by another AI, waiting on other work, or something an AI
// said stands in its way. Trillion's own waits (for a chat, for any AI to connect) are exactly what taking it ends.
export function notTakeable(item, nowIso, trillion) {
  if (item.state === 'taken' && !(item.hold_until && item.hold_until <= nowIso)) return 'being worked on';
  if (item.state !== 'open' && item.state !== 'taken') return 'being worked on';
  if (item.next_step?.kind === 'dependency') return 'waits for other work';
  if (item.in_the_way && item.in_the_way_by !== trillion) return 'something is in the way';
  return null;
}

// The person's chosen AI row ids in their order (settings.ai_order, else settings.use_ai).
const orderOf = settings => (settings.ai_order?.length ? settings.ai_order : settings.use_ai ? [settings.use_ai] : []);

/**
 * The AI row that runs work now: the first of the person's chosen AIs, in their order (settings.ai_order, else
 * settings.use_ai), that is not resting after reaching its usage limit (settings.resting: { row id: until ISO }).
 * When every chosen AI is resting, the first one (a run then waits for its limit to reset).
 * `runnable(row)` (optional) says whether a row's program is installed where Trillion looks: an AI that is not is passed
 * over for the next of the person's AIs, and when none is, the answer is null (nothing is claimed for an AI that cannot run).
 */
export function chosenAi(settings, now = new Date().toISOString(), runnable = () => true) {
  const order = orderOf(settings);
  if (!order.length) throw new Error(`No AI is chosen on this computer yet. Choose one with node harness/wake-sessions.mjs --choose-ai <${settings.ais.map(item => item.id).join(' | ')}>.`);
  for (const id of order) if (!settings.ais.some(item => item.id === id)) throw new Error(`The chosen AI "${id}" names no row in take-open-work.json ais.`);
  const rowOf = id => settings.ais.find(item => item.id === id);
  const awake = order.find(id => !(settings.resting?.[id] > now) && runnable(rowOf(id))) ?? order.find(id => runnable(rowOf(id)));
  return awake ? rowOf(awake) : null;
}

/** Keeps that an AI row rests until `until`, and why (<state>/resting.json { id: { until, because } }, read back by
 * readSettings, which also reads the older { id: until }). */
export function restAi(settings, id, until, because = null) {
  const path = join(home(settings.state_folder), 'resting.json');
  let resting = {};
  try { resting = JSON.parse(readFileSync(path, 'utf8')); } catch { /* none yet */ }
  mkdirSync(home(settings.state_folder), { recursive: true });
  writeFileSync(path, JSON.stringify({ ...resting, [id]: { until, because } }));
}

/** Keeps what went wrong with an AI row that did NOT make it rest (a run that could not start, one that timed out
 * with no usage limit in its words), or clears it with `what` null (<state>/trouble.json { id: { at, what } }). */
export function noteTrouble(settings, id, what, at = new Date().toISOString()) {
  const path = join(home(settings.state_folder), 'trouble.json');
  let trouble = {};
  try { trouble = JSON.parse(readFileSync(path, 'utf8')); } catch { /* none yet */ }
  if (what === null && !trouble[id]) return;
  if (what === null) delete trouble[id]; else trouble[id] = { at, what };
  mkdirSync(home(settings.state_folder), { recursive: true });
  writeFileSync(path, JSON.stringify(trouble));
}

// The wall clock in an IANA time zone at an instant: { year, month (1-12), day, hour, minute, second }. Throws for an unknown zone.
const zoneClock = (ms, zone) => {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone: zone, hourCycle: 'h23', year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric', second: 'numeric' })
    .formatToParts(new Date(ms)).map(part => [part.type, Number(part.value)]));
  return { year: parts.year, month: parts.month, day: parts.day, hour: parts.hour, minute: parts.minute, second: parts.second };
};
// The instant at which a zone's wall clock reads year/month (0-11)/day/hour/minute (Date.UTC carries a day or month past its end).
// The zone's offset is read at the guess and again at the corrected guess, so a time just past a clock change is still right.
const zoneInstant = ({ year, month, day, hour, minute }, zone) => {
  const wall = Date.UTC(year, month, day, hour, minute);
  let guess = wall;
  for (let round = 0; round < 2; round += 1) {
    const clock = zoneClock(guess, zone);
    guess = wall - (Date.UTC(clock.year, clock.month - 1, clock.day, clock.hour, clock.minute, clock.second) - guess);
  }
  return guess;
};

/** When an AI's usage-limit words say it resets (settings.limit_reset): the ISO instant of "resets Oct 13 at 7am
 * (America/Los_Angeles)", or of "resets 7am (America/Los_Angeles)" the next time that clock reads it; null when the words
 * name no (readable) reset, so the caller rests limit_rest_hours instead. */
export function limitResetAt(settings, words, nowMs) {
  const rule = settings.limit_reset;
  const found = rule && new RegExp(rule.pattern, 'i').exec(String(words ?? ''));
  if (!found) return null;
  const { month, day, hour, minute, meridiem, zone } = found.groups;
  if (Number(hour) < 1 || Number(hour) > 12) return null;
  const at = { hour: (Number(hour) % 12) + (meridiem.toLowerCase() === 'pm' ? 12 : 0), minute: Number(minute ?? 0) };
  try {
    const today = zoneClock(nowMs, zone);
    const named = month ? rule.months.indexOf(month.toLowerCase()) : today.month - 1;
    if (named < 0) return null;
    const first = { ...at, year: today.year, month: named, day: month ? Number(day) : today.day };
    let instant = zoneInstant(first, zone);
    // Already past: a dated reset is next year's, a bare time is tomorrow's.
    if (instant <= nowMs) instant = zoneInstant(month ? { ...first, year: first.year + 1 } : { ...first, day: first.day + 1 }, zone);
    return new Date(instant).toISOString();
  } catch { return null; /* an unknown time zone */ }
}

/** Until when an AI rests after its words said it reached its limit: the reset they name, else limit_rest_hours from now. */
export const restUntil = (settings, words, nowMs) => limitResetAt(settings, words, nowMs) ?? new Date(nowMs + settings.limit_rest_hours * 3_600_000).toISOString();

/** The data's `computer_args` applied: for each rule whose setting `values` (this computer's settings.json) has, its args
 * go right after that program's name in every AI, chat and triage model command. Pure; settings come back as given when no rule applies. */
export function withComputerArgs(settings, values) {
  const rules = (settings.computer_args ?? []).filter(rule => typeof values?.[rule.setting] === 'string' && values[rule.setting]);
  if (!rules.length) return settings;
  const given = Object.fromEntries(rules.map(rule => [rule.setting, home(values[rule.setting])]));
  const add = command => rules.reduce((argv, rule) => (argv[0] === rule.program ? [argv[0], ...rule.args.map(part => fill(part, given)), ...argv.slice(1)] : argv), command);
  return {
    ...settings,
    ais: settings.ais.map(row => ({ ...row, command: add(row.command) })),
    chats: settings.chats.map(row => ({ ...row, command: add(row.command), ...(row.retry_command ? { retry_command: add(row.retry_command) } : {}) })),
    ...(settings.triage ? { triage: { ...settings.triage, models: settings.triage.models.map(row => ({ ...row, command: add(row.command) })) } } : {}),
  };
}

/** Whether an AI run's words say it reached its usage limit (settings.limit_patterns, case-insensitive, per line); only a
 * run that failed is read this way, so work that merely talks about limits is never taken for one. */
export const reachedLimit = (settings, words) => (settings.limit_patterns ?? []).some(pattern => new RegExp(pattern, 'im').test(String(words ?? '')));

/** The chat row whose source_prefix starts this source id, with the session id after it. */
export function chatOf(settings, source_id) {
  const row = settings.chats.find(item => typeof source_id === 'string' && source_id.startsWith(item.source_prefix));
  return row ? { row, session: source_id.slice(row.source_prefix.length) } : null;
}

/**
 * What to start now. Pure.
 *   open:     the account's work (read-work-tree rows: handoff_id, state, status, to_agent, input, handed_at, hold_until)
 *   agents:   published agent cards ({ agent_id, takes_work, source_id })
 *   settings: take-open-work.json
 *   started:  Map handoff_id → local record ({ mode, source_id, ended_at })
 *   today:    runs started today;  running: runs alive now
 *   chats:    Map source_id → { cwd, idle, bytes } for chat sessions found on this computer
 *   agent_id: this computer's agent id;  computer: its name;  now: ISO time
 *   runnable(row): whether a settings row's program is installed where Trillion looks (default: every row is)
 * → { start: [{ handoff_id, mode, agent_id, command, cwd, prompt, source_id? }], left: { reason: count } }
 */
export function plan({ open, agents, settings, started, today, running, chats, agent_id, computer, now, triaged = null, runnable = () => true }) {
  // What the person said themselves (a share from their phone, their own message: priority at or above
  // src/inbound-words.json from_person) goes first and is never held by daily_cap, only by the free slots.
  const own = isOwnWork;
  const slots = Math.max(0, settings.max_concurrent - running);
  const room = Math.min(slots, Math.max(0, settings.daily_cap - today));
  const sourceOwners = new Map(agents.filter(card => card.takes_work && card.source_id).map(card => [card.source_id, card.agent_id]));
  const busyChats = new Set([...started.values()].filter(record => record.mode === 'chat' && !record.ended_at).map(record => record.source_id));
  // The AI that takes unnamed work now: the first chosen AI whose program is installed (null when none is).
  const ai = chosenAi(settings, now, runnable);
  const left = {};
  const leave = reason => { left[reason] = (left[reason] ?? 0) + 1; };
  const start = [];
  const ordered = [...open].sort(takingOrder);
  for (const item of ordered) {
    if (item.state === 'finished') continue;
    const why = notTakeable(item, now, settings.trillion_marks_as);
    if (why) { leave(why); continue; }
    if (started.has(item.handoff_id) && !started.get(item.handoff_id).limit_hit) { leave('already started here'); continue; }
    const source_id = item.input?.arrived?.source_id;
    // A task names its assignees (record ids of anyone; none means anyone may take it). A chat's work names one AI in to_agent.
    // With tasks.take_unassigned false (DATA), a task that names nobody is not this worker's: it is left for whoever it is
    // handed to, so only the tasks that name this worker's own id are taken.
    if (item.task && item.assignees.length === 0 && settings.tasks?.take_unassigned === false) { leave('handed to nobody'); continue; }
    const named = item.task ? item.assignees.length > 0 && !item.assignees.includes(agent_id) : Boolean(item.to_agent) && sourceOwners.get(source_id) !== item.to_agent;
    if (named) { leave('handed to a named agent'); continue; }
    // With a triage step (settings.triage, harness/triage-open-work.mjs), only work it sorted as real work is run.
    if (triaged && !own(item) && !item.input?.arrived?.from_person && !(item.to_agent && sourceOwners.get(source_id) === item.to_agent)
      && !String(item.from_agent ?? '').startsWith(settings.triage.agent_id_prefix)) {
      const verdict = triaged.get(item.handoff_id);
      const then = verdict && settings.triage.outcomes.find(row => row.id === verdict.outcome)?.then;
      if (then !== 'take') { leave(verdict ? 'triaged as not needing a run' : 'waits for triage'); continue; }
    }
    let job;
    if (typeof source_id === 'string' && source_id) {
      const chat = chatOf(settings, source_id);
      const found = chats.get(source_id);
      // Its chat's first turn is over and no chat took it (the account's anyone_from): any AI of the person's may.
      const anyone = typeof item.anyone_from === 'string' && item.anyone_from <= now;
      const resumable = chat && found && found.bytes <= settings.chat_largest_bytes;
      const why = !chat || !found ? 'waits for its own chat' : found.bytes > settings.chat_largest_bytes ? 'its chat is too long to resume'
        : !found.idle || busyChats.has(source_id) ? 'its chat is busy' : !runnable(chat.row) ? 'its AI is not installed here' : null;
      if (why && (item.to_agent || !(anyone && (!resumable || why === 'its chat is busy')))) { leave(why); continue; }
      if (!why) {
        const chat_agent_id = item.to_agent ?? fill(settings.chat_agent_id, { session: chat.session });
        const prompt = fill(settings.prompts.chat, { handoff_id: item.handoff_id, source_id, chat_agent_id, computer });
        job = { handoff_id: item.handoff_id, mode: 'chat', agent_id: chat_agent_id, source_id, cwd: found.cwd, prompt,
          command: chat.row.command.map(part => fill(part, { session: chat.session, prompt })), ai_id: chat.row.id, work_mcp: chat.row.work_mcp };
      }
    }
    if (!job) {
      if (!ai) { leave('no chosen AI is installed here'); continue; }
      const prompt = fill(item.task ? settings.prompts.task : settings.prompts.claim, { handoff_id: item.handoff_id, agent_id, computer, take_tool: settings.tasks?.take_tool, move_tool: settings.tasks?.move_tool, finish_tool: settings.tasks?.finish_tool, continuation: item.continuation ? JSON.stringify(item.continuation) : 'none', do: item.asks?.do ?? requestedOutcome(item) ?? '', submit: JSON.stringify(item.asks?.submit ?? null), result_file: resultFileOf(settings, item.handoff_id) });
      job = { handoff_id: item.handoff_id, mode: 'claim', agent_id, cwd: home(settings.working_folder), prompt,
        command: ai.command.map(part => fill(part, { prompt })), ai_id: ai.id, work_mcp: ai.work_mcp };
    }
    if (start.length >= (own(item) ? slots : room)) { leave(!own(item) && settings.daily_cap - today <= 0 ? 'daily cap reached' : 'no free slot now'); continue; }
    if (item.task) job.job_contract = taskContract(item, settings);
    job.own = own(item);
    start.push(job);
    if (job.mode === 'chat') busyChats.add(source_id);
  }
  return { start, left };
}

/** What the triage step sorted here: Map handoff_id → { outcome, then, reason } (harness/triage-open-work.mjs writes it). */
export function readTriaged(folder) {
  const dir = join(folder, 'triaged');
  const found = new Map();
  let names = [];
  try { names = readdirSync(dir); } catch { return found; }
  for (const name of names) {
    if (!name.endsWith('.json')) continue;
    try { const record = JSON.parse(readFileSync(join(dir, name), 'utf8')); found.set(record.handoff_id, record); } catch { /* being written */ }
  }
  return found;
}

/** Local records of what was started here: one file per handoff, created exclusively. */
export function startedRecords(folder) {
  const dir = join(folder, 'started');
  mkdirSync(dir, { recursive: true });
  const path = id => {
    const encoded = join(dir, `${encodeURIComponent(id)}.json`);
    const legacy = join(dir, `${id.replace(/[^A-Za-z0-9_-]/g, '_')}.json`);
    try { if (JSON.parse(readFileSync(legacy, 'utf8')).handoff_id === id) return legacy; } catch { /* no matching older receipt */ }
    return encoded;
  };
  return {
    all() {
      const found = new Map();
      for (const name of readdirSync(dir)) {
        if (!name.endsWith('.json')) continue;
        try { const record = JSON.parse(readFileSync(join(dir, name), 'utf8')); found.set(record.handoff_id, record); } catch { /* a record being written */ }
      }
      return found;
    },
    history() {
      return readdirSync(dir).filter(name => name.endsWith('.history')).flatMap(name => { try { return [JSON.parse(readFileSync(join(dir, name), 'utf8'))]; } catch { return []; } });
    },
    // Exclusive create: false when this computer already started (or is starting) that handoff.
    claim(record) {
      let fd;
      try { fd = openSync(path(record.handoff_id), 'wx'); } catch { return false; }
      writeFileSync(fd, JSON.stringify(record));
      closeSync(fd);
      return true;
    },
    update(id, change) {
      const record = { ...JSON.parse(readFileSync(path(id), 'utf8')), ...change };
      writeFileSync(path(id), JSON.stringify(record));
      return record;
    },
    rearm(id) {
      const earlier = JSON.parse(readFileSync(path(id), 'utf8'));
      if (!earlier.ended_at) return null;
      const attempt = earlier.attempt ?? 1;
      renameSync(path(id), `${path(id)}.attempt-${attempt}.history`);
      return attempt + 1;
    },
  };
}

// How long a task may sit between its local record and its process before it counts as lost.
const STARTING_MS = 5 * 60_000;
const alive = pid => { try { process.kill(pid, 0); return true; } catch { return false; } };
// A chat's kept file can be larger than one string may be (a long Codex or Claude session passes 512 MB, and reading it
// whole threw "Cannot create a string longer than 0x1fffffe8 characters", so no waiting work ever started). Lines are
// read a block at a time until `take` says it has what it needs.
const BLOCK_BYTES = 1 << 20;
export function eachLine(file, take) {
  const fd = openSync(file, 'r');
  try {
    const block = Buffer.alloc(BLOCK_BYTES);
    let rest = '';
    for (let at = 0; ;) {
      const read = readSync(fd, block, 0, BLOCK_BYTES, at);
      at += read;
      const lines = (rest + block.toString('utf8', 0, read)).split('\n');
      rest = read ? lines.pop() : '';
      for (const line of lines) if (take(line)) return;
      if (!read) return;
    }
  } finally { closeSync(fd); }
}

// The last `bytes` of a file as text, without reading the rest.
export function tailOf(file, bytes) {
  const size = statSync(file).size;
  const fd = openSync(file, 'r');
  try {
    const block = Buffer.alloc(Math.min(bytes, size));
    const read = readSync(fd, block, 0, block.length, size - block.length);
    return block.toString('utf8', 0, read);
  } finally { closeSync(fd); }
}

const localDay = iso => { const at = new Date(iso); return `${at.getFullYear()}-${at.getMonth() + 1}-${at.getDate()}`; };

/** Where each chat named by the open work lives on this computer, and whether it has been idle long enough. */
export function findChats(settings, sourceIds, nowMs) {
  const found = new Map();
  for (const source_id of sourceIds) {
    const chat = chatOf(settings, source_id);
    if (!chat) continue;
    const pattern = home(fill(chat.row.session_file, { session: chat.session }));
    const file = matchFiles(pattern)[0];
    if (!file) continue;
    let cwd = null;
    eachLine(file, line => {
      if (!line.trim()) return false;
      let row;
      try { row = JSON.parse(line); } catch { return false; }
      const value = chat.row.working_folder_at.reduce((at, key) => (at && typeof at === 'object' ? at[key] : undefined), row);
      if (typeof value === 'string' && value) { cwd = value; return true; }
      return false;
    });
    if (!cwd) continue;
    const kept = statSync(file);
    found.set(source_id, { cwd, idle: nowMs - kept.mtimeMs >= settings.chat_idle_minutes * 60_000, bytes: kept.size });
  }
  return found;
}

// A path pattern where each "*" matches within one folder name.
export function matchFiles(pattern) {
  const parts = pattern.split('/').filter(Boolean);
  let paths = ['/'];
  for (const part of parts) {
    const next = [];
    const test = part.includes('*') ? new RegExp(`^${part.split('*').map(text => text.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('.*')}$`) : null;
    for (const at of paths) {
      if (!test) { next.push(join(at, part)); continue; }
      let names = [];
      try { names = readdirSync(at); } catch { continue; }
      for (const name of names) if (test.test(name)) next.push(join(at, name));
    }
    paths = next;
  }
  return paths.filter(path => { try { return statSync(path).isFile(); } catch { return false; } });
}

// Whether two acceptances name the same outcome, target and rules, whatever the order their keys were stored in.
const canonical = value => (Array.isArray(value) ? value.map(canonical) : value && typeof value === 'object' ? Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])])) : value);
const sameAcceptance = (saved, wanted) => Boolean(saved) && JSON.stringify(canonical(saved)) === JSON.stringify(canonical(wanted));

/**
 * Finishes a task run from its result file: the answer is checked against the step's submit shape (asks.submit) and refused
 * when it names a keyword this computer does not check or when the task names checks (asks.checks, not evaluated here). The
 * answer is recorded on the task, the acceptance saved (one rule: the answer is present), and the task finished against that
 * acceptance. Resolves null when the task is finished; otherwise the reason it was not, which the caller gives the task back with.
 */
export async function finishFromAnswer(call, settings, { job, read, logPath, at = new Date() }) {
  const words = settings.words;
  const file = resultFileOf(settings, job.handoff_id);
  let written = null;
  try { written = JSON.parse(readFileSync(file, 'utf8')); } catch { /* no readable result */ }
  const evidence = written?.evidence;
  if (!written || typeof written !== 'object' || Array.isArray(written) || typeof evidence !== 'string' || !evidence.trim()) return fill(words.answer_missing, { log: logPath });
  if (written.result === null || written.result === undefined) return fill(words.answer_refused, { why: evidence.trim().slice(0, 400) });
  if (!read.asks?.submit) return fill(words.answer_refused, { why: 'the task names no submit shape to check the answer against' });
  if (Array.isArray(read.asks.checks) && read.asks.checks.length) return fill(words.answer_refused, { why: 'the task names checks, which this computer does not evaluate' });
  let issue;
  try { issue = answerIssue(written.result, read.asks.submit); }
  catch (error) { if (error instanceof UnsupportedSchema) return fill(words.answer_refused, { why: error.message }); throw error; }
  if (issue) return fill(words.answer_refused, { why: issue });
  const outcome = requestedOutcome(read);
  if (!outcome) return fill(words.answer_refused, { why: 'the task names no outcome to check against' });
  const target = { type: settings.tasks.kind, id: job.handoff_id };
  const acceptance = { outcome, target, rules: [{ id: 'outcome', path: 'answer', required: true }] };
  const check = { target, outcome, checked_at: at.toISOString(), evidence: [{ ref: file, observation: evidence.trim().slice(0, 2000) }], obligations: [] };
  try {
    await call('/handoffs/answer', { handoff_id: job.handoff_id, answer: written.result });
    // A retry finds the acceptance an earlier attempt saved; a different saved acceptance is never replaced (the shared plan refuses it).
    if (!sameAcceptance(read.acceptance, acceptance)) await call('/handoffs/plan', { handoff_id: job.handoff_id, agent_id: job.agent_id, taken_at: job.taken_at, acceptance });
    await call('/handoffs/finish', { handoff_id: job.handoff_id, agent_id: job.agent_id, taken_at: job.taken_at, result: JSON.stringify(written.result), check });
  } catch (error) {
    return fill(words.answer_not_finished, { why: error?.message ?? String(error) });
  }
  return null;
}

/**
 * One pass: read the account's open work, plan, claim, start runs. → { agent_id, started: [...], left, runs: [Promise] }
 *   call(path, body) → the account's /mcp/api answer;  computer: this computer's name
 */
// `listed` (optional) is the open work already read this pass ({ work, agents }, listOpenWork), less what sorting closed.
// `locate` (optional, default resolveProgram) finds a command's program: an AI whose program it cannot find is not claimed
// for or run, and its card says so (see the invariant 7 above).
export async function runPass({ settings, call, computer, log = () => {}, now = () => new Date(), spawnRun = spawn, knownAgents = null, onlyHandoffId = null, alreadyPublished = false, listed = null, locate = resolveProgram, checkConnection = preflightTrillion }) {
  const folder = home(settings.state_folder);
  const records = startedRecords(folder);
  const ai = chosenAi(settings);
  const agent_id = `${call.tasks ? 'ai:' : ''}${takerCard(settings, computer).agent_id}`;
  const nowIso = now().toISOString();
  // A transport loss may hide a still-running atomic take. Recover its original request key before deciding
  // whether this task was claimed; a fresh key could take it twice after a release or strand a late claim.
  for (const record of records.all().values()) {
    if (!record.claim_pending) continue;
    try {
      const taken = await call('/handoffs/take', { agent_id: record.agent_id, handoff_id: record.handoff_id, request_key: record.request_key });
      const released = !taken.handoff || await releaseHeld(call, settings, { ...record, taken_at: taken.handoff.taken_at });
      records.update(record.handoff_id, { claim_pending: false, ended_at: nowIso, release_pending: !released, ...(released ? { released_at: nowIso } : {}) });
    } catch { log({ did: 'claim recovery pending', handoff_id: record.handoff_id }); }
  }
  // Recover orphaned claims before listing the backlog: a large account may fail
  // that read while these dead runs still occupy every available slot.
  for (const record of records.all().values()) {
    if (!record.ended_at && !record.claim_pending && (record.pid ? !alive(record.pid) : now().getTime() - Date.parse(record.started_at) > STARTING_MS))
      records.update(record.handoff_id, { ended_at: nowIso, lost: true });
  }
  for (const record of records.all().values()) {
    if ((!record.lost && !record.release_pending) || (record.released_at && !record.release_pending) || record.mode !== 'claim') continue;
    if (await releaseHeld(call, settings, record, record.recovery_because)) {
      records.update(record.handoff_id, { released_at: nowIso, release_pending: false, final_read_pending: false });
      log({ did: record.lost ? 'released lost run' : 'released pending run', handoff_id: record.handoff_id });
    } else records.update(record.handoff_id, { release_pending: true });
  }
  const open = [];
  const listedCards = new Map();
  let listedAgents = [];
  let after = null;
  // One announced task is read by its id, never by listing every open task (2026-10-07: each announced chat task listed
  // all 3,646 open tasks, 73 pages, about three page calls a second on the busiest account). A chat's task is given back
  // to its chat by the agent cards, which the first page of open work carries; one page is read for them only when
  // the caller has none.
  const named = onlyHandoffId ? (await call('/handoffs/read', { handoff_id: onlyHandoffId })).handoff : null;
  if (onlyHandoffId) {
    if (named) open.push(named);
    if (named?.input?.arrived?.source_id && !(Array.isArray(knownAgents) && knownAgents.length)) {
      const first = await call('/handoffs/open-page', { limit: 1, agent_scope: 'work', handoff_id: onlyHandoffId });
      if (!Array.isArray(first?.agents)) throw new Error('The account did not return its agents.');
      listedAgents = first.agents;
    }
  } else if (listed) {
    open.push(...listed.work);
    listedAgents = listed.agents;
  } else do {
    const page = await readPage(call, { after, limit: 50, agent_scope: 'work' }, { backoff_seconds: settings.page_retry?.backoff_seconds });
    if (!Array.isArray(page?.work) || !Array.isArray(page.agents)) throw new Error('The account did not return its open work.');
    open.push(...page.work);
    for (const card of page.agents) listedCards.set(card.agent_id, card);
    listedAgents = [...listedCards.values()];
    after = page.next_after ?? null;
  } while (after);
  const selected = onlyHandoffId ? open.filter(item => item.handoff_id === onlyHandoffId) : open;
  const agents = Array.isArray(knownAgents) && knownAgents.length ? knownAgents : listedAgents;
  const started = records.all();
  // An older helper could leave an ended source-chat run held and blocked by its
  // own error report. Give that exact attempt back; its local retry count remains.
  for (const item of selected) {
    const record = started.get(item.handoff_id);
    if (item.state !== 'taken' || record?.mode !== 'chat' || !record.ended_at) continue;
    try {
      const current = (await call('/handoffs/read', { handoff_id: item.handoff_id })).handoff;
      if (current?.taken_by !== record.agent_id || !current.in_the_way?.includes(record.log)
        || Date.parse(current.taken_at) > Date.parse(record.ended_at)) continue;
      await call('/handoffs/in-the-way', { handoff_id: item.handoff_id, agent_id: record.agent_id,
        generation: current.generation, in_the_way: null });
      await call('/handoffs/release', { handoff_id: item.handoff_id, agent_id: record.agent_id,
        generation: current.generation, because: `The source chat run ended; its log is ${record.log}.` });
      item.state = 'open'; item.in_the_way = null; item.taken_by = null;
    } catch { /* A newer holder wins; the next account read decides. */ }
  }
  const nowMs = now().getTime();
  const retryAfterMinutes = settings.retry_unfinished_minutes ?? [0, 1, 5];
  const attempts = new Map();
  const executions = new Map();
  for (const item of selected) {
    if (item.state !== 'open' && !(call.tasks && item.state === 'taken')) continue;
    const record = started.get(item.handoff_id);
    const attempt = record?.attempt ?? 1;
    const reviewed = call.tasks && (record?.executor_starts ?? 0) >= settings.tasks.max_attempts
      && typeof item.resumed?.words === 'string' && item.resumed.words.trim()
      && Date.parse(item.resumed.at) > Date.parse(record.ended_at);
    const revised = reviewed || record?.job_contract && JSON.stringify(record.job_contract) !== JSON.stringify(taskContract(item, settings));
    if (call.tasks && (record?.executor_starts ?? 0) >= settings.tasks.max_attempts && !revised) {
      if (item.state === 'open' && item.continuation?.owner === agent_id) {
        try { await call('/handoffs/release', { handoff_id: item.handoff_id, agent_id, taken_at: record.taken_at, because: settings.tasks.review_action, park: true }); } catch { /* The next pass retains the cap and retries the canonical park. */ }
      }
      continue;
    }
    if (record?.claim_pending || record?.release_pending || !record?.ended_at || (!call.tasks && attempt >= retryAfterMinutes.length) || nowMs - Date.parse(record.ended_at) < retryAfterMinutes[Math.min(attempt, retryAfterMinutes.length - 1)] * 60_000) continue;
    if (record.parked && record.parked_move === item.last_move?.key) continue;
    executions.set(item.handoff_id, revised ? 0 : record.executor_starts ?? (record.pid ? attempt : 0));
    attempts.set(item.handoff_id, revised ? 1 : attempt + 1);
  }
  // Jobs stopped while the account was busy are released as soon as it answers again.
  for (const record of started.values()) {
    if (!record.release_pending) continue;
    if (await releaseHeld(call, settings, record)) { records.update(record.handoff_id, { release_pending: false, released_at: nowIso }); log({ did: 'released', handoff_id: record.handoff_id }); }
  }
  const current = records.all();
  // The person's own words are not counted toward daily_cap (plan), so their runs are not counted here either.
  const today = [...current.values(), ...records.history()].filter(record => record.pid && !record.own && localDay(record.started_at) === localDay(nowIso)).length;
  const running = [...current.values()].filter(record => !record.ended_at || record.claim_pending).length;
  const chats = findChats(settings, new Set(selected.map(item => item.input?.arrived?.source_id).filter(Boolean)), now().getTime());
  // What the triage step (harness/triage-open-work.mjs) sorted, when this computer sorts work before running it.
  const triaged = settings.triage && !call.tasks ? readTriaged(folder) : null;
  // An AI whose program is not installed where Trillion looks is neither claimed for nor run. Its trouble says which program
  // and the folders tried (words.program_missing_trouble), the card shows it, and it clears once the program is found.
  const runnable = row => programReady(row, locate);
  const card = () => ({ ...takerCard(settings, computer, now().toISOString(), runnable), agent_id });
  const republish = () => call('/agents/publish', card()).catch(() => {});
  const trouble = (ai_id, what) => {
    noteTrouble(settings, ai_id, what, now().toISOString());
    settings.trouble = Object.fromEntries(Object.entries(settings.trouble ?? {}).filter(([id]) => id !== ai_id).concat(what === null ? [] : [[ai_id, { at: now().toISOString(), what }]]));
  };
  let programChanged = false;
  for (const id of orderOf(settings)) {
    const row = settings.ais.find(item => item.id === id);
    if (!row) continue;
    const words = programMissingWords(row.command[0]);
    const had = settings.trouble?.[id]?.what === words;
    if (!runnable(row) && !had) { trouble(id, words); programChanged = true; }
    else if (runnable(row) && had) { trouble(id, null); programChanged = true; }
  }
  if (programChanged) await republish();
  const planned = plan({ open: selected, agents, settings, started: new Map([...current].filter(([id]) => !attempts.has(id))), today, running, chats, agent_id, computer, now: nowIso, triaged, runnable });
  log({ did: 'planned', open: selected.length, starting: planned.start.map(job => job.handoff_id), left: planned.left });
  if (!alreadyPublished && planned.start.some(job => job.mode === 'claim')) {
    await call('/agents/publish', card());
  }
  const runs = [];
  const begun = [];
  // Whatever rests an AI or goes wrong with it is shown in Trillion at once: the taker's card is published again with it
  // (takerCard), and a failed publish is left to the next pass, which publishes whatever is then true.
  const rest = (ai_id, until, because) => {
    restAi(settings, ai_id, until, because);
    settings.resting = { ...settings.resting, [ai_id]: until };
    settings.resting_because = { ...settings.resting_because, [ai_id]: because };
    log({ did: 'rested', ai: ai_id, until, because });
  };
  // A run that could not start (the system refused, or its program went missing): the task is given back, the AI does not
  // rest (nothing says its budget is spent), and why is on the card (`what`, the words the card shows).
  const failedToStart = async (job, error, what = fill(settings.words.start_failed_trouble, { error: error?.message ?? error })) => {
    trouble(job.ai_id, what);
    records.update(job.handoff_id, { ended_at: now().toISOString(), code: null, start_failed: what });
    const released = await releaseHeld(call, settings, job, fill(settings.words.released_start_failed, { ai: job.ai_id, error: error?.message ?? error }));
    if (!released) records.update(job.handoff_id, { release_pending: true });
    log({ did: 'AI could not start', ai: job.ai_id, handoff_id: job.handoff_id, error: String(error?.message ?? error), released });
    await republish();
    return { handoff_id: job.handoff_id, code: null, finished: false, started: false, released };
  };
  let connectionChecked = null;
  for (const job of planned.start) {
    job.attempt = attempts.get(job.handoff_id) ?? 1;
    job.executor_starts = executions.get(job.handoff_id) ?? 0;
    // A later attempt may need a larger context/model for the same exact chat.
    // The choice is data on that chat row; the handoff and session IDs stay fixed.
    const chat = job.mode === 'chat' ? chatOf(settings, job.source_id) : null;
    if ((attempts.get(job.handoff_id) ?? 1) > 1 && chat?.row.retry_command) {
      job.command = chat.row.retry_command.map(part => fill(part, { session: chat.session, prompt: job.prompt }));
    }
    // The program is found by the same rule as the planning (resolveProgram); one that went missing since is a wall too.
    const program = locate(job.command[0]);
    if (!program) {
      const what = programMissingWords(job.command[0]); trouble(job.ai_id, what); await republish();
      log({ did: 'AI could not start', ai: job.ai_id, handoff_id: job.handoff_id, error: what, released: true });
      continue;
    }
    // One successful initialize proves the exact bridge all runs in this pass receive. This happens before the local
    // record and before /handoffs/take, so an authentication failure cannot consume a slot or hold a task.
    if (settings.work_mcp) {
      connectionChecked ??= Promise.resolve().then(() => checkConnection(settings));
      try { await connectionChecked; }
      catch (error) {
        const what = fill(settings.words.mcp_unavailable_trouble, { error: error?.message ?? error });
        trouble(job.ai_id, what); await republish();
        log({ did: 'Trillion MCP unavailable before claim', ai: job.ai_id, handoff_id: job.handoff_id, error: String(error?.message ?? error) });
        continue;
      }
    }
    if (attempts.has(job.handoff_id) && records.all().has(job.handoff_id)) {
      try { records.rearm(job.handoff_id); } catch { log({ did: 'already starting here', handoff_id: job.handoff_id }); continue; }
    }
    if (!records.claim({ handoff_id: job.handoff_id, mode: job.mode, source_id: job.source_id ?? null, agent_id: job.agent_id, started_at: nowIso, attempt: attempts.get(job.handoff_id) ?? 1, request_key: randomUUID(), ...(job.job_contract ? { job_contract: job.job_contract } : {}), executor_starts: job.executor_starts, ...(job.own ? { own: true } : {}) })) { log({ did: 'already started here', handoff_id: job.handoff_id }); continue; }
    if (job.mode === 'claim') {
      let taken;
      try { taken = await call('/handoffs/take', { agent_id, handoff_id: job.handoff_id, ...(call.tasks ? { request_key: records.all().get(job.handoff_id).request_key } : {}) }); }
      catch (error) {
        records.update(job.handoff_id, { ended_at: nowIso, refused: error.message, ...(call.tasks && !error.refused ? { claim_pending: true } : {}) });
        log({ did: 'not taken', handoff_id: job.handoff_id, note: error.message });
        continue;
      }
      if (!taken.handoff) { records.update(job.handoff_id, { ended_at: nowIso, refused: taken.note ?? 'not taken' }); log({ did: 'not taken', handoff_id: job.handoff_id, note: taken.note }); continue; }
      if (call.tasks) { job.taken_at = taken.handoff.taken_at; job.prompt = fill(job.prompt, { taken_at: job.taken_at }); records.update(job.handoff_id, { taken_at: job.taken_at }); }
    }
    const logPath = join(folder, 'runs', `${call.tasks ? encodeURIComponent(job.handoff_id) : job.handoff_id}.log`);
    mkdirSync(join(folder, 'runs'), { recursive: true });
    try { job.command = withWorkMcp(job, job.command, settings, folder); }
    catch (error) { runs.push(failedToStart(job, error)); continue; }
    if (call.tasks) { mkdirSync(join(folder, 'results'), { recursive: true }); try { unlinkSync(resultFileOf(settings, job.handoff_id)); } catch { /* none from an earlier run */ } }
    const out = openSync(logPath, 'a');
    let child;
    try { child = spawnRun(program, job.command.slice(1), { cwd: job.cwd, env: childEnv(), stdio: ['ignore', out, out] }); } catch (error) {
      closeSync(out);
      runs.push(failedToStart(job, error));
      continue;
    }
    closeSync(out);
    // A program that cannot be started (not found) never gets a pid: the error comes as an event, then it closes.
    let startError = null;
    if (child.pid) job.executor_starts += 1;
    records.update(job.handoff_id, { pid: child.pid, log: logPath, executor_starts: job.executor_starts });
    log({ did: 'started', handoff_id: job.handoff_id, mode: job.mode, pid: child.pid });
    begun.push(job.handoff_id);
    // While the run is alive the account is looked at every busy.check_every_seconds; when it keeps answering busy
    // (busy.tries checks in a row, each already sent again on busy.backoff_seconds), the run is stopped and the task
    // released at once, so an AI never burns its budget against an account that cannot answer it.
    let busyChecks = 0;
    let stoppedBusy = false;
    let stoppedTimeout = false;
    let checking = false;
    let stoppedClaim = false;
    const deadline = setTimeout(() => {
      stoppedTimeout = true;
      log({ did: 'stopped, AI run timed out', handoff_id: job.handoff_id, pid: child.pid });
      child.kill('SIGTERM');
    }, (settings.run_timeout_minutes ?? 30) * 60_000);
    const watch = setInterval(async () => {
      if (checking) return;
      checking = true;
      try {
        const current = (await call('/handoffs/read', { handoff_id: job.handoff_id }))?.handoff;
        busyChecks = 0;
        if (call.tasks && !stoppedClaim && (!current || current.state !== 'taken'
          || current.taken_by !== job.agent_id || current.taken_at !== job.taken_at)) {
          stoppedClaim = true;
          log({ did: 'stopped, claim ended or changed', handoff_id: job.handoff_id, pid: child.pid });
          child.kill('SIGTERM');
        }
      } catch (error) {
        if (!isBusy(error)) return;
        busyChecks += 1;
        if (busyChecks >= settings.busy.tries && !stoppedBusy) { stoppedBusy = true; log({ did: 'stopped, account busy', handoff_id: job.handoff_id, pid: child.pid }); child.kill('SIGTERM'); }
      } finally { checking = false; }
    }, settings.busy.check_every_seconds * 1000);
    watch.unref?.();
    runs.push(new Promise(resolve => {
      child.on('close', code => resolve(code));
      child.on('error', error => { if (!child.pid) { startError = error; resolve(null); } });
    }).then(async code => {
      clearTimeout(deadline);
      clearInterval(watch);
      if (startError) return failedToStart(job, startError);
      records.update(job.handoff_id, { ended_at: now().toISOString(), code, ...(stoppedBusy ? { stopped_busy: true } : {}), ...(stoppedTimeout ? { stopped_timeout: true } : {}) });
      let said = '';
      try { said = tailOf(logPath, 20000); } catch { /* no words kept */ }
      // A line of the run's words that says it reached its limit, for the reason shown beside the rest.
      const limitLine = () => (said.split('\n').find(line => reachedLimit(settings, line)) ?? '').trim().slice(0, 200);
      // A run that timed out is NOT a reason to rest its AI (2026-10-08: Codex was rested 6h for a timeout caused by
      // the Trillion account erroring, not by Codex): it rests only when its own words say it reached its limit, until
      // the reset they name. Otherwise why it was stopped is kept and shown on the card.
      if (stoppedTimeout) {
        const limited = reachedLimit(settings, said);
        if (limited) rest(job.ai_id, restUntil(settings, said, now().getTime()), fill(settings.words.rested_because, { said: limitLine() }));
        else trouble(job.ai_id, fill(settings.words.timed_out_trouble, { minutes: settings.run_timeout_minutes ?? 30 }));
        const released = await releaseHeld(call, settings, job, limited
          ? fill(settings.words.released_limit, { ai: job.ai_id, until: settings.resting[job.ai_id] })
          : fill(settings.words.released_timeout, { minutes: settings.run_timeout_minutes ?? 30, log: logPath, computer }));
        if (!released) records.update(job.handoff_id, { release_pending: true });
        log({ did: released ? 'released timed out run' : 'timed out run awaits release', handoff_id: job.handoff_id, ai: job.ai_id, rested: limited });
        await republish();
        return { handoff_id: job.handoff_id, code, finished: false, timeout: true, released };
      }
      if (stoppedBusy) {
        const released = await releaseHeld(call, settings, job);
        if (!released) records.update(job.handoff_id, { release_pending: true });
        log({ did: released ? 'released' : 'release waits for the account', handoff_id: job.handoff_id, code });
        return { handoff_id: job.handoff_id, code, finished: false, released };
      }
      // An AI that reached its usage limit rests until the reset its words name (limit_reset; else limit_rest_hours from
      // now); its task is given back and planned again, and the next of the person's chosen AIs runs work meanwhile (chosenAi).
      if (code !== 0 && reachedLimit(settings, said)) {
        rest(job.ai_id, restUntil(settings, said, now().getTime()), fill(settings.words.rested_because, { said: limitLine() }));
        const released = await releaseHeld(call, settings, job, fill(settings.words.released_limit, { ai: job.ai_id, until: settings.resting[job.ai_id] }));
        records.update(job.handoff_id, { limit_hit: true, ...(released ? {} : { release_pending: true }) });
        log({ did: 'AI reached its usage limit', ai: job.ai_id, handoff_id: job.handoff_id, released });
        await republish();
        return { handoff_id: job.handoff_id, code, finished: false, limit: true };
      }
      let read;
      try { read = (await call('/handoffs/read', { handoff_id: job.handoff_id }))?.handoff; }
      catch (error) {
        // Process exit says nothing about the persisted claim. Keep its exact take for recovery before the next
        // backlog read, even though this local process has ended; never turn an unavailable read into lost ownership.
        records.update(job.handoff_id, { final_read_pending: true, release_pending: true, recovery_because: fill(settings.words.not_finished, { code, log: logPath, computer }) });
        log({ did: 'final job read awaits recovery', handoff_id: job.handoff_id, error: String(error?.message ?? error) });
      }
      // A task run is finished by this computer from the result file the run wrote, checked against the step's submit shape
      // (finishFromAnswer). The run never finishes its own task. A refusal gives the task back with its reason.
      let refusal = null;
      if (call.tasks && code === 0 && read?.state === 'taken' && read.taken_by === job.agent_id) {
        refusal = await finishFromAnswer(call, settings, { job, read, logPath, at: now() });
        if (refusal === null) read = (await call('/handoffs/read', { handoff_id: job.handoff_id }))?.handoff;
      }
      const finished = read?.state === 'finished';
      let released = false;
      if (!finished && read?.state === 'taken' && read.taken_by === job.agent_id) {
        released = await releaseHeld(call, settings, job, refusal ?? fill(settings.words.not_finished, { code, log: logPath, computer }));
        if (!released) records.update(job.handoff_id, { release_pending: true });
      }
      if (call.tasks && !finished && job.executor_starts >= settings.tasks.max_attempts && read?.state === 'open' && read.continuation?.owner === job.agent_id) {
        try { await call('/handoffs/release', { handoff_id: job.handoff_id, agent_id: job.agent_id, taken_at: job.taken_at, because: settings.tasks.review_action, park: true }); }
        catch { records.update(job.handoff_id, { review_pending: true }); }
      }
      // A run that finished its task shows its AI works: an earlier failure to start or timeout leaves the card.
      if (finished && settings.trouble?.[job.ai_id]) { trouble(job.ai_id, null); await republish(); }
      log({ did: finished ? 'finished' : 'ended unfinished', handoff_id: job.handoff_id, code, summary: read?.summary ?? null });
      return { handoff_id: job.handoff_id, code, finished, ...(!finished ? { released } : {}) };
    }));
  }
  return { agent_id, started: begun, left: planned.left, runs };
}

// The rows here, with the AI the person chose from the helper's own settings (one place the choice is kept).
/** Whether an error is the account saying it is busy (it answered, and asked to be sent again). */
export const isBusy = error => Boolean(error?.busy);

/** Gives back a task this computer's run held, so the next AI can take it at once (`because` is what the task then says;
 * the busy account's words when none is given). → true when the account took it back. */
export async function releaseHeld(call, settings, job, because = settings.words.released_busy) {
  try {
    // A task recovery belongs to the original take, not whichever claim the latest read happens to show.
    // Missing local evidence stays pending for review; borrowing a fresh timestamp would authorize another run's release.
    if (call.tasks && (typeof job.taken_at !== 'string' || !Number.isFinite(Date.parse(job.taken_at)))) return false;
    const answer = await call('/handoffs/read', { handoff_id: job.handoff_id });
    const read = answer?.handoff;
    if (call.tasks) {
      if (!answer || !Object.hasOwn(answer, 'handoff')) return false;
      if (read === null) return true; // An explicit absent target, rather than an unavailable read.
      if (!read || (!Object.values(settings.tasks.worker_states).includes(read.state) && !['open', 'finished'].includes(read.state))) return false;
      if (read.state === 'taken' && (typeof read.taken_by !== 'string' || typeof read.taken_at !== 'string' || !Number.isFinite(Date.parse(read.taken_at)))) return false;
    }
    if (read?.state !== 'taken' || read.taken_by !== job.agent_id || (job.taken_at && read.taken_at !== job.taken_at)) return true;
    await call('/handoffs/release', { handoff_id: job.handoff_id, agent_id: job.agent_id, generation: read.generation, because, ...(call.tasks ? { taken_at: job.taken_at } : {}), ...(call.tasks && (job.executor_starts ?? 0) >= settings.tasks.max_attempts ? { park: true } : {}) });
    return true;
  } catch { return false; }
}

export function readSettings() {
  // This computer's own settings (settings.json) add arguments to commands (computer_args) before anything runs.
  const settings = withComputerArgs(JSON.parse(readFileSync(new URL('./take-open-work.json', import.meta.url), 'utf8')), computerSettings());
  const kept = name => { try { return JSON.parse(readFileSync(join(home(settings.state_folder), name), 'utf8')); } catch { return {}; } };
  // resting.json holds { id: { until, because } }, or the older { id: until }.
  const rows = Object.entries(kept('resting.json'));
  const resting = Object.fromEntries(rows.map(([id, row]) => [id, typeof row === 'string' ? row : row?.until]));
  const resting_because = Object.fromEntries(rows.filter(([, row]) => row?.because).map(([id, row]) => [id, row.because]));
  return { ...settings, tasks_store: computerSettings().tasks_store ?? null, use_ai: chosenAiOnThisComputer(), ai_order: aiOrder(), resting, resting_because, trouble: kept('trouble.json') };
}

// The worker keeps scheduling/attempt receipts only. The shared task owner (tools/plan-tasks-and-todo-lists) remains the
// only queue and the only authority for claims and transitions: each tool runs over the records it names, and the writes
// it answers are kept by run-a-task-move.mjs, each conditioned on the value it was read at. This transport adapter leaves
// legacy direct callers unchanged.
export function taskCaller(call, settings, { now = () => new Date(), computer = computerName() } = {}) {
  const rules = settings.tasks;
  if (!rules) return call;
  if (typeof call.resource !== 'function') throw new Error('The task worker needs the addressed resource transport.');
  const workerId = `${rules.ai_kind}:${takerCard(settings, computer).agent_id}`;
  const openStates = wordsOfStates(taskRules.states.filter(state => !state.terminal).map(state => state.key));
  // Where the tasks are kept: this computer's settings name the held connection of the database whose tables keep them
  // (`tasks_store`), else the account's records door keeps them. In tables, this worker's own record is a `user` row.
  const store = settings.tasks_store ? { credential_name: settings.tasks_store } : null;
  const operation = tasksIn((address, method, input, key = randomUUID()) => call.resource(address, method, input, key), store);
  const aiKind = store ? rules.store_ai_kind : rules.ai_kind;
  const kindOf = id => String(id).split(':')[0];
  // The records a task tool names: the task itself, its continuation owner, its assignees, and the consumer a finish checks.
  const readsOf = input => ({ ids: [
    ...(input.id ? [{ type: rules.kind, id: input.id }] : []),
    ...(input.continuation?.owner ? [{ type: kindOf(input.continuation.owner), id: input.continuation.owner }] : []),
    ...(Array.isArray(input.assignees) ? input.assignees.map(id => ({ type: kindOf(id), id })) : []),
    ...(input.check?.target ? [{ type: input.check.target.type, id: input.check.target.id }] : []),
  ] });
  // One task tool run over the records it names. `kept: false` means the account refused its write whole because the
  // task changed since it was read: nothing was written, and the caller reads again.
  const act = (tool, input, key) => runTaskMove(operation, { tool, input, key, read: readsOf(input), reads: rules.task_reads, waitSeconds: rules.task_wait_seconds });
  const workerStateOfTask = task => workerStateOf(task?.status, settings);
  const shown = task => task ? { ...task, handoff_id: task.id, task: true, assignees: task.assignees ?? [],
    state: workerStateOfTask(task) === 'done' && task.check?.consumer?.identity && task.check.acceptance_identity && task.check.taken_at === task.taken_at ? 'finished' : workerStateOfTask(task),
    from_agent: task.sent_by, handed_at: task.sent_at, priority: priorityNumber(task.priority),
    // The shared take action decides whether an old claim can be taken. An adapter never owns that stale-time rule.
    hold_until: workerStateOfTask(task) === 'taken' ? now().toISOString() : null,
    next_step: Date.parse(task.continuation?.after) > now().getTime() ? { kind: 'dependency' } : null,
    input: task.input ?? {},
  } : null;
  const resumeDue = async task => {
    const record = startedRecords(home(settings.state_folder)).all().get(task?.id);
    if ((record?.executor_starts ?? 0) >= rules.max_attempts && JSON.stringify(record.job_contract) === JSON.stringify(taskContract(shown(task), settings))) return task;
    if (workerStateOfTask(task) !== 'blocked' || task.continuation?.owner !== workerId || Date.parse(task.continuation.after) > now().getTime()) return task;
    const resumed = await act(rules.move_tool, { as: workerId, id: task.id, action: 'resume', because: rules.recovery_action });
    if (!resumed.kept) throw new Error('The task changed before its resume was written; the next pass reads it again.');
    if (typeof resumed.result?.moved !== 'boolean') throw new Error('The shared resume returned no transition result.');
    return resumed.result.task;
  };
  const adapted = async (path, body = {}) => {
    if (path === '/handoffs/open-page') {
      const cursor = body.after ? JSON.parse(body.after) : { state: 0, after: null };
      if (!Number.isInteger(cursor.state) || cursor.state < 0 || cursor.state >= openStates.length) throw new Error('The open-task cursor names no declared state.');
      const page = await operation('@own-records', 'records:list', { type: rules.kind, where: { status: openStates[cursor.state] }, limit: 100, ...(cursor.after ? { after: cursor.after } : {}) });
      if (!Array.isArray(page?.records)) throw new Error('The account did not return its task records.');
      const work = [];
      for (const row of page.records) work.push(shown(await resumeDue({ id: row.id, ...row.value })));
      const next = page.next ? { state: cursor.state, after: page.next }
        : cursor.state + 1 < openStates.length ? { state: cursor.state + 1, after: null } : null;
      return { work: work.filter(Boolean), agents: [], next_after: next ? JSON.stringify(next) : null };
    }
    if (path === '/handoffs/read') {
      const value = await operation('@own-records', 'records:read', { id: body.handoff_id });
      if (value === undefined) throw new Error('The account did not return the task read.');
      return { handoff: value === null ? null : shown(await resumeDue({ id: body.handoff_id, ...value })) };
    }
    if (path === '/handoffs/take') {
      try {
        const { result, kept } = await act(rules.take_tool, { as: body.agent_id, id: body.handoff_id }, body.request_key);
        if (!Object.hasOwn(result, 'taken')) throw new Error('The shared take returned no claim result.');
        // Refused whole by the account's conditional write: nothing was taken, so the next pass reads the task again.
        if (!kept) return { handoff: null, note: 'The task changed before it could be taken.' };
        return { handoff: shown(result.taken), note: result.reason };
      } catch (error) {
        // A declared rule refusal cannot have claimed the task. Transport loss and pending tasks remain uncertain.
        if (/The rule for .take.|cannot be given .take.|No task .* is among the records/.test(error?.message ?? '')) error.refused = true;
        throw error;
      }
    }
    if (path === '/handoffs/answer') {
      const before = await operation('@own-records', 'records:read', { id: body.handoff_id });
      if (!before) throw new Error('The task was not found to record its answer.');
      await operation('@own-records', 'records:write', { records: [{ id: body.handoff_id, type: rules.kind, value: { ...before, answer: body.answer }, expected: { type: rules.kind, value: before } }] });
      return { recorded: true };
    }
    if (path === '/handoffs/plan') {
      const { result, kept } = await act(rules.move_tool, { as: body.agent_id, id: body.handoff_id, action: 'plan', taken_at: body.taken_at, acceptance: body.acceptance }, randomUUID());
      if (!kept) throw new Error('The task changed before its acceptance was saved; the next pass reads it again.');
      if (typeof result?.moved !== 'boolean') throw new Error('The shared plan returned no transition result.');
      if (!result.moved) throw new Error('The shared plan did not save the acceptance.');
      return { moved: true };
    }
    if (path === '/handoffs/finish') {
      const { result, kept } = await act(rules.finish_tool, { as: body.agent_id, id: body.handoff_id, taken_at: body.taken_at, result: body.result, check: body.check }, randomUUID());
      if (!kept) throw new Error('The task changed before its finish was written; the next pass reads it again.');
      return { result };
    }
    if (path === '/handoffs/release') {
      const { result, kept } = await act(rules.move_tool, { as: body.agent_id, id: body.handoff_id, action: body.park ? 'wait' : 'release', taken_at: body.taken_at, because: body.because,
        continuation: { owner: body.agent_id, action: body.park ? rules.review_action : rules.recovery_action, after: new Date(now().getTime() + (rules.recovery_after_seconds ?? 60) * 1000).toISOString(), reason: body.because } }, body.request_key);
      if (!kept) throw new Error('The task changed before this release was written; the next pass reads it again.');
      if (typeof result?.moved !== 'boolean') throw new Error('The shared recovery returned no transition result.');
      const job = shown(result.task);
      if (body.park && result.moved) startedRecords(home(settings.state_folder)).update(body.handoff_id, { parked: true, parked_move: job.last_move?.key });
      // A lost CAS is not a released claim. Readback decides whether this worker still holds it.
      if (!result.moved && job.state === 'taken' && job.taken_by === body.agent_id) throw new Error('The task changed before release.');
      return { moved: result.moved, job };
    }
    // The helper's identity is its canonical AI record. Preserve unrelated cells and existing person choices.
    if (path === '/agents/publish') {
      const id = body.agent_id;
      const before = await operation('@own-records', 'records:read', { id });
      if (before === undefined) throw new Error('The account did not return the worker AI record.');
      try { await operation('@own-records', 'records:write', { records: [{ id, type: aiKind, value: { ...(before ?? {}), ...(store ? { name: before?.name ?? body.name } : {}), kind: before?.kind ?? rules.default_ai_kind,
        label: before?.label ?? body.name, agent_id: before?.agent_id ?? id.slice(id.indexOf(':') + 1), can: before?.can ?? ['any'], live: { ...(before?.live ?? {}), seen_at: now().toISOString(), minutes: 60 },
        runs_on: before?.runs_on ?? { device: body.where, place: 'placement:your-computer' }, capacity: body.capacity }, expected: before === null ? null : { type: aiKind, value: before } }] }); }
      catch (error) {
        if (error?.code !== 'original_command_conflict' && !String(error?.message).includes('original_command_conflict')) throw error;
        // Another pass published the same AI card first. Its fresh cells win; claiming still uses the task's conditional write.
      }
      return { agent_id: id };
    }
    throw new Error(`The task worker does not use legacy operation ${path}.`);
  };
  adapted.tasks = true;
  adapted.resource = call.resource;
  return adapted;
}

/** The account's /mcp/api routes with the personal key; an answer saying to send again (retry-after) is sent again. */
// A busy answer is sent again after each of backoff_seconds in turn (never sooner than the account's own retry-after),
// then given up with an error marked busy.
export function accountCaller(origin, key, { backoff_seconds = readSettings().busy.backoff_seconds, wait = seconds => new Promise(resolve => setTimeout(resolve, seconds * 1000)), send = fetch } = {}) {
  const call = async (path, body) => {
    for (let attempt = 0; ; attempt += 1) {
      const answer = await send(`${origin.replace(/\/$/, '')}/mcp/api${path}`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` }, body: JSON.stringify(body) });
      const value = await answer.json().catch(() => ({}));
      if (answer.ok) return value;
      const said = answer.headers.get('retry-after');
      const after = said === null ? NaN : Number(said);
      if (!Number.isFinite(after)) throw new Error(`${path}: ${value.error ?? answer.status}`);
      if (attempt >= backoff_seconds.length) throw Object.assign(new Error(`${path}: ${value.error ?? answer.status}`), { busy: true });
      await wait(Math.max(after, backoff_seconds[attempt]));
    }
  };
  // The same direct /mcp route the keychain bridge carries, with keys confined to the Authorization header.
  call.resource = async (address, method, input, request_key = randomUUID()) => {
    const message = { jsonrpc: '2.0', id: request_key, method: 'tools/call', params: { name: 'do_one_thing_in_my_account', arguments: { address, method, input, request_key } } };
    for (let attempt = 0; ; attempt += 1) {
      const response = await send(`${origin.replace(/\/$/, '')}/mcp`, { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', authorization: `Bearer ${key}` }, body: JSON.stringify(message) });
      const reply = await response.json().catch(() => null);
      if (!response.ok || reply?.error) {
        const after = Number(response.headers.get('retry-after') ?? NaN);
        if (Number.isFinite(after) && attempt < backoff_seconds.length) { await wait(Math.max(after, backoff_seconds[attempt])); continue; }
        throw Object.assign(new Error(reply?.error?.message ?? `The addressed resource call failed (${response.status}).`), { busy: Number.isFinite(after) });
      }
      const result = reply?.result;
      if (result?.isError) throw new Error(result.content?.find(row => row.type === 'text')?.text ?? 'The addressed resource operation was refused.');
      if (result?.structuredContent !== undefined) return result.structuredContent;
      const text = result?.content?.find(row => row.type === 'text')?.text;
      if (text !== undefined) { try { return JSON.parse(text); } catch { throw new Error('The addressed resource operation returned unreadable output.'); } }
      if (result === undefined) throw new Error('The addressed resource operation returned no result.');
      return result;
    }
  };
  // One file's first bytes by its name or identity (GET /namespace/contents), as { encoding, content }: what a task
  // points at, read by the sorting step (triage-open-work.mjs attachedText).
  call.readFile = async (name, length = 65536) => {
    const answer = await send(`${origin.replace(/\/$/, '')}/mcp/api/namespace/contents/read`, { method: 'POST', headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' }, body: JSON.stringify({ name, offset: 0, length }) });
    if (!answer.ok) return null;
    return answer.json().catch(() => null);
  };
  return call;
}

export function computerName() {
  try { return execFileSync('scutil', ['--get', 'ComputerName'], { encoding: 'utf8' }).trim() || hostname(); } catch { return hostname(); }
}

/** The same work-taking identity is advertised by the live helper and used when a pass claims work. It also says which of
 * the chosen AIs rest (until when and why, capacity.resting), what went wrong with one that did not rest (capacity.trouble),
 * and when every chosen AI rests (capacity.all_resting), in the description too, so the person sees it in Trillion. */
export function takerCard(settings, computer = computerName(), now = new Date().toISOString(), runnable = () => true) {
  // The AI named is the one that runs now (chosenAi with the programs found); with none found, the first chosen one.
  const ai = chosenAi(settings, now, runnable) ?? settings.ais.find(item => item.id === orderOf(settings)[0]);
  const label = id => settings.ais.find(item => item.id === id)?.label ?? id;
  const order = orderOf(settings);
  const resting = order.filter(id => settings.resting?.[id] > now).map(id => ({ ai: id, until: settings.resting[id], because: settings.resting_because?.[id] ?? fill(settings.words.rested_because, { said: 'no reason kept' }) }));
  const troubled = order.filter(id => settings.trouble?.[id]).map(id => ({ ai: id, at: settings.trouble[id].at, what: settings.trouble[id].what }));
  const all_resting = order.length > 0 && resting.length === order.length;
  const lines = [
    ...(all_resting ? [fill(settings.words.all_resting, { resting: resting.map(row => fill(settings.words.resting_line, { ai: label(row.ai), until: row.until, because: row.because })).join(' ') })]
      : resting.map(row => fill(settings.words.resting_line, { ai: label(row.ai), until: row.until, because: row.because }))),
    ...troubled.map(row => fill(settings.words.trouble_line, { ai: label(row.ai), what: row.what })),
  ];
  return {
    agent_id: `${settings.agent_id_prefix}${computer.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')}`,
    name: fill(settings.agent_name, { ai: ai.label, computer }),
    description: [fill(settings.agent_description, { ai: ai.label, computer }), ...lines].join(' '),
    harness: ai.label, where: computer, takes_work: true,
    capacity: { max_concurrent: settings.max_concurrent, ttl_minutes: 60, ...(resting.length ? { resting, all_resting } : {}), ...(troubled.length ? { trouble: troubled } : {}) },
    delivery: { stream: true },
  };
}

// One page of open work, read again after each of backoff_seconds in turn when the read fails (a dropped connection
// partway through a walk of ~90 pages), then given up with the last error. A busy answer was already sent again by
// accountCaller, so it is not waited on twice.
export async function readPage(call, body, { backoff_seconds = readSettings().page_retry.backoff_seconds, wait = seconds => new Promise(resolve => setTimeout(resolve, seconds * 1000)) } = {}) {
  for (let attempt = 0; ; attempt += 1) {
    try { return await call('/handoffs/open-page', body); } catch (error) {
      if (error?.busy || attempt >= backoff_seconds.length) throw error;
      await wait(backoff_seconds[attempt]);
    }
  }
}

/** Every piece of open work the account holds, a page at a time: { work, agents }. */
export async function listOpenWork(call, retry) {
  const work = [];
  const cards = new Map();
  let after = null;
  do {
    const page = await readPage(call, { after, limit: 50, agent_scope: 'work' }, retry);
    if (!Array.isArray(page?.work) || !Array.isArray(page.agents)) throw new Error('The account did not return its open work.');
    work.push(...page.work);
    for (const card of page.agents) cards.set(card.agent_id, card);
    after = page.next_after ?? null;
  } while (after);
  return { work, agents: [...cards.values()] };
}

/** The helper's handler: one pass on any account change; returns once the runs are started. A full pass reads the
 * open work once for sorting and taking; it answers `idle` when it sorted nothing and started nothing. */
// afterRuns (optional) is called once every run this pass started has ended, so a freed slot is filled at once.
export default async function handle(event, agents, { afterRuns = null } = {}) {
  const settings = readSettings();
  const log = entry => process.stdout.write(`${JSON.stringify({ at: new Date().toISOString(), part: 'take-open-work', event: event?.type ?? null, ...entry })}\n`);
  const call = taskCaller(operationCaller(accountOfSettings(settings), { env: childEnv() }), settings);
  // New work is sorted first, so only real work gets a full run (harness/triage-open-work.mjs).
  const announcedId = event?.refs?.handoff_id ?? event?.subject_id ?? null;
  const onlyHandoffId = call.tasks && !String(announcedId).startsWith(`${settings.tasks.kind}:`) ? null : announcedId;
  let listed = onlyHandoffId ? null : await listOpenWork(call);
  let sorted = null;
  if (settings.triage && !call.tasks) {
    const triage = await import('./triage-open-work.mjs');
    sorted = await triage.runTriage({ settings, call, computer: computerName(), log, onlyHandoffId, listed });
    const closed = new Set(sorted?.closed ?? []);
    if (listed && closed.size) listed = { ...listed, work: listed.work.filter(item => !closed.has(item.handoff_id)) };
  }
  const { runs, ...rest } = await runPass({ settings, call, computer: computerName(), log, knownAgents: agents, onlyHandoffId, alreadyPublished: !call.tasks, listed });
  if (afterRuns && runs.length) Promise.allSettled(runs).then(() => afterRuns());
  return { ...rest, idle: !rest.started.length && !(sorted?.verdicts?.length) };
}

async function main(argv) {
  const settings = readSettings();
  const pairs = Object.fromEntries(argv.flatMap((value, index) => (value.startsWith('--') ? [[value.slice(2), argv[index + 1]?.startsWith('--') ? 'true' : argv[index + 1] ?? 'true']] : [])));
  if (!pairs.once) throw new Error('Run one pass with --once.');
  const log = entry => process.stdout.write(`${JSON.stringify({ at: new Date().toISOString(), ...entry })}\n`);
  const call = taskCaller(operationCaller(accountOfSettings(settings), { env: childEnv() }), settings);
  if (settings.triage && !call.tasks && !pairs['handoff-id']) { const triage = await import('./triage-open-work.mjs'); await triage.runTriage({ settings, call, computer: computerName(), log }); }
  const pass = await runPass({ settings, call, computer: computerName(), log, onlyHandoffId: pairs['handoff-id'] ?? null });
  const ended = await Promise.all(pass.runs);
  log({ did: 'pass done', agent_id: pass.agent_id, started: pass.started, ended, left: pass.left });
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

