#!/usr/bin/env node
// tools/use-your-tools-from-a-shell/do-work/command.mjs
//
// Moved from an older repository (moved-from.json names where); the files it installs beside itself are this folder's.
//
// Purpose
//   The command: any AI that can run a shell (Claude Code, Codex, Cursor, Gemini CLI, opencode, a script) sees
//   the person's AIs and their tasks, gives, takes and hands on tasks, lists and runs Workshop tools and runs any engine
//   operation, with no MCP connection of its own. Every command is addressed calls of the engine's one MCP tool,
//   do_one_thing_in_my_account {address, method, request_key, input} (command.json `engine`), at the account's door: the Mac
//   app's local door when this computer has one (./local-door.mjs), else the address given (--origin or {CLI}_ORIGIN).
//   A task is one calendar-task record and its assignees are who may do it; the task rows (tools/plan-tasks-and-todo-lists,
//   packed under ./packs) decide every move. This command reads the records a move needs, runs the row through
//   run-a-task-move.mjs, and applies the writes the row answers, each conditioned on the value it was read at.
//
//     {cli} setup                      sign in once, put the command on PATH, write the skill for each AI app here
//     {cli} whoami                     who is signed in, this AI's id and facts (--verbose: the account id and the address that answered)
//     {cli} who [--all] [--list FILE]  the person's AIs, grouped by owner, named by the list:ais name formula when that list is given
//     {cli} publish [HELD]             this AI's own `ai` record as a `keep` row for the person's own store (writes nothing)
//     {cli} tasks | give | take | who-can-take | finish | fail | hand-on | plan | release | stuck | wait | resume | edit | withdraw | remove | serve
//                                         tasks, each a read or one move through its Workshop task tool (command.json `tasks`)
//     {cli} tools | call TOOL JSON     the Workshop tools, and run one
//     {cli} op METHOD JSON [--pin ID]...  any engine operation (--pin: the computers to meet it at, in order)
//     {cli} schedule list | on|off TOOL WAKE_ID | cancel RUN_KEY [--pin ID]...
//                                         the wakes the tool rows declare, read and switched at the engine's wake owner
//     records replay-from-transcripts --since TIME
//                                         the rows this computer's AIs wrote, from their transcripts, as an inventory
//                                         to keep in the person's own store (replay-recorded-writes.mjs; writes nothing)
//
// Non-negotiable invariants
//   1. One road: do_one_thing_in_my_account over MCP JSON-RPC at the door. The only other addresses are the public origin's
//      own sign-in (OAuth, at the endpoints its /.well-known documents name), used by login and to renew the sign-in it kept.
//   2. The credential is the account's existing key (the Keychain item the site's Mac app keeps, else a 0600 file, else
//      {CLI}_KEY) or the sign-in login kept. It is read into memory only, never printed, never put in a command line
//      or a log; the Keychain is written through `security -i` on standard input. logout forgets only a credential this
//      program made, never the Mac app's key.
//   3. Every call carries one request_key, reused on every retry, so a retry is answered as the first call was.
//   4. A refusal says which door refused and why. "{cli} login" is said only when there is no credential at all.
//   5. A move is the task row's conditioned write: a task another AI moved first is reported, never retried blindly.
//   6. An AI's name is never stored or built here: `who` evaluates the name formula of the `ai_list` list it is given.
//   7. No row is read or written here except through the records the account answers: a command that makes a row
//      (publish) prints it as `keep` with `expected`, for the caller to keep where the person keeps rows.
//   8. Settings, the skill text, the task table and every place written are DATA in command.json and command-skill.md;
//      a new AI app is one `skills` row and one `agents` row.
//
import { spawn, spawnSync } from 'node:child_process';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { chmodSync, existsSync, writeSync, lstatSync, mkdirSync, readFileSync, readdirSync, readlinkSync, realpathSync, renameSync, rmSync, statSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { createServer, request as httpRequest } from 'node:http';
import { createInterface } from 'node:readline';
import { homedir, hostname } from 'node:os';
import { basename, dirname, join, resolve as resolvePath } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { runOnAgUi } from './ag-ui-agent.mjs';
import { makeHashCodeHexFromBytes, requestKeyForEngine } from './packs/read-data/identity.mjs';
import { blake3 } from './packs/read-data/blake3.mjs';
import { settledWrite } from './settled-write.mjs';
import { KeepRefused, keepResult, readResult } from './keep-result.mjs';
import { localDoorAddress } from './local-door.mjs';
import { keptFetch, startKeeper } from './keep-the-connection.mjs';
import settings from './command.json' with { type: 'json' };
import taskRules from './packs/tools/plan-tasks-and-todo-lists/task-moves.json' with { type: 'json' };
import { declaredStates, readFor, runTaskMove, statesFrom, stateOfWord, tasksIn, wordsOfStates } from './packs/tools/plan-tasks-and-todo-lists/run-a-task-move.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const fill = (template, values) => template.replace(/\{(\w+)\}/g, (whole, name) => (values[name] === undefined ? whole : String(values[name])));
/** The command's own name, from the site row of the site it came from (`speakFor`). */
export const cliName = () => settings.site?.cli ?? 'command';
const pause = ms => new Promise(done => setTimeout(done, ms));
const object = value => Boolean(value) && typeof value === 'object' && !Array.isArray(value);

export class CommandError extends Error {
  constructor(message, { status = 1, answer = null, detail = null } = {}) { super(message); this.status = status; this.answer = answer; this.detail = detail; }
}

/** A path from settings with ~ as the home folder. */
export const expand = (path, home = homedir()) => (path === '~' ? home : path.startsWith('~/') ? join(home, path.slice(2)) : path);

/** This computer's name as it reads in an agent id: lower-case words joined by dashes ("Work-Laptop.local" -> "work-laptop"). */
export const computerOf = (name = hostname()) => name.split('.')[0].toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'computer';

/** A chat session's id as it reads in an agent id: its last letters and digits (the random end of a UUID v4 or v7). */
export const sessionOf = (value, rules = settings) => String(value).toLowerCase().replace(/[^a-z0-9]+/g, '').slice(-rules.agent_id.session_chars);

const run = (command, args, options = {}) => spawnSync(command, args, { encoding: 'utf8', timeout: 10_000, ...options });

/** The name the person gave this computer, as people read it: the system's own computer name (command.json
 *  `computer_name.programs`, per platform) with the copy counter the system adds to a duplicate ("MacBook Pro (3)")
 *  removed (`computer_name.strip`), else the host name before its first dot. */
export function computerNameOf({ platform = process.platform, exec = run, host = hostname(), rules = settings } = {}) {
  const asked = rules.computer_name.programs[platform];
  const answer = asked ? exec(asked[0], asked.slice(1), { stdio: ['ignore', 'pipe', 'ignore'] }) : null;
  const named = answer?.status === 0 ? String(answer.stdout).trim() : '';
  const plain = named.replace(new RegExp(rules.computer_name.strip), '').trim();
  return plain || host.split('.')[0];
}

/** The model an AI app runs, read from the app's own facts: its `model_env` variables, else the setting its
 *  `model_config` names in the app's config file (JSON key or TOML `key = "value"` line), with any suffix the app adds
 *  (`model_suffix`, such as a context-size mark) removed. Null when the app says none. */
export function modelOf(row, { env = process.env, home = homedir(), read = path => readFileSync(path, 'utf8'), rules = settings } = {}) {
  const clean = value => (typeof value === 'string' && value.trim() ? value.trim().replace(new RegExp(rules.model_suffix), '') : null);
  for (const name of row.model_env ?? []) if (clean(env[name])) return clean(env[name]);
  const config = row.model_config;
  if (!config) return null;
  const root = (config.home_variable && env[config.home_variable]) || join(home, config.folder);
  let text;
  try { text = read(join(root, config.file)); } catch { return null; }
  if (config.format === 'json') { try { return clean(JSON.parse(text)?.[config.key]); } catch { return null; } }
  const line = text.split('\n').find(entry => new RegExp(`^\\s*${config.key}\\s*=`).test(entry));
  return clean(line?.split('=').slice(1).join('=').trim().replace(/^["']|["']$/g, ''));
}

/** The provider of a model id, a fact read from command.json `model_families` by the id's first word, or null. */
export const providerOf = (id, rules = settings) => (id ? rules.model_families.find(row => row.prefix === id.split(/[-_\s]+/)[0].toLowerCase())?.provider ?? null : null);

/** Which AI runs this command: --as, else {CLI}_AGENT, else the first `agents` row whose variable is set, one id per
 *  chat session when that app names its session (`session_env`), else one per computer. `held_as` are the other ids a task
 *  this AI holds may have been taken under: the computer id, for tasks taken before sessions had their own id. `ai_id` is
 *  its `ai` record id. `app`, `model`, `provider` and `computer` are the facts its record carries; no name is made here. */
export function agentOf({ as = null, env = process.env, computer = computerOf(), computerName = null, model = undefined, rules = settings } = {}) {
  const row = rules.agents.find(item => item.env.some(name => env[name])) ?? rules.fallback_agent;
  const named = (row.session_env ?? []).map(name => env[name]).find(value => typeof value === 'string' && sessionOf(value, rules));
  const session = named === undefined ? null : sessionOf(named, rules);
  const values = { harness: row.harness, agent: row.agent, computer, session };
  const computerId = fill(rules.agent_id.computer, values);
  const chosen = as ?? (env[settings.env.agent] || null);
  const agent_id = chosen ?? (session ? fill(rules.agent_id.session, values) : computerId);
  // The engine trims an agent id and cuts it at most_chars, so a longer or padded id would name some other agent.
  if (!agent_id || agent_id !== agent_id.trim() || agent_id.length > rules.agent_id.most_chars) {
    throw new CommandError(`An agent id is 1 to ${rules.agent_id.most_chars} characters with no space at either end.`, { status: 2 });
  }
  const modelId = model === undefined ? modelOf(row, { env, rules }) : model;
  return { agent_id, ai_id: aiIdOf(agent_id, rules), held_as: chosen || !session ? [] : [computerId], session: chosen ? null : session, harness: row.harness,
    app: row.app ?? null, model: modelId, provider: providerOf(modelId, rules) ?? row.provider ?? null, computer: computerName ?? computer };
}

/** An `ai` record id for an agent id or an id that already is one (command.json `engine.ai_type`). */
// A record id names its kind (`ai:codex`, `person:someone`); a bare name is an AI's, so it gets the `ai:` kind.
export const aiIdOf = (id, rules = settings) => (/^[^:\s]+:\S+$/.test(String(id)) ? String(id) : `${rules.engine.ai_type}:${id}`);

// ── Command line ─────────────────────────────────────────────────────────────────────────────────────────────────

const VALUE_FLAGS = new Set(['address', 'description', 'title', 'source-file', 'obligations-file', 'continuation-file', 'request-key', 'as', 'timeout', 'wait', 'summary', 'because', 'reason', 'priority', 'key', 'origin', 'harness', 'outcome', 'limit', 'status', 'to', 'can', 'from', 'taken-by', 'assignee', 'ag-ui', 'since', 'list', 'check-file', 'acceptance-file', 'input', 'store', 'pin', 'upload']);
// A flag given more than once keeps every value, in order (`--to A --to B`); the others keep the last.
const MULTI_FLAGS = new Set(['to', 'can', 'pin']);

/** The method `op` names first. A word that starts with @ is the address the old form put first, which a call no longer names. */
function opMethod(word) {
  const method = need(word, `Name the method: ${cliName()} op METHOD JSON, for example ${cliName()} op tools:list '{}'.`);
  if (method.startsWith('@')) throw new CommandError(`A call names its method, not an address: ${cliName()} op METHOD JSON (for example ${cliName()} op tools:list '{}'). --address ADDRESS is only for passing a method on.`, { status: 2 });
  return method;
}

/** argv -> { words, flags, rest }: `--name value` for VALUE_FLAGS, `--name` alone is true, everything after `--` is rest. */
export function parseArgs(argv) {
  const words = [], flags = {};
  const put = (name, value) => { flags[name] = MULTI_FLAGS.has(name) ? [...(flags[name] ?? []), value] : value; };
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (value === '--') return { words, flags, rest: argv.slice(index + 1) };
    if (!value.startsWith('--') || value === '-') { words.push(value); continue; }
    const [name, inline] = value.slice(2).split(/=(.*)/s, 2);
    if (inline !== undefined) put(name, inline);
    else if (VALUE_FLAGS.has(name)) {
      if (argv[index + 1] === undefined) throw new CommandError(`--${name} needs a value.`, { status: 2 });
      put(name, argv[index += 1]);
    } else flags[name] = true;
  }
  return { words, flags, rest: [] };
}

const wholeNumber = (value, name) => {
  if (value === undefined) return undefined;
  const number = Number(value);
  if (!Number.isInteger(number) || number < 0) throw new CommandError(`--${name} is a whole number.`, { status: 2 });
  return number;
};
const need = (value, words) => { if (value === undefined || value === '') throw new CommandError(words, { status: 2 }); return value; };
const joined = list => (list.length ? list.join(' ') : undefined);
/** The route `op` and `schedule` are sent with for their `--pin` flags: `{ pins }`, the computer ids in the order given (a
 *  repeated flag, or a comma list), each one the engine accepts (command.json `engine.pins`); `{}` when no --pin is given,
 *  so the call's envelope is unchanged. Refused before anything is sent. */
export function pinRouteOf(flags, { rules = settings } = {}) {
  if (flags.pin === undefined) return {};
  const { most, id_pattern } = rules.engine.pins;
  const pins = [flags.pin].flat().flatMap(value => value.split(','));
  if (pins.length > most) throw new CommandError(fill(rules.words.pin_too_many, { most, count: pins.length }), { status: 2 });
  const refused = pins.find(id => !new RegExp(id_pattern).test(id));
  if (refused !== undefined) throw new CommandError(fill(rules.words.pin_refused, { id: short(refused, 40) }), { status: 2 });
  return { pins };
}
/** The JSON object in `file` (a --check-file or --acceptance-file), or a refusal saying what it should hold. */
const readJsonFile = (file, name, example) => {
  let value;
  try { value = JSON.parse(readFileSync(String(file), 'utf8')); } catch (error) { throw new CommandError(`Could not read ${name} JSON from ${file}: ${error.message}`, { status: 2 }); }
  if (!object(value) && !(name === 'obligations' && Array.isArray(value))) throw new CommandError(`${name} is one JSON object${name === 'obligations' ? ' or array' : ''}, for example ${example}.`, { status: 2 });
  return value;
};
const validTime = value => typeof value === 'string' && Number.isFinite(Date.parse(value)) && /^\d{4}-\d\d-\d\dT.*(?:Z|[+-]\d\d:\d\d)$/.test(value);
const validateEvidence = rows => Array.isArray(rows) && rows.length > 0 && rows.every(row => object(row) && typeof row.ref === 'string' && row.ref.trim() && typeof row.observation === 'string' && row.observation.trim());
export function validateCheck(check) {
  if (!object(check) || typeof check.outcome !== 'string' || !check.outcome.trim() || !validTime(check.checked_at) || !validateEvidence(check.evidence) || !Array.isArray(check.obligations))
    throw new CommandError('A check receipt needs outcome, an ISO checked_at time, evidence rows with ref and observation, and obligations (an empty array when none were requested).', { status: 2 });
  if (check.obligations !== undefined && (!Array.isArray(check.obligations) || check.obligations.some(row => !object(row) || typeof row.id !== 'string' || !row.id.trim() || typeof row.outcome !== 'string' || !row.outcome.trim() || !validateEvidence(row.evidence))))
    throw new CommandError('Each obligation check needs its id, outcome, and evidence rows with ref and observation.', { status: 2 });
  return check;
}
export function validateContinuation(value) {
  if (!object(value) || typeof value.owner !== 'string' || !/^ai:[A-Za-z0-9._:-]+$/.test(value.owner) || typeof value.action !== 'string' || !value.action.trim() || !validTime(value.after) || typeof value.reason !== 'string' || !value.reason.trim())
    throw new CommandError('A continuation needs owner ai:NAME, action, ISO after time, and reason.', { status: 2 });
  return value;
}
const validateSource = value => {
  if (!object(value) || typeof value.kind !== 'string' || !value.kind.trim() || typeof value.ref !== 'string' || !value.ref.trim()) throw new CommandError('A source needs kind and ref.', { status: 2 });
  return value;
};
const validateObligations = value => {
  if (!Array.isArray(value) || value.some(row => !object(row) || typeof row.id !== 'string' || !row.id.trim() || typeof row.outcome !== 'string' || !row.outcome.trim()) || new Set(value.map(row => row.id)).size !== value.length)
    throw new CommandError('Obligations are unique rows with id and outcome.', { status: 2 });
  return value;
};
export function validateAcceptance(value) {
  if (!object(value) || typeof value.outcome !== 'string' || !value.outcome.trim() || !object(value.target) || typeof value.target.type !== 'string' || !value.target.type.trim() || typeof value.target.id !== 'string' || !value.target.id.trim() || !Array.isArray(value.rules))
    throw new CommandError('Acceptance needs outcome, target type and id, and a rules array.', { status: 2 });
  return value;
}
export function checkForTask(check, task) {
  try { validateCheck(check); } catch { return false; }
  if (!task.acceptance) return false;
  const expected = task.acceptance.outcome;
  if (check.outcome !== expected) return false;
  const obligations = task.obligations ?? [];
  if (check.obligations.length !== obligations.length) return false;
  const byId = new Map(check.obligations.map(row => [row.id, row]));
  if (byId.size !== obligations.length) return false;
  for (const required of obligations) {
    const got = byId.get(required.id);
    if (!got || got.outcome !== required.outcome) return false;
  }
  return true;
}

/** Which of this AI's ids holds task `id`: its own, else an id it held work under before (held.json), else its own. */
export const holderOf = (me, held, id) => [me.agent_id, ...(me.held_as ?? [])].find(agent => held[`${agent} ${id}`] !== undefined) ?? me.agent_id;

/** The tasks this AI holds, newest last: { id, said }. */
export const holdingOf = (me, held) => Object.entries(held).flatMap(([key, kept]) => {
  const agent = key.slice(0, key.lastIndexOf(' ')), id = key.slice(key.lastIndexOf(' ') + 1);
  return [me.agent_id, ...(me.held_as ?? [])].includes(agent) ? [{ id, said: typeof kept === 'object' ? kept?.said ?? '' : '' }] : [];
});

/** The task commands. Each is one read or one move through its Workshop task tool (command.json `tasks.tools`), run by
 *  run-a-task-move.mjs; `serve` takes and moves tasks through the same tools. `tasks.actions` maps each move command to the
 *  action the task row takes. */
export const TASK_COMMANDS = new Set(['tasks', 'give', 'take', 'who-can-take', ...Object.keys(settings.tasks.actions)]);

/** A record id, `<kind>:<name>` (ai:codex-on-mac, person:someone, a task's record id): refused whole when it is not one. */
export function recordIdOf(value, name) {
  if (typeof value !== 'string' || !/^[^:\s]+:\S+$/.test(value)) throw new CommandError(`${name} is a record id, <kind>:<name>, for example ai:codex-on-mac or person:someone.`, { status: 2 });
  return value;
}
/** The reads of run-a-task-move.mjs for records named by id: a task is the task kind's record, and any other record is labelled by its kind. */
const taskRef = id => ({ type: taskRules.task_kind, id: recordIdOf(id, 'A task') });
/** The words a task asks for, as the rows read them: its outcome, else its description, else its title. */
const wordsOf = task => [task.outcome, task.description, task.title].find(words => typeof words === 'string' && words.trim() !== '') ?? '';
/** The states a task ends in (the rows' terminal states): `give --wait` returns once a task is in one of them. */
const finishedStates = taskRules.states.filter(state => state.terminal).map(state => state.key);
/** The state a take moves a task into (the rows' `take` transition), so who-can-take counts the tasks each one holds. */
const takenState = taskRules.transitions.find(edge => edge.action === 'take').to;
const recordRef = id => ({ type: recordIdOf(id, 'A record').split(':')[0], id });
/** What a take reads when no task is named: the tasks a take may move, and the caller's own record. */
const takeReads = me => ({ tasks: { statuses: wordsOfStates(statesFrom('take')) }, ids: [recordRef(me.ai_id)] });
const statusOf = word => {
  if (!declaredStates().includes(stateOfWord(word))) throw new CommandError(`--status is one of ${declaredStates().join(', ')}.`, { status: 2 });
  return word;
};
const priorityOf = word => {
  if (!taskRules.priorities.includes(word)) throw new CommandError(`--priority is one of ${taskRules.priorities.join(', ')}.`, { status: 2 });
  return word;
};

/** The addressed transport run-a-task-move.mjs expects, `resource(address, method, input, key)`: each call answered whole. */
export const resourceOf = (client, { rules = settings, store = null } = {}) => tasksIn((address, method, input, key) =>
  opWhole(client, address, method, input, { requestKey: key ?? randomUUID(), rules }), store);
/** The database whose tables keep this person's tasks (command.json `tasks.store`): the held connection name given with
 *  --store, kept for the next command, or the one kept before; null when none was ever given (the records door keeps them). */
function tasksStoreOf(context, rules = settings) {
  const given = context.flags?.[rules.tasks.store.flag];
  if (typeof given === 'string' && given) { context.state.keepTasksStore?.(given); return { credential_name: given }; }
  const kept = context.state.tasksStore?.();
  return kept ? { credential_name: kept } : null;
}
/** The record types who-can-take reads: the store's when the tasks are kept in tables. */
const whoTypes = (store, rules = settings) => (store ? rules.tasks.store.who_types : rules.tasks.who_types);

/** Runs one Workshop tool by its id with `input` at the door: tools:run, answered whole. Answers the tool's own answer. */
export async function toolCall(client, tool, input, { idempotent = false, rules = settings } = {}) {
  const requestKey = randomUUID(), method = rules.engine.tools_run, request = { tool, input };
  const first = await client.op(null, method, request, { idempotent, requestKey });
  const answer = bytePageOf(first) ? await wholeAnswer(client, null, method, request, first, { requestKey, rules }) : first;
  return object(answer) && Object.hasOwn(answer, 'result') ? answer.result : answer;
}

/** The route a call of one Workshop tool is sent with: the `need` of the tool's run template (tools:list with `tool`, the
 *  row's invoke block as the engine gives it), passed through untouched. A need that names no door and no computer
 *  capability is no route (the same as none), so such a call is sent exactly as it was before routes existed. */
export async function routeOf(client, tool, { rules = settings } = {}) {
  const row = await client.op(null, rules.engine.tools_list, { tool }, { idempotent: true });
  const need = row?.run?.need;
  const names = list => Array.isArray(list) && list.length > 0;
  return names(need?.local_doors) || names(need?.capabilities) ? { need } : {};
}

/** The call one task command makes: { call, input, read, wait? }. `call` names its tool in command.json `tasks.tools`
 *  (see, give, take, who, change, finish). `read` is what run-a-task-move.mjs reads for it; a move by id also reads its task
 *  (main), and its assignees and continuation owner are named here. `me` is agentOf(); `held` is what this AI last took
 *  (a move is made as the id that took the task). */
export function argumentsFor(command, { words, flags }, { me, held = {}, requestKey = randomUUID(), rules = settings } = {}) {
  const [first, ...more] = words;
  const idFor = verb => taskRef(need(first, `Name the task: ${cliName()} ${verb} ID.`)).id;
  const move = (verb, action, extra) => {
    const id = idFor(verb);
    const named = [...(extra.assignees ?? []), ...(extra.continuation ? [extra.continuation.owner] : [])].map(recordRef);
    return { call: action === 'finish' ? 'finish' : 'change', input: { as: aiIdOf(holderOf(me, held, id), rules), id, action, ...extra }, read: { ids: named } };
  };
  // A repeated --to is a list (parseArgs); one given as a single value is a list of one.
  const handsTo = () => [flags.to ?? []].flat().map(id => recordIdOf(id, '--to'));
  switch (command) {
    case 'tasks': {
      if (first) return { call: 'see', input: { id: taskRef(first).id }, read: { ids: [taskRef(first)] } };
      const where = {
        ...(flags.from !== undefined ? { sent_by: recordIdOf(flags.from, '--from') } : {}),
        ...(flags['taken-by'] !== undefined ? { taken_by: recordIdOf(flags['taken-by'], '--taken-by') } : {}),
      };
      const status = flags.status === undefined ? undefined : statusOf(flags.status);
      const limit = wholeNumber(flags.limit, 'limit') ?? rules.tasks.list_limit;
      return {
        call: 'see',
        input: { ...(status !== undefined ? { status } : {}), ...where, ...(flags.assignee !== undefined ? { assignee: recordIdOf(flags.assignee, '--assignee') } : {}), limit },
        read: { tasks: { ...(Object.keys(where).length ? { where } : {}), ...(status !== undefined ? { statuses: wordsOfStates([stateOfWord(status)]) } : {}) } },
      };
    }
    case 'give': {
      const description = need(joined(words), `Say the task: ${cliName()} give WORDS [--to ID]...`);
      const assignees = handsTo();
      const acceptance = flags['acceptance-file'] ? validateAcceptance(readJsonFile(flags['acceptance-file'], 'acceptance', '{"outcome":"...","target":{"type":"...","id":"..."},"rules":[...]}')) : null;
      if (acceptance && flags.outcome !== undefined && flags.outcome !== acceptance.outcome) throw new CommandError('--outcome must exactly match acceptance.outcome.', { status: 2 });
      return {
        call: 'give', wait: flags.wait,
        input: {
          as: me.ai_id, key: flags.key ?? requestKey, description,
          ...(flags.title !== undefined ? { title: flags.title } : {}),
          ...(assignees.length ? { assignees } : {}),
          ...(flags.priority !== undefined ? { priority: priorityOf(flags.priority) } : {}),
          ...(flags.outcome !== undefined ? { outcome: flags.outcome } : acceptance ? { outcome: acceptance.outcome } : {}),
          ...(flags['source-file'] ? { source: validateSource(readJsonFile(flags['source-file'], 'source', '{"kind":"repository","ref":"..."}')) } : {}),
          ...(flags['obligations-file'] ? { obligations: validateObligations(readJsonFile(flags['obligations-file'], 'obligations', '[{"id":"...","outcome":"..."}]')) } : {}),
          ...(acceptance ? { acceptance } : {}),
        },
        read: { ids: assignees.map(recordRef) },
      };
    }
    case 'take':
      if (first) return { call: 'take', input: { as: me.ai_id, id: taskRef(first).id, ...(flags['only-mine'] ? { only_mine: true } : {}) }, read: { ids: [taskRef(first)] } };
      return { call: 'take', input: { as: me.ai_id, ...(flags['only-mine'] ? { only_mine: true } : {}) }, read: takeReads(me) };
    case 'who-can-take':
      return { call: 'who', input: { ...(flags.can !== undefined ? { can: [flags.can].flat() } : {}), ...(flags.live === true ? { live_only: true } : {}) }, read: { types: rules.tasks.who_types, tasks: { statuses: wordsOfStates([takenState]) } } };
    case 'finish':
    case 'fail': {
      const result = need(joined(more), `Say what came of it: ${cliName()} ${command} ID "RESULT".`);
      return move(command, rules.tasks.actions[command], { result, ...(command === 'finish' ? { summary: flags.summary ?? result.split('\n')[0].slice(0, 300) } : {}),
        ...(flags['check-file'] ? { check: validateCheck(readJsonFile(flags['check-file'], 'check', '{"outcome":"...","checked_at":"...","evidence":[{"ref":"...","observation":"..."}],"obligations":[]}')) } : {}) });
    }
    case 'plan':
      return move('plan', rules.tasks.actions.plan, { acceptance: validateAcceptance(readJsonFile(need(flags['acceptance-file'], 'Name the saved consumer acceptance: --acceptance-file JSON.'), 'acceptance', '{"outcome":"...","target":{"type":"...","id":"..."},"rules":[...]}')) });
    case 'stuck':
      return flags.clear ? move('stuck', rules.tasks.actions.unstuck, {}) : move('stuck', rules.tasks.actions.stuck, { words: need(joined(more), 'Say what is in the way, or pass --clear.') });
    case 'release':
      return move('release', rules.tasks.actions.release, { ...(flags.because ? { because: flags.because } : {}), ...(flags['continuation-file'] ? { continuation: validateContinuation(readJsonFile(flags['continuation-file'], 'continuation', '{"owner":"ai:...","action":"...","after":"...","reason":"..."}')) } : {}) });
    case 'wait':
      return move('wait', rules.tasks.actions.wait, { continuation: validateContinuation(readJsonFile(need(flags['continuation-file'], 'Say who owns the next step and when: --continuation-file JSON.'), 'continuation', '{"owner":"ai:...","action":"...","after":"...","reason":"..."}')) });
    case 'resume':
      return move('resume', rules.tasks.actions.resume, { because: need(flags.because, 'Say what changed after reviewing the existing effects: --because WORDS.') });
    case 'hand-on': {
      const assignees = handsTo();
      if (!assignees.length) throw new CommandError(`Say who takes it next: ${cliName()} hand-on ID --to ID (repeat --to for more).`, { status: 2 });
      return move('hand-on', rules.tasks.actions['hand-on'], { assignees, ...(flags.because ? { because: flags.because } : {}) });
    }
    case 'edit': {
      const input = {
        ...(flags.description !== undefined ? { description: flags.description } : {}),
        ...(flags.title !== undefined ? { title: flags.title } : {}),
        ...(flags.outcome !== undefined ? { outcome: flags.outcome } : {}),
        ...(flags['source-file'] ? { source: validateSource(readJsonFile(flags['source-file'], 'source', '{"kind":"repository","ref":"..."}')) } : {}),
        ...(flags['obligations-file'] ? { obligations: validateObligations(readJsonFile(flags['obligations-file'], 'obligations', '[{"id":"...","outcome":"..."}]')) } : {}),
        ...(flags.to !== undefined ? { assignees: handsTo() } : {}),
        ...(flags.priority !== undefined ? { priority: priorityOf(flags.priority) } : {}),
      };
      if (!Object.keys(input).length) throw new CommandError('Name at least one field to change with --description, --title, --outcome, --source-file, --obligations-file, --to, or --priority.', { status: 2 });
      return move('edit', rules.tasks.actions.edit, input);
    }
    case 'withdraw': return move('withdraw', rules.tasks.actions.withdraw, { because: need(flags.reason, 'Say why: --reason "WHY".') });
    case 'remove': return move('remove', rules.tasks.actions.remove, {});
    default: throw new CommandError(`Unknown command ${command}. Run ${cliName()} help.`, { status: 2 });
  }
}

/** This AI's `ai` record as `publish` answers it: the record it already has (its other cells kept as they are; a new
 *  record starts from `ai_record.new`) with its fact cells set: `owner` (the account the door answered for, never typed
 *  by the AI), `agent_id`, `app`, `model`, `provider`, `computer`, `harness`, `where` (repository and branch, never a
 *  path), `working_on` (the task it holds, or null) and `live.seen_at` now. No name is written. `facts` is
 *  { repository, branch, holding } (placeOf, holdingOf). */
export function aiRecordOf(me, { account, held = null, now = new Date(), repository = null, branch = null, holding = [] } = {}, rules = settings) {
  const card = rules.agent_card;
  const where = repository ? fill(card.where_in_repository, { repository, branch: branch ?? card.no_branch }) : card.where;
  const latest = holding.at(-1);
  const working_on = latest ? fill(holding.length > 1 ? card.working_on_more : card.working_on, { doing: short(latest.said || latest.id, card.doing_chars), more: holding.length - 1 }) : null;
  const before = object(held) ? held : rules.ai_record.new;
  return { ...before, owner: account, agent_id: me.agent_id, app: me.app, model: me.model, provider: me.provider, computer: me.computer, harness: me.harness,
    where, working_on, live: { ...rules.ai_record.new.live, ...(object(before.live) ? before.live : {}), seen_at: now.toISOString() } };
}


/** Where this AI works, as its card says it: the repository's name and branch from git in the current folder, or {}
 *  outside a repository. Only names: the remote's last part (never its address, which may carry a sign-in) or the top
 *  folder's own name, each cut to place_chars printable characters. */
export function placeOf({ cwd = process.cwd(), exec = run, rules = settings } = {}) {
  const git = args => exec('git', args, { cwd, stdio: ['ignore', 'pipe', 'ignore'], timeout: 5_000 });
  const clean = value => String(value ?? '').replace(/[^\x20-\x7e]/g, '').trim().slice(0, rules.agent_card.place_chars) || null;
  const top = git(['rev-parse', '--show-toplevel', '--abbrev-ref', 'HEAD']);
  if (top.status !== 0) return {};
  const [folder = '', head = ''] = String(top.stdout).trim().split('\n');
  const remote = git(['config', '--get', 'remote.origin.url']);
  const fromRemote = remote.status === 0 ? String(remote.stdout).trim().replace(/\/+$/, '').split(/[/:]/).pop().replace(/\.git$/, '') : '';
  return { repository: clean(fromRemote) ?? clean(basename(folder)), branch: head === 'HEAD' ? null : clean(head) };
}

// ── The account key ──────────────────────────────────────────────────────────────────────────────────────────────


/**
 * Where this computer keeps the key: the macOS Keychain item, else the 0600 file. `exec` is spawnSync's shape.
 * With `account` (an account id) the key is that account's own Keychain entry (`<keychain_account>:<id>`) or file (`<key_file>.<id>`),
 * so several accounts on one computer never overwrite each other; with none it is the single entry it has always been.
 */
/** `value` when it is a credential of a kind the door takes (command.json `bearers.shapes`), else null. Nothing here names a
 *  prefix: a new kind of key or token is a new row. */
export const bearerOf = (value, rules = settings) => (typeof value === 'string' && rules.bearers.shapes.some(row => new RegExp(row.pattern).test(value)) ? value : null);

export function keyStore({ rules = settings, home = homedir(), platform = process.platform, exec = run, account = null } = {}) {
  if (account !== null && !/^[A-Za-z0-9_-]{1,80}$/.test(String(account))) throw new CommandError('An account id is letters, digits, dashes and underscores.');
  const file = account === null ? expand(rules.key_file, home) : `${expand(rules.key_file, home)}.${account}`;
  const holder = account === null ? rules.keychain_account : `${rules.keychain_account}:${account}`;
  const keychain = platform === 'darwin';
  return {
    where: keychain ? `the Keychain item ${rules.keychain_item}${account === null ? '' : ` for ${account}`}` : file,
    read() {
      if (keychain) {
        const answer = exec('/usr/bin/security', ['find-generic-password', ...(account === null ? [] : ['-a', holder]), '-s', rules.keychain_item, '-w'], { stdio: ['ignore', 'pipe', 'ignore'] });
        const key = answer.status === 0 ? String(answer.stdout).trim() : '';
        return bearerOf(key, rules);
      }
      try { return bearerOf(readFileSync(file, 'utf8').trim(), rules); } catch { return null; }
    },
    // The value goes to `security -i` on standard input, never into an argument another process can list.
    write(key) {
      if (bearerOf(key, rules) === null) throw new CommandError('The account answered something that is not a key this command takes.');
      if (keychain) {
        const answer = exec('/usr/bin/security', ['-i'], { input: `add-generic-password -U -a ${holder} -s ${rules.keychain_item} -w ${key}\n`, stdio: ['pipe', 'ignore', 'pipe'] });
        if (answer.status !== 0) throw new CommandError(`The key could not be kept in the Keychain (${String(answer.stderr ?? '').trim() || answer.status}).`);
        return;
      }
      mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
      writeFileSync(`${file}.new`, `${key}\n`, { mode: 0o600 });
      renameSync(`${file}.new`, file);
      chmodSync(file, 0o600);
    },
    forget() {
      if (keychain) exec('/usr/bin/security', ['delete-generic-password', ...(account === null ? [] : ['-a', holder]), '-s', rules.keychain_item], { stdio: 'ignore' });
      else rmSync(file, { force: true });
    },
  };
}

/**
 * Where this computer keeps the sign-in `login` made (command.json `grant`): the Keychain item `grant.keychain_item`,
 * holding the sign-in as one base64url word written through `security -i` on standard input, else the 0600 file
 * `grant.file` in the state folder. `read()` answers { access_token, refresh_token, expires_at_ms, client_id, origin }
 * or null.
 */
export function grantStore({ rules = settings, home = homedir(), platform = process.platform, exec = run } = {}) {
  const file = join(expand(rules.state_folder, home), rules.grant.file);
  const keychain = platform === 'darwin';
  const decode = text => {
    try { const grant = JSON.parse(Buffer.from(String(text).trim(), 'base64url').toString('utf8')); return object(grant) && typeof grant.access_token === 'string' ? grant : null; } catch { return null; }
  };
  return {
    where: keychain ? `the Keychain item ${rules.grant.keychain_item}` : file,
    read() {
      if (keychain) {
        const answer = exec('/usr/bin/security', ['find-generic-password', '-a', rules.keychain_account, '-s', rules.grant.keychain_item, '-w'], { stdio: ['ignore', 'pipe', 'ignore'] });
        return answer.status === 0 ? decode(answer.stdout) : null;
      }
      try { return decode(readFileSync(file, 'utf8')); } catch { return null; }
    },
    write(grant) {
      const word = Buffer.from(JSON.stringify(grant)).toString('base64url');
      if (keychain) {
        const answer = exec('/usr/bin/security', ['-i'], { input: `add-generic-password -U -a ${rules.keychain_account} -s ${rules.grant.keychain_item} -w ${word}\n`, stdio: ['pipe', 'ignore', 'pipe'] });
        if (answer.status !== 0) throw new CommandError(rules.words.sign_in_not_kept, { detail: fill(rules.words.details.sign_in_not_kept, { why: String(answer.stderr ?? '').trim() || answer.status }) });
        return;
      }
      mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
      writeFileSync(`${file}.new`, `${word}\n`, { mode: 0o600 });
      renameSync(`${file}.new`, file);
      chmodSync(file, 0o600);
    },
    forget() {
      if (keychain) exec('/usr/bin/security', ['delete-generic-password', '-a', rules.keychain_account, '-s', rules.grant.keychain_item], { stdio: 'ignore' });
      else rmSync(file, { force: true });
    },
  };
}

const form = values => ({ method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(values).toString() });
async function asJson(response, what, rules = settings) {
  const value = await response.json().catch(() => ({}));
  if (!response.ok) throw new CommandError(rules.words.sign_in_step_failed, { detail: fill(rules.words.details.sign_in_step_failed, { what, why: value.error_description ?? value.error ?? response.status }) });
  return value;
}
// A renewal answer that brings no new refresh token leaves the kept one in place (RFC 6749 section 6: the server MAY issue a new
// one); dropping it signed this computer out an hour later (Nov 17 2026, 8:49 PM CST).
// `asked` is the scope the sign-in asked for when the person approved it, kept so a command that now asks for more signs in again
// (asksNothingNew); a renewal keeps what the first sign-in asked.
const grantOf = (tokens, { client_id, origin, now = Date.now, found, rules = settings, asked = null }) => ({ access_token: tokens.access_token, refresh_token: tokens.refresh_token ?? found?.refresh_token ?? null,
  expires_at_ms: Number.isFinite(tokens.expires_in) ? now() + tokens.expires_in * 1000 : null, client_id, origin,
  token_endpoint: found.token_endpoint, revocation_endpoint: found.revocation_endpoint ?? null, resource: found.resource, asked });

/** Whether a kept sign-in was asked for every scope this command asks for now (command.json `scope`). One kept before the
 *  asked scope was recorded, or asked for less, is not: `login` signs in again, so a scope added to the command reaches the
 *  person's next login without a flag (Nov 19 2026: grants:offer was added, and `login` kept the old sign-in). What the
 *  person approved is the server's to say; this compares what was asked, so choosing Read only does not make every login
 *  ask again. */
export const asksNothingNew = (grant, scope = settings.scope) => {
  const asked = new Set(typeof grant?.asked === 'string' ? grant.asked.split(' ').filter(Boolean) : []);
  return String(scope).split(' ').filter(Boolean).every(word => asked.has(word));
};

/** What the sign-in server says about itself and the resource it signs in to. The resource's RFC 9728 document is read from the
 *  door the program will call (`resourceDoor`, an MCP address; the issuer's own /mcp when none is given), never from the issuer's
 *  root; its `authorization_servers[0]` names the server whose RFC 8414 document gives the endpoints. */
export async function discover(origin, { fetchImpl = fetch, resourceDoor = `${origin}/mcp`, rules = settings } = {}) {
  const resource = await asJson(await fetchImpl(new URL(rules.protected_resource_path, resourceDoor)), 'Reading the sign-in resource', rules);
  if (typeof resource.resource !== 'string') throw new CommandError(rules.words.sign_in_step_failed, { detail: fill(rules.words.details.sign_in_step_failed, { what: 'Reading the sign-in resource', why: 'it names no resource' }) });
  const named = resource.authorization_servers?.[0];
  const issuer = typeof named === 'string' && URL.canParse(named) ? new URL(named).origin : origin;
  const server = await asJson(await fetchImpl(`${issuer}/.well-known/oauth-authorization-server`), 'Reading the sign-in server', rules);
  for (const name of ['authorization_endpoint', 'token_endpoint']) if (typeof server[name] !== 'string') throw new CommandError(rules.words.sign_in_step_failed, { detail: fill(rules.words.details.sign_in_step_failed, { what: 'Reading the sign-in server', why: `it names no ${name}` }) });
  return { authorization_endpoint: server.authorization_endpoint, token_endpoint: server.token_endpoint, revocation_endpoint: server.revocation_endpoint ?? null, resource: resource.resource };
}

/** A kept sign-in renewed at its origin's /oauth/token with its refresh token. A refused renewal means the sign-in ended. */
export async function refreshGrant(grant, { fetchImpl = fetch, rules = settings, now = Date.now } = {}) {
  const response = await fetchImpl(grant.token_endpoint, form({ grant_type: 'refresh_token', refresh_token: grant.refresh_token, client_id: grant.client_id }));
  if (response.status === 400 || response.status === 401) throw new CommandError(rules.words.sign_in_ended, { status: 3 });
  // A server that is busy or down has not ended the sign-in: say to wait, never to sign in again.
  if (response.status === 429 || response.status >= 500) throw new CommandError(rules.words.sign_in_busy, { status: 4, detail: fill(rules.words.details.sign_in_step_failed, { what: 'Renewing this computer\'s sign-in', why: response.status }) });
  return grantOf(await asJson(response, 'Renewing this computer\'s sign-in', rules), { client_id: grant.client_id, origin: grant.origin, now, rules, found: grant, asked: grant.asked ?? null });
}

const endsSoon = (grant, rules, now) => Boolean(grant.refresh_token) && Number.isFinite(grant.expires_at_ms) && grant.expires_at_ms - now() < rules.grant.refresh_before_seconds * 1000;

/** Runs `work` holding this computer's one sign-in lock (a folder made atomically in the state folder), so one renewal is in flight
 *  at a time across every process. A lock older than `lock_stale_seconds` is a dead process's and is taken over. */
async function withSignInLock(work, { rules = settings, home = homedir() } = {}) {
  const folder = expand(rules.state_folder, home);
  const lock = join(folder, rules.grant.lock);
  mkdirSync(folder, { recursive: true, mode: 0o700 });
  const until = Date.now() + rules.grant.lock_wait_seconds * 1000;
  for (;;) {
    try { mkdirSync(lock); break; } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      let age = 0;
      try { age = Date.now() - statSync(lock).mtimeMs; } catch { continue; }
      if (age > rules.grant.lock_stale_seconds * 1000 || Date.now() > until) { rmSync(lock, { recursive: true, force: true }); continue; }
      await pause(25 + Math.random() * 50);
    }
  }
  try { return await work(); } finally { rmSync(lock, { recursive: true, force: true }); }
}

/** The sign-in renewed once for every process that found it ending: under the lock the stored sign-in is read again and used if another
 *  process has renewed it; a refused renewal is read against the store again before it is called ended, since the process that won may
 *  have written the new one between. */
async function renewedGrant(grant, { grants, fetchImpl, rules, now, home }) {
  return withSignInLock(async () => {
    const stored = grants.read() ?? grant;
    if (!endsSoon(stored, rules, now)) return stored;
    try {
      const next = await refreshGrant(stored, { fetchImpl, rules, now });
      grants.write(next);
      return next;
    } catch (error) {
      const again = grants.read();
      if (again && again.refresh_token !== stored.refresh_token && !endsSoon(again, rules, now)) return again;
      // The server said the sign-in is over (400 or 401, not busy): keep that in the store, so no later run asks it again; a new login replaces it.
      if (error.status === 3) grants.write({ ...stored, ended: true });
      throw error;
    }
  }, { rules, home });
}

/** The credential for this run: {CLI}_KEY (a machine with no Keychain or file), else the sign-in
 *  login kept, else the kept key, renewed first when it ends within `grant.refresh_before_seconds`. { kind: 'key'|'sign-in', bearer, where,
 *  origin? }, or null when there is none. */
export async function credentialFor({ env = process.env, store = keyStore(), grants = grantStore(), fetchImpl = fetch, rules = settings, now = Date.now, home = homedir() } = {}) {
  if (env[rules.env.key]) {
    // A key the person put in {CLI}_KEY is sent as given or not at all: one of no declared kind is refused, never swapped for the kept key.
    if (bearerOf(env[rules.env.key], rules) === null) throw new CommandError(fill(rules.bearers.refused, { kinds: rules.bearers.shapes.map(row => row.kind).join(', ') }), { status: 2 });
    return { kind: 'key', bearer: env[rules.env.key], where: rules.env.key };
  }
  // A sign-in this person made (`{cli} login`) is the newer word: it comes before a key an app kept, which an engine that
  // admits only the sign-in tool's passes and API keys would refuse.
  let grant = grants.read();
  if (!grant) {
    const key = store.read();
    return key ? { kind: 'key', bearer: key, where: store.where } : null;
  }
  if (grant.ended === true) throw new CommandError(rules.words.sign_in_ended, { status: 3 });
  if (endsSoon(grant, rules, now)) grant = await renewedGrant(grant, { grants, fetchImpl, rules, now, home });
  return { kind: 'sign-in', bearer: grant.access_token, where: grants.where, origin: grant.origin, resource: grant.resource };
}

// ── The door ─────────────────────────────────────────────────────────────────────────────────────────────────────

/** The Mac app's local door on this computer (./local-door.mjs, run against the app command.json `mac_app` names),
 *  or null when this computer has none. */
export function findLocalDoor({ rules = settings } = {}) {
  try { return localDoorAddress({ runtime: join(rules.mac_app, 'Contents', 'MacOS', 'node') }); } catch { return null; }
}

/** The door this run talks to: `asked` (--origin or {CLI}_ORIGIN); else, for the account's key, the Mac app's local door
 *  when this computer has one; else the origin a sign-in was made at, else the declared address (`declared`, {CLI}_ORIGIN); with none the run is
 *  refused. { mcp, origin, name, local, public (the declared address), localMcp }: `localMcp` is this computer's local door, named when another door refuses the key. */
/** The sign-in servers (origins) a door names in its protected-resource document (RFC 9728); none when it does not answer. */
async function engineServersOf(door, { fetchImpl, rules }) {
  if (!door) return [];
  const document = await fetchImpl(new URL(rules.protected_resource_path, door)).then(answer => (answer.ok ? answer.json() : null)).catch(() => null);
  return (Array.isArray(document?.authorization_servers) ? document.authorization_servers : []).filter(name => typeof name === 'string' && URL.canParse(name)).map(name => new URL(name).origin);
}


export function doorFor({ asked = null, credential = null, declared = null, rules = settings, localMcp = findLocalDoor({ rules }) } = {}) {
  // The engine a run talks to: the one asked for (--origin, {CLI}_ORIGIN); else, for a kept key, this computer's own; else, for a sign-in,
  // the one its pass was made for (`resource`: the pass names it, so no host is compared and no other engine is tried); else the declared
  // address, else the sign-in site's own engine (the public origin the Mac app declares), else none: the run is refused.
  const mcp = asked ? `${asked}/mcp`
    : credential?.kind === 'key' && localMcp ? localMcp
    : credential?.kind === 'sign-in' ? credential.resource ?? `${credential.origin}/mcp`
    : declared ? `${declared}/mcp` : null;
  if (mcp === null) throw new CommandError(rules.words.no_origin, { status: 2 });
  const origin = new URL(mcp).origin;
  if (mcp === localMcp) return { mcp, origin, localMcp, name: rules.words.local_door, local: true, public: false };
  const isPublic = origin === declared;
  return { mcp, origin, localMcp, name: isPublic ? rules.words.public_door : rules.words.named_door, local: false, public: isPublic };
}

/** The unix socket this computer's engine answers `POST /persons/add` on, read from its computer config (command.json
 *  `computer_config_files`, `agent_socket`); null when this computer has no engine config. */
export function findAgentSocket({ rules = settings, home = homedir() } = {}) {
  for (const file of rules.computer_config_files) {
    try {
      const socket = JSON.parse(readFileSync(expand(file, home), 'utf8')).agent_socket;
      if (typeof socket === 'string' && socket) return socket;
    } catch { /* not this one */ }
  }
  return null;
}

/** This computer's engine config: the first of `computer_config_files` that reads as JSON, else null. */
export function engineConfigHere({ rules = settings, home = homedir() } = {}) {
  for (const file of rules.computer_config_files) {
    try { return JSON.parse(readFileSync(expand(file, home), 'utf8')); } catch { /* not this one */ }
  }
  return null;
}

/** Where a raw upload is sent on this computer: the door's own address at this computer's engine, when that engine listens on a
 *  loopback address and answers for the door's host (its config's `listen` and a door whose `accepts_hosts` names it). Only the
 *  computer that holds the person spools the bytes (a door that passes calls on to it answers `uploads_not_taken_here`), and the
 *  bytes then never leave this computer. Answers { url, host }, or null when this computer runs no such engine. */
export function uploadDoorHere(door, { config = engineConfigHere() } = {}) {
  if (!config || door.local) return null;
  const at = new URL(door.mcp);
  const listen = typeof config.listen === 'string' ? config.listen : '';
  if (!/^127\.0\.0\.1:\d{2,5}$/.test(listen)) return null;
  const answers = (config.doors ?? []).some(row => Array.isArray(row?.accepts_hosts) && row.accepts_hosts.includes(at.host));
  return answers ? { url: `http://${listen}${at.pathname}`, host: at.host } : null;
}

/** One POST to `url` naming `host` as its Host (fetch cannot), answered as a fetch Response. */
export function postNamingHost(url, host, { headers, body, signal }) {
  return new Promise((resolve, reject) => {
    const request = httpRequest(url, { method: 'POST', headers: { ...headers, host }, signal }, response => {
      const chunks = [];
      response.on('data', chunk => chunks.push(chunk));
      response.on('end', () => resolve(new Response(Buffer.concat(chunks), { status: response.statusCode, headers: { 'content-type': response.headers['content-type'] ?? 'application/json' } })));
      response.on('error', reject);
    });
    request.on('error', reject);
    request.end(body);
  });
}

/** Where this computer keeps the carrier's key (command.json `carry`): the Keychain item `carry.keychain_item`, holding
 *  { private, public } as one base64url word written through `security -i` on standard input, else the 0600 file
 *  `carry.key_file` in the state folder. */
export function carrierKeyStore({ rules = settings, home = homedir(), platform = process.platform, exec = run } = {}) {
  const file = join(expand(rules.state_folder, home), rules.carry.key_file);
  const keychain = platform === 'darwin';
  const decode = text => {
    try { const key = JSON.parse(Buffer.from(String(text).trim(), 'base64url').toString('utf8')); return object(key) && typeof key.private === 'string' && typeof key.public === 'string' ? key : null; } catch { return null; }
  };
  return {
    read() {
      if (keychain) {
        const answer = exec('/usr/bin/security', ['find-generic-password', '-a', rules.keychain_account, '-s', rules.carry.keychain_item, '-w'], { stdio: ['ignore', 'pipe', 'ignore'] });
        return answer.status === 0 ? decode(answer.stdout) : null;
      }
      try { return decode(readFileSync(file, 'utf8')); } catch { return null; }
    },
    write(key) {
      const word = Buffer.from(JSON.stringify(key)).toString('base64url');
      if (keychain) {
        const answer = exec('/usr/bin/security', ['-i'], { input: `add-generic-password -U -a ${rules.keychain_account} -s ${rules.carry.keychain_item} -w ${word}\n`, stdio: ['pipe', 'ignore', 'pipe'] });
        if (answer.status !== 0) throw new CommandError(fill(rules.words.not_carried, { why: String(answer.stderr ?? '').trim() || answer.status }));
        return;
      }
      mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
      writeFileSync(`${file}.new`, `${word}\n`, { mode: 0o600 });
      renameSync(`${file}.new`, file);
      chmodSync(file, 0o600);
    },
  };
}

/** The carrier module (command.json `carry.modules`, packed or beside this tool), or null when neither is here. */
async function loadCarrier(rules = settings) {
  for (const path of rules.carry.modules) {
    const url = new URL(path, import.meta.url);
    if (existsSync(url)) return import(url.href);
  }
  return null;
}

/** The doors a computer holds, as its announcement names them: each name reported with exactly one port. A name reported with
 *  two different ports is not held (trillion-rust src/tool_runs/reach.rs `Have::held`), so it is not sent. */
export function heldDoors(entries) {
  const ports = new Map();
  for (const [name, port] of entries) ports.set(name, new Set([...(ports.get(name) ?? []), port]));
  return [...ports].filter(([, set]) => set.size === 1).map(([name, set]) => ({ name, port: [...set][0] }));
}

/** This computer's `have` for its announcement, built from what its engine config's `report` says of itself: its local ports
 *  and its label. It sends only what the engine accepts (trillion-rust src/tool_runs/reach.rs `Have::parse`): a door name of
 *  1 to 64 lowercase letters, digits and '-', a port from 1 to 65535, and a label of 1 to 128 characters with no control
 *  character. */
export function haveOf(report = {}, offers) {
  const doors = heldDoors(Object.entries(report?.local_ports ?? {}))
    .filter(({ name, port }) => /^[a-z0-9-]{1,64}$/.test(name) && Number.isInteger(port) && port >= 1 && port <= 65535);
  const label = report?.label;
  const named = typeof label === 'string' && [...label].length >= 1 && [...label].length <= 128 && !/\p{Cc}/u.test(label);
  const have = named ? { doors, label } : { doors };
  // What the engine offers tool runs (its /readyz `offers`, capability ids): a meeting point sends a row's call only to a
  // computer that offers what the row declares (trillion-rust reach.rs `Have::offers`). Not known: not said.
  if (Array.isArray(offers) && offers.length <= 64 && offers.every(id => typeof id === 'string' && /^[a-z0-9-]{1,64}$/.test(id))) have.offers = [...new Set(offers)].sort();
  return have;
}

/** The capability ids the engine listening at `listen` offers (its /readyz `offers`), or undefined when it does not say. */
export async function offersHere(listen, { fetchImpl = fetch, timeoutMs = 3000 } = {}) {
  try {
    const answer = await fetchImpl(`http://${listen}/readyz`, { signal: AbortSignal.timeout(timeoutMs) });
    const said = await answer.json();
    return Array.isArray(said?.offers) ? said.offers : undefined;
  } catch { return undefined; }
}

/** Carries this computer to the meeting point of the site this command came from (command.json `carry`) when it runs its own
 *  engine: makes the carrier's key once, and installs the carrier under this computer's init row. Answers what the install
 *  answered, or null when this computer runs no engine, came from no site, or has no carrier. */
export async function carryThisComputer(context, { rules = settings, home = homedir(), platform = process.platform, exec = run, load = loadCarrier, program = null, readOffers = offersHere } = {}) {
  const engine = engineConfigHere({ rules, home });
  const listen = engine?.listen;
  const site = context.state.site();
  if (typeof listen !== 'string' || !site) return null;
  const carrier = await load(rules);
  if (!carrier) return null;
  const way = carrier.WAYS.find(row => row.id === rules.carry.way);
  const state = join(expand(rules.state_folder, home), rules.carry.state);
  const keys = carrierKeyStore({ rules, home, platform, exec });
  let key = keys.read();
  if (!key) { key = carrier.makeKey(way, { state }); keys.write(key); }
  // The carrier runs this very program as it was invoked: the command learns its name, and so its sign-in, from the file
  // it runs as, so the program file under another name (command.mjs) would be signed in to nobody.
  const self = program ?? [process.execPath, process.argv[1] ? resolvePath(process.argv[1]) : fileURLToPath(import.meta.url)];
  const { announce } = rules.carry;
  return carrier.installCarrier({
    label: rules.carry.label, way, relay_host: { id: 'site', hostname: new URL(site).hostname },
    computer_id: Buffer.from(blake3(new TextEncoder().encode(key.public))).toString('hex').slice(0, 16), local_port: Number(listen.split(':').at(-1)),
    values: { public_key: key.public, have: JSON.stringify(haveOf(engine.report, await readOffers(listen))) }, credential_command: [...self, 'carrier-key'],
    announce: { argv: [...self, 'op', '--origin', site, '--address', announce.address, announce.method, announce.input], every_seconds: announce.every_seconds, settle_seconds: announce.settle_seconds, gives: announce.gives },
  }, state);
}

/** One line for `login` about carrying this computer: said only when it was carried, or when carrying it failed. */
async function carriedWords(context) {
  if (!context.carry) return '';
  try { return (await context.carry()) ? `\n${settings.words.carried}` : ''; } catch (error) { return `\n${fill(settings.words.not_carried, { why: error.message })}`; }
}

/** Asks this computer's engine to hold the person the pass or key names: `POST /persons/add` on the engine's own unix socket,
 *  which it serves only to the same user on this computer, as this login is. Answers { person, added }; null when this computer
 *  has no engine socket; a CommandError saying why when the engine refused or does not answer. */
export async function addPersonHere({ socket, bearer, rules = settings }) {
  if (!socket) return null;
  const reply = await new Promise((resolve, reject) => {
    const request = httpRequest({ socketPath: socket, path: '/persons/add', method: 'POST', headers: { authorization: `Bearer ${bearer}`, host: 'localhost' } }, response => {
      const chunks = [];
      response.on('data', chunk => chunks.push(chunk));
      response.on('end', () => resolve({ status: response.statusCode, text: Buffer.concat(chunks).toString('utf8') }));
    });
    request.on('error', reject);
    request.end();
  }).catch(error => { throw new CommandError(rules.words.not_running, { status: 4, detail: fill(rules.words.details.not_running_engine, { url: socket, why: error.code ?? error.message }) }); });
  let answer = {};
  try { answer = JSON.parse(reply.text); } catch { /* no JSON body */ }
  if (reply.status < 200 || reply.status > 299) throw Object.assign(new CommandError(reply.status === 401 ? rules.words.refused : rules.words.not_taken_in, { status: reply.status === 401 ? 3 : 4, detail: fill(rules.words.details.not_taken_in, { url: socket, status: reply.status, why: answer.error ?? 'refused' }) }), { notTaken: true, why: typeof answer.why === 'string' ? answer.why : null });
  return answer;
}

// ── The MCP road ─────────────────────────────────────────────────────────────────────────────────────────────────

/** Every JSON-RPC reply in one answer body: plain JSON or server-sent events. */
export function repliesOf(raw) {
  const text = String(raw ?? '').trim();
  if (!text) return [];
  if (text.startsWith('{') || text.startsWith('[')) return [JSON.parse(text)].flat();
  return text.split('\n').filter(line => line.startsWith('data:')).map(line => JSON.parse(line.slice(5)));
}

/** What a tools/call result says: its structured answer, else its text read as JSON, else the text. */
export function answerOf(result) {
  if (object(result?.structuredContent)) return result.structuredContent;
  const text = (result?.content ?? []).filter(item => item?.type === 'text').map(item => item.text).join('\n');
  try { return JSON.parse(text); } catch { return { text }; }
}

/** Seconds to wait before the next try after try number `attempt` (from 0): the gap doubles from retry.first_seconds up to
 *  retry.most_seconds (a door's own retry_after_seconds, when it gave one, replaces the doubled gap, under the same top),
 *  then is cut down by up to retry.jitter of itself. */
export function retryGap(retry, attempt, asked = null, random = Math.random) {
  const grown = Number.isFinite(asked) && asked >= 0 ? asked : retry.first_seconds * 2 ** attempt;
  return Math.min(retry.most_seconds, grown) * (1 - retry.jitter * random());
}

/**
 * One account's door: `rpc(method, params)`, `tool(name, args)`, `op(address, method, input)` (one do_one_thing_in_my_account
 * with one request_key, reused on every retry) and `whoami()` (MCP initialize: the account in result._meta). A refusal
 * names the door: 401 is the door refusing this credential, 404 is a route the door does not serve.
 */
export function engineClient({ door, credential, fetchImpl = fetch, rules = settings, wait = pause, random = Math.random, timeoutSeconds = rules.retry.attempt_seconds, renew = null, uploadAt = null, postAt = postNamingHost } = {}) {
  if (!credential?.bearer) throw new CommandError(rules.words.no_credential, { status: 3 });
  const headers = { 'content-type': 'application/json', accept: 'application/json, text/event-stream', authorization: `Bearer ${credential.bearer}`, 'user-agent': `${cliName()}-cli` };
  let next = 0, renewed = false;
  // One try waits this many seconds (--timeout); the call itself ends only when retry.count tries are spent.
  const signal = () => AbortSignal.timeout(timeoutSeconds * 1000);
  const gap = (attempt, asked = null) => retryGap(rules.retry, attempt, asked, random);
  const refused = () => credential.kind === 'sign-in' && !door.local && !audiencesOf(credential.bearer).includes(door.mcp)
    ? new CommandError(rules.words.not_covered, { status: 3, detail: fill(rules.words.details.not_covered, { mcp: door.mcp }) })
    : new CommandError(credential.kind === 'key' && !door.local && door.localMcp !== door.mcp && (door.public || door.localMcp)
    ? rules.words.refused_key_at_door : rules.words.refused, { status: 3, detail: fill(rules.words.details.refused, { mcp: door.mcp, kind: credential.kind, where: credential.where }) });
  // `also` (a raw upload's own headers) is laid over a copy; every other request sends the one `headers` a renewed sign-in updates.
  async function send(body, { idempotent, once = false, also = null }) {
    for (let attempt = 0; ; attempt += 1) {
      let response = null, failure = null;
      // A raw upload goes to the computer that holds the person when this is it (`uploadAt`, uploadDoorHere), else to the door.
      const post = also && uploadAt ? () => postAt(uploadAt.url, uploadAt.host, { headers: { ...headers, ...also }, body, signal: signal() })
        : () => fetchImpl(door.mcp, { method: 'POST', headers: also ? { ...headers, ...also } : headers, body, signal: signal() });
      try { response = await post(); } catch (error) { failure = error; }
      const passing = failure || response.status === 429 || response.status >= 500;
      // Every try carries the same request_key, so a try after a lost or slow answer is answered as the first was.
      if (passing && !once && attempt < rules.retry.count) { await wait(gap(attempt) * 1000); continue; }
      // A call sent `once` is still sent again, one time after the first retry gap, when its connection ended before any
      // answer (not a timeout): a front door that reloads closes its idle kept-alive connections, and a call already on one is
      // lost unread (RFC 9110 9.2.2 lets a client resend an idempotent request then). The gap lets the other kept connections
      // the reload closed be seen closed, so the resend is not lost on one of them too. The gateway's reload at 9:05:50 AM CST
      // Nov 20 2026 ended 3 such requests; `whoami` was one call that never tried again.
      if (failure && failure.name !== 'TimeoutError' && once && idempotent && attempt === 0) { await wait(gap(attempt) * 1000); continue; }
      const maybe = idempotent ? '' : ' It may have happened; read it back before trying again.';
      if (failure?.name === 'TimeoutError') throw new CommandError(fill(rules.words.no_answer, { which: door.name, tries: attempt + 1 }) + maybe, { status: 4, detail: fill(rules.words.details.no_answer, { mcp: door.mcp, seconds: timeoutSeconds, tries: attempt + 1 }) });
      if (failure) {
        const why = failure.cause?.code ?? failure.message;
        throw door.local ? new CommandError(rules.words.not_running, { status: 4, detail: fill(rules.words.details.not_running, { mcp: door.mcp, why }) })
          : new CommandError(fill(rules.words.unreachable, { which: door.name }) + maybe, { status: 4, detail: fill(rules.words.details.unreachable, { mcp: door.mcp, why }) });
      }
      // A sign-in read when the command started may end while it runs (a sign-in it waits on for minutes): the door's 401 is
      // answered by renewing it once (`renew`, the kept sign-in read again and renewed when it ends) and sending again.
      if (response.status === 401 && renew && !renewed) {
        renewed = true;
        const fresh = await renew().catch(() => null);
        if (fresh?.bearer && fresh.bearer !== credential.bearer) { credential = fresh; headers.authorization = `Bearer ${fresh.bearer}`; continue; }
      }
      if (response.status === 401) throw refused();
      if (response.status === 404) throw new CommandError(fill(rules.words.missing_route, { which: door.name }), { status: 4, detail: fill(rules.words.details.missing_route, { mcp: door.mcp, route: new URL(door.mcp).pathname }) });
      if (passing || !response.ok) throw new CommandError(fill(rules.words.unreachable, { which: door.name }) + maybe, { status: 4, detail: fill(rules.words.details.answered, { mcp: door.mcp, status: response.status }) });
      return response;
    }
  }
  // A call that carries a file (`upload`, its bytes) is one raw upload: the file is the body, sent as an octet stream, and the
  // JSON-RPC message rides in the `X-Call` header as base64url (the engine's src/mcp/upload.rs); the door spools the body and
  // hands it to the session call as its row's `byte_argument`. Every other call is the message as a JSON body.
  async function rpc(method, params, { idempotent = true, once = false, upload = null } = {}) {
    const id = (next += 1);
    const message = JSON.stringify({ jsonrpc: '2.0', id, method, params });
    const response = upload
      ? await send(upload, { idempotent, once, also: { 'content-type': 'application/octet-stream', 'x-call': Buffer.from(message).toString('base64url') } })
      : await send(message, { idempotent, once });
    const text = await response.text();
    let reply;
    try { reply = repliesOf(text).find(item => item?.id === id); } catch { reply = null; }
    if (!reply) throw new CommandError(fill(rules.words.unreachable, { which: door.name }), { status: 4, detail: fill(rules.words.details.no_reply, { mcp: door.mcp, status: response.status, method }) });
    if (reply.error) throw new CommandError(reply.error.message ?? fill(rules.words.refused_code, { which: door.name }), { answer: reply.error, detail: fill(rules.words.details.answered, { mcp: door.mcp, status: `an error to ${method}` }) });
    return reply.result;
  }
  // An engine older than trillion-rust 9133c735e refuses a call that carries `need` (engine.need_refusal) before any effect.
  // That one refusal sends the same call once more without `need`; from then on the call is sent without it. Any other
  // refusal is thrown as it was.
  const refusesNeed = (error, sent) => Object.hasOwn(sent, 'need') && error?.answer?.code === rules.engine.need_refusal.code
    && error.answer.message === rules.engine.need_refusal.message;
  async function tool(name, args, { idempotent = false, upload = null } = {}) {
    let sent = args;
    const send = () => rpc('tools/call', { name, arguments: sent }, { idempotent, upload });
    for (let attempt = 0; ; attempt += 1) {
      const result = await send().catch(error => {
        if (!refusesNeed(error, sent)) throw error;
        sent = Object.fromEntries(Object.entries(sent).filter(([key]) => key !== 'need'));
        return send();
      });
      const answer = answerOf(result);
      if (!result?.isError) return answer;
      const error = answer?.error ?? {};
      // The engine names why in a code (structuredContent.code); its words say which door refused what.
      const code = answer?.code ?? error.code ?? null;
      // The same request_key rides on every attempt, so a retried call is answered as the first one was.
      if ((error.retryable === true || rules.retry.codes.includes(code)) && attempt < rules.retry.count) { await wait(gap(attempt, error.retry_after_seconds) * 1000); continue; }
      const words = code ? rules.words.codes[code] ?? rules.words.refused_code : null;
      // The engine names the step that refused in `cause` (file, line, and the error); the message names the door and the code.
      const cause = typeof answer?.cause === 'string' ? ` Cause: ${answer.cause}` : '';
      const said = words ? fill(words, { which: door.name, code, tool: args?.input?.tool ?? name }) : null;
      // The engine's own words for its code (`detail`, its words.json) come first; this command's table is for an engine that sends none.
      const told = typeof answer?.detail === 'string' && answer.detail ? answer.detail : null;
      throw Object.assign(new CommandError(error.message ?? told ?? said ?? answer?.text ?? fill(rules.words.refused_code, { which: door.name }), { answer, detail: `${fill(rules.words.details.refused_code, { mcp: door.mcp, tool: name, code: code ?? 'no code' })}${cause}` }), { code });
    }
  }
  // A call names its method; the engine finds the owner by it. An address is sent only when one is given: to pass a method
  // on to a computer whose own owner answers it (a meeting point's announce). A route (`need`, `pins`: see routeOf) is sent
  // only when given, so every other call's envelope is unchanged.
  const op = (address, method, input = {}, { idempotent = false, requestKey = randomUUID(), route = {}, upload = null } = {}) =>
    tool(rules.engine.tool, { ...(address ? { address } : {}), method, request_key: requestKeyForEngine(requestKey), input, ...route }, { idempotent, upload });
  async function whoami() {
    const result = await rpc('initialize', { protocolVersion: rules.engine.protocol_version, capabilities: {}, clientInfo: { name: rules.client_name, version: rules.client_version } }, { once: true });
    // Whose account answered: the engine names it under `<its site, reversed>/account`, or `account` when it names no
    // product; no product's name is kept here (engine.account_meta is the key's last part).
    const named = Object.entries(result?._meta ?? {}).find(([key, value]) => (key === rules.engine.account_meta || key.endsWith(`/${rules.engine.account_meta}`)) && typeof value?.account_id === 'string');
    const account = named?.[1].account_id;
    if (typeof account !== 'string' || !account) throw new CommandError(rules.words.no_account, { status: 4, detail: fill(rules.words.details.no_account, { mcp: door.mcp }) });
    return { account, server: result.serverInfo ?? null, capabilities: result.capabilities ?? {} };
  }
  return { rpc, tool, op, whoami, door, credential, wait };
}

/** Every row of a paged engine list: `op` again with `after` set to each page's `next` until it is null. A pager that
 *  answers a `next` it already gave never ends, so it is refused, and so is one past `engine.most_pages` pages. */
export async function allPages(client, address, method, input, field, rules = settings) {
  const rows = [], seen = new Set();
  let after = null;
  for (let page = 0; page < rules.engine.most_pages; page += 1) {
    const answer = await client.op(address, method, after === null ? input : { ...input, after }, { idempotent: true });
    rows.push(...(Array.isArray(answer?.[field]) ? answer[field] : []));
    const next = answer?.next ?? null;
    if (next === null) return rows;
    if (seen.has(next) || next === after) throw new CommandError(rules.words.pager_stuck, { status: 4, detail: fill(rules.words.details.pager_stuck, { method, next: short(next, 80) }) });
    seen.add(next);
    after = next;
  }
  throw new CommandError(rules.words.too_many_pages, { status: 4, detail: fill(rules.words.details.too_many_pages, { method, pages: rules.engine.most_pages }) });
}

/** The BLAKE3 of bytes as the door names it: 64 hex digits, the content identity's `1f:` prefix taken off. */
const blake3Hex = bytes => makeHashCodeHexFromBytes(bytes).slice('1f:'.length);

/** The byte page an answer is, or null: an answer too large for one reply comes as
 *  `{byte_page: {offset, length, total, next_after_byte, blake3, base64}}`, whatever operation gave it. */
const bytePageOf = answer => (object(answer) && object(answer.byte_page) ? answer.byte_page : null);

/**
 * The whole of a byte-paged answer. `first` is the answer to `op(address, method, input)` under `requestKey`; every
 * further page is the same operation under the SAME request key with `after_byte` beside the input's own fields, set to
 * the page's `next_after_byte`, until offset + length is the total. The engine answers those from the first call's
 * receipt, never by running it again. Each page must continue where the last ended and name the first page's total and
 * BLAKE3; the joined bytes must be that many and hash to that BLAKE3, or nothing is answered. The bytes are read as
 * JSON, else answered as text.
 */
async function wholeAnswer(client, address, method, input, first, { requestKey, rules = settings, route = {} } = {}) {
  const broken = why => new CommandError(rules.words.byte_page_broken, { status: 4, detail: fill(rules.words.details.byte_page_broken, { method, why }) });
  const head = bytePageOf(first);
  const { total, blake3 } = head;
  if (!Number.isInteger(total) || total < 0) throw broken('no whole size');
  if (typeof blake3 !== 'string' || !/^[0-9a-f]{64}$/i.test(blake3)) throw broken('no BLAKE3');
  const parts = [];
  let page = head, at = 0;
  for (let count = 1; ; count += 1) {
    if (page.offset !== at) throw broken(`a page starts at byte ${page.offset}, not ${at}`);
    if (page.total !== total || String(page.blake3).toLowerCase() !== blake3.toLowerCase()) throw broken('a page belongs to another answer');
    const bytes = Buffer.from(typeof page.base64 === 'string' ? page.base64 : '', 'base64');
    if (bytes.length !== page.length) throw broken(`a page says ${page.length} bytes and holds ${bytes.length}`);
    if (!bytes.length && at < total) throw broken(`an empty page at byte ${at} of ${total}`);
    parts.push(bytes);
    at += bytes.length;
    if (at > total) throw broken(`the pages hold more than ${total} bytes`);
    if (at === total) break;
    if (page.next_after_byte !== at) throw broken(`next_after_byte is ${page.next_after_byte ?? 'null'} at byte ${at} of ${total}`);
    if (count >= rules.engine.most_pages) throw new CommandError(rules.words.too_many_pages, { status: 4, detail: fill(rules.words.details.too_many_pages, { method, pages: rules.engine.most_pages }) });
    const next = await client.op(address, method, { ...input, after_byte: at }, { idempotent: true, requestKey, route });
    page = bytePageOf(next);
    if (!page) throw broken(`the page after byte ${at} is not a byte_page`);
  }
  const joined = Buffer.concat(parts);
  const got = blake3Hex(joined);
  if (got !== blake3.toLowerCase()) throw new CommandError(rules.words.byte_page_mismatch, { status: 4, detail: fill(rules.words.details.byte_page_mismatch, { method, bytes: joined.length, got, want: blake3 }) });
  const text = joined.toString('utf8');
  try { return JSON.parse(text); } catch { return text; }
}

/** The bytes of the file `--upload` names, sent as the call's raw body (one piece: the engine takes at most
 *  `direct_calls.upload_most_bytes` in one body, so a larger file is sent as pieces, each its own call); null without the flag. */
export function uploadOf(path, rules = settings) {
  if (path === undefined) return null;
  if (typeof path !== 'string' || !path) throw new CommandError(rules.words.upload_needs_a_file, { status: 2 });
  let bytes;
  try { bytes = readFileSync(path); } catch (error) { throw new CommandError(fill(rules.words.upload_unreadable, { path, why: error.code ?? error.message }), { status: 2 }); }
  if (bytes.length > rules.direct_calls.upload_most_bytes) throw new CommandError(fill(rules.words.upload_too_large, { path, bytes: bytes.length, most: rules.direct_calls.upload_most_bytes }), { status: 2 });
  return bytes;
}

/** One operation answered whole: `op` under one request key for the call and every page of its answer, and when the
 *  answer is a byte page, every page after it (wholeAnswer). */
export async function opWhole(client, address, method, input, { requestKey = randomUUID(), rules = settings, route = {}, upload = null } = {}) {
  try {
    return await opWholeOnce(client, address, method, input, { requestKey, rules, route, upload });
  } catch (error) {
    // Every refusal names the key it was sent under, so a caller can quote it. A call that times out may still have landed under
    // this key: the same key answers it, so the way to ask again is the key.
    const line = fill(rules.words.request_key_line, { key: requestKey });
    const hint = error instanceof CommandError && error.status === 4 ? ` ${fill(rules.words.retry_with_key, { key: requestKey, flag: '--request-key' })}` : '';
    if (error instanceof CommandError) {
      throw Object.assign(new CommandError(`${error.message} ${line}${hint}`, { status: error.status, detail: error.detail }), { answer: error.answer, code: error.code });
    }
    throw error;
  }
}

async function opWholeOnce(client, address, method, input, { requestKey, rules, route, upload }) {
  // A write the engine keeps answers accepted and pending until its writer settles it: the same key then answers the outcome, or the
  // writer's refusal, which the call throws. The wait is settled-write.mjs, so no write is reported as kept while pending.
  const first = await settledWrite(answerKey => client.op(address, method, input, { requestKey: answerKey, route, upload }), requestKey, {
    sleep: client.wait,
    pending: answer => answer?.accepted === true && answer?.pending === true,
    expired: () => new CommandError(rules.words.write_pending, { status: 4 }),
  });
  return bytePageOf(first) ? wholeAnswer(client, address, method, input, first, { requestKey, rules, route }) : first;
}

// ── Signing in once ──────────────────────────────────────────────────────────────────────────────────────────────

/** The page the browser is sent to when the sign-in ends: the sign-in tool's own (`client.done_path`), the one owner of its look and words. */
const donePage = (origin, result, rules = settings) => `${origin}${rules.client.done_path}?result=${result}`;

const base64url = bytes => Buffer.from(bytes).toString('base64url');

/** A PKCE pair (RFC 7636, S256 as OAuth requires) and the state that ties the browser's answer to this login. */
export function pkce(random = randomBytes) {
  const verifier = base64url(random(32));
  return { verifier, challenge: createHash('sha256').update(verifier).digest('base64url'), state: base64url(random(16)) };
}

/** The account's own browser sign-in: this program is a client of the sign-in server by its Client ID Metadata Document (the
 *  https address `origin` + `client.id_path`, which lists the one loopback redirect `client.redirect_port` listens on), so nothing is
 *  registered. It reads the server's endpoints (`discover`), opens its authorize address with PKCE and the resource the
 *  server names, takes the code on that loopback address and exchanges it. Answers the sign-in (grantOf: access and refresh
 *  tokens, when the access token ends, the client id, the origin, the endpoints and the account the pass names), kept by the
 *  caller. `open(url)` shows the page; the person signs in there. */
/** One line typed into this terminal, when it is one (a pasted address); never answers when it is not. */
function typedLine() {
  if (!process.stdin.isTTY) return { line: new Promise(() => {}), stop: () => {} };
  const reader = createInterface({ input: process.stdin });
  return { line: new Promise(resolve => reader.once('line', resolve)), stop: () => reader.close() };
}

export async function signInWithBrowser({ origin, resourceDoor, rules = settings, fetchImpl = fetch, open = openInBrowser, now = Date.now, say = text => process.stderr.write(`${text}\n`), typed = typedLine } = {}) {
  if (!origin) throw new CommandError(rules.words.no_origin, { status: 2 });
  const found = await discover(origin, { fetchImpl, resourceDoor, rules });
  const { verifier, challenge, state } = pkce();
  let resolveCode, rejectCode;
  const arrived = new Promise((resolve, reject) => { resolveCode = resolve; rejectCode = reject; });
  const server = createServer((request, response) => {
    const url = new URL(request.url, 'http://127.0.0.1');
    if (url.pathname !== '/callback') { response.writeHead(404).end(); return; }
    // An answer that carries another sign-in's state is an old tab's: it is told so and ignored, and this run keeps waiting for its own.
    if (url.searchParams.get('state') !== state) { response.writeHead(302, { location: donePage(origin, 'old', rules) }).end(); return; }
    const done = url.searchParams.get('code');
    response.writeHead(302, { location: donePage(origin, done ? 'done' : 'failed', rules) }).end();
    if (done) resolveCode(url.searchParams.get('code'));
    else rejectCode(new CommandError(rules.words.sign_in_step_failed, { detail: fill(rules.words.sign_in_failed, { why: url.searchParams.get('error_description') ?? url.searchParams.get('error') ?? rules.words.sign_in_failed_unknown }) }));
  });
  // One sign-in waits at a time: the client document names one answer address, so a second run says so instead of failing raw.
  await new Promise((resolve, reject) => {
    server.once('error', error => reject(error.code === 'EADDRINUSE' ? new CommandError(rules.words.sign_in_waiting, { status: 4, detail: error.message }) : error));
    server.listen(rules.client.redirect_port ?? 0, '127.0.0.1', resolve);
  });
  const redirect = `http://127.0.0.1:${server.address().port}/callback`;
  try {
    const authorize = new URL(found.authorization_endpoint);
    for (const [name, value] of Object.entries({ response_type: 'code', client_id: `${origin}${rules.client.id_path}`, redirect_uri: redirect, code_challenge: challenge, code_challenge_method: 'S256', state, scope: rules.scope })) authorize.searchParams.set(name, value);
    authorize.searchParams.set('resource', found.resource);
    Promise.resolve().then(() => open(authorize.href)).catch(error => rejectCode(new CommandError(fill(rules.words.browser_not_opened, { link: authorize.href }), { detail: error.message.split('\n')[0] })));
    // A computer with no browser (a remote shell) opens nothing and says nothing: the link is always said, so the person can open it anywhere.
    say(fill(rules.words.open_this_link, { link: authorize.href }));
    // Signed in on another device (a phone, for a computer with no screen): its browser ends on this computer's answer address, which it
    // cannot reach; the person pastes that address here, and its code is taken as if it had arrived.
    const pasted = typed();
    pasted.line.then(line => {
      const url = URL.canParse(String(line).trim()) ? new URL(String(line).trim()) : null;
      if (!url || url.searchParams.get('state') !== state) return;
      if (url.searchParams.get('code')) resolveCode(url.searchParams.get('code'));
    });
    let timer;
    const late = new Promise((resolve, reject) => { timer = setTimeout(() => reject(new CommandError(fill(rules.words.sign_in_late, { seconds: rules.sign_in_wait_seconds }))), rules.sign_in_wait_seconds * 1000); });
    const code = await Promise.race([arrived, late]).finally(() => { clearTimeout(timer); pasted.stop(); });
    const tokens = await asJson(await fetchImpl(found.token_endpoint, form({ grant_type: 'authorization_code', code, redirect_uri: redirect, client_id: `${origin}${rules.client.id_path}`, code_verifier: verifier, resource: found.resource })), 'The sign-in exchange', rules);
    if (typeof tokens.access_token !== 'string' || !tokens.access_token) throw new CommandError(rules.words.sign_in_step_failed, { detail: fill(rules.words.details.sign_in_step_failed, { what: 'The sign-in exchange', why: 'no access token' }) });
    return grantOf(tokens, { client_id: `${origin}${rules.client.id_path}`, origin, now, found, rules, asked: rules.scope });
  } finally { server.close(); }
}

/** The tool-server sign-in module (command.json `connect.modules`, beside this tool in the Workshop copy), or null when it is
 *  not here. */
async function loadToolServerSignIn(rules = settings) {
  for (const path of rules.connect.modules) {
    const url = new URL(path, import.meta.url);
    if (existsSync(url)) return import(url.href);
  }
  return null;
}

/** `connect ADDRESS`: signs the person in to the remote tool server at ADDRESS (an MCP server's https address) so any AI can call
 *  its tools by that address. The sign-in module finds where the server's sign-in lives and registers this caller with this
 *  computer's loopback answer address (RFC 8252); the person signs in at the link said here; the code that comes back is traded
 *  by the person's engine (the trade tool keeps the tokens in their vault, so no token reaches this program); then the server's
 *  tools are listed by its address. Answers {connected, address, tools, unavailable?}. */
export async function connectToolServer(client, address, { rules = settings, origin = null, load = loadToolServerSignIn, open = openInBrowser, say = text => process.stderr.write(`${text}\n`), typed = typedLine } = {}) {
  if (typeof address !== 'string' || !URL.canParse(address) || new URL(address).protocol !== 'https:') throw new CommandError(rules.words.connect_needs_address, { status: 2 });
  const signIn = await load(rules);
  if (!signIn) throw new CommandError(fill(rules.words.connect_unavailable, { cli: cliName() }), { status: 3 });
  const found = await signIn.discover(address).catch(error => { throw new CommandError(error.message, { status: 4 }); });
  const fresh = signIn.freshSignIn();
  let resolveCallback;
  const arrived = new Promise(resolve => { resolveCallback = resolve; });
  const done = result => (origin ? { location: donePage(origin, result, rules) } : {});
  const server = createServer((request, response) => {
    const url = new URL(request.url, 'http://127.0.0.1');
    if (url.pathname !== '/callback') { response.writeHead(404).end(); return; }
    if (url.searchParams.get('state') !== fresh.state) { response.writeHead(origin ? 302 : 409, done('old')).end(); return; }
    response.writeHead(origin ? 302 : 200, done(url.searchParams.get('code') ? 'done' : 'failed')).end();
    resolveCallback(Object.fromEntries(url.searchParams));
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const redirect = `http://127.0.0.1:${server.address().port}/callback`;
  try {
    const clientId = await signIn.register(found, redirect, { name: rules.site?.name ?? cliName() }).catch(error => { throw new CommandError(error.message, { status: 4 }); });
    const link = signIn.authorizeAddress(found, clientId, redirect, fresh);
    Promise.resolve().then(() => open(link)).catch(() => {});
    say(fill(rules.words.open_this_link, { link }));
    // Signed in on another device: the person pastes the address its browser ended on.
    const pasted = typed();
    pasted.line.then(line => {
      const url = URL.canParse(String(line).trim()) ? new URL(String(line).trim()) : null;
      if (url && url.searchParams.get('state') === fresh.state) resolveCallback(Object.fromEntries(url.searchParams));
    });
    let timer;
    const late = new Promise((resolve, reject) => { timer = setTimeout(() => reject(new CommandError(fill(rules.words.sign_in_late, { seconds: rules.sign_in_wait_seconds }))), rules.sign_in_wait_seconds * 1000); });
    const callback = await Promise.race([arrived, late]).finally(() => { clearTimeout(timer); pasted.stop(); });
    const input = (() => { try { return signIn.tradeInput(found, clientId, redirect, fresh, callback); } catch (error) { throw new CommandError(error.message, { status: 4 }); } })();
    await client.op(null, rules.engine.tools_run, { tool: signIn.TRADE_TOOL, input });
    const listed = await client.op(null, rules.engine.tools_list, { address });
    return { connected: found.host, address, tools: (listed?.tools ?? []).map(tool => tool.id), ...(listed?.unavailable?.length ? { unavailable: listed.unavailable } : {}) };
  } finally { server.close(); }
}

/** Ends a sign-in this program made: its refresh token is revoked at the server's revocation endpoint, which ends the grant and
 *  every token it gave. */
export async function endSignIn(grant, { fetchImpl = fetch } = {}) {
  if (!grant?.refresh_token || !grant.revocation_endpoint) return;
  await fetchImpl(grant.revocation_endpoint, form({ token: grant.refresh_token, token_type_hint: 'refresh_token', client_id: grant.client_id })).catch(() => null);
}

function openInBrowser(url) {
  const opener = process.platform === 'darwin' ? ['/usr/bin/open', [url]] : process.platform === 'win32' ? ['cmd', ['/c', 'start', '', url]] : ['xdg-open', [url]];
  spawn(opener[0], opener[1], { stdio: 'ignore', detached: true }).on('error', () => {}).unref();
}

// ── Local state: the key this program made, and each task this AI took ────────────────────────────────────────────

export function stateOf({ rules = settings, home = homedir() } = {}) {
  const folder = expand(rules.state_folder, home);
  const path = name => join(folder, name);
  const read = name => { try { return JSON.parse(readFileSync(path(name), 'utf8')); } catch { return null; } };
  const write = (name, value) => { mkdirSync(folder, { recursive: true, mode: 0o700 }); writeFileSync(`${path(name)}.new`, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 }); renameSync(`${path(name)}.new`, path(name)); };
  return {
    // The `until` a tool run asked under `key` was sent with (`withUntil`), made by `make` the first time and kept, so the same
    // key asked again sends the same request; the newest `direct_calls.until_most` keys are kept.
    untilOf(key, make) {
      if (!key) return make();
      const kept = read(rules.direct_calls.until_file) ?? {};
      if (Number.isInteger(kept[key])) return kept[key];
      const until = make();
      write(rules.direct_calls.until_file, Object.fromEntries([...Object.entries(kept).filter(([name]) => name !== key), [key, until]].slice(-rules.direct_calls.until_most)));
      return until;
    },
    held: () => read(rules.held_file)?.held ?? {},
    // Kept per agent and task, so a task is moved as the id that took it, and this AI's record can say what it is doing.
    hold(agentId, task) {
      const held = read(rules.held_file)?.held ?? {};
      held[`${agentId} ${task.id}`] = { said: short(task.title ?? task.description ?? '', rules.agent_card.doing_chars) };
      write(rules.held_file, { held: Object.fromEntries(Object.entries(held).slice(-200)) });
    },
    letGo(agentId, taskId) {
      const held = read(rules.held_file)?.held ?? {};
      delete held[`${agentId} ${taskId}`];
      write(rules.held_file, { held });
    },
    // The site this command was installed from (`site_file`, written by that site's install line): where `login` signs in.
    site: () => { const origin = read(rules.site_file)?.origin; return typeof origin === 'string' && URL.canParse(origin) ? new URL(origin).origin : null; },
    keepSite: origin => write(rules.site_file, { origin }),
    connection: () => read(rules.connection.file),
    keepConnection: value => write(rules.connection.file, value),
    forgetConnection: () => rmSync(path(rules.connection.file), { force: true }),
    tasksStore: () => { const name = read(rules.tasks.store.file)?.credential_name; return typeof name === 'string' && name ? name : null; },
    keepTasksStore: name => write(rules.tasks.store.file, { credential_name: name }),
    madeKey: () => read(rules.made_key_file),
    keepMade: value => write(rules.made_key_file, value),
    forgetMade: () => rmSync(path(rules.made_key_file), { force: true }),
  };
}

// ── setup: the program on PATH and one skill file per AI app ─────────────────────────────────────────────────────

const sameBytes = (path, bytes) => { try { return readFileSync(path).equals(Buffer.from(bytes)); } catch { return false; } };
const writeIfChanged = (path, bytes, mode) => {
  if (sameBytes(path, bytes)) return 'unchanged';
  const existed = existsSync(path);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(`${path}.new`, bytes, mode ? { mode } : undefined);
  renameSync(`${path}.new`, path);
  return existed ? 'updated' : 'written';
};

/** Copies this program to the stable folder and links it on PATH. Answers one row per place, with what happened. The Workshop
 *  installer owns the copy: each `{cli} setup` from a newer program writes the files that changed. */
export function installProgram({ rules = settings, home = homedir(), from = HERE } = {}) {
  const folder = expand(rules.install.folder, home);
  const rows = rules.install.files.map(name => ({ path: join(folder, name), outcome: writeIfChanged(join(folder, name), readFileSync(join(from, name)), name.endsWith('.mjs') ? 0o755 : 0o644) }));
  const link = expand(rules.install.link, home), target = join(folder, 'command.mjs');
  let outcome = 'written';
  try {
    if (lstatSync(link).isSymbolicLink() && readlinkSync(link) === target) outcome = 'unchanged';
    else if (lstatSync(link).isSymbolicLink()) { unlinkSync(link); outcome = 'updated'; }
    else outcome = 'refused';
  } catch { /* nothing there yet */ }
  if (outcome === 'refused') rows.push({ path: link, outcome, note: `${link} is a file this program did not make; it was left as it is.` });
  else {
    if (outcome !== 'unchanged') { mkdirSync(dirname(link), { recursive: true }); symlinkSync(target, link); }
    rows.push({ path: link, outcome, ...((process.env.PATH ?? '').split(':').includes(dirname(link)) ? {} : { note: `${dirname(link)} is not on PATH; add it, or run ${link}.` }) });
  }
  return rows;
}

/** The skill text for every app: command-skill.md with this program's command filled in. */
export const skillText = ({ from = HERE, command = cliName() } = {}) => fill(readFileSync(join(from, 'command-skill.md'), 'utf8'), { command });

/** Writes the skill for each app found here (or each one named). Idempotent: an unchanged file is not written again, and a
 *  file at that place that is not this skill (another skill of the same name) is left as it is. */
export function installSkills({ rules = settings, home = homedir(), env = process.env, only = null, text = skillText() } = {}) {
  const ours = `name: ${rules.skill_name}\n`;
  return rules.skills.filter(row => (only ? only.includes(row.id) : row.detect.some(path => existsSync(join(home, path))))).map(row => {
    const root = (row.home_variable && env[row.home_variable]) || join(home, row.folder);
    const path = join(root, row.file);
    let present = null;
    try { present = readFileSync(path, 'utf8'); } catch { /* not there yet */ }
    if (present !== null && !present.includes(ours)) return { app: row.label, path, outcome: 'refused', note: 'another skill is kept there; it was left as it is' };
    return { app: row.label, path, outcome: writeIfChanged(path, text) };
  });
}

// ── What a person or an AI reads ─────────────────────────────────────────────────────────────────────────────────

const QUIET = new Set(['ai_instructions']);
const quiet = value => (object(value) ? Object.fromEntries(Object.entries(value).filter(([name]) => !QUIET.has(name))) : value);
const short = (value, size = 100) => { const text = typeof value === 'string' ? value : JSON.stringify(value); return text && text.length > size ? `${text.slice(0, size - 1)}…` : text ?? ''; };

/** The AIs' names: the name field of the person's `ai_list` list (its formula, a formula-engine binding), evaluated by
 *  tool:evaluate-a-formula over every row's stored value in one call. The list is handed in (`list`: its value as the
 *  person's store holds it); a list with no formula name field is said by name; there is no other way to name an AI. */
export async function namesOf(client, values, list, rules = settings) {
  const fields = Array.isArray(list?.fields) ? list.fields : null;
  const field = fields?.find(row => row.id === list.title_field);
  const binding = field?.kind === rules.who.formula_kind ? field.derive?.request?.binding : null;
  if (!binding) throw new CommandError(fill(rules.who.no_list, { list: rules.who.ai_list }), { status: 2 });
  if (!values.length) return [];
  const answer = await client.op(null, rules.engine.tools_run, { tool: rules.who.formula_tool, input: { binding, rows: values } }, { idempotent: true });
  const named = answer?.result?.values ?? answer?.values;
  if (!Array.isArray(named) || named.length !== values.length) throw new CommandError(fill(rules.who.no_names, { tool: rules.who.formula_tool }), { status: 4 });
  return named.map(name => (typeof name === 'string' && name.trim() ? name : null));
}

/** One AI as `who` reads it, from tool:see-who-can-take-work ({ id, type, value, live, seen_at, busy }) and a `name` when one is given. Its
 *  owner is the row's `owner` cell, else the account the door answered for; the AI never types it. Liveness is the
 *  tool's, computed when read; `recent` is within `who.seen_within_days`. */
export function aiOf(row, { name = null, now = Date.now(), owner = null, rules = settings } = {}) {
  const value = object(row?.value) ? row.value : {};
  const seen = Date.parse(row?.seen_at ?? '');
  return { id: row.id, agent_id: value.agent_id ?? row.id, owner: value.owner ?? owner,
    group: name ?? fill(rules.who.no_name, { kind: value.kind ?? rules.who.unknown_kind }),
    seen_at: Number.isFinite(seen) ? new Date(seen).toISOString() : null, ready: row?.live === true, busy: row?.busy ?? 0,
    recent: Number.isFinite(seen) && now - seen <= rules.who.seen_within_days * 86_400_000, working_on: value.working_on ?? null };
}

const latest = rows => rows.reduce((at, row) => (row.seen_at && (!at || row.seen_at > at) ? row.seen_at : at), null);

/** The person's AIs as one line per AI, not per chat: rows grouped by owner (yours first), then by name, each AI with
 *  its chats beneath, ready ones first, then the newest seen. */
export function groupsOf(ais, { you = null } = {}) {
  const byOwner = new Map();
  for (const ai of ais) {
    const owner = byOwner.get(ai.owner) ?? new Map();
    owner.set(ai.group, [...(owner.get(ai.group) ?? []), ai]);
    byOwner.set(ai.owner, owner);
  }
  const chatOrder = (a, b) => Number(b.ready) - Number(a.ready) || String(b.seen_at ?? '').localeCompare(String(a.seen_at ?? '')) || String(a.agent_id).localeCompare(String(b.agent_id));
  return [...byOwner].map(([owner, groups]) => ({ owner, mine: owner === you,
    ais: [...groups].map(([name, chats]) => ({ name, chats: chats.sort(chatOrder), ready: chats.filter(chat => chat.ready).length, last_seen: latest(chats) }))
      .sort((a, b) => b.ready - a.ready || String(b.last_seen ?? '').localeCompare(String(a.last_seen ?? '')) || a.name.localeCompare(b.name)) }))
    .sort((a, b) => Number(b.mine) - Number(a.mine) || String(a.owner).localeCompare(String(b.owner)));
}

/** A time as the person reads it: in this computer's own time zone, with the zone named. */
export const localTime = at => new Date(at).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', timeZoneName: 'short' });

/** One owner's AIs: the owner line, each AI's line, and beneath it its ready chats (every chat with `all`). */
function ownerLines(group, { all = false, rules = settings } = {}) {
  const account = group.owner ? `${String(group.owner).slice(0, rules.who.account_chars)}…` : rules.who.unknown_owner;
  return [fill(group.mine ? rules.who.you : rules.who.owner, { account }), ...group.ais.flatMap(ai => [
    `  ${fill(rules.who.ai_line, { name: ai.name, ready: ai.ready, chats: ai.chats.length, seen: ai.last_seen ? fill(rules.who.seen, { at: localTime(ai.last_seen) }) : '' })}`,
    ...ai.chats.filter(chat => all || chat.ready).map(chat => `    ${chat.ready ? 'ready' : 'away'}  ${chat.id}${chat.busy ? `  ${chat.busy} taken` : ''}${chat.working_on ? `  working on: ${short(chat.working_on, 160)}` : ''}${!chat.ready && chat.seen_at ? `  ${fill(rules.who.seen, { at: localTime(chat.seen_at) }).trim()}` : ''}`),
  ])];
}

/** The lines for one task: its id, status, who it is for or who took it and who gave it, its words, and what came of it. */
export function taskLines(task) {
  const assignees = Array.isArray(task.assignees) ? task.assignees : [];
  const whom = task.taken_by ? `  taken by ${task.taken_by}` : assignees.length ? `  for ${assignees.join(', ')}` : '  for anyone';
  return [`${task.id}  ${task.status ?? 'unknown'}${whom}${task.sent_by ? `  from ${task.sent_by}` : ''}`,
    ...(typeof task.description === 'string' && task.description ? [`  description: ${short(task.description, 300)}`] : []),
    ...(typeof task.title === 'string' && task.title ? [`  title: ${short(task.title, 120)}`] : []),
    ...(task.stuck?.words ? [`  in the way: ${short(task.stuck.words, 300)}`] : []),
    ...(task.result !== undefined && task.result !== null ? [`  result: ${short(task.result, 1000)}`] : [])];
}

/** Plain lines for a command's answer; --json prints the answer itself instead. */
export function render(command, answer, rules = settings) {
  const value = quiet(answer);
  if (command === 'who' && Array.isArray(value.groups)) {
    const hidden = value.hidden ? [fill(rules.who.hidden, { count: value.hidden, days: rules.who.seen_within_days })] : [];
    if (!value.groups.length) return [rules.who.none, ...hidden].join('\n');
    return [...value.groups.flatMap(group => ownerLines(group, { all: value.all, rules })), ...hidden].join('\n');
  }
  if (command === 'tasks' && Array.isArray(value.tasks)) return value.tasks.length ? [...value.tasks.flatMap(taskLines), ...(value.more ? [rules.words.more_tasks] : [])].join('\n') : rules.words.no_tasks;
  if (command === 'who-can-take' && Array.isArray(value.who)) return value.who.length ? value.who.map(row => `${row.id}  ${row.live ? 'live' : 'away'}  ${row.busy} taken`).join('\n') : rules.words.no_takers;
  if (command === 'tools' && Array.isArray(value.tools)) return value.tools.map(row => `${row.id}  ${short(row.job ?? row.label ?? '', 110)}`).join('\n');
  if (command === 'give' && object(value.task)) return [fill(value.status === 'already-there' ? rules.words.gave_before : rules.words.gave, { id: value.task_id }), ...taskLines(value.task), ...(value.note ? [value.note] : [])].join('\n');
  if (command === 'take') return object(value.taken) ? [fill(rules.words.took, { id: value.taken.id }), ...taskLines(value.taken)].join('\n')
    : [value.reason === 'changed' ? fill(rules.words.take_lost, { id: value.task_id, taker: value.task?.taken_by ?? rules.words.another_ai }) : value.reason === 'gone' ? fill(rules.words.take_gone, { id: value.task_id }) : rules.words.nothing_to_take, ...(object(value.task) ? taskLines(value.task) : [])].join('\n');
  if (Object.hasOwn(rules.tasks.actions, command) && typeof value.moved === 'boolean') return [value.moved ? fill(rules.words.moved, { id: value.task_id, from: value.from, to: value.to })
    : fill(rules.words.not_moved, { id: value.task_id, reason: value.reason ?? 'refused' }), ...(object(value.task) ? taskLines(value.task) : [])].join('\n');
  if (typeof value.text === 'string' && Object.keys(value).length === 1) return value.text;
  return JSON.stringify(value, null, 2);
}

// ── Waiting: a read every poll_seconds ───────────────────────────────────────────────────────────────────────────

/** Calls `check()` every `pollSeconds` until it answers a value or `seconds` pass (then null). */
export async function waitFor(check, { seconds, pollSeconds = settings.wait.poll_seconds, sleep = pause } = {}) {
  const deadline = Date.now() + seconds * 1000;
  for (;;) {
    const found = await check();
    if (found !== null && found !== undefined) return found;
    const left = deadline - Date.now();
    if (left <= 0) return null;
    await sleep(Math.min(left, pollSeconds * 1000));
  }
}

// ── serve: stay ready and run a command for each task ────────────────────────────────────────────────────────────

/** Runs `command` with the task's words on standard input; answers { ok, output }. */
export function runTask(command, task, { rules = settings, me, spawnImpl = spawn } = {}) {
  return new Promise(resolve => {
    // The task's saved terms travel with it, so a command can check its work against them.
    const terms = JSON.stringify({ taken_at: task.taken_at, outcome: task.outcome, obligations: task.obligations, acceptance: task.acceptance,
      source: task.source ?? null, source_task: task.source_task ?? null, continuation: task.continuation ?? null });
    const child = spawnImpl(command[0], command.slice(1), { stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, [settings.env.task_id]: task.id, [settings.env.agent]: me.agent_id, [settings.env.task_context]: terms } });
    let output = '', errors = '';
    const timer = setTimeout(() => child.kill('SIGTERM'), rules.serve.run_timeout_minutes * 60_000);
    child.stdout.on('data', chunk => { output = (output + chunk).slice(-rules.serve.result_chars); });
    child.stderr.on('data', chunk => { errors = (errors + chunk).slice(-2000); });
    child.on('error', error => { clearTimeout(timer); resolve({ ok: false, output: `${command[0]} could not start: ${error.message}` }); });
    child.on('close', code => {
      clearTimeout(timer);
      const words = output.trim() || '(the command printed nothing)';
      if (code !== 0) return resolve({ ok: false, output: (errors || output).trim().slice(-500) || `${command[0]} stopped with ${code}.` });
      try {
        const envelope = JSON.parse(words);
        if (object(envelope) && typeof envelope.result === 'string' && object(envelope.check)) return resolve({ ok: true, output: envelope.result, check: envelope.check });
      } catch { /* plain output carries no check receipt */ }
      resolve({ ok: true, output: words });
    });
    child.stdin.on('error', () => {});
    child.stdin.end(`${wordsOf(task)}\n`);
  });
}

/** One pass: take a task with tasks.tools.take; when there is one, run it, then finish it, say what is in the way, or give
 *  it back when the command failed, each with the task row that makes that move. A move another AI made first is logged,
 *  never retried. */
export async function serveOnce({ client, me, command, state, rules = settings, log, runImpl = runTask, refresh = async () => {} }) {
  const tasksStore = state.tasksStore?.();
  const resource = resourceOf(client, { rules, store: tasksStore ? { credential_name: tasksStore } : null });
  const took = await runTaskMove(resource, { tool: rules.tasks.tools.take, input: { as: me.ai_id }, read: takeReads(me) });
  const task = took.result?.taken;
  if (!object(task)) return false;
  if (!took.kept) { log({ event: 'not_take', task_id: task.id, reason: 'changed' }); return false; }
  state.hold(me.agent_id, task);
  log({ event: 'took', task_id: task.id });
  await refresh();
  const { ok, output = '', stuck = null, check } = await runImpl(command, task, { rules, me, client });
  // A finish needs the saved acceptance and a consumer check receipt for it. A run with neither, or one that failed, is blocked
  // on an owned next step, not given back: its effects may have happened, and the next taker reads them before running again.
  const next = (reason, action = 'Inspect the existing consumer result and requested outcome before deciding whether to execute anything again') =>
    ({ continuation: { owner: me.ai_id, action, after: new Date(Date.now() + rules.serve.continue_after_minutes * 60_000).toISOString(), reason } });
  let action, extra;
  if (stuck) [action, extra] = ['stuck', { words: stuck }];
  else if (ok && checkForTask(check, task)) [action, extra] = ['finish', { result: await kept(keepResult(client, task.id, Buffer.from(output, 'utf8'), rules)), summary: output.split('\n')[0].slice(0, 300), check: { ...check, target: task.acceptance.target } }];
  else if (!task.acceptance) [action, extra] = ['wait', next('This task has no saved consumer acceptance, so its requested outcome cannot be checked yet.', 'Ask the sender to add a saved consumer acceptance, then inspect existing consumer state before deciding whether to continue')];
  else [action, extra] = ['wait', next(ok ? 'The command returned successfully but supplied no complete consumer check receipt.' : output || 'The command did not complete; partial effects are unknown.')];
  // The records the move names: the task, its acceptance target for a finish, and the continuation owner (this AI) for a wait.
  const ids = [taskRef(task.id), ...(action === 'finish' ? [{ type: task.acceptance.target.type, id: task.acceptance.target.id }] : []), ...(action === 'wait' ? [recordRef(me.ai_id)] : [])];
  const moved = await runTaskMove(resource, { tool: action === 'finish' ? rules.tasks.tools.finish : rules.tasks.tools.change,
    input: { as: me.ai_id, id: task.id, taken_at: task.taken_at, action: rules.tasks.actions[action], ...extra }, read: { ids } });
  // A task that says what is in the way stays taken (an AG-UI agent's interrupt); any other move ends this AI's hold.
  if (!stuck) state.letGo(me.agent_id, task.id);
  await refresh();
  const movedOk = moved.kept && moved.result?.moved !== false;
  log({ event: movedOk ? action : `not_${action}`, task_id: task.id, ...(movedOk ? {} : { reason: moved.kept ? moved.result?.reason : 'changed' }) });
  return true;
}

// ── The site ────────────────────────────────────────────────────────────────────────────────────────────────────

/** The site this command speaks for: the site file's `site` and `cli` (written by the install line of the site it came from),
 *  else the command's own name as it was run (`invoked`, the link's name). No product is named in this tool: every {site_name} and
 *  {cli} in a sentence a person reads, and in the folders it keeps, is filled from this. */
export function siteOf({ invoked = process.argv[1] ?? '', home = homedir(), rules = settings } = {}) {
  const cli = basename(invoked).replace(/\.m?js$/, '');
  let site = null;
  try { site = JSON.parse(readFileSync(join(expand(rules.state_folder.replaceAll('{cli}', cli), home), rules.site_file), 'utf8')); } catch { /* not installed from a site */ }
  // The command name is a shell word; the site is words in any script (only quotes, backslashes, dollars and control
  // characters are refused).
  const command = value => (typeof value === 'string' && /^[a-z][a-z0-9-]{0,31}$/.test(value) ? value : null);
  const words = value => (typeof value === 'string' && /^[^\p{C}"\\`$]{1,64}$/u.test(value) ? value : null);
  return { cli: command(site?.cli) ?? cli, site_name: words(site?.site_name) ?? command(site?.cli) ?? cli };
}

/** Fills {site_name} and {cli} in this program's settings, once: the sentences a person reads and the places it keeps. */
export function speakFor(site, rules = settings) {
  if (rules.site) return;
  const values = { ...site, CLI: site.cli.toUpperCase().replace(/-/g, '_') };
  const filled = value => (typeof value === 'string' ? fill(value, values)
    : Array.isArray(value) ? value.map(filled)
    : value && typeof value === 'object' ? Object.fromEntries(Object.entries(value).map(([name, child]) => [name, filled(child)])) : value);
  // Every part, never a list of parts: a part left off a list keeps a raw {cli} in what a person or an AI reads.
  for (const part of Object.keys(rules)) rules[part] = filled(rules[part]);
  rules.site = site;
}

// ── The commands ─────────────────────────────────────────────────────────────────────────────────────────────────

const HELP = `{cli}: see your AIs and their tasks, and run your {site_name}'s tools, from any shell.

  {cli} setup [--harness claude-code,codex,cursor]   sign in once, put {cli} on PATH, write each app's skill
  {cli} login [--origin ADDRESS] | logout | whoami    sign in to {site_name} (to another one with its address), sign out, or say who is signed in
  {cli} connection [--write]                          the address and key source local bridges read, with a command per app
  {cli} who [--all] [--list FILE]                     your AIs seen lately (--all: every one): ready or away; --list names them by your list:ais as your store holds it
  {cli} publish [HELD_JSON|-]                         this AI's own record as a keep row (its facts, seen now) for your own store; HELD_JSON is the value your store holds now
  {cli} tools | call TOOL JSON|-                      your Workshop tools, and run one by its id
  {cli} connect ADDRESS                               sign in to a remote tool server (an MCP server's https address); then any AI calls its tools by that address
  {cli} op METHOD JSON|- [--pin ID]...                 any engine operation by its method (do_one_thing_in_my_account); op --dry-run shows the request and sends nothing
  --pin ID  meet the op or schedule call at this computer first, then the next --pin in order (repeat it, or give IDs separated by commas; at most ${settings.engine.pins.most})
  --upload FILE      (op, call) send FILE's bytes as the call's raw body (at most ${settings.direct_calls.upload_most_bytes} bytes): a session tool takes it as the file argument its row names (byte_argument)
  --timeout SECONDS  wait this long for one try of a call (default ${settings.retry.attempt_seconds}); a try with no answer is asked again, up to ${settings.retry.count} more times, under the same request key
  {cli} schedule list | on TOOL WAKE_ID | off TOOL WAKE_ID | cancel RUN_KEY [--pin ID]...   the wakes your tool rows declare: list, switch, or cancel one admitted run (a wake is made, changed or removed in its row's wakes list)
  {cli} update                                        who updates this command (it never updates itself)
  ${basename(settings.install.link)} records replay-from-transcripts --since TIME            list the rows this computer's AIs wrote, to keep in your own store (writes nothing)

  Tasks (a task is one calendar-task record; its assignees are the record ids that may do it: a person, an AI, anything with a record; none means anyone):
  {cli} TASK-COMMAND ... --store NAME                 the tasks are rows of your own database's tables: NAME is the connection you saved for it (kept for the next command)
  {cli} tasks [ID] [--status S] [--from ID] [--taken-by ID] [--assignee ID] [--limit N]   the newest tasks that match, or one with its result
  {cli} give WORDS [--to ID]... [--title T] [--priority urgent|high|medium|low] [--outcome TEXT] [--key K] [--wait SECONDS]   give a task (--to: who may take it; repeat for more)
  {cli} take [ID] [--only-mine]                       take the oldest task you may take (or that one)
  {cli} who-can-take [--can WORD]... [--live]         the people and AIs that can take a task: live now, and how many tasks each holds
  {cli} finish ID "RESULT" [--check-file JSON] | fail ID "WHY"   record what came of a task you took (no words: the result is read from standard input, any size; one too long for the task row is kept as a file of your files and the row names it)
  {cli} tasks ID --result                             print that task's whole result, whether on the row or kept as a file
  {cli} hand-on ID --to ID [--to ID]... [--because WHY]   hand a task you took, or gave, to whoever is named next (the task waits for them)
  {cli} plan ID --acceptance-file JSON                save what a task you took must come to, read from the record that shows it (finish checks it)
  {cli} stuck ID "WORDS" | stuck ID --clear           say what is in the way, or that nothing is now
  {cli} release ID [--because WHY] [--continuation-file JSON]   give a task back, with an owned next step if you have one
  {cli} wait ID --continuation-file JSON              block on a bounded next step ({owner, action, after, reason})
  {cli} resume ID --because "WHAT CHANGED"            resume after reviewing existing effects and the dependency
  {cli} edit ID [--description WORDS --title TEXT --outcome TEXT --to ID --priority P --source-file JSON --obligations-file JSON]   edit a task you gave
  {cli} withdraw ID --reason "WHY" | remove ID        take back a task you gave; delete a finished one
  {cli} serve -- COMMAND ARGS | serve --ag-ui URL     stay ready: run COMMAND (or an AG-UI agent) for each task taken

  Record ids are <kind>:<name> (ai:codex-on-mac, person:someone). --as ID acts as another id (default: from
  {CLI}_AGENT or the AI running this). --json prints the answer. --verbose adds the technical details of a refusal.`;

/** `schedule`: the wakes the person's tool rows declare (each row's `wakes` list), read and switched at the engine's wake
 *  owner (`engine.wake`: list, switch), and one admitted run cancelled (`engine.cancel`). A call names its method only; the
 *  engine finds the owner. A wake is made, changed or removed in its row's `wakes` list, never here. */
export async function schedules(client, words, { requestKey, rules = settings, inputFile, route = {}, readInput = file => readFileSync(file === '-' ? 0 : file, 'utf8') } = {}) {
  const [action = 'list', ...args] = words;
  const { wake } = rules.engine;
  if (action === 'list') {
    if (args.length) throw new CommandError(`Use ${cliName()} schedule list.`, { status: 2 });
    return client.op(null, wake.list, {}, { idempotent: true, route });
  }
  if (action === 'on' || action === 'off') {
    const [tool, id, ...extra] = args;
    need(tool, `Name the tool: ${cliName()} schedule ${action} TOOL WAKE_ID.`);
    need(id, `Name the wake id: ${cliName()} schedule ${action} TOOL WAKE_ID.`);
    if (extra.length) throw new CommandError(`Use ${cliName()} schedule ${action} TOOL WAKE_ID.`, { status: 2 });
    if (inputFile === undefined) return opWhole(client, null, wake.switch, { tool, id, on: action === 'on' }, { requestKey, route });
    if (action === 'off') throw new CommandError(rules.words.schedule_input_off, { status: 2 });
    const input = switchInput(inputFile, readInput, rules);
    // An engine older than the input refuses the unknown field; that refusal is passed through with one line of help and
    // the call is never sent again without the input, which would switch the wake on without it.
    return opWhole(client, null, wake.switch, { tool, id, on: true, input }, { requestKey, route }).catch(error => {
      if (error?.answer?.code === rules.engine.need_refusal.code) error.message = `${error.message}\n${rules.words.schedule_input_old_engine}`;
      throw error;
    });
  }
  if (action === 'cancel') {
    const [run, ...extra] = args;
    need(run, `Name the exact admitted run key: ${cliName()} schedule cancel RUN_KEY.`);
    if (extra.length) throw new CommandError(`Use ${cliName()} schedule cancel RUN_KEY.`, { status: 2 });
    return opWhole(client, null, rules.engine.cancel, { run }, { requestKey, route });
  }
  throw new CommandError(`Unknown schedule command ${action}. Run ${cliName()} help.`, { status: 2 });
}

/** The person's own input for a wake switch: one JSON object read from a file (- is standard input), within the engine's size
 *  limit. Refused in words before any call; its values are never printed (an unreadable one names the file, not the text). */
function switchInput(file, readInput, rules) {
  if (file === true || file === '') throw new CommandError(fill(rules.words.schedule_input_object, { cli: cliName() }), { status: 2 });
  let text, value;
  try { text = readInput(file); } catch (error) { throw new CommandError(`Could not read --input ${file === '-' ? 'from standard input' : file}: ${error.code ?? 'unreadable'}.`, { status: 2 }); }
  try { value = JSON.parse(text); } catch { throw new CommandError(fill(rules.words.schedule_input_object, { cli: cliName() }), { status: 2 }); }
  if (!object(value)) throw new CommandError(fill(rules.words.schedule_input_object, { cli: cliName() }), { status: 2 });
  const size = Buffer.byteLength(JSON.stringify(value));
  if (size > rules.engine.wake.max_switch_input_bytes) throw new CommandError(fill(rules.words.schedule_input_size, { limit: rules.engine.wake.max_switch_input_bytes, size }), { status: 2 });
  return value;
}

/** The door and client for this run; a run with no credential says to log in, and only then. */
/** --timeout SECONDS: how long one try of this call waits, a whole number of at least 1 (command.json retry.attempt_seconds
 *  when none is given). The call ends only when its retries are spent. */
const timeoutOf = value => {
  const number = Number(value);
  if (!Number.isInteger(number) || number < 1) throw new CommandError(settings.words.timeout_range, { status: 2 });
  return number;
};

/**
 * The run request a command sends: `input` with `until` (UTC milliseconds) added when it asks a tool run (`engine.tools_run`)
 * with --timeout and names no `until` of its own: now plus that wait. A door that carries the call to another computer (the
 * gateway's meeting point, trillion-rust src/native_entry/meeting.rs `answer_wait`) waits for its computer's answer until
 * then, at most its own longest call, and without it only its default (120 s): at 12:07-12:12 PM CST Nov 21 2026 two
 * hearings of a 1.18 GB recording were cut there after 2 minutes although --timeout said 1300. The `until` is kept per
 * request key (`stateOf().untilOf`), so the same command asked again under its key sends the same request and the run's
 * journal sees one run. The engine ends the run at `until` too, so the wait asked for is also the run's limit.
 * A session call (`call` beside `tool`) is sent as given: the engine takes `until` only on a run, and a call that names it is
 * refused as tools_run_input_refused (trillion-rust src/tool_runs/tools.rs, a call names tool, input, call and byte_upload
 * alone). From 3:59 PM CST Nov 21 2026 every `op tools:run {tool: tool:your-files, call}` with --timeout was refused so.
 */
export function withUntil(method, input, { requestKey = null, timeoutSeconds, state = null, rules = settings, now = Date.now } = {}) {
  if (method !== rules.engine.tools_run || timeoutSeconds === undefined || !input || typeof input !== 'object' || Array.isArray(input) || input.until !== undefined || input.call !== undefined) return input;
  const make = () => now() + timeoutSeconds * 1000;
  return { ...input, until: typeof state?.untilOf === 'function' ? state.untilOf(requestKey, make) : make() };
}

async function signedInClient(context) {
  const credential = await credentialFor({ env: context.env, store: context.store, grants: context.grants, fetchImpl: context.fetchImpl });
  if (!credential) throw new CommandError(settings.words.no_credential, { status: 3 });
  const door = doorFor({ asked: context.asked, declared: context.declared ?? context.state.site(), credential, localMcp: context.localMcp() });
  // The key this computer keeps goes only to this computer's local door or the address declared in {CLI}_ORIGIN; any other door gets a key the person gives for it ({CLI}_KEY).
  if (credential.kind === 'key' && credential.where !== settings.env.key && !door.local && !door.public) throw new CommandError(settings.words.kept_key_elsewhere, { status: 3 });
  const timeoutSeconds = context.flags.timeout === undefined ? undefined : timeoutOf(context.flags.timeout);
  const renew = credential.kind === 'sign-in' ? () => credentialFor({ env: context.env, store: context.store, grants: context.grants, fetchImpl: context.fetchImpl }) : null;
  const uploadAt = context.flags.upload === undefined ? null : context.uploadDoor(door);
  return engineClient({ door, credential, renew, fetchImpl: context.fetchImpl, wait: context.wait, uploadAt, ...(timeoutSeconds === undefined ? {} : { timeoutSeconds }) });
}

/** This AI's own `ai` record (aiRecordOf) as one `keep` row for the person's own store, conditioned on `held`: the value
 *  that store holds for it now (null when it has none), read there by the caller and handed in. A person's edit made
 *  meanwhile (a nickname, an order) is carried, and the store refuses the keep when its value is no longer `held`. Nothing
 *  is written here. */
export async function publishRecord(client, context, { held = null, rules = settings } = {}) {
  const { engine } = rules;
  const account = context.account ??= (await client.whoami()).account;
  const place = context.place ??= context.placeImpl();
  const holding = holdingOf(context.me, context.state.held());
  const value = aiRecordOf(context.me, { account, held, ...place, holding }, rules);
  return { keep: [{ id: context.me.ai_id, type: engine.ai_type, value, expected: held === null ? null : { type: engine.ai_type, value: held } }] };
}

/** What `give` says about when the receiver sees the task: each assignee reads it when it next reads its tasks; anyone's
 *  when someone next takes it. */
export function giveNote(task, rules = settings) {
  const assignees = Array.isArray(task?.assignees) ? task.assignees : [];
  return assignees.length ? fill(rules.give_note.to, { to: assignees.join(', ') }) : rules.give_note.any;
}

/** Where a local bridge finds this computer's engine: the address and where the credential this command holds lives (never
 *  the credential), rewritten whenever it changes, so a rotated key never breaks a bridge that reads this file. A sign-in
 *  `login` made is held only by this command (its pass is renewed here and handed to nobody), so a recipe that sends a key
 *  (`{key_env}` in its template) is offered only while a key is what this command holds. */
export function connectionOf({ origin, store, credential = null, rules = settings, account = null, at = new Date().toISOString() }) {
  const signedIn = credential?.kind === 'sign-in';
  const keySource = signedIn ? { kind: credential.kind, where: credential.where }
    : { kind: 'key', env: rules.env.key, where: store.where, keychain_item: rules.keychain_item, key_file: rules.key_file };
  const base = { schema: rules.connection.schema, origin, mcp_url: `${origin}/mcp`, account, key_source: keySource, written_at: at };
  const fill = text => text.replaceAll('{mcp_url}', base.mcp_url).replaceAll('{origin}', origin).replaceAll('{key_env}', rules.env.key);
  const offered = rules.connection.recipes.filter(row => !(signedIn && row.template?.includes('{key_env}')));
  // The connection guide owns app commands; standalone CLI installs point to that current guide rather than ship a copied manual.
  return { ...base, recipes: offered.map(row => ({ id: row.id, label: row.label,
    command: row.guide ? `Follow ${row.label}'s current connection steps: ${new URL(row.guide.path, origin).href}` : fill(row.template),
    ...(row.guide ? { guide: { ...row.guide, url: new URL(row.guide.path, origin).href } } : {}),
  })) };
}
const keepConnection = (context, client, account) => {
  context.state.keepConnection(connectionOf({ origin: client.door.origin, store: context.store, credential: client.credential, account }));
};

/** The audiences a pass names (its `aud` claim, one or a list), read without checking it: which doors it was made for. */
export function audiencesOf(bearer) {
  try {
    const aud = JSON.parse(Buffer.from(String(bearer).split('.')[1] ?? '', 'base64url').toString('utf8')).aud;
    return (Array.isArray(aud) ? aud : [aud]).filter(item => typeof item === 'string');
  } catch { return []; }
}

/** The email a pass names (its `email` claim), or null: a key, or a pass that names none. Read to say who is signed in; the pass is
 *  never checked here (the door checks it on every call). */
export function emailOf(credential) {
  const parts = String(credential?.bearer ?? '').split('.');
  if (parts.length !== 3) return null;
  try {
    const email = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8')).email;
    return typeof email === 'string' && email ? email : null;
  } catch { return null; }
}
const signedInWords = (credential, rules = settings) => { const email = emailOf(credential); return email ? fill(rules.words.signed_in, { email }) : rules.words.signed_in_no_email; };

/** Holds the person at this computer's engine (`addPersonHere`) when that engine is the door in use, then asks who they are: a main-built
 *  engine serves no one it has not been told to hold, so asking first is refused. Another engine is not reached by this socket (it admits
 *  people by its own rule). Answers { account }; a refusal is thrown (status 3, or `notTaken` from the add, with the engine's `why` when
 *  it gave one). */
async function knownAs(context, client) {
  if (client.door.local) await addPersonHere({ socket: context.agentSocket(), bearer: client.credential.bearer });
  return client.whoami();
}

const refusedBy = error => error instanceof CommandError && (error.status === 3 || error.notTaken === true);

/** `{cli} login`: the person is known as the credential this computer keeps names them, else one browser sign-in is made (never more
 *  than one per run: a kept credential the engine refuses, for any reason, never blocks it), and then they are known. A new sign-in
 *  that is refused too is said with the engine's reason; nothing is tried again. */
async function login(context, { again = false } = {}) {
  // A kept sign-in the engine refused is not where the new one is made: the new one goes to the site this command came from.
  let refused = false;
  if (!again) {
    let client = null;
    try { client = await signedInClient(context); } catch (error) { if (!refusedBy(error)) throw error; refused = true; }
    // A sign-in made for another engine than the one named is not this one's: the named engine gets its own walk.
    if (client?.credential.kind === 'sign-in' && context.asked && client.door.mcp !== client.credential.resource) client = null;
    // A sign-in this program made that was not asked for every scope the command asks for now is made again.
    if (client?.credential.kind === 'sign-in' && !asksNothingNew(context.grants.read())) client = null;
    if (client) {
      try {
        const known = await knownAs(context, client);
        keepConnection(context, client, known.account);
        return `${signedInWords(client.credential)}${await carriedWords(context)}`;
      } catch (error) {
        // A kept credential the engine refuses is no sign-in: the person signs in again. Anything else (an engine that did not answer) is said.
        if (!refusedBy(error)) throw error;
        refused = true;
      }
    }
  }
  if (context.flags['key-stdin']) {
    const chunks = [];
    for await (const chunk of process.stdin) chunks.push(chunk);
    const key = Buffer.concat(chunks).toString('utf8').trim();
    if (bearerOf(key, settings) === null) throw new CommandError(fill(settings.bearers.refused, { kinds: settings.bearers.shapes.map(row => row.kind).join(', ') }), { status: 2 });
    context.store.write(key);
  } else {
    // The engine signed in to is the one named (--origin, {CLI}_ORIGIN); else the one a kept sign-in was made for; else the site this
    // command was installed from (`site_file`; no address is kept in this shared tool), where every website sign-up lives. Its
    // protected-resource document names the sign-in server and the resource; one that does not answer is said, and no other is tried.
    const site = context.state.site();
    const keptResource = refused ? null : context.grants.read()?.resource ?? null;
    if (!context.asked && !keptResource && !site) throw new CommandError(settings.words.no_origin, { status: 2 });
    const door = context.asked ? `${context.asked}/mcp` : keptResource ?? `${site}/mcp`;
    const issuer = (await engineServersOf(door, { fetchImpl: context.fetchImpl, rules: settings }))[0];
    if (!issuer) throw door === context.localMcp()
      ? new CommandError(settings.words.not_running, { status: 4, detail: fill(settings.words.details.not_running, { mcp: door, why: 'no protected-resource document' }) })
      : new CommandError(settings.words.not_answering, { status: 4, detail: fill(settings.words.details.not_running, { mcp: door, why: 'no protected-resource document' }) });
    const grant = await signInWithBrowser({ origin: issuer, resourceDoor: door, fetchImpl: context.fetchImpl, ...(context.open ? { open: context.open } : {}) });
    // A sign-in this program made before is ended when a new one replaces it; the Mac app's key is never touched.
    if (context.state.madeKey()?.where === context.grants.where) await endSignIn(context.grants.read(), { fetchImpl: context.fetchImpl });
    context.grants.write(grant);
    context.state.keepMade({ kind: 'sign-in', where: context.grants.where, at: new Date().toISOString() });
  }
  const client = await signedInClient(context);
  const known = await knownAs(context, client).catch(error => { throw refusedBy(error) ? new CommandError(fill(settings.words.refused_new, { why: error.why ?? error.message }), { status: 3, detail: error.detail }) : error; });
  keepConnection(context, client, known.account);
  return `${signedInWords(client.credential)}${await carriedWords(context)}`;
}

async function logout(context) {
  const made = context.state.madeKey();
  if (made?.kind === 'sign-in' && made.where === context.grants.where) {
    await endSignIn(context.grants.read(), { fetchImpl: context.fetchImpl });
    context.grants.forget();
    context.state.forgetMade();
    context.state.forgetConnection();
    return settings.words.signed_out;
  }
  const kept = await credentialFor({ env: context.env, store: context.store, grants: context.grants, fetchImpl: context.fetchImpl }).catch(() => null);
  return kept ? settings.words.signed_out_elsewhere_kept : settings.words.not_signed_in;
}

async function serve(context) {
  const agUi = context.flags['ag-ui'] ?? null;
  if (!context.rest.length && !agUi) throw new CommandError(`Say what runs each task: ${cliName()} serve -- COMMAND ARGS (the task's words arrive on its standard input), or ${cliName()} serve --ag-ui URL (an AG-UI agent).`, { status: 2 });
  if (agUi && !/^https?:\/\//.test(agUi)) throw new CommandError('--ag-ui is the address of an AG-UI agent, starting http:// or https://.', { status: 2 });
  // An AG-UI agent keeps one thread per task: the task's id is its thread.
  const runImpl = agUi ? (_command, task, options) => runOnAgUi(agUi, { handoff_id: task.id, words: wordsOf(task) }, { ...options, fetchImpl: context.fetchImpl }) : runTask;
  const client = await signedInClient(context);
  const { me, state } = context;
  const log = entry => process.stderr.write(`${JSON.stringify({ at: new Date().toISOString(), agent_id: me.agent_id, ...entry })}\n`);
  const stop = () => { log({ event: 'stopped' }); process.exit(0); };
  process.once('SIGINT', stop); process.once('SIGTERM', stop);
  log({ event: 'ready', ...(agUi ? { ag_ui: agUi } : { command: context.rest[0] }) });
  for (;;) {
    let worked = false;
    try { worked = await serveOnce({ client, me, command: context.rest, state, log, runImpl }); } catch (error) { log({ event: 'failed', error: error.message }); }
    if (!worked) await pause(settings.serve.contact_seconds * 1000);
  }
}


/** `{cli} update`: this program does not fetch code. The installed copy follows the Workshop copy the engine
 *  keeps current (workshopProgram), and `{cli} setup` run from a newer Workshop program refreshes the installed files. */
export function updateWords({ rules = settings } = {}) {
  return rules.update.workshop;
}

/** `records replay-from-transcripts`: the rows this computer's AIs wrote, read from their transcripts
 *  (replay-recorded-writes.mjs, which reads shell lines with this program's own parser and names). It writes only the
 *  inventory folder and needs no credential; its rows are kept in the person's own store by whoever restores them. */
async function records(context, words) {
  const { flags } = context;
  if (words[0] !== 'replay-from-transcripts') throw new CommandError('Name what to do: records replay-from-transcripts --since TIME.', { status: 2 });
  const replay = await import('./replay-recorded-writes.mjs');
  const host = { parseArgs, expand, settings, programs: new Set([basename(expand(settings.install.link)), basename(fileURLToPath(import.meta.url))]) };
  if (flags.write !== undefined) throw new CommandError('Nothing is written from here: keep the inventory\'s rows in your own store, in its own language.', { status: 2 });
  if (!Number.isFinite(Date.parse(flags.since ?? ''))) throw new CommandError('Name the earliest call to read: --since TIME, for example 2026-01-31T00:00:00Z.', { status: 2 });
  return JSON.stringify(await replay.dryRun({ host, since: flags.since, env: context.env, home: context.transcriptHome }), null, 2);
}

const readJson = async (raw, example) => {
  let text = raw ?? '{}';
  if (text === '-') { const chunks = []; for await (const chunk of process.stdin) chunks.push(chunk); text = Buffer.concat(chunks).toString('utf8'); }
  try { const value = JSON.parse(text); if (object(value)) return value; } catch { /* refused below */ }
  throw new CommandError(`The input is one JSON object, for example ${example}.`, { status: 2 });
};

/** A keep or read the door could not complete exactly is a refusal like any other (status 4: the caller may try again under the same task). */
const kept = async work => { try { return await work; } catch (error) { throw error instanceof KeepRefused ? new CommandError(error.message, { status: 4 }) : error; } };

const readStdin = async stream => { const chunks = []; for await (const chunk of stream) chunks.push(chunk); return Buffer.concat(chunks); };

/** The result of task `id` in a `tasks ID` answer, as text; a refusal when the task is not there or has none. */
function taskResultOf(answer, id) {
  const result = answer?.tasks?.[0]?.result;
  if (typeof result !== 'string') throw new CommandError(fill(settings.words.no_result, { id }), { status: 1 });
  return result;
}

/** A whole result: its text, or for bytes that are not text, the raw bytes straight to standard output. */
function printResult(bytes, stdout) {
  const text = bytes.toString('utf8');
  if (Buffer.from(text, 'utf8').equals(bytes)) return text;
  stdout.write(bytes);
  return '';
}

/** Runs one command line; answers the text to print. `seams` carries what tests replace: store, grants, state, open, env,
 *  fetchImpl, wait, place, localDoor (the local door's MCP address, or null), computerName and model. */
/** The fetch every command sends with: through this computer's kept connection (./keep-the-connection.mjs, command.json
 *  `kept_connection`), so a command reuses the connection the last one opened instead of opening its own. */
export function keptConnection({ rules = settings, home = homedir() } = {}) {
  const socket = join(expand(rules.state_folder, home), rules.kept_connection.socket);
  return keptFetch({ socket, start: () => { mkdirSync(dirname(socket), { recursive: true, mode: 0o700 }); startKeeper({ socket, idleSeconds: rules.kept_connection.idle_seconds }); } });
}

/** The read or move one task command makes, run through run-a-task-move.mjs: the row reads what it needs, the writes it answers
 *  are applied where they were read, and a write refused because the task changed is answered as "changed". */
async function taskCommand(client, context, { command, call, flags, requestKey, stdinBytes, stdout, print }) {
  const { tools, holder_commands: holders } = settings.tasks;
  const { me, state } = context;
  const store = tasksStoreOf(context);
  const resource = resourceOf(client, { store });
  if (call.call === 'who') call.read.types = whoTypes(store);
  // Who-can-take reads the tasks held now only to count them: in tables, only the fields that count.
  if (store && call.call === 'who') call.read.tasks = { ...call.read.tasks, fields: settings.tasks.store.busy_fields };
  // In tables, a listing asks the store for only the newest it shows (one more, to know there are more), never every task.
  if (store && call.call === 'see' && call.input.id === undefined && call.input.assignee === undefined) {
    call.read.tasks = { ...call.read.tasks, newest: { ...settings.tasks.store.newest, count: (call.input.limit ?? settings.tasks.list_limit) + 1 } };
  }
  const shownOf = found => (found ? { id: found.id, ...found.value } : null);
  const withoutKeep = answer => { const { keep: _keep, ...rest } = answer; return rest; };
  const readOne = async id => shownOf((await readFor(resource, { ids: [taskRef(id)] }))[0] ?? null);
  if (call.call === 'see') {
    if (flags.result === true && !call.input.id) throw new CommandError(`Name the task: ${cliName()} tasks ID --result.`, { status: 2 });
    const answer = await runTaskMove(resource, { tool: tools.see, input: call.input, key: requestKey, read: call.read });
    if (flags.result === true) return printResult(await kept(readResult(client, taskResultOf(answer.result, call.input.id), settings)), stdout);
    return print('tasks', withoutKeep(answer.result));
  }
  if (call.call === 'give') {
    const answer = await runTaskMove(resource, { tool: tools.give, input: call.input, key: requestKey, read: call.read });
    if (!answer.kept) throw new CommandError(settings.words.not_written, { status: 4 });
    const given = withoutKeep(answer.result);
    if (call.wait === undefined) return print('give', { ...given, note: giveNote(given.task) });
    const seconds = Number(call.wait);
    if (!Number.isFinite(seconds) || seconds <= 0) throw new CommandError('--wait is a number of seconds.', { status: 2 });
    const done = await waitFor(async () => {
      const seen = await readOne(given.task_id);
      return seen && finishedStates.includes(seen.status) ? seen : null;
    }, { seconds, sleep: context.wait });
    if (done) return print('tasks', { tasks: [done], more: false });
    return print('give', { ...given, note: [giveNote(given.task), fill(settings.words.not_finished, { seconds, id: given.task_id })].join(' ') });
  }
  if (call.call === 'take') {
    const answer = await runTaskMove(resource, { tool: tools.take, input: call.input, key: requestKey, read: call.read });
    if (!answer.kept) {
      const id = answer.result.taken?.id ?? call.input.id;
      return print('take', { taken: null, tried: answer.result.tried ?? 0, task_id: id, reason: 'changed', task: await readOne(id) });
    }
    const taken = answer.result.taken;
    if (object(taken)) state.hold(me.agent_id, taken);
    return print('take', withoutKeep(answer.result));
  }
  if (call.call === 'who') {
    const answer = await runTaskMove(resource, { tool: tools.who, input: call.input, key: requestKey, read: call.read });
    return print('who-can-take', withoutKeep(answer.result));
  }
  // A move by id: the task is read first, so a move is made on the task as it is, with the claim it holds.
  const id = call.input.id;
  const [found] = await readFor(resource, { ids: [taskRef(id)] });
  if (!found) throw new CommandError(fill(settings.words.no_task, { id }), { status: 1 });
  if (call.input.result !== undefined) call.input.result = await kept(keepResult(client, id, stdinBytes ?? Buffer.from(call.input.result, 'utf8'), settings));
  const task = found.value;
  // The claim a move names is read from the task's own row, when this AI holds it: never from a file the AIs share. A task held
  // by another AI is sent without a claim, and the row refuses it, saying who holds it.
  if (holders.includes(command) && task.taken_by === call.input.as) call.input.taken_at = task.taken_at;
  if (call.input.check && call.input.check.target === undefined && task.acceptance) call.input.check.target = task.acceptance.target;
  // A finish or plan names the consumer its acceptance points at: the saved one for a finish, the one handed in for a plan.
  const acceptanceTarget = call.input.action === 'finish' ? task.acceptance?.target : call.input.acceptance?.target;
  const target = acceptanceTarget ? [{ type: acceptanceTarget.type, id: acceptanceTarget.id }] : [];
  const answer = await runTaskMove(resource, { tool: tools[call.call], input: call.input, key: requestKey, read: { ids: [taskRef(id), ...call.read.ids, ...target] } });
  if (!answer.kept) return print(command, { task_id: id, moved: false, from: task.status, to: null, reason: 'changed', task: await readOne(id) });
  const moved = withoutKeep(answer.result);
  // A move that clears the claim ends this AI's hold on the task (hand-on and resume clear the taker too).
  if (moved.moved && ['finish', 'fail', 'release', 'hand-on', 'resume', 'withdraw', 'remove'].includes(command)) state.letGo(holderOf(me, state.held(), id), id);
  return print(command, moved);
}

export async function main(argv, seams = {}) {
  if (seams.site) speakFor(seams.site);
  const parsed = parseArgs(argv);
  const [command = 'help', ...spoken] = parsed.words;
  // finish and fail with no result words (or `-`) take the result from standard input, as bytes of any size.
  const fromStdin = (command === 'finish' || command === 'fail') && spoken.length > 0 && (spoken.length === 1 || (spoken.length === 2 && spoken[1] === '-'));
  const stdinBytes = fromStdin ? await readStdin(seams.stdin ?? process.stdin) : null;
  const words = fromStdin ? [spoken[0], stdinBytes.toString('utf8')] : spoken;
  const flags = parsed.flags;
  const env = seams.env ?? process.env;
  const asked = (flags.origin ?? env[settings.env.origin])?.replace(/\/$/, '') || null;
  const context = { asked, declared: env[settings.env.origin]?.replace(/\/$/, '') || null, flags, env, rest: parsed.rest, transcriptHome: seams.transcriptHome, fetchImpl: seams.fetchImpl ?? (seams.state ? fetch : keptConnection()), wait: seams.wait ?? pause,
    store: seams.store ?? keyStore(), grants: seams.grants ?? grantStore(), state: seams.state ?? stateOf(), open: seams.open ?? null,
    localMcp: seams.localDoor ?? (() => findLocalDoor()), agentSocket: seams.agentSocket ?? (() => findAgentSocket()),
    uploadDoor: seams.uploadDoor ?? (seams.state ? () => null : door => uploadDoorHere(door)),
    me: agentOf({ as: flags.as ?? null, env, computerName: seams.computerName ?? computerNameOf(), ...(seams.model !== undefined ? { model: seams.model } : {}) }),
    placeImpl: seams.place ?? (() => placeOf()) };
  // A run given its state (a test) carries this computer only through the carry it is given.
  context.carry = seams.carry ?? (seams.state ? null : () => carryThisComputer(context));
  const print = (name, answer) => (flags.json ? JSON.stringify(answer, null, 2) : render(name, answer));
  const engine = settings.engine;
  if (command === 'help' || flags.help) return fill(HELP, settings.site ? { ...settings.site, CLI: settings.site.cli.toUpperCase().replace(/-/g, '_') } : {});
  if (command === 'login') return login(context, { again: flags.again === true });
  if (command === 'logout') return logout(context);
  if (command === 'connection') {
    const credential = await credentialFor({ env, store: context.store, grants: context.grants, fetchImpl: context.fetchImpl }).catch(() => null);
    // Said from the credential held now; the kept file is only what a bridge reads, and is rewritten from this with --write.
    const kept = credential === null && context.state.connection() ? context.state.connection()
      : connectionOf({ origin: (doorFor({ asked: context.asked, declared: context.declared, credential, localMcp: context.localMcp() })).origin, store: context.store, credential });
    if (flags.write === true) context.state.keepConnection(kept);
    return flags.json ? JSON.stringify(kept, null, 2) : [`${kept.mcp_url}  (${kept.key_source.kind === 'sign-in' ? 'signed in' : 'key'}: ${kept.key_source.where})`, ...kept.recipes.map(row => `${row.label}: ${row.command}`)].join('\n');
  }
  if (command === 'setup') {
    const only = flags.harness ? String(flags.harness).split(',') : null;
    const lines = [await login(context)];
    for (const row of installProgram()) lines.push(`${row.outcome}: ${row.path}${row.note ? ` (${row.note})` : ''}`);
    const skills = installSkills({ only });
    for (const row of skills) lines.push(`${row.outcome}: ${row.app} skill ${row.path}${row.note ? ` (${row.note})` : ''}`);
    if (!skills.length) lines.push('No AI app folders were found here; name one with --harness claude-code,codex,cursor.');
    return lines.join('\n');
  }
  if (command === 'records') return records(context, words);
  if (command === 'update') return updateWords();
  // The carrier's key, on descriptor 3 only (the carrier's credential command), never on the output.
  if (command === 'carrier-key') {
    const key = carrierKeyStore().read();
    if (!key) throw new CommandError(fill(settings.words.not_carried, { why: 'no key is kept here' }), { status: 3 });
    writeSync(3, key.private);
    return '';
  }
  if (command === 'serve') return serve(context);
  if (!TASK_COMMANDS.has(command) && !['whoami', 'tools', 'connect', 'call', 'op', 'who', 'publish', 'schedule'].includes(command)) throw new CommandError(`Unknown command ${command}. Run ${cliName()} help.`, { status: 2 });
  const pinned = command === 'op' || command === 'schedule' ? pinRouteOf(flags) : {};
  if (command === 'call' || command === 'op') {
    const known = settings.direct_calls.flags[command];
    const unknown = Object.keys(flags).find(name => !known.includes(name));
    if (unknown !== undefined) throw new CommandError(fill(settings.words.unknown_flag, { command, flag: unknown, known: known.map(name => `--${name}`).join(', ') }), { status: 2 });
    if (flags['dry-run'] === true) {
      const request = { ...(flags.address ? { address: flags.address } : {}), method: opMethod(words[0]), ...pinned,
        request_key: flags['request-key'] ?? randomUUID(), input: await readJson(words[1], '{"id": "..."}') };
      return JSON.stringify(request, null, 2);
    }
  }
  // A task command's words are checked before anything is sent; then its one read or move runs (taskCommand).
  const requestKey = randomUUID();
  const call = TASK_COMMANDS.has(command) ? argumentsFor(command, { words, flags }, { me: context.me, held: context.state.held(), requestKey }) : null;
  const client = await signedInClient(context);
  // A move the task rows do not allow is said in the rows' own words, as a refusal (status 1), never as a program failure.
  if (call) return taskCommand(client, context, { command, call, flags, requestKey, stdinBytes, stdout: seams.stdout ?? process.stdout, print })
    .catch(error => { throw error?.code === 'tool_refused' ? new CommandError(error.message, { status: 1 }) : error; });
  if (command === 'publish') {
    const held = words[0] === undefined ? null : await readJson(words[0], '{"kind": "cli"}');
    return JSON.stringify(await publishRecord(client, context, { held }), null, 2);
  }
  if (command === 'whoami') {
    // An engine started again holds no one until told: a pass it has not held is added again here, as login adds it.
    const kept = client.credential.kind === 'key' && client.credential.where !== settings.env.key;
    // A key the Mac app kept long ago that the engine will not read is no sign-in: say so at once, never after retries.
    const known = await knownAs(context, client).catch(error => { throw kept && refusedBy(error) ? new CommandError(settings.words.no_credential, { status: 3, detail: error.detail }) : error; });
    const { account } = known;
    const { agent_id, ai_id, held_as, app, model, provider, computer, harness } = context.me;
    return flags.json ? JSON.stringify({ account_id: account, agent_id, ai_id, held_as, app, model, provider, computer, harness, door: client.door.mcp, local: client.door.local }, null, 2)
      : [signedInWords(client.credential), fill(settings.words.whoami_where, { where: client.door.local ? settings.words.this_mac : new URL(client.door.mcp).host }), fill(settings.words.whoami_ai, { ai: ai_id }), fill(settings.words.whoami_facts, { facts: [app, model, provider, computer].filter(Boolean).join(', ') }),
        ...(flags.verbose === true ? [`account ${account}`, ...(held_as.length ? [`tasks taken before this session had its own id are finished as ${held_as.join(', ')}`] : []), `door ${client.door.mcp}`] : [])].join('\n');
  }
  if (command === 'schedule') {
    const requestKey = flags['request-key'] ?? randomUUID();
    if (requestKey.length > 160) throw new CommandError('A schedule --request-key may be at most 160 characters so its per-step keys remain unique.', { status: 2 });
    return print('schedule', await schedules(client, words, { requestKey, rules: settings, inputFile: flags.input, route: pinned }));
  }
  if (command === 'tools') return print('tools', { tools: await allPages(client, null, engine.tools_list, {}, 'tools') });
  if (command === 'connect') return JSON.stringify(await connectToolServer(client, words[0], { origin: context.state.site() }), null, 2);
  if (command === 'call' || command === 'op') {
    // An answer too large for one reply is read page by page, joined and checked (opWhole) before it is printed.
    const whole = answer => (typeof answer === 'string' ? answer : JSON.stringify(answer, null, 2));
    if (command === 'call') {
      const tool = need(words[0], `Name the tool: ${cliName()} call TOOL JSON, with an id from ${cliName()} tools.`);
      const input = await readJson(words[1], '{"text": "..."}');
      const timeoutSeconds = flags.timeout === undefined ? undefined : timeoutOf(flags.timeout);
      const request = withUntil(engine.tools_run, { tool, input }, { requestKey: flags['request-key'] ?? null, timeoutSeconds, state: context.state });
      return whole(await opWhole(client, null, engine.tools_run, request, { requestKey: flags['request-key'], route: await routeOf(client, tool), upload: uploadOf(flags.upload) }));
    }
    const method = opMethod(words[0]);
    const timeoutSeconds = flags.timeout === undefined ? undefined : timeoutOf(flags.timeout);
    const request = withUntil(method, await readJson(words[1], '{"id": "..."}'), { requestKey: flags['request-key'] ?? null, timeoutSeconds, state: context.state });
    return whole(await opWhole(client, flags.address ?? null, method, request, { requestKey: flags['request-key'], route: pinned, upload: uploadOf(flags.upload) }));
  }
  if (command === 'who') {
    const now = Date.now();
    const { account } = await client.whoami();
    // Who may take work: the records of who_types, handed in with the tasks held now, so each one's busy count is read too.
    const store = tasksStoreOf(context);
    const { result } = await runTaskMove(resourceOf(client, { store }), { tool: settings.who.tool, input: {}, read: { types: whoTypes(store), tasks: { statuses: wordsOfStates([takenState]), ...(store ? { fields: settings.tasks.store.busy_fields } : {}) } } });
    const rows = result?.who ?? [];
    const recent = row => flags.all === true || aiOf(row, { now }).recent;
    const shown = rows.filter(recent);
    const list = flags.list === undefined ? null : readJsonFile(flags.list, 'the list', '{"title_field": "name", "fields": [...]}');
    const names = list === null ? [] : await namesOf(client, shown.map(row => row.value ?? {}), list);
    const ais = shown.map((row, at) => aiOf(row, { name: names[at] ?? null, now, owner: account }));
    return print('who', { you: account, all: flags.all === true, groups: groupsOf(ais, { you: account }), hidden: rows.length - shown.length });
  }
}


/** The Workshop copy of this command that the installed copy runs, or null (rules.install.follow). Only the installed copy follows:
 *  a copy run from anywhere else (the Workshop's own, a checkout) runs itself, so the two never hand off to each other. */
export function workshopProgram({ rules = settings, home = homedir(), here = HERE, self = fileURLToPath(import.meta.url) } = {}) {
  const follow = rules.install.follow;
  const real = path => { try { return realpathSync(path); } catch { return null; } };
  if (real(here) !== real(expand(rules.install.folder, home))) return null;
  // Each person's state folder the engine config names, with the Workshop install its engine keeps current.
  const installed = state => {
    let current;
    try { current = JSON.parse(readFileSync(join(state, follow.installs_folder, follow.state_file), 'utf8'))[follow.current_field]; } catch { return null; }
    if (typeof current !== 'string' || !/^[\w.-]+$/.test(current)) return null;
    return real(join(state, follow.installs_folder, current, follow.program));
  };
  for (const file of rules.computer_config_files) {
    let persons;
    try { persons = JSON.parse(readFileSync(expand(file, home), 'utf8'))[follow.persons_field]; } catch { continue; }
    if (typeof persons !== 'string') continue;
    let names;
    try { names = readdirSync(persons); } catch { continue; }
    const programs = names.map(name => installed(join(persons, name))).filter(program => program !== null);
    // One person: their copy. Several: none, rather than a guess of whose.
    if (programs.length === 1 && programs[0] !== real(self)) return programs[0];
    return null;
  }
  return null;
}

/** The node inside the Mac app (command.json `mac_app`) when this program is not already running under it, else null. */
export function appNodeToRunUnder({ rules = settings, execPath = process.execPath, env = process.env } = {}) {
  // Run again at most once: a run that is already the re-run never starts another, whatever the paths say.
  if (env[rules.env.rerun]) return null;
  // The file system's own spelling of each path (a case-blind disk answers /Applications/x.app for /Applications/X.app).
  const real = path => { try { return realpathSync.native(path); } catch { return null; } };
  const appNode = real(join(rules.mac_app, 'Contents', 'MacOS', 'node'));
  return appNode !== null && appNode !== real(execPath) ? appNode : null;
}

// Run when started as a program (directly, or through the link setup puts on PATH).
const startedAsProgram = (() => { try { return realpathSync(process.argv[1] ?? '') === realpathSync(fileURLToPath(import.meta.url)); } catch { return false; } })();
if (startedAsProgram) {
  // The site this command speaks for, first: its folders, its app and what it follows are the site's.
  const site = siteOf();
  speakFor(site);
  // The engine on this computer admits only code the Mac app signed, so a shell's own node runs this program again under the app's.
  const appNode = appNodeToRunUnder();
  if (appNode !== null) {
    const again = spawnSync(appNode, process.argv.slice(1), { stdio: 'inherit', env: { ...process.env, [settings.env.rerun]: '1' } });
    process.exit(again.status ?? 1);
  }
  // The installed copy runs the Workshop's copy when there is one; a copy that cannot be loaded leaves this one to run.
  let run = { main, CommandError };
  const followed = workshopProgram();
  if (followed !== null) run = await import(pathToFileURL(followed).href).catch(() => run);
  run.main(process.argv.slice(2), { site }).then(text => { if (text) process.stdout.write(`${text}\n`); }, error => {
    const known = error instanceof run.CommandError || error instanceof CommandError;
    const words = known ? error.message : `${run.cliName?.() ?? 'command'}: ${error.stack ?? error}`;
    // The technical line of a refusal is printed only with --verbose.
    const technical = known && error.detail && process.argv.includes('--verbose') ? error.detail : null;
    // With --json a refusal is {code, message} on the error line, so a program reads the engine's code and never the words.
    process.stderr.write(`${process.argv.includes('--json') ? JSON.stringify({ code: error.code ?? null, message: words, ...(technical ? { detail: technical } : {}) }) : [words, technical].filter(Boolean).join('\n')}\n`);
    process.exitCode = known ? error.status : 1;
  });
}
