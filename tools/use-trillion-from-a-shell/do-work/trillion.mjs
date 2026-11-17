#!/usr/bin/env node
// tools/use-trillion-from-a-shell/do-work/trillion.mjs
//
// Moved from Trillion-X/trillion harness/trillion.mjs; the files it installs beside itself are this folder's.
//
// Purpose
//   The `trillion` command: any AI that can run a shell (Claude Code, Codex, Cursor, Gemini CLI, opencode, a script) sees
//   the person's AIs and their AI jobs, hands and takes work, lists and runs Workshop tools and runs any engine
//   operation, with no MCP connection of its own. Every command is ONE call of the engine's one MCP tool,
//   run_resource_operation {address, method, request_key, input} (trillion.json `engine`), at the account's door: the Mac
//   app's local door when this computer has one (./local-door.mjs), else the address given (--origin or TRILLION_ORIGIN). The engine's own
//   checks and the Workshop work tools (tools/hand-work-to-ais) decide; nothing here decides, stores or routes work.
//
//     trillion setup                      sign in once, put `trillion` on PATH, write the skill for each AI app here
//     trillion whoami                     who is signed in, this AI's id and facts (--verbose: the account id and the address that answered)
//     trillion who [--all]                the person's AIs, named by the list:ais name formula, grouped by owner
//     trillion publish                    write this AI's own `ai` record (its facts and when it was seen)
//     trillion send|work|take|finish|fail|stuck|release|withdraw|remove|serve
//                                         AI jobs, each through the Workshop tool its trillion.json `work` row names
//     trillion events ID                  one job's versions, newest first
//     trillion tools | call TOOL JSON     the Workshop tools, and run one
//     trillion op ADDRESS METHOD JSON     any engine operation
//     records replay-from-transcripts --since TIME | --write --inventory FOLDER
//                                         the rows this computer's AIs wrote, from their transcripts
//                                         (replay-recorded-writes.mjs)
//
// Non-negotiable invariants
//   1. One road: run_resource_operation over MCP JSON-RPC at the door. The only other addresses are the public origin's
//      own sign-in (OAuth, at the endpoints its /.well-known documents name), used by login and to renew the sign-in it kept.
//   2. The credential is the account's existing key (the Keychain item the Trillion Mac app keeps, else a 0600 file, else
//      TRILLION_KEY) or the sign-in login kept. It is read into memory only, never printed, never put in a command line
//      or a log; the Keychain is written through `security -i` on standard input. logout forgets only a credential this
//      program made, never the Mac app's key.
//   3. Every call carries one request_key, reused on every retry, so a retry is answered as the first call was.
//   4. A refusal says which door refused and why. "trillion login" is said only when there is no credential at all.
//   5. A claim is the work tool's conditioned write: a job another AI moved first is reported, never retried blindly.
//   6. An AI's name is never stored or built here: `who` evaluates the name formula of the `ai_list` list over the rows.
//   7. Settings, the skill text, the work table and every place written are DATA in trillion.json and trillion-skill.md;
//      a new AI app is one `skills` row and one `agents` row.
//
import { spawn, spawnSync } from 'node:child_process';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { chmodSync, existsSync, lstatSync, mkdirSync, readFileSync, readlinkSync, realpathSync, renameSync, rmSync, statSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { createServer, request as httpRequest } from 'node:http';
import { homedir, hostname } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { runOnAgUi } from './ag-ui-agent.mjs';
import { makeHashCodeHexFromBytes, requestKeyForEngine } from './packs/read-data/identity.mjs';
import { settledWrite } from './packs/read-data/settled-write.mjs';
import { KeepRefused, keepResult, readResult } from './keep-result.mjs';
import { localDoorAddress, localDoorOrigin } from './local-door.mjs';
import settings from './trillion.json' with { type: 'json' };

const HERE = dirname(fileURLToPath(import.meta.url));
const fill = (template, values) => template.replace(/\{(\w+)\}/g, (whole, name) => (values[name] === undefined ? whole : String(values[name])));
const pause = ms => new Promise(done => setTimeout(done, ms));
const object = value => Boolean(value) && typeof value === 'object' && !Array.isArray(value);

export class TrillionError extends Error {
  constructor(message, { status = 1, answer = null, detail = null } = {}) { super(message); this.status = status; this.answer = answer; this.detail = detail; }
}

/** A path from settings with ~ as the home folder. */
export const expand = (path, home = homedir()) => (path === '~' ? home : path.startsWith('~/') ? join(home, path.slice(2)) : path);

/** This computer's name as it reads in an agent id: lower-case words joined by dashes ("Work-Laptop.local" -> "work-laptop"). */
export const computerOf = (name = hostname()) => name.split('.')[0].toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'computer';

/** A chat session's id as it reads in an agent id: its last letters and digits (the random end of a UUID v4 or v7). */
export const sessionOf = (value, rules = settings) => String(value).toLowerCase().replace(/[^a-z0-9]+/g, '').slice(-rules.agent_id.session_chars);

const run = (command, args, options = {}) => spawnSync(command, args, { encoding: 'utf8', timeout: 10_000, ...options });

/** The name the person gave this computer, as people read it: the system's own computer name (trillion.json
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

/** The provider of a model id, a fact read from trillion.json `model_families` by the id's first word, or null. */
export const providerOf = (id, rules = settings) => (id ? rules.model_families.find(row => row.prefix === id.split(/[-_\s]+/)[0].toLowerCase())?.provider ?? null : null);

/** Which AI runs this command: --as, else TRILLION_AGENT, else the first `agents` row whose variable is set, one id per
 *  chat session when that app names its session (`session_env`), else one per computer. `held_as` are the other ids a job
 *  this AI holds may have been taken under: the computer id, for jobs taken before sessions had their own id. `ai_id` is
 *  its `ai` record id. `app`, `model`, `provider` and `computer` are the facts its record carries; no name is made here. */
export function agentOf({ as = null, env = process.env, computer = computerOf(), computerName = null, model = undefined, rules = settings } = {}) {
  const row = rules.agents.find(item => item.env.some(name => env[name])) ?? rules.fallback_agent;
  const named = (row.session_env ?? []).map(name => env[name]).find(value => typeof value === 'string' && sessionOf(value, rules));
  const session = named === undefined ? null : sessionOf(named, rules);
  const values = { harness: row.harness, agent: row.agent, computer, session };
  const computerId = fill(rules.agent_id.computer, values);
  const chosen = as ?? (env.TRILLION_AGENT || null);
  const agent_id = chosen ?? (session ? fill(rules.agent_id.session, values) : computerId);
  // Trillion trims an agent id and cuts it at most_chars, so a longer or padded id would name some other agent.
  if (!agent_id || agent_id !== agent_id.trim() || agent_id.length > rules.agent_id.most_chars) {
    throw new TrillionError(`An agent id is 1 to ${rules.agent_id.most_chars} characters with no space at either end.`, { status: 2 });
  }
  const modelId = model === undefined ? modelOf(row, { env, rules }) : model;
  return { agent_id, ai_id: aiIdOf(agent_id, rules), held_as: chosen || !session ? [] : [computerId], session: chosen ? null : session, harness: row.harness,
    app: row.app ?? null, model: modelId, provider: providerOf(modelId, rules) ?? row.provider ?? null, computer: computerName ?? computer };
}

/** An `ai` record id for an agent id or an id that already is one (trillion.json `engine.ai_type`). */
export const aiIdOf = (id, rules = settings) => (String(id).startsWith(`${rules.engine.ai_type}:`) ? String(id) : `${rules.engine.ai_type}:${id}`);

// ── Command line ─────────────────────────────────────────────────────────────────────────────────────────────────

const VALUE_FLAGS = new Set(['job', 'source-file', 'obligations-file', 'continuation-file', 'request-key', 'as', 'timeout', 'wait', 'summary', 'because', 'reason', 'priority', 'key', 'origin', 'harness', 'outcome', 'limit', 'status', 'to', 'from', 'taker', 'label', 'ag-ui', 'since', 'inventory', 'check-file', 'acceptance-file']);

/** argv -> { words, flags, rest }: `--name value` for VALUE_FLAGS, `--name` alone is true, everything after `--` is rest. */
export function parseArgs(argv) {
  const words = [], flags = {};
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (value === '--') return { words, flags, rest: argv.slice(index + 1) };
    if (!value.startsWith('--') || value === '-') { words.push(value); continue; }
    const [name, inline] = value.slice(2).split(/=(.*)/s, 2);
    if (inline !== undefined) flags[name] = inline;
    else if (VALUE_FLAGS.has(name)) {
      if (argv[index + 1] === undefined) throw new TrillionError(`--${name} needs a value.`, { status: 2 });
      flags[name] = argv[index += 1];
    } else flags[name] = true;
  }
  return { words, flags, rest: [] };
}

const wholeNumber = (value, name) => {
  if (value === undefined) return undefined;
  const number = Number(value);
  if (!Number.isInteger(number) || number < 0) throw new TrillionError(`--${name} is a whole number.`, { status: 2 });
  return number;
};
const need = (value, words) => { if (value === undefined || value === '') throw new TrillionError(words, { status: 2 }); return value; };
const joined = list => (list.length ? list.join(' ') : undefined);
/** The JSON object in `file` (a --check-file or --acceptance-file), or a refusal saying what it should hold. */
const readJsonFile = (file, name, example) => {
  let value;
  try { value = JSON.parse(readFileSync(String(file), 'utf8')); } catch (error) { throw new TrillionError(`Could not read ${name} JSON from ${file}: ${error.message}`, { status: 2 }); }
  if (!object(value) && !(name === 'obligations' && Array.isArray(value))) throw new TrillionError(`${name} is one JSON object${name === 'obligations' ? ' or array' : ''}, for example ${example}.`, { status: 2 });
  return value;
};
const validTime = value => typeof value === 'string' && Number.isFinite(Date.parse(value)) && /^\d{4}-\d\d-\d\dT.*(?:Z|[+-]\d\d:\d\d)$/.test(value);
const validateEvidence = rows => Array.isArray(rows) && rows.length > 0 && rows.every(row => object(row) && typeof row.ref === 'string' && row.ref.trim() && typeof row.observation === 'string' && row.observation.trim());
export function validateCheck(check) {
  if (!object(check) || typeof check.outcome !== 'string' || !check.outcome.trim() || !validTime(check.checked_at) || !validateEvidence(check.evidence) || !Array.isArray(check.obligations))
    throw new TrillionError('A check receipt needs outcome, an ISO checked_at time, evidence rows with ref and observation, and obligations (an empty array when none were requested).', { status: 2 });
  if (check.obligations !== undefined && (!Array.isArray(check.obligations) || check.obligations.some(row => !object(row) || typeof row.id !== 'string' || !row.id.trim() || typeof row.outcome !== 'string' || !row.outcome.trim() || !validateEvidence(row.evidence))))
    throw new TrillionError('Each obligation check needs its id, outcome, and evidence rows with ref and observation.', { status: 2 });
  return check;
}
export function validateContinuation(value) {
  if (!object(value) || typeof value.owner !== 'string' || !/^ai:[A-Za-z0-9._:-]+$/.test(value.owner) || typeof value.action !== 'string' || !value.action.trim() || !validTime(value.after) || typeof value.reason !== 'string' || !value.reason.trim())
    throw new TrillionError('A continuation needs owner ai:NAME, action, ISO after time, and reason.', { status: 2 });
  return value;
}
const validateSource = value => {
  if (!object(value) || typeof value.kind !== 'string' || !value.kind.trim() || typeof value.ref !== 'string' || !value.ref.trim()) throw new TrillionError('A source needs kind and ref.', { status: 2 });
  return value;
};
const validateObligations = value => {
  if (!Array.isArray(value) || value.some(row => !object(row) || typeof row.id !== 'string' || !row.id.trim() || typeof row.outcome !== 'string' || !row.outcome.trim()) || new Set(value.map(row => row.id)).size !== value.length)
    throw new TrillionError('Obligations are unique rows with id and outcome.', { status: 2 });
  return value;
};
export function validateAcceptance(value) {
  if (!object(value) || typeof value.outcome !== 'string' || !value.outcome.trim() || !object(value.target) || typeof value.target.type !== 'string' || !value.target.type.trim() || typeof value.target.id !== 'string' || !value.target.id.trim() || !Array.isArray(value.rules))
    throw new TrillionError('Acceptance needs outcome, target type and id, and a rules array.', { status: 2 });
  return value;
}
export function checkForJob(check, job) {
  try { validateCheck(check); } catch { return false; }
  if (!job.acceptance) return false;
  const expected = job.acceptance.outcome;
  if (check.outcome !== expected) return false;
  const obligations = job.obligations ?? [];
  if (check.obligations.length !== obligations.length) return false;
  const byId = new Map(check.obligations.map(row => [row.id, row]));
  if (byId.size !== obligations.length) return false;
  for (const required of obligations) {
    const got = byId.get(required.id);
    if (!got || got.outcome !== required.outcome) return false;
  }
  return true;
}

/** Which of this AI's ids holds job `id`: its own, else an id it held work under before (held.json), else its own. */
export const holderOf = (me, held, id) => [me.agent_id, ...(me.held_as ?? [])].find(agent => held[`${agent} ${id}`] !== undefined) ?? me.agent_id;

/** The jobs this AI holds, newest last: { id, said }. */
export const holdingOf = (me, held) => Object.entries(held).flatMap(([key, kept]) => {
  const agent = key.slice(0, key.lastIndexOf(' ')), id = key.slice(key.lastIndexOf(' ') + 1);
  return [me.agent_id, ...(me.held_as ?? [])].includes(agent) ? [{ id, said: typeof kept === 'object' ? kept?.said ?? '' : '' }] : [];
});

/** The work commands, each answered by the Workshop work tool its trillion.json `work` row names, and serve, which takes
 *  and moves jobs through the same rows. `work.actions` are the commands that move a job with tool:change-an-ai-job. */
export const WORK_COMMANDS = new Set(['send', 'work', 'take', 'serve', ...Object.keys(settings.work.actions)]);

/** Runs one work tool (`work.tools[name]`) with `input`: tools:run at the door. Answers the tool's own answer, whole: a job
 *  row too large for one reply (a long brief) comes as byte pages, which are read through under the call's request key. */
export async function workCall(client, name, input, { idempotent = false, rules = settings } = {}) {
  const requestKey = randomUUID(), method = rules.engine.tools_run, request = { tool: rules.work.tools[name], input };
  const first = await client.op(rules.engine.tools, method, request, { idempotent, requestKey });
  const answer = bytePageOf(first) ? await wholeAnswer(client, rules.engine.tools, method, request, first, { requestKey, rules }) : first;
  return object(answer) && Object.hasOwn(answer, 'result') ? answer.result : answer;
}

/** The work call one work command makes: { work, input }, `work` naming its trillion.json `work.tools` row. `me` is
 *  agentOf(); `held` is what this AI last took (a job moves as the id that took it). */
export function argumentsFor(command, { words, flags }, { me, held = {}, requestKey = randomUUID(), rules = settings } = {}) {
  const [first, ...more] = words;
  const as = id => aiIdOf(holderOf(me, held, id), rules);
  const move = (action, extra) => ({ work: 'change', input: { as: as(first), id: first, action, ...extra } });
  switch (command) {
    case 'send': {
      const to = need(first, 'Say who: trillion send any "JOB", or trillion send AI "JOB" with an id from trillion who.');
      const job = need(joined(more), 'Say the job: trillion send any "JOB".');
      const acceptance = flags['acceptance-file'] ? validateAcceptance(readJsonFile(flags['acceptance-file'], 'acceptance', '{"outcome":"...","target":{"type":"...","id":"..."},"rules":[...]}')) : null;
      if (acceptance && flags.outcome !== undefined && flags.outcome !== acceptance.outcome) throw new TrillionError('--outcome must exactly match acceptance.outcome.', { status: 2 });
      return { work: 'send', input: {
        as: me.ai_id, job, key: flags.key ?? requestKey, to: to === 'any' ? null : aiIdOf(to, rules),
        ...(flags.priority !== undefined ? { priority: wholeNumber(flags.priority, 'priority') } : {}),
        ...(flags.outcome !== undefined ? { outcome: flags.outcome } : acceptance ? { outcome: acceptance.outcome } : {}),
        ...(flags.label ? { label: flags.label } : {}),
        ...(flags['source-file'] ? { source: validateSource(readJsonFile(flags['source-file'], 'source', '{"kind":"repository","ref":"..."}')) } : {}),
        ...(flags['obligations-file'] ? { obligations: validateObligations(readJsonFile(flags['obligations-file'], 'obligations', '[{"id":"...","outcome":"..."}]')) } : {}),
        ...(acceptance ? { acceptance } : {}),
      } };
    }
    case 'work': return { work: 'see', input: first ? { id: first } : {
      ...(flags.status ? { status: flags.status } : {}), ...(flags.to ? { to: aiIdOf(flags.to, rules) } : {}),
      ...(flags.from ? { from: aiIdOf(flags.from, rules) } : {}), ...(flags.taker ? { taker: aiIdOf(flags.taker, rules) } : {}),
      limit: wholeNumber(flags.limit, 'limit') ?? rules.work_list_limit,
    } };
    case 'take': return { work: 'take', input: { as: me.ai_id, ...(first ? { id: first } : {}), ...(flags.mine ? { only_mine: true } : {}) } };
    case 'finish':
    case 'fail': {
      need(first, `Name the job: trillion ${command} ID "RESULT".`);
      const result = need(joined(more), `Say what came of it: trillion ${command} ID "RESULT".`);
      return move(rules.work.actions[command], { result, ...(command === 'finish' ? { summary: flags.summary ?? result.split('\n')[0].slice(0, 300) } : {}),
        ...(flags['check-file'] ? { check: validateCheck(readJsonFile(flags['check-file'], 'check', '{"outcome":"...","checked_at":"...","evidence":[{"ref":"...","observation":"..."}],"obligations":[]}')) } : {}) });
    }
    case 'plan': {
      need(first, 'Name the job: trillion plan ID --acceptance-file JSON.');
      return move(rules.work.actions.plan, { acceptance: validateAcceptance(readJsonFile(need(flags['acceptance-file'], 'Name the saved consumer acceptance: --acceptance-file JSON.'), 'acceptance', '{"outcome":"...","target":{"type":"...","id":"..."},"rules":[...]}')) });
    }
    case 'stuck': {
      need(first, 'Name the job: trillion stuck ID "WHAT IS IN THE WAY".');
      return flags.clear ? move(rules.work.actions.unstuck, {}) : move(rules.work.actions.stuck, { words: need(joined(more), 'Say what is in the way, or pass --clear.') });
    }
    case 'release': need(first, `Name the job: trillion release ID --because "WHY".`); return move(rules.work.actions.release, { ...(flags.because ? { because: flags.because } : {}), ...(flags['continuation-file'] ? { continuation: validateContinuation(readJsonFile(flags['continuation-file'], 'continuation', '{"owner":"ai:...","action":"...","after":"...","reason":"..."}')) } : {}) });
    case 'wait': need(first, `Name the job: trillion wait ID --continuation-file JSON.`); return move(rules.work.actions.wait, { continuation: validateContinuation(readJsonFile(need(flags['continuation-file'], 'Say who owns the next step and when: --continuation-file JSON.'), 'continuation', '{"owner":"ai:...","action":"...","after":"...","reason":"..."}')) });
    case 'resume': need(first, `Name the job: trillion resume ID.`); return move(rules.work.actions.resume, { because: need(flags.because, 'Say what changed after reviewing the existing effects: --because WORDS.') });
    case 'edit': {
      need(first, `Name the job: trillion edit ID [--job WORDS].`);
      const input = {
        ...(flags.job !== undefined ? { job: flags.job } : {}),
        ...(flags.outcome !== undefined ? { outcome: flags.outcome } : {}),
        ...(flags.label !== undefined ? { label: flags.label } : {}),
        ...(flags['source-file'] ? { source: validateSource(readJsonFile(flags['source-file'], 'source', '{"kind":"repository","ref":"..."}')) } : {}),
        ...(flags['obligations-file'] ? { obligations: validateObligations(readJsonFile(flags['obligations-file'], 'obligations', '[{"id":"...","outcome":"..."}]')) } : {}),
        ...(flags.to !== undefined ? { to: flags.to === 'any' ? null : aiIdOf(flags.to, rules) } : {}),
        ...(flags.priority !== undefined ? { priority: wholeNumber(flags.priority, 'priority') } : {}),
      };
      if (!Object.keys(input).length) throw new TrillionError('Name at least one field to change with --job, --outcome, --label, --source-file, --obligations-file, --to, or --priority.', { status: 2 });
      return move(rules.work.actions.edit, input);
    }
    case 'withdraw': need(first, 'Name the job: trillion withdraw ID --reason "WHY".'); return move(rules.work.actions.withdraw, { because: need(flags.reason, 'Say why: --reason "WHY".') });
    case 'remove': need(first, 'Name the job: trillion remove ID.'); return move(rules.work.actions.remove, {});
    default: throw new TrillionError(`Unknown command ${command}. Run trillion help.`, { status: 2 });
  }
}

/** This AI's `ai` record as `publish` writes it: the record it already has (its other cells kept as they are; a new
 *  record starts from `ai_record.new`) with its fact cells set: `owner` (the account the door answered for, never typed
 *  by the AI), `agent_id`, `app`, `model`, `provider`, `computer`, `harness`, `where` (repository and branch, never a
 *  path), `working_on` (the job it holds, or null) and `live.seen_at` now. No name is written. `facts` is
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
/** `value` when it is a credential of a kind the door takes (trillion.json `bearers.shapes`), else null. Nothing here names a
 *  prefix: a new kind of key or token is a new row. */
export const bearerOf = (value, rules = settings) => (typeof value === 'string' && rules.bearers.shapes.some(row => new RegExp(row.pattern).test(value)) ? value : null);

export function keyStore({ rules = settings, home = homedir(), platform = process.platform, exec = run, account = null } = {}) {
  if (account !== null && !/^[A-Za-z0-9_-]{1,80}$/.test(String(account))) throw new TrillionError('An account id is letters, digits, dashes and underscores.');
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
      if (bearerOf(key, rules) === null) throw new TrillionError('The account answered something that is not a Trillion key.');
      if (keychain) {
        const answer = exec('/usr/bin/security', ['-i'], { input: `add-generic-password -U -a ${holder} -s ${rules.keychain_item} -w ${key}\n`, stdio: ['pipe', 'ignore', 'pipe'] });
        if (answer.status !== 0) throw new TrillionError(`The key could not be kept in the Keychain (${String(answer.stderr ?? '').trim() || answer.status}).`);
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
 * Where this computer keeps the sign-in `login` made (trillion.json `grant`): the Keychain item `grant.keychain_item`,
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
        if (answer.status !== 0) throw new TrillionError(rules.words.sign_in_not_kept, { detail: fill(rules.words.details.sign_in_not_kept, { why: String(answer.stderr ?? '').trim() || answer.status }) });
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
  if (!response.ok) throw new TrillionError(rules.words.sign_in_step_failed, { detail: fill(rules.words.details.sign_in_step_failed, { what, why: value.error_description ?? value.error ?? response.status }) });
  return value;
}
const grantOf = (tokens, { client_id, origin, now = Date.now, found, rules = settings }) => ({ access_token: tokens.access_token, refresh_token: tokens.refresh_token ?? null,
  expires_at_ms: Number.isFinite(tokens.expires_in) ? now() + tokens.expires_in * 1000 : null, client_id, origin,
  token_endpoint: found.token_endpoint, revocation_endpoint: found.revocation_endpoint ?? null, resource: found.resource });

/** What the sign-in server says about itself and the resource it signs in to. The resource's RFC 9728 document is read from the
 *  door the program will call (`resourceDoor`, an MCP address; the issuer's own /mcp when none is given), never from the issuer's
 *  root; its `authorization_servers[0]` names the server whose RFC 8414 document gives the endpoints. */
export async function discover(origin, { fetchImpl = fetch, resourceDoor = `${origin}/mcp`, rules = settings } = {}) {
  const resource = await asJson(await fetchImpl(new URL(rules.protected_resource_path, resourceDoor)), 'Reading the sign-in resource', rules);
  if (typeof resource.resource !== 'string') throw new TrillionError(rules.words.sign_in_step_failed, { detail: fill(rules.words.details.sign_in_step_failed, { what: 'Reading the sign-in resource', why: 'it names no resource' }) });
  const named = resource.authorization_servers?.[0];
  const issuer = typeof named === 'string' && URL.canParse(named) ? new URL(named).origin : origin;
  const server = await asJson(await fetchImpl(`${issuer}/.well-known/oauth-authorization-server`), 'Reading the sign-in server', rules);
  for (const name of ['authorization_endpoint', 'token_endpoint']) if (typeof server[name] !== 'string') throw new TrillionError(rules.words.sign_in_step_failed, { detail: fill(rules.words.details.sign_in_step_failed, { what: 'Reading the sign-in server', why: `it names no ${name}` }) });
  return { authorization_endpoint: server.authorization_endpoint, token_endpoint: server.token_endpoint, revocation_endpoint: server.revocation_endpoint ?? null, resource: resource.resource };
}

/** A kept sign-in renewed at its origin's /oauth/token with its refresh token. A refused renewal means the sign-in ended. */
export async function refreshGrant(grant, { fetchImpl = fetch, rules = settings, now = Date.now } = {}) {
  const response = await fetchImpl(grant.token_endpoint, form({ grant_type: 'refresh_token', refresh_token: grant.refresh_token, client_id: grant.client_id }));
  if (response.status === 400 || response.status === 401) throw new TrillionError(rules.words.sign_in_ended, { status: 3 });
  // A server that is busy or down has not ended the sign-in: say to wait, never to sign in again.
  if (response.status === 429 || response.status >= 500) throw new TrillionError(rules.words.sign_in_busy, { status: 4, detail: fill(rules.words.details.sign_in_step_failed, { what: 'Renewing this computer\'s sign-in', why: response.status }) });
  return grantOf(await asJson(response, 'Renewing this computer\'s sign-in', rules), { client_id: grant.client_id, origin: grant.origin, now, rules, found: grant });
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

/** The credential for this run: TRILLION_KEY (a machine with no Keychain or file), else the sign-in
 *  login kept, else the kept key, renewed first when it ends within `grant.refresh_before_seconds`. { kind: 'key'|'sign-in', bearer, where,
 *  origin? }, or null when there is none. */
export async function credentialFor({ env = process.env, store = keyStore(), grants = grantStore(), fetchImpl = fetch, rules = settings, now = Date.now, home = homedir() } = {}) {
  if (env.TRILLION_KEY) {
    // A key the person put in TRILLION_KEY is sent as given or not at all: one of no declared kind is refused, never swapped for the kept key.
    if (bearerOf(env.TRILLION_KEY, rules) === null) throw new TrillionError(fill(rules.bearers.refused, { kinds: rules.bearers.shapes.map(row => row.kind).join(', ') }), { status: 2 });
    return { kind: 'key', bearer: env.TRILLION_KEY, where: 'TRILLION_KEY' };
  }
  // A sign-in this person made (`trillion login`) is the newer word: it comes before a key an app kept, which an engine that
  // admits only the sign-in tool's passes and API keys would refuse.
  let grant = grants.read();
  if (!grant) {
    const key = store.read();
    return key ? { kind: 'key', bearer: key, where: store.where } : null;
  }
  if (grant.ended === true) throw new TrillionError(rules.words.sign_in_ended, { status: 3 });
  if (endsSoon(grant, rules, now)) grant = await renewedGrant(grant, { grants, fetchImpl, rules, now, home });
  return { kind: 'sign-in', bearer: grant.access_token, where: grants.where, origin: grant.origin };
}

// ── The door ─────────────────────────────────────────────────────────────────────────────────────────────────────

/** The Mac app's local door on this computer (./local-door.mjs, run against the app trillion.json `mac_app` names),
 *  or null when this computer has none. */
export function findLocalDoor({ rules = settings } = {}) {
  try { return localDoorAddress({ runtime: join(rules.mac_app, 'Contents', 'MacOS', 'node') }); } catch { return null; }
}

/** The door this run talks to: `asked` (--origin or TRILLION_ORIGIN); else, for the account's key, the Mac app's local door
 *  when this computer has one; else the origin a sign-in was made at, else the declared address (`declared`, TRILLION_ORIGIN); with none the run is
 *  refused. { mcp, origin, name, local, public (the declared address), localMcp }: `localMcp` is this computer's local door, named when another door refuses the key. */
export function findDeclaredOrigin({ rules = settings } = {}) { return localDoorOrigin({ runtime: join(rules.mac_app, 'Contents', 'MacOS', 'node') }); }

/** Where a sign-in is made when `trillion login` names no address: the one asked (--origin, TRILLION_ORIGIN); else the origin
 *  of the sign-in this computer keeps; else the sign-in server this computer's engine names in its protected-resource
 *  document; else the public origin the app declares. With none the run is refused. */
export async function issuerFor({ asked = null, kept = null, localMcp = findLocalDoor(), declared = findDeclaredOrigin(), fetchImpl = fetch, rules = settings } = {}) {
  if (asked) return asked;
  if (kept) return kept;
  const server = (await engineServersOf(localMcp, { fetchImpl, rules }))[0];
  if (server) return server;
  if (declared) return declared;
  throw new TrillionError(rules.words.no_origin, { status: 2 });
}

/** The sign-in servers (origins) this computer's engine names in its protected-resource document; none when it has no engine
 *  or does not answer. */
async function engineServersOf(localMcp, { fetchImpl, rules }) {
  if (!localMcp) return [];
  const document = await fetchImpl(new URL(rules.protected_resource_path, localMcp)).then(answer => (answer.ok ? answer.json() : null)).catch(() => null);
  return (Array.isArray(document?.authorization_servers) ? document.authorization_servers : []).filter(name => typeof name === 'string' && URL.canParse(name)).map(name => new URL(name).origin);
}

/** The door whose protected-resource document a sign-in at `origin` reads: this computer's engine when it names `origin` as its
 *  sign-in server, else `origin`'s own /mcp. */
export async function resourceDoorFor(origin, { localMcp = findLocalDoor(), fetchImpl = fetch, rules = settings } = {}) {
  return (await engineServersOf(localMcp, { fetchImpl, rules })).includes(origin) ? localMcp : `${origin}/mcp`;
}

export function doorFor({ asked = null, credential = null, declared = null, rules = settings, localMcp = findLocalDoor({ rules }), localIssuers = [] } = {}) {
  const at = mcp => ({ mcp, origin: new URL(mcp).origin, localMcp });
  // A key goes to this computer's local door; a sign-in goes there when this computer's engine names the pass's issuer as its own
  // (`localIssuers`, the authorization_servers of its protected-resource document), else to the address it was made at.
  const own = credential?.kind === 'key' || (credential?.kind === 'sign-in' && localIssuers.includes(credential.origin));
  if (!asked && own && localMcp) return { ...at(localMcp), name: rules.words.local_door, local: true, public: false };
  const named = asked ?? credential?.origin ?? declared;
  if (!named) throw new TrillionError(rules.words.no_origin, { status: 2 });
  const origin = named.replace(/\/$/, '');
  const isPublic = origin === declared;
  const mcp = `${origin}/mcp`;
  return { ...at(mcp), name: isPublic ? rules.words.public_door : rules.words.named_door, local: false, public: isPublic };
}

/** The unix socket this computer's engine answers `POST /persons/add` on, read from its computer config (trillion.json
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

/** Asks this computer's engine to hold the person the pass or key names: `POST /persons/add` on the engine's own unix socket,
 *  which it serves only to the same user on this computer, as this login is. Answers { person, added }; null when this computer
 *  has no engine socket; a TrillionError saying why when the engine refused or does not answer. */
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
  }).catch(error => { throw new TrillionError(rules.words.not_running, { status: 4, detail: fill(rules.words.details.not_running_engine, { url: socket, why: error.code ?? error.message }) }); });
  let answer = {};
  try { answer = JSON.parse(reply.text); } catch { /* no JSON body */ }
  if (reply.status < 200 || reply.status > 299) throw Object.assign(new TrillionError(reply.status === 401 ? rules.words.refused : rules.words.not_taken_in, { status: reply.status === 401 ? 3 : 4, detail: fill(rules.words.details.not_taken_in, { url: socket, status: reply.status, why: answer.error ?? 'refused' }) }), { notTaken: true, why: typeof answer.why === 'string' ? answer.why : null });
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
 * One account's door: `rpc(method, params)`, `tool(name, args)`, `op(address, method, input)` (one run_resource_operation
 * with one request_key, reused on every retry) and `whoami()` (MCP initialize: the account in result._meta). A refusal
 * names the door: 401 is the door refusing this credential, 404 is a route the door does not serve.
 */
export function trillionClient({ door, credential, fetchImpl = fetch, rules = settings, wait = pause, random = Math.random, timeoutSeconds = rules.retry.attempt_seconds } = {}) {
  if (!credential?.bearer) throw new TrillionError(rules.words.no_credential, { status: 3 });
  const headers = { 'content-type': 'application/json', accept: 'application/json, text/event-stream', authorization: `Bearer ${credential.bearer}`, 'user-agent': 'trillion-cli' };
  let next = 0;
  // One try waits this many seconds (--timeout); the call itself ends only when retry.count tries are spent.
  const signal = () => AbortSignal.timeout(timeoutSeconds * 1000);
  const gap = (attempt, asked = null) => retryGap(rules.retry, attempt, asked, random);
  const refused = () => credential.kind === 'sign-in' && !door.local && !audiencesOf(credential.bearer).includes(door.mcp)
    ? new TrillionError(rules.words.not_covered, { status: 3, detail: fill(rules.words.details.not_covered, { mcp: door.mcp }) })
    : new TrillionError(credential.kind === 'key' && !door.local && door.localMcp !== door.mcp && (door.public || door.localMcp)
    ? rules.words.refused_key_at_door : rules.words.refused, { status: 3, detail: fill(rules.words.details.refused, { mcp: door.mcp, kind: credential.kind, where: credential.where }) });
  async function send(body, { idempotent, once = false }) {
    for (let attempt = 0; ; attempt += 1) {
      let response = null, failure = null;
      try { response = await fetchImpl(door.mcp, { method: 'POST', headers, body, signal: signal() }); } catch (error) { failure = error; }
      const passing = failure || response.status === 429 || response.status >= 500;
      // Every try carries the same request_key, so a try after a lost or slow answer is answered as the first was.
      if (passing && !once && attempt < rules.retry.count) { await wait(gap(attempt) * 1000); continue; }
      const maybe = idempotent ? '' : ' It may have happened; read it back before trying again.';
      if (failure?.name === 'TimeoutError') throw new TrillionError(fill(rules.words.no_answer, { trillion: door.name, tries: attempt + 1 }) + maybe, { status: 4, detail: fill(rules.words.details.no_answer, { mcp: door.mcp, seconds: timeoutSeconds, tries: attempt + 1 }) });
      if (failure) {
        const why = failure.cause?.code ?? failure.message;
        throw door.local ? new TrillionError(rules.words.not_running, { status: 4, detail: fill(rules.words.details.not_running, { mcp: door.mcp, why }) })
          : new TrillionError(fill(rules.words.unreachable, { trillion: door.name }) + maybe, { status: 4, detail: fill(rules.words.details.unreachable, { mcp: door.mcp, why }) });
      }
      if (response.status === 401) throw refused();
      if (response.status === 404) throw new TrillionError(fill(rules.words.missing_route, { trillion: door.name }), { status: 4, detail: fill(rules.words.details.missing_route, { mcp: door.mcp, route: new URL(door.mcp).pathname }) });
      if (passing || !response.ok) throw new TrillionError(fill(rules.words.unreachable, { trillion: door.name }) + maybe, { status: 4, detail: fill(rules.words.details.answered, { mcp: door.mcp, status: response.status }) });
      return response;
    }
  }
  async function rpc(method, params, { idempotent = true, once = false } = {}) {
    const id = (next += 1);
    const response = await send(JSON.stringify({ jsonrpc: '2.0', id, method, params }), { idempotent, once });
    const text = await response.text();
    let reply;
    try { reply = repliesOf(text).find(item => item?.id === id); } catch { reply = null; }
    if (!reply) throw new TrillionError(fill(rules.words.unreachable, { trillion: door.name }), { status: 4, detail: fill(rules.words.details.no_reply, { mcp: door.mcp, status: response.status, method }) });
    if (reply.error) throw new TrillionError(reply.error.message ?? fill(rules.words.refused_code, { trillion: door.name }), { answer: reply.error, detail: fill(rules.words.details.answered, { mcp: door.mcp, status: `an error to ${method}` }) });
    return reply.result;
  }
  async function tool(name, args, { idempotent = false } = {}) {
    for (let attempt = 0; ; attempt += 1) {
      const result = await rpc('tools/call', { name, arguments: args }, { idempotent });
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
      const said = words ? fill(words, { trillion: door.name, code, tool: args?.input?.tool ?? name }) : null;
      throw Object.assign(new TrillionError(error.message ?? answer?.text ?? said ?? fill(rules.words.refused_code, { trillion: door.name }), { answer, detail: `${fill(rules.words.details.refused_code, { mcp: door.mcp, tool: name, code: code ?? 'no code' })}${cause}` }), { code });
    }
  }
  const op = (address, method, input = {}, { idempotent = false, requestKey = randomUUID() } = {}) =>
    tool(rules.engine.tool, { address, method, request_key: requestKeyForEngine(requestKey), input }, { idempotent });
  async function whoami() {
    const result = await rpc('initialize', { protocolVersion: rules.engine.protocol_version, capabilities: {}, clientInfo: { name: rules.client_name, version: rules.client_version } }, { once: true });
    const account = result?._meta?.[rules.engine.account_meta]?.account_id;
    if (typeof account !== 'string' || !account) throw new TrillionError(rules.words.no_account, { status: 4, detail: fill(rules.words.details.no_account, { mcp: door.mcp }) });
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
    if (seen.has(next) || next === after) throw new TrillionError(rules.words.pager_stuck, { status: 4, detail: fill(rules.words.details.pager_stuck, { method, next: short(next, 80) }) });
    seen.add(next);
    after = next;
  }
  throw new TrillionError(rules.words.too_many_pages, { status: 4, detail: fill(rules.words.details.too_many_pages, { method, pages: rules.engine.most_pages }) });
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
async function wholeAnswer(client, address, method, input, first, { requestKey, rules = settings } = {}) {
  const broken = why => new TrillionError(rules.words.byte_page_broken, { status: 4, detail: fill(rules.words.details.byte_page_broken, { method, why }) });
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
    if (count >= rules.engine.most_pages) throw new TrillionError(rules.words.too_many_pages, { status: 4, detail: fill(rules.words.details.too_many_pages, { method, pages: rules.engine.most_pages }) });
    const next = await client.op(address, method, { ...input, after_byte: at }, { idempotent: true, requestKey });
    page = bytePageOf(next);
    if (!page) throw broken(`the page after byte ${at} is not a byte_page`);
  }
  const joined = Buffer.concat(parts);
  const got = blake3Hex(joined);
  if (got !== blake3.toLowerCase()) throw new TrillionError(rules.words.byte_page_mismatch, { status: 4, detail: fill(rules.words.details.byte_page_mismatch, { method, bytes: joined.length, got, want: blake3 }) });
  const text = joined.toString('utf8');
  try { return JSON.parse(text); } catch { return text; }
}

/** One operation answered whole: `op` under one request key for the call and every page of its answer, and when the
 *  answer is a byte page, every page after it (wholeAnswer). */
export async function opWhole(client, address, method, input, { requestKey = randomUUID(), rules = settings } = {}) {
  try {
    return await opWholeOnce(client, address, method, input, { requestKey, rules });
  } catch (error) {
    // Every refusal names the key it was sent under, so a caller can quote it. A call that times out may still have landed under
    // this key: the same key answers it, so the way to ask again is the key.
    const line = fill(rules.words.request_key_line, { key: requestKey });
    const hint = error instanceof TrillionError && error.status === 4 ? ` ${fill(rules.words.retry_with_key, { key: requestKey, flag: '--request-key' })}` : '';
    if (error instanceof TrillionError) {
      throw Object.assign(new TrillionError(`${error.message} ${line}${hint}`, { status: error.status, detail: error.detail }), { answer: error.answer, code: error.code });
    }
    throw error;
  }
}

async function opWholeOnce(client, address, method, input, { requestKey, rules }) {
  // A write the engine keeps answers accepted and pending until its writer settles it: the same key then answers the outcome, or the
  // writer's refusal, which the call throws. The wait is the records client's (settled-write.mjs), so no write is reported as kept while pending.
  const first = await settledWrite(answerKey => client.op(address, method, input, { requestKey: answerKey }), requestKey, {
    sleep: client.wait,
    pending: answer => answer?.accepted === true && answer?.pending === true,
    expired: () => new TrillionError(rules.words.write_pending, { status: 4 }),
  });
  return bytePageOf(first) ? wholeAnswer(client, address, method, input, first, { requestKey, rules }) : first;
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
export async function signInWithBrowser({ origin, resourceDoor, rules = settings, fetchImpl = fetch, open = openInBrowser, now = Date.now } = {}) {
  if (!origin) throw new TrillionError(rules.words.no_origin, { status: 2 });
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
    else rejectCode(new TrillionError(rules.words.sign_in_step_failed, { detail: fill(rules.words.sign_in_failed, { why: url.searchParams.get('error_description') ?? url.searchParams.get('error') ?? rules.words.sign_in_failed_unknown }) }));
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(rules.client.redirect_port ?? 0, '127.0.0.1', resolve); });
  const redirect = `http://127.0.0.1:${server.address().port}/callback`;
  try {
    const authorize = new URL(found.authorization_endpoint);
    for (const [name, value] of Object.entries({ response_type: 'code', client_id: `${origin}${rules.client.id_path}`, redirect_uri: redirect, code_challenge: challenge, code_challenge_method: 'S256', state, scope: rules.scope })) authorize.searchParams.set(name, value);
    authorize.searchParams.set('resource', found.resource);
    Promise.resolve().then(() => open(authorize.href)).catch(error => rejectCode(new TrillionError(fill(rules.words.browser_not_opened, { link: authorize.href }), { detail: error.message.split('\n')[0] })));
    let timer;
    const late = new Promise((resolve, reject) => { timer = setTimeout(() => reject(new TrillionError(fill(rules.words.sign_in_late, { seconds: rules.sign_in_wait_seconds }))), rules.sign_in_wait_seconds * 1000); });
    const code = await Promise.race([arrived, late]).finally(() => clearTimeout(timer));
    const tokens = await asJson(await fetchImpl(found.token_endpoint, form({ grant_type: 'authorization_code', code, redirect_uri: redirect, client_id: `${origin}${rules.client.id_path}`, code_verifier: verifier, resource: found.resource })), 'The sign-in exchange', rules);
    if (typeof tokens.access_token !== 'string' || !tokens.access_token) throw new TrillionError(rules.words.sign_in_step_failed, { detail: fill(rules.words.details.sign_in_step_failed, { what: 'The sign-in exchange', why: 'no access token' }) });
    return grantOf(tokens, { client_id: `${origin}${rules.client.id_path}`, origin, now, found, rules });
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

// ── Local state: the key this program made, and each job this AI took ────────────────────────────────────────────

export function stateOf({ rules = settings, home = homedir() } = {}) {
  const folder = expand(rules.state_folder, home);
  const path = name => join(folder, name);
  const read = name => { try { return JSON.parse(readFileSync(path(name), 'utf8')); } catch { return null; } };
  const write = (name, value) => { mkdirSync(folder, { recursive: true, mode: 0o700 }); writeFileSync(`${path(name)}.new`, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 }); renameSync(`${path(name)}.new`, path(name)); };
  return {
    held: () => read(rules.held_file)?.held ?? {},
    // Kept per agent and job, so a job is moved as the id that took it, and this AI's record can say what it is doing.
    hold(agentId, job) {
      const held = read(rules.held_file)?.held ?? {};
      held[`${agentId} ${job.id}`] = { said: short(job.job ?? '', rules.agent_card.doing_chars) };
      write(rules.held_file, { held: Object.fromEntries(Object.entries(held).slice(-200)) });
    },
    letGo(agentId, jobId) {
      const held = read(rules.held_file)?.held ?? {};
      delete held[`${agentId} ${jobId}`];
      write(rules.held_file, { held });
    },
    connection: () => read(rules.connection.file),
    keepConnection: value => write(rules.connection.file, value),
    forgetConnection: () => rmSync(path(rules.connection.file), { force: true }),
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
 *  installer owns the copy: each `trillion setup` from a newer program writes the files that changed. */
export function installProgram({ rules = settings, home = homedir(), from = HERE } = {}) {
  const folder = expand(rules.install.folder, home);
  const rows = rules.install.files.map(name => ({ path: join(folder, name), outcome: writeIfChanged(join(folder, name), readFileSync(join(from, name)), name.endsWith('.mjs') ? 0o755 : 0o644) }));
  const link = expand(rules.install.link, home), target = join(folder, 'trillion.mjs');
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

/** The skill text for every app: trillion-skill.md with this program's command filled in. */
export const skillText = ({ from = HERE, command = 'trillion' } = {}) => fill(readFileSync(join(from, 'trillion-skill.md'), 'utf8'), { command });

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

const QUIET = new Set(['ai_instructions', 'trillion/screen']);
const quiet = value => (object(value) ? Object.fromEntries(Object.entries(value).filter(([name]) => !QUIET.has(name))) : value);
const short = (value, size = 100) => { const text = typeof value === 'string' ? value : JSON.stringify(value); return text && text.length > size ? `${text.slice(0, size - 1)}…` : text ?? ''; };

/** The AIs' names: the name field of the person's `ai_list` list (its formula, a formula-engine binding), evaluated by
 *  tool:evaluate-a-formula over every row's stored value in one call. A missing list, or one with no formula name field,
 *  is said by name; there is no other way to name an AI. */
export async function namesOf(client, values, rules = settings) {
  const list = await client.op(rules.engine.records, rules.engine.read, { id: rules.who.ai_list }, { idempotent: true });
  const fields = Array.isArray(list?.value?.fields) ? list.value.fields : null;
  const field = fields?.find(row => row.id === list.value.title_field);
  const binding = field?.kind === rules.who.formula_kind ? field.derive?.request?.binding : null;
  if (!binding) throw new TrillionError(fill(rules.who.no_list, { list: rules.who.ai_list }), { status: 4 });
  if (!values.length) return [];
  const answer = await client.op(rules.engine.tools, rules.engine.tools_run, { tool: rules.who.formula_tool, input: { binding, rows: values } }, { idempotent: true });
  const named = answer?.result?.values ?? answer?.values;
  if (!Array.isArray(named) || named.length !== values.length) throw new TrillionError(fill(rules.who.no_names, { tool: rules.who.formula_tool }), { status: 4 });
  return named.map(name => (typeof name === 'string' && name.trim() ? name : null));
}

/** One AI as `who` reads it, from tool:see-my-ais ({ id, value, live, seen_at, busy }) and its evaluated `name`. Its
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

/** The lines for one AI job: its id, status, who it is for or who took it and who sent it, the job, and what came of it. */
export function jobLines(job) {
  return [`${job.id}  ${job.status ?? 'unknown'}${job.taker ? `  taken by ${job.taker}` : job.to ? `  for ${job.to}` : '  for any AI'}${job.from ? `  from ${job.from}` : ''}`,
    ...(typeof job.job === 'string' && job.job ? [`  job: ${short(job.job, 300)}`] : []),
    ...(job.label ? [`  label: ${short(job.label, 120)}`] : []),
    ...(job.stuck?.words ? [`  in the way: ${short(job.stuck.words, 300)}`] : []),
    ...(job.result !== undefined && job.result !== null ? [`  result: ${short(job.result, 1000)}`] : [])];
}

/** Plain lines for a command's answer; --json prints the answer itself instead. */
export function render(command, answer, rules = settings) {
  const value = quiet(answer);
  if (command === 'who' && Array.isArray(value.groups)) {
    const hidden = value.hidden ? [fill(rules.who.hidden, { count: value.hidden, days: rules.who.seen_within_days })] : [];
    if (!value.groups.length) return [rules.who.none, ...hidden].join('\n');
    return [...value.groups.flatMap(group => ownerLines(group, { all: value.all, rules })), ...hidden].join('\n');
  }
  if (command === 'work' && Array.isArray(value.jobs)) return value.jobs.length ? [...value.jobs.flatMap(jobLines), ...(value.more ? [rules.words.more_jobs] : [])].join('\n') : rules.words.no_jobs;
  if (command === 'events' && Array.isArray(value.versions)) return value.versions.map(row => `${row.version}  ${row.at}  ${row.deleted ? 'removed' : row.value?.status ?? ''}`).join('\n') || 'No versions.';
  if (command === 'tools' && Array.isArray(value.tools)) return value.tools.map(row => `${row.id}  ${short(row.job ?? row.label ?? '', 110)}`).join('\n');
  if (command === 'send' && object(value.job)) return [fill(value.status === 'already-there' ? rules.words.sent_before : rules.words.sent, { id: value.job_id }), ...jobLines(value.job), ...(value.note ? [value.note] : [])].join('\n');
  if (command === 'take') return object(value.taken) ? [fill(rules.words.took, { id: value.taken.id }), ...jobLines(value.taken)].join('\n')
    : [value.reason === 'changed' ? fill(rules.words.take_lost, { id: value.job_id, taker: value.job?.taker ?? rules.words.another_ai }) : value.reason === 'gone' ? fill(rules.words.take_gone, { id: value.job_id }) : rules.words.nothing_to_take, ...(object(value.job) ? jobLines(value.job) : [])].join('\n');
  if (Object.hasOwn(rules.work.actions, command) && typeof value.moved === 'boolean') return [value.moved ? fill(rules.words.moved, { id: value.job_id, from: value.from, to: value.to })
    : fill(rules.words.not_moved, { id: value.job_id, reason: value.reason ?? 'refused' }), ...(object(value.job) ? jobLines(value.job) : [])].join('\n');
  if (command === 'publish' && object(value.record)) return fill(rules.words.published, { id: value.record.id });
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

// ── serve: stay ready and run a command for each job ────────────────────────────────────────────────────────────

/** Runs `command` with the job's words on standard input; answers { ok, output }. */
export function runJob(command, job, { rules = settings, me, spawnImpl = spawn } = {}) {
  return new Promise(resolve => {
    // The job's saved terms travel with it, so a command can check its work against them.
    const terms = JSON.stringify({ taken_at: job.taken_at, outcome: job.outcome, obligations: job.obligations, acceptance: job.acceptance,
      source_job: job.source_job ?? job.source, continuation: job.continuation });
    const child = spawnImpl(command[0], command.slice(1), { stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, TRILLION_JOB_ID: job.id, TRILLION_AGENT: me.agent_id, AI_JOB_CONTEXT: terms } });
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
    child.stdin.end(`${job.job}\n`);
  });
}

/** One pass: take a job with tool:take-an-ai-job; when there is one, run it, then finish it, say what is in the way, or
 *  give it back when the command failed, each with tool:change-an-ai-job. A move another AI made first is logged, never
 *  retried. */
export async function serveOnce({ client, me, command, state, rules = settings, log, runImpl = runJob, refresh = async () => {} }) {
  const answer = await workCall(client, 'take', { as: me.ai_id }, { rules });
  const job = answer?.taken;
  if (!object(job)) return false;
  state.hold(me.agent_id, job);
  log({ event: 'took', job_id: job.id });
  await refresh();
  const { ok, output = '', stuck = null, check } = await runImpl(command, job, { rules, me, client });
  // A finish needs the saved acceptance and a consumer check receipt for it. A run with neither, or one that failed, is blocked
  // on an owned next step, not given back: its effects may have happened, and the next taker reads them before running again.
  const next = (reason, action = 'Inspect the existing consumer result and requested outcome before deciding whether to execute anything again') =>
    ({ continuation: { owner: me.ai_id, action, after: new Date(Date.now() + rules.serve.continue_after_minutes * 60_000).toISOString(), reason } });
  let action, extra;
  if (stuck) [action, extra] = ['stuck', { words: stuck }];
  else if (ok && checkForJob(check, job)) [action, extra] = ['finish', { result: await kept(keepResult(client, job.id, Buffer.from(output, 'utf8'), rules)), summary: output.split('\n')[0].slice(0, 300), check: { ...check, target: job.acceptance.target } }];
  else if (!job.acceptance) [action, extra] = ['wait', next('This job has no saved consumer acceptance, so its requested outcome cannot be checked yet.', 'Ask the sender to add a saved consumer acceptance, then inspect existing consumer state before deciding whether to continue')];
  else [action, extra] = ['wait', next(ok ? 'The command returned successfully but supplied no complete consumer check receipt.' : output || 'The command did not complete; partial effects are unknown.')];
  const moved = await workCall(client, 'change', { as: me.ai_id, id: job.id, taken_at: job.taken_at, action: rules.work.actions[action], ...extra }, { rules });
  // A job that says what is in the way stays taken (an AG-UI agent's interrupt); any other move ends this AI's hold.
  if (!stuck) state.letGo(me.agent_id, job.id);
  await refresh();
  log({ event: moved?.moved === false ? `not_${action}` : action, job_id: job.id, ...(moved?.moved === false ? { reason: moved.reason } : {}) });
  return true;
}

// ── The commands ─────────────────────────────────────────────────────────────────────────────────────────────────

const HELP = `trillion: see your AIs and their work, and run your Trillion's tools, from any shell.

  trillion setup [--harness claude-code,codex,cursor]   sign in once, put trillion on PATH, write each app's skill
  trillion login [--origin ADDRESS] | logout | whoami    sign in to Trillion (to another one with its address), sign out, or say who is signed in
  trillion connection [--write]                          the address and key source local bridges read, with a command per app
  trillion who [--all]                                   your AIs seen lately (--all: every one): ready or away
  trillion publish [--dry-run]                           write this AI's own record: its facts and that it was seen now
  trillion tools | call TOOL JSON|-                      your Workshop tools, and run one by its id
  trillion op ADDRESS METHOD JSON|-                      any engine operation (run_resource_operation); op --dry-run shows the request and sends nothing
  --timeout SECONDS  wait this long for one try of a call (default ${settings.retry.attempt_seconds}); a try with no answer is asked again, up to ${settings.retry.count} more times, under the same request key
  trillion schedule list | read ID                       list wake schedules or read one with its admitted runs
  trillion schedule at ID TOOL WAKE_ID TIME BUDGET_JSON INPUT_JSON | repeat ID TOOL WAKE_ID EVERY_MS BUDGET_JSON INPUT_JSON [--from TIME]   create one
  trillion schedule edit ID JSON | on ID | off ID | delete ID | cancel RUN_KEY   change, switch, remove, or cancel one admitted run
  trillion update                                        who updates this command (it never updates itself)
  ${basename(settings.install.link)} records replay-from-transcripts --since TIME            list the rows this computer's AIs wrote (writes nothing)
  ${basename(settings.install.link)} records replay-from-transcripts --write --inventory DIR write that list's rows back, then read some back

  AI jobs (each runs the Workshop work tool trillion.json names for it):
  trillion work [ID] [--status S --to AI --from AI --taker AI --limit N]   the newest jobs, or one with its result
  trillion events ID                                     one job's versions, newest first
  trillion send any "JOB" | send AI "JOB"                hand off a job (--wait SECONDS, --priority 0-9, --outcome "DONE WHEN", --label, --acceptance-file, --source-file, --obligations-file)
  trillion take [ID] [--mine]                            take the oldest waiting job you may take (or that one)
  trillion finish ID "RESULT" [--check-file JSON] | fail ID "WHY"            record what came of a job you took (no words: the result is read from standard input, any size; one too long for the job row is kept as a file of your files and the row names it)
  trillion work ID --result                              print that job's whole result, whether on the row or kept as a file
  trillion plan ID --acceptance-file JSON                save what a job you took must come to, read from the record that shows it (finish checks it)
  trillion stuck ID "WORDS" | stuck ID --clear           say what is in the way, or that nothing is now
  trillion release ID [--because WHY] [--continuation-file JSON]   give a job back, with an owned next step if you have one
  trillion wait ID --continuation-file JSON              block on a bounded next step ({owner, action, after, reason})
  trillion resume ID --because "WHAT CHANGED"            resume after reviewing existing effects and the dependency
  trillion edit ID [--job WORDS --outcome TEXT --label TEXT --source-file JSON --obligations-file JSON --to AI|any --priority 0-9]   edit a job you sent
  trillion withdraw ID --reason "WHY" | remove ID        take back a job you sent; delete a finished one
  trillion serve -- COMMAND ARGS | serve --ag-ui URL     stay ready: run COMMAND (or an AG-UI agent) for each job taken

  AI ids are ai:NAME (the ai: may be left off); job ids are ai-job:KEY. --as AI acts as another AI id (default: from
  TRILLION_AGENT or the AI running this). --json prints the answer. --verbose adds the technical details of a refusal.`;

/** Wake declarations use the caller's records and wake rights. Writes use the root identity when present, else its
 * exact prior type/value, and each step gets a stable child key derived from this invocation's request key. */
const scheduleChildKey = (base, step) => `${base}:schedule:${step}`;
const canonicalJson = value => Array.isArray(value) ? value.map(canonicalJson) : object(value)
  ? Object.fromEntries(Object.keys(value).sort().map(key => [key, canonicalJson(value[key])])) : value;
const exactJson = (a, b) => JSON.stringify(canonicalJson(a)) === JSON.stringify(canonicalJson(b));
const scheduleTime = (text, label) => {
  const value = String(text);
  if (/^\d+$/.test(value)) {
    const ms = Number(value);
    if (Number.isSafeInteger(ms)) return ms;
  }
  if (validTime(value)) {
    const ms = Date.parse(value);
    if (Number.isSafeInteger(ms)) return ms;
  }
  throw new TrillionError(`${label} is an ISO time with an explicit offset or whole milliseconds since 1970.`, { status: 2 });
};
const scheduleObject = async (text, label, example) => {
  const value = await readJson(text, example);
  if (!object(value)) throw new TrillionError(`${label} is one JSON object.`, { status: 2 });
  return value;
};
async function scheduleRecord(client, id, rules = settings) {
  const record = await client.op(rules.engine.records, rules.engine.read, { id }, { idempotent: true });
  if (!object(record) || record.value == null) return { id, type: record?.type ?? null, value: null, identity: null };
  return record;
}
async function scheduleRecords(client, rules = settings) {
  return allPages(client, rules.engine.records, rules.engine.list, { type: rules.engine.wake.declaration_kind }, 'records', rules);
}
async function scheduleCauses(client, rules = settings) {
  const pages = [];
  let after = null;
  const seen = new Set();
  for (let page = 0; page < rules.engine.most_pages; page += 1) {
    const answer = await client.op(rules.engine.records, rules.engine.wake.causes, after === null ? {} : { after }, { idempotent: true });
    pages.push(answer);
    const next = answer?.next ?? null;
    if (next === null) return pages;
    if (seen.has(next) || next === after) throw new TrillionError(rules.words.pager_stuck, { status: 4, detail: fill(rules.words.details.pager_stuck, { method: rules.engine.wake.causes, next: short(next, 80) }) });
    seen.add(next);
    after = next;
  }
  throw new TrillionError(rules.words.too_many_pages, { status: 4, detail: fill(rules.words.details.too_many_pages, { method: rules.engine.wake.causes, pages: rules.engine.most_pages }) });
}
const scheduleWake = (pages, declaration) => pages.flatMap(page => Array.isArray(page?.wakes) ? page.wakes : [])
  .find(wake => wake?.origin === 'person' && wake.tool === declaration?.tool && wake.id === declaration?.id) ?? null;
const scheduleState = (record, pages, wakeOverride = null) => {
  const wake = wakeOverride ?? scheduleWake(pages, record?.value);
  const live = Object.assign({}, ...pages.map(page => object(page?.book?.live) ? page.book.live : {}));
  const admitted_causes = Object.entries(live).filter(([, cause]) => cause?.tool === record?.value?.tool && cause?.wake === record?.value?.id)
    .map(([run, cause]) => ({ run, ...cause }));
  return { id: record.id, type: record.type, value: record.value, on: wake?.switched_on ?? false,
    wake_found: Boolean(wake), state: wake ? (wake.switched_on ? 'on' : 'off') : 'unavailable', admitted_causes };
};
async function scheduleWrite(client, { id, before, value, requestKey, step, rules = settings }) {
  const expected = before?.value == null ? null : (before.identity
    ? { type: before.type, identity: before.identity }
    : { type: before.type, value: before.value });
  const record = { id, type: rules.engine.wake.declaration_kind, value, expected };
  let answer;
  try {
    answer = await opWhole(client, rules.engine.records, rules.engine.write, { records: [record] }, { requestKey: scheduleChildKey(requestKey, step) });
  } catch (error) {
    if (error.status !== 4) throw error;
    let after;
    try { after = await scheduleRecord(client, id, rules); }
    catch (readError) {
      return { outcome: 'unknown', read_back: false, verification_error: readError.message,
        request_key: scheduleChildKey(requestKey, step), record: null };
    }
    const desired = value == null ? after.value == null : after.type === rules.engine.wake.declaration_kind && exactJson(after.value, value);
    if (!desired) {
      error.message += ` Read-back shows schedule ${id} has not reached the requested state; no dependent step was started.`;
      throw error;
    }
    return { outcome: 'unknown', read_back: true, request_key: scheduleChildKey(requestKey, step), record: after };
  }
  let after;
  try { after = await scheduleRecord(client, id, rules); }
  catch (error) {
    return { ...answer, outcome: 'answered', read_back: false, verification_error: error.message,
      request_key: scheduleChildKey(requestKey, step), record: null };
  }
  const matches = value == null ? after.value == null : after.type === rules.engine.wake.declaration_kind && exactJson(after.value, value);
  if (!matches) throw Object.assign(new TrillionError(`The write answered, but read-back does not show the requested state for schedule ${id}; no dependent step was started.`, { status: 4, answer }), { requestKey: scheduleChildKey(requestKey, step) });
  return { ...answer, read_back: true, record: after };
}
async function scheduleSwitch(client, declaration, on, requestKey, step, rules = settings, { force = false } = {}) {
  let pages = await scheduleCauses(client, rules);
  let current = scheduleWake(pages, declaration);
  if (!current) throw new TrillionError(`Schedule ${declaration.record_id ?? declaration.id} is not a current person-authored wake; it was not switched.`, { status: 4 });
  if (current.switched_on === on && !force) return { on, unchanged: true, complete: true, read_back: true, wake: current };
  try {
    await opWhole(client, rules.engine.records, rules.engine.wake.switch, { tool: declaration.tool, id: declaration.id, on },
      { requestKey: scheduleChildKey(requestKey, step) });
  } catch (error) {
    if (error.status !== 4) throw error;
    try { pages = await scheduleCauses(client, rules); }
    catch (readError) {
      return { on: null, requested_on: on, state: 'unverified', complete: false, outcome: 'unknown', read_back: false, verification_error: readError.message,
        request_key: scheduleChildKey(requestKey, step), wake: current };
    }
    current = scheduleWake(pages, declaration);
    if (current?.switched_on !== on) {
      error.message += ` Read-back does not show the requested ${on ? 'on' : 'off'} state; no dependent step was started.`;
      throw error;
    }
    return { on, complete: true, outcome: 'unknown', read_back: true, request_key: scheduleChildKey(requestKey, step), wake: current };
  }
  try { pages = await scheduleCauses(client, rules); }
  catch (error) {
    return { on: null, requested_on: on, state: 'unverified', complete: false, outcome: 'answered', read_back: false, verification_error: error.message,
      request_key: scheduleChildKey(requestKey, step), wake: current };
  }
  current = scheduleWake(pages, declaration);
  if (current?.switched_on !== on) throw new TrillionError(`The switch answered, but read-back does not show schedule ${declaration.record_id ?? declaration.id} ${on ? 'on' : 'off'}.`, { status: 4 });
  return { on, complete: true, read_back: true, wake: current };
}
export async function schedules(client, words, { requestKey, flags = {}, rules = settings } = {}) {
  const [action, id, ...args] = words;
  const needId = () => need(id, `Name a schedule record id: trillion schedule read ID.`);
  const records = async () => scheduleRecords(client, rules);
  const show = async row => scheduleState(row, await scheduleCauses(client, rules));
  if (!action || action === 'list') {
    if (id || args.length) throw new TrillionError(`Use trillion schedule list with no record id.`, { status: 2 });
    const [rows, causes] = await Promise.all([records(), scheduleCauses(client, rules)]);
    return { schedules: rows.map(row => scheduleState(row, causes)), refused: causes[0]?.refused ?? [] };
  }
  if (action === 'read') {
    needId();
    if (args.length) throw new TrillionError(`Use trillion schedule read ID.`, { status: 2 });
    const row = await scheduleRecord(client, id, rules);
    if (row.value == null || row.type !== rules.engine.wake.declaration_kind) throw new TrillionError(`No wake declaration is saved as ${id}.`, { status: 4 });
    return show(row);
  }
  if (action === 'at' || action === 'repeat') {
    needId();
    const [tool, wakeId, timeOrPeriod, budgetText, inputText, ...extra] = args;
    need(tool, `Name the tool: trillion schedule ${action} RECORD_ID TOOL WAKE_ID ${action === 'at' ? 'TIME' : 'EVERY_MS'} BUDGET_JSON INPUT_JSON.`);
    need(wakeId, `Name the wake id: trillion schedule ${action} RECORD_ID TOOL WAKE_ID ...`);
    need(timeOrPeriod, `Name the ${action === 'at' ? 'time' : 'repeat interval'}: trillion schedule ${action} RECORD_ID TOOL WAKE_ID ...`);
    need(budgetText, `Name the budget JSON object: trillion schedule ${action} ID TOOL WAKE_ID ... BUDGET_JSON INPUT_JSON.`);
    need(inputText, `Name the input JSON object: trillion schedule ${action} ID TOOL WAKE_ID ... BUDGET_JSON INPUT_JSON.`);
    if (extra.length) throw new TrillionError(`Use one BUDGET_JSON object and one INPUT_JSON object.`, { status: 2 });
    const budget = await scheduleObject(budgetText, 'budget', '{"steps":4,"wall_ms":600000}');
    const input = await scheduleObject(inputText, 'input', '{"start_at":"step-id"}');
    const on = action === 'at' ? { time: { at_ms: scheduleTime(timeOrPeriod, 'TIME') } } : { time: { every_ms: Number(timeOrPeriod) } };
    if (action === 'repeat') {
      const every = Number(timeOrPeriod);
      if (!Number.isSafeInteger(every) || every < 1) throw new TrillionError('EVERY_MS is a positive whole number of milliseconds.', { status: 2 });
      on.time.every_ms = every;
      if (flags.from !== undefined) on.time.from_ms = scheduleTime(flags.from, '--from');
    }
    if (action === 'at' && flags.from !== undefined) throw new TrillionError('--from is only for schedule repeat.', { status: 2 });
    const value = { tool, id: wakeId, on, budget, input, kind: rules.engine.wake.declaration_kind };
    const before = await scheduleRecord(client, id, rules);
    if (before.value != null) throw new TrillionError(`Schedule record ${id} already exists; read it and use schedule edit to change it.`, { status: 4 });
    const write = await scheduleWrite(client, { id, before, value, requestKey, step: 'create', rules });
    if (!write.read_back) return { id, type: rules.engine.wake.declaration_kind, value: null, on: null, wake_found: null,
      state: 'unverified', scheduled: 'unknown', complete: false, write_applied: write.outcome === 'answered' ? true : null, write };
    let pages;
    try { pages = await scheduleCauses(client, rules); }
    catch (error) { return { id, type: write.record.type, value: write.record.value, on: null, wake_found: null,
      state: 'unverified', scheduled: 'unknown', complete: false, write_applied: true, verification_error: error.message, write }; }
    const initialState = scheduleState(write.record, pages);
    let enabled;
    try {
      enabled = await scheduleSwitch(client, { ...write.record.value, record_id: id }, true, requestKey, 'create-on', rules);
    } catch (error) {
      return { ...initialState, scheduled: false, complete: false, switch_error: error.message,
        request_key: scheduleChildKey(requestKey, 'create-on'), write };
    }
    if (!enabled.complete) return { ...initialState, on: null, wake_found: null, state: 'unverified', scheduled: 'unknown',
      complete: false, enabled, write };
    const state = scheduleState(write.record, pages, enabled.wake);
    return { ...state, scheduled: state.on, complete: state.on, enabled, write };
  }
  if (action === 'edit') {
    needId();
    if (args.length !== 1) throw new TrillionError(`Use trillion schedule edit ID JSON_OBJECT.`, { status: 2 });
    const patch = await scheduleObject(args[0], 'schedule changes', '{"budget":{"steps":4,"wall_ms":600000}}');
    if (!Object.keys(patch).length) throw new TrillionError('Name at least one schedule field to change in the JSON object.', { status: 2 });
    const before = await scheduleRecord(client, id, rules);
    if (before.value == null || before.type !== rules.engine.wake.declaration_kind) throw new TrillionError(`No wake declaration is saved as ${id}.`, { status: 4 });
    if ((patch.tool !== undefined && patch.tool !== before.value.tool) || (patch.id !== undefined && patch.id !== before.value.id))
      throw new TrillionError('A schedule keeps its tool and wake id; create a new schedule and delete the old one to replace either.', { status: 2 });
    const value = { ...before.value, ...patch, kind: rules.engine.wake.declaration_kind };
    if (!object(value.on) || !object(value.budget) || !object(value.input) || typeof value.tool !== 'string' || typeof value.id !== 'string')
      throw new TrillionError('A schedule keeps tool, id, on, budget and input as JSON objects; use schedule edit with their complete values.', { status: 2 });
    const originalPages = await scheduleCauses(client, rules);
    const originalWake = scheduleWake(originalPages, before.value);
    if (!originalWake) throw new TrillionError(`Schedule ${id} has no current person-authored wake; it was not edited.`, { status: 4 });
    const stopped = await scheduleSwitch(client, { ...before.value, record_id: id }, false, requestKey, 'edit-off', rules, { force: true });
    if (!stopped.complete) return { id, type: before.type, value: before.value, on: null, wake_found: null,
      state: 'unverified', edited: false, complete: false, scheduled: 'unknown', stopped, request_key: stopped.request_key };
    let fresh;
    try { fresh = await scheduleRecord(client, id, rules); }
    catch (error) { return { id, type: before.type, value: before.value, on: false, state: 'off', edited: false,
      complete: false, scheduled: false, future_admissions: 'stopped', stopped, verification_error: error.message }; }
    if (fresh.value == null || fresh.type !== before.type || !exactJson(fresh.value, before.value))
      throw new TrillionError(`Schedule ${id} changed while it was being edited; this edit left the current record unchanged.`, { status: 4 });
    const write = await scheduleWrite(client, { id, before: fresh, value, requestKey, step: 'edit', rules });
    if (!write.read_back) return { id, type: before.type, value: null, on: false, state: 'off', edited: null,
      write_applied: write.outcome === 'answered' ? true : null, complete: false, scheduled: false,
      future_admissions: 'stopped', stopped, write };
    let enabled;
    if (originalWake.switched_on) {
      try { enabled = await scheduleSwitch(client, { ...write.record.value, record_id: id }, true, requestKey, 'edit-on', rules); }
      catch (error) {
        let pages;
        try { pages = await scheduleCauses(client, rules); }
        catch (readError) { return { id, type: write.record.type, value: write.record.value, on: null, wake_found: null,
          state: 'unverified', write_applied: true, complete: false, scheduled: 'unknown', future_admissions: 'unknown',
          reenable_error: error.message, verification_error: readError.message,
          request_key: scheduleChildKey(requestKey, 'edit-on'), write }; }
        const state = scheduleState(write.record, pages);
        return { ...state, write_applied: true, complete: false, scheduled: state.on,
          future_admissions: state.on ? 'enabled' : 'stopped', reenable_error: error.message,
          request_key: scheduleChildKey(requestKey, 'edit-on'), write };
      }
      if (!enabled.complete) return { id, type: write.record.type, value: write.record.value, on: null, wake_found: null,
        state: 'unverified', write_applied: true, complete: false, scheduled: 'unknown', future_admissions: 'unknown',
        reenable_error: enabled.verification_error, enabled, write };
    }
    const state = scheduleState(write.record, originalPages, enabled?.wake ?? stopped.wake);
    return { ...state, ...(enabled ? { enabled } : {}), write };
  }
  if (action === 'on' || action === 'off') {
    needId();
    if (args.length) throw new TrillionError(`Use trillion schedule ${action} ID.`, { status: 2 });
    const row = await scheduleRecord(client, id, rules);
    if (row.value == null || row.type !== rules.engine.wake.declaration_kind) throw new TrillionError(`No wake declaration is saved as ${id}.`, { status: 4 });
    const switched = await scheduleSwitch(client, { ...row.value, record_id: id }, action === 'on', requestKey, action, rules);
    return { id, ...switched, future_admissions: switched.complete ? (action === 'on' ? 'enabled' : 'stopped') : 'unverified',
      already_admitted_causes: 'unchanged' };
  }
  if (action === 'delete') {
    needId();
    if (args.length) throw new TrillionError(`Use trillion schedule delete ID.`, { status: 2 });
    const before = await scheduleRecord(client, id, rules);
    if (before.value == null || before.type !== rules.engine.wake.declaration_kind) throw new TrillionError(`No wake declaration is saved as ${id}.`, { status: 4 });
    let stopped = { on: false, unchanged: true, complete: true };
    const current = await scheduleWake(await scheduleCauses(client, rules), before.value);
    if (!current) throw new TrillionError(`Schedule ${id} has no current person-authored wake; it was not deleted.`, { status: 4 });
    if (current.switched_on) stopped = await scheduleSwitch(client, { ...before.value, record_id: id }, false, requestKey, 'delete-off', rules);
    if (!stopped.complete) return { id, deleted: false, complete: false, scheduled: 'unknown', stopped,
      request_key: stopped.request_key };
    let fresh;
    try { fresh = await scheduleRecord(client, id, rules); }
    catch (error) { return { id, deleted: false, complete: false, stopped, future_admissions: 'stopped',
      verification_error: error.message }; }
    if (fresh.value == null) return { id, deleted: true, stopped };
    if (fresh.type !== before.type || (before.identity
      ? fresh.identity !== before.identity
      : !exactJson(fresh.value, before.value)))
      throw new TrillionError(`Schedule ${id} changed while it was being deleted; the changed record was kept.`, { status: 4 });
    const write = await scheduleWrite(client, { id, before: fresh, value: null, requestKey, step: 'delete', rules });
    if (!write.read_back) return { id, deleted: 'unknown', complete: false, write_applied: write.outcome === 'answered' ? true : null,
      stopped, future_admissions: 'stopped', write };
    return { id, deleted: true, stopped, write, future_admissions: 'removed', already_admitted_causes: 'unchanged' };
  }
  if (action === 'cancel') {
    const run = need(id, `Name the exact admitted run key: trillion schedule cancel RUN_KEY.`);
    if (args.length) throw new TrillionError(`Use trillion schedule cancel RUN_KEY.`, { status: 2 });
    const live = pages => Object.assign({}, ...pages.map(page => object(page?.book?.live) ? page.book.live : {}));
    const before = live(await scheduleCauses(client, rules));
    if (!Object.hasOwn(before, run)) throw new TrillionError(`No currently admitted live cause has run key ${run}; nothing was cancelled.`, { status: 4 });
    let answer;
    let outcome = 'answered';
    const cancelKey = scheduleChildKey(requestKey, 'cancel');
    try { answer = await opWhole(client, rules.engine.tools, rules.engine.cancel, { run }, { requestKey: cancelKey }); }
    catch (error) {
      if (error.status !== 4) throw error;
      outcome = 'unknown';
      answer = { cancelled: 'unknown' };
    }
    let after;
    let verificationError;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      try { after = live(await scheduleCauses(client, rules)); }
      catch (error) { verificationError = error.message; break; }
      if (!Object.hasOwn(after, run)) break;
    }
    if (verificationError) return { run, ...answer, outcome, cancellation_state: 'unverified',
      requested: answer?.cancelled === true ? true : outcome === 'unknown' ? null : false,
      complete: false, read_back: null, verification_error: verificationError, request_key: cancelKey,
      scope: 'already-admitted cause only; future admissions are unchanged' };
    const stillLive = Object.hasOwn(after, run);
    const cancellationState = stillLive
      ? (outcome === 'unknown' || answer?.cancelled === true ? 'pending' : 'not_running')
      : 'retired';
    return { run, ...answer, outcome,
      complete: true, request_key: cancelKey,
      cancellation_state: cancellationState, requested: answer?.cancelled === true ? true : outcome === 'unknown' ? null : false,
      read_back: { live: stillLive },
      scope: 'already-admitted cause only; future admissions are unchanged' };
  }
  throw new TrillionError(`Unknown schedule command ${action}. Run trillion help.`, { status: 2 });
}

/** The door and client for this run; a run with no credential says to log in, and only then. */
/** --timeout SECONDS: how long one try of this call waits, a whole number of at least 1 (trillion.json retry.attempt_seconds
 *  when none is given). The call ends only when its retries are spent. */
const timeoutOf = value => {
  const number = Number(value);
  if (!Number.isInteger(number) || number < 1) throw new TrillionError(settings.words.timeout_range, { status: 2 });
  return number;
};

/** The door a credential is presented at: doorFor, told which issuers this computer's engine names as its own. */
async function doorOf(context, credential) {
  const localMcp = context.localMcp();
  const localIssuers = credential?.kind === 'sign-in' ? await engineServersOf(localMcp, { fetchImpl: context.fetchImpl, rules: settings }) : [];
  return doorFor({ asked: context.asked, declared: context.declared, credential, localMcp, localIssuers });
}

async function signedInClient(context) {
  const credential = await credentialFor({ env: context.env, store: context.store, grants: context.grants, fetchImpl: context.fetchImpl });
  if (!credential) throw new TrillionError(settings.words.no_credential, { status: 3 });
  const door = await doorOf(context, credential);
  // The key this computer keeps goes only to this computer's local door or the address declared in TRILLION_ORIGIN; any other door gets a key the person gives for it (TRILLION_KEY).
  if (credential.kind === 'key' && credential.where !== 'TRILLION_KEY' && !door.local && !door.public) throw new TrillionError(settings.words.kept_key_elsewhere, { status: 3 });
  const timeoutSeconds = context.flags.timeout === undefined ? undefined : timeoutOf(context.flags.timeout);
  return trillionClient({ door, credential, fetchImpl: context.fetchImpl, wait: context.wait, ...(timeoutSeconds === undefined ? {} : { timeoutSeconds }) });
}

/** Writes this AI's own `ai` record (aiRecordOf) through the records door, conditioned on the value just read (null when
 *  it has none), so a person's edit made meanwhile (a nickname, an order) is never written over: a refused write is
 *  read and made again, at most `ai_record.write_tries` times. Answers { record } as written, or { record, value } with
 *  `dry` (nothing written). */
export async function publishRecord(client, context, { dry = false, rules = settings } = {}) {
  const { engine } = rules;
  const account = context.account ??= (await client.whoami()).account;
  const place = context.place ??= context.placeImpl();
  const holding = holdingOf(context.me, context.state.held());
  for (let tries = 1; ; tries += 1) {
    const read = await client.op(engine.records, engine.read, { id: context.me.ai_id, type: engine.ai_type }, { idempotent: true });
    const before = object(read?.value) ? read.value : null;
    const value = aiRecordOf(context.me, { account, held: before, ...place, holding }, rules);
    const record = { id: context.me.ai_id, type: engine.ai_type, value };
    if (dry) return { record, before };
    try {
      await client.op(engine.records, engine.write, { records: [{ ...record, expected: before === null ? null : { type: engine.ai_type, value: before } }] });
      return { record };
    } catch (error) {
      if (tries >= rules.ai_record.write_tries || !rules.ai_record.changed_codes.includes(error?.code)) throw error;
    }
  }
}

/** Publishes this AI's record when this run has not yet; a refusal only adds a note, since the job call itself stands. */
async function ensurePublished(client, context) {
  if (context.published) return null;
  try { await publishRecord(client, context); context.published = true; return null; } catch (error) { return fill(settings.words.not_published, { why: error.message }); }
}

/** What `send` says about when the receiver sees the job: the AI it names reads it when it next reads its work; any AI's
 *  when one next takes. */
export function sendNote(answer, rules = settings) {
  const to = answer?.job?.to;
  return to ? fill(rules.send_note.to, { to }) : rules.send_note.any;
}

/** Where a local bridge finds this computer's Trillion: the address and where the key lives (never the key), rewritten whenever the key changes, so a rotated key never breaks a bridge that reads this file. */
export function connectionOf({ origin, store, rules = settings, account = null, at = new Date().toISOString() }) {
  const base = { schema: rules.connection.schema, origin, mcp_url: `${origin}/mcp`, account, key_source: { env: 'TRILLION_KEY', where: store.where, keychain_item: rules.keychain_item, key_file: rules.key_file }, written_at: at };
  const fill = text => text.replaceAll('{mcp_url}', base.mcp_url).replaceAll('{origin}', origin).replaceAll('{key_env}', base.key_source.env);
  // The connection guide owns app commands; standalone CLI installs point to that current guide rather than ship a copied manual.
  return { ...base, recipes: rules.connection.recipes.map(row => ({ id: row.id, label: row.label,
    command: row.guide ? `Follow ${row.label}'s current Trillion connection steps: ${new URL(row.guide.path, origin).href}` : fill(row.template),
    ...(row.guide ? { guide: { ...row.guide, url: new URL(row.guide.path, origin).href } } : {}),
  })) };
}
const keepConnection = (context, door, account) => { context.state.keepConnection(connectionOf({ origin: door.origin, store: context.store, account })); };

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

/** Holds the person at this computer's engine (`addPersonHere`), then asks who they are: a main-built engine serves no one it has
 *  not been told to hold, so asking first is refused. Answers { account }; a refusal is thrown (status 3, or `notTaken` from the add, with
 *  the engine's `why` when it gave one). An engine that is not running is said only when the door in use is that engine, since a
 *  sign-in also works at the public address. */
async function knownAs(context, client) {
  await addPersonHere({ socket: context.agentSocket(), bearer: client.credential.bearer }).catch(error => {
    if (!(error instanceof TrillionError) || error.status === 3 || error.notTaken || client.door.local) throw error;
  });
  return client.whoami();
}

const refusedBy = error => error instanceof TrillionError && (error.status === 3 || error.notTaken === true);

/** Whether a refusal of a kept sign-in is one a new sign-in mends: only one the engine says is expired or revoked (trillion.json
 *  `resign_when`); a pass whose own renewal was refused never gets this far (signedInClient throws, and login signs in). Any other
 *  reason, or none given, would refuse the new sign-in too. */
const resigns = error => settings.resign_when.includes(error.why);

/** `trillion login`: the person is known as the credential this computer keeps names them, else one browser sign-in is made (never more
 *  than one per run, and none for a kept sign-in the engine refuses for a reason a new one would not mend), and then they are known. */
async function login(context, { again = false } = {}) {
  if (!again) {
    let client = null;
    try { client = await signedInClient(context); } catch (error) { if (!refusedBy(error)) throw error; }
    if (client) {
      try {
        const known = await knownAs(context, client);
        keepConnection(context, client.door, known.account);
        return signedInWords(client.credential);
      } catch (error) {
        // A kept key the engine will not hold is no sign-in yet: the person signs in. A kept sign-in it refuses for another reason is said, not repeated.
        if (!refusedBy(error) || (client.credential.kind === 'sign-in' && !resigns(error))) throw error.status === 3 ? new TrillionError(settings.words.refused_kept, { status: 3, detail: error.detail }) : error;
      }
    }
  }
  if (context.flags['key-stdin']) {
    const chunks = [];
    for await (const chunk of process.stdin) chunks.push(chunk);
    const key = Buffer.concat(chunks).toString('utf8').trim();
    if (bearerOf(key, settings) === null) throw new TrillionError(fill(settings.bearers.refused, { kinds: settings.bearers.shapes.map(row => row.kind).join(', ') }), { status: 2 });
    context.store.write(key);
  } else {
    const localMcp = context.localMcp();
    // With no address named, the sign-in is for this computer's own engine: one that does not answer is said, never replaced by another
    // Trillion's door (a sign-in made for the wrong door is refused by this computer's engine). --origin names another one.
    const own = !context.asked && localMcp ? await engineServersOf(localMcp, { fetchImpl: context.fetchImpl, rules: settings }) : null;
    if (own?.length === 0) throw new TrillionError(settings.words.not_running, { status: 4, detail: fill(settings.words.details.not_running, { mcp: localMcp, why: 'no protected-resource document' }) });
    const kept = context.grants.read()?.origin ?? null;
    const origin = own ? (own.includes(kept) ? kept : own[0]) : await issuerFor({ asked: context.asked, kept, localMcp, declared: context.declaredOrigin(), fetchImpl: context.fetchImpl });
    const grant = await signInWithBrowser({ origin, resourceDoor: own ? localMcp : await resourceDoorFor(origin, { localMcp, fetchImpl: context.fetchImpl }), fetchImpl: context.fetchImpl, ...(context.open ? { open: context.open } : {}) });
    // A sign-in this program made before is ended when a new one replaces it; the Mac app's key is never touched.
    if (context.state.madeKey()?.where === context.grants.where) await endSignIn(context.grants.read(), { fetchImpl: context.fetchImpl });
    context.grants.write(grant);
    context.state.keepMade({ kind: 'sign-in', where: context.grants.where, at: new Date().toISOString() });
  }
  const client = await signedInClient(context);
  const known = await knownAs(context, client).catch(error => { throw error.status === 3 ? new TrillionError(settings.words.refused_kept, { status: 3, detail: error.detail }) : error; });
  keepConnection(context, client.door, known.account);
  return signedInWords(client.credential);
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
  if (!context.rest.length && !agUi) throw new TrillionError('Say what runs each job: trillion serve -- COMMAND ARGS (the job arrives on its standard input), or trillion serve --ag-ui URL (an AG-UI agent).', { status: 2 });
  if (agUi && !/^https?:\/\//.test(agUi)) throw new TrillionError('--ag-ui is the address of an AG-UI agent, starting http:// or https://.', { status: 2 });
  // An AG-UI agent keeps one thread per job: the job's id is its thread.
  const runImpl = agUi ? (_command, job, options) => runOnAgUi(agUi, { ...job, handoff_id: job.id }, { ...options, fetchImpl: context.fetchImpl }) : runJob;
  const client = await signedInClient(context);
  const { me, state } = context;
  const log = entry => process.stderr.write(`${JSON.stringify({ at: new Date().toISOString(), agent_id: me.agent_id, ...entry })}\n`);
  // This AI's record says it was seen now on every contact, so `who` shows it ready for as long as it serves.
  const refresh = () => publishRecord(client, context).catch(error => log({ event: 'record_failed', error: error.message }));
  await publishRecord(client, context);
  const stop = () => { log({ event: 'stopped' }); process.exit(0); };
  process.once('SIGINT', stop); process.once('SIGTERM', stop);
  log({ event: 'ready', ...(agUi ? { ag_ui: agUi } : { command: context.rest[0] }) });
  let lastContact = Date.now();
  for (;;) {
    if (Date.now() - lastContact >= settings.serve.contact_seconds * 1000) { await refresh(); lastContact = Date.now(); }
    let worked = false;
    try { worked = await serveOnce({ client, me, command: context.rest, state, log, refresh, runImpl }); } catch (error) { log({ event: 'failed', error: error.message }); }
    if (!worked) await pause(settings.serve.contact_seconds * 1000);
  }
}


/** `trillion update`: this program does not fetch code. The installed copy follows the Workshop copy the engine
 *  keeps current (workshopProgram), and `trillion setup` run from a newer Workshop program refreshes the installed files. */
export function updateWords({ rules = settings } = {}) {
  return rules.update.workshop;
}

/** `records replay-from-transcripts`: the rows this computer's AIs wrote, read from their transcripts
 *  (replay-recorded-writes.mjs, which reads shell lines with this program's own parser and names). A dry run writes
 *  only the inventory folder and needs no credential; --write --inventory FOLDER writes that folder's rows through the
 *  records door. */
async function records(context, words) {
  const { flags } = context;
  if (words[0] !== 'replay-from-transcripts') throw new TrillionError('Name what to do: records replay-from-transcripts --since TIME | --write --inventory FOLDER.', { status: 2 });
  const replay = await import('./replay-recorded-writes.mjs');
  const host = { parseArgs, expand, settings, programs: new Set([basename(expand(settings.install.link)), basename(fileURLToPath(import.meta.url))]) };
  if (flags.write !== true) {
    if (!Number.isFinite(Date.parse(flags.since ?? ''))) throw new TrillionError('Name the earliest call to read: --since TIME, for example 2026-01-31T00:00:00Z.', { status: 2 });
    return JSON.stringify(await replay.dryRun({ host, since: flags.since, env: context.env, home: context.transcriptHome }), null, 2);
  }
  const folder = need(flags.inventory, 'Name the inventory a dry run wrote: --write --inventory FOLDER.');
  if (!existsSync(join(folder, 'records.jsonl'))) throw new TrillionError(`${folder} holds no records.jsonl from a dry run.`, { status: 2 });
  return JSON.stringify(await replay.writeInventory(await signedInClient(context), folder), null, 2);
}

const readJson = async (raw, example) => {
  let text = raw ?? '{}';
  if (text === '-') { const chunks = []; for await (const chunk of process.stdin) chunks.push(chunk); text = Buffer.concat(chunks).toString('utf8'); }
  try { const value = JSON.parse(text); if (object(value)) return value; } catch { /* refused below */ }
  throw new TrillionError(`The input is one JSON object, for example ${example}.`, { status: 2 });
};

/** Every path of `value` that holds a leaf (a non-object, or an array, kept whole), as `a.b` -> leaf. */
const leaves = (value, path = '', out = {}) => {
  if (object(value)) { for (const [name, inner] of Object.entries(value)) leaves(inner, path ? `${path}.${name}` : name, out); }
  else out[path] = value;
  return out;
};

/** What a records:write would do, read and not sent: per row its current value (records:read), the new value, the field-by-field
 *  diff, the fields the write drops, and `removes` for a value null. When the engine says it can check a write without committing it
 *  (capabilities.experimental[rule.capability]) the same records are also sent once as `check_only`, under a fresh request key, and
 *  `engine_check` is what the engine answered or the refusal the write would meet; an engine that does not say so is never sent it,
 *  because it would ignore the field and commit. */
export async function dryRunWrite(client, request, { rules = settings } = {}) {
  const rule = rules.direct_calls.dry_run_reads_first;
  const rows = [];
  for (const item of Array.isArray(request.input?.records) ? request.input.records : []) {
    const read = await client.op(request.address, rule.read_method, { id: item?.id }, { idempotent: true });
    const current = read?.value ?? null;
    const next = item?.value ?? null;
    const before = current === null ? {} : leaves(current), after = next === null ? {} : leaves(next);
    const diff = [...new Set([...Object.keys(before), ...Object.keys(after)])].sort()
      .filter(path => JSON.stringify(before[path]) !== JSON.stringify(after[path]))
      .map(path => ({ field: path, before: path in before ? before[path] : null, after: path in after ? after[path] : null, change: !(path in before) ? 'added' : !(path in after) ? 'dropped' : 'changed' }));
    rows.push({ id: item?.id, type: item?.type ?? read?.type ?? null,
      action: next === null ? (current === null ? 'nothing to remove' : rule.removes) : current === null ? 'creates this row' : diff.length ? 'replaces this row' : 'no change',
      current, new: next, diff, dropped_fields: diff.filter(entry => entry.change === 'dropped').map(entry => entry.field) });
  }
  let engineCheck = null;
  if ((await client.whoami()).capabilities?.experimental?.[rule.capability] === true) {
    try {
      const answer = await client.op(request.address, request.method, { ...request.input, check_only: true }, { requestKey: randomUUID() });
      engineCheck = answer?.check_only === true ? { would_refuse: false, changed: answer.changed, write_count: answer.write_count } : { would_refuse: null, warning: rule.not_honored, answer };
    } catch (error) {
      if (!(error instanceof TrillionError)) throw error;
      engineCheck = { would_refuse: true, refusal: error.message };
    }
  }
  return { dry_run: true, sent: false, request, rows, engine_check: engineCheck, ...(engineCheck === null ? { note: rule.no_validate_route } : {}) };
}

/** A keep or read the door could not complete exactly is a refusal like any other (status 4: the caller may try again under the same job). */
const kept = async work => { try { return await work; } catch (error) { throw error instanceof KeepRefused ? new TrillionError(error.message, { status: 4 }) : error; } };

const readStdin = async stream => { const chunks = []; for await (const chunk of stream) chunks.push(chunk); return Buffer.concat(chunks); };

/** The result of job `id` in a `work ID` answer, as text; a refusal when the job is not there or has none. */
function jobResultOf(answer, id) {
  const result = answer?.jobs?.[0]?.result;
  if (typeof result !== 'string') throw new TrillionError(fill(settings.words.no_result, { id }), { status: 1 });
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
export async function main(argv, seams = {}) {
  const parsed = parseArgs(argv);
  const [command = 'help', ...spoken] = parsed.words;
  // finish and fail with no result words (or `-`) take the result from standard input, as bytes of any size.
  const fromStdin = (command === 'finish' || command === 'fail') && spoken.length > 0 && (spoken.length === 1 || (spoken.length === 2 && spoken[1] === '-'));
  const stdinBytes = fromStdin ? await readStdin(seams.stdin ?? process.stdin) : null;
  const words = fromStdin ? [spoken[0], stdinBytes.toString('utf8')] : spoken;
  const flags = parsed.flags;
  const env = seams.env ?? process.env;
  const asked = (flags.origin ?? env.TRILLION_ORIGIN)?.replace(/\/$/, '') || null;
  const context = { asked, declared: env.TRILLION_ORIGIN?.replace(/\/$/, '') || null, flags, env, rest: parsed.rest, transcriptHome: seams.transcriptHome, fetchImpl: seams.fetchImpl ?? fetch, wait: seams.wait ?? pause,
    store: seams.store ?? keyStore(), grants: seams.grants ?? grantStore(), state: seams.state ?? stateOf(), open: seams.open ?? null,
    localMcp: seams.localDoor ?? (() => findLocalDoor()), agentSocket: seams.agentSocket ?? (() => findAgentSocket()), declaredOrigin: seams.declaredOrigin ?? (() => findDeclaredOrigin()),
    me: agentOf({ as: flags.as ?? null, env, computerName: seams.computerName ?? computerNameOf(), ...(seams.model !== undefined ? { model: seams.model } : {}) }),
    placeImpl: seams.place ?? (() => placeOf()) };
  const print = (name, answer) => (flags.json ? JSON.stringify(answer, null, 2) : render(name, answer));
  const engine = settings.engine;
  if (command === 'help' || flags.help) return HELP;
  if (command === 'login') return login(context, { again: flags.again === true });
  if (command === 'logout') return logout(context);
  if (command === 'connection') {
    const credential = await credentialFor({ env, store: context.store, grants: context.grants, fetchImpl: context.fetchImpl }).catch(() => null);
    const kept = context.state.connection() ?? connectionOf({ origin: (await doorOf(context, credential)).origin, store: context.store });
    if (flags.write === true) context.state.keepConnection(kept);
    return flags.json ? JSON.stringify(kept, null, 2) : [`${kept.mcp_url}  (key: ${kept.key_source.where})`, ...kept.recipes.map(row => `${row.label}: ${row.command}`)].join('\n');
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
  if (command === 'serve') return serve(context);
  if (!WORK_COMMANDS.has(command) && !['whoami', 'tools', 'call', 'op', 'who', 'events', 'publish', 'schedule'].includes(command)) throw new TrillionError(`Unknown command ${command}. Run trillion help.`, { status: 2 });
  if (command === 'call' || command === 'op') {
    const known = settings.direct_calls.flags[command];
    const unknown = Object.keys(flags).find(name => !known.includes(name));
    if (unknown !== undefined) throw new TrillionError(fill(settings.words.unknown_flag, { command, flag: unknown, known: known.map(name => `--${name}`).join(', ') }), { status: 2 });
    if (flags['dry-run'] === true) {
      const request = { address: need(words[0], 'Name the address: trillion op ADDRESS METHOD JSON.'), method: need(words[1], 'Name the method: trillion op ADDRESS METHOD JSON.'),
        request_key: flags['request-key'] ?? randomUUID(), input: await readJson(words[2], '{"id": "..."}') };
      if (request.method !== settings.direct_calls.dry_run_reads_first.method) return JSON.stringify(request, null, 2);
      return JSON.stringify(await dryRunWrite(await signedInClient(context), request), null, 2);
    }
  }
  // A work command's words are checked before anything is sent.
  const call = WORK_COMMANDS.has(command) ? argumentsFor(command, { words, flags }, { me: context.me, held: context.state.held() }) : null;
  const client = await signedInClient(context);
  if (call) {
    if (call.input.result !== undefined && call.work === 'change') call.input.result = await kept(keepResult(client, call.input.id, stdinBytes ?? Buffer.from(call.input.result, 'utf8'), settings));
    if (settings.work.holder_commands.includes(command)) {
      // The claim a move names is read from the job's own row, when this AI is the one holding it: never from a file the
      // AIs on this computer share. A job held by another AI is sent without a claim, and the tool refuses it, saying who holds it.
      const job = (await workCall(client, 'see', { id: call.input.id }, { idempotent: true }))?.jobs?.[0];
      if (job?.taker === call.input.as) call.input.taken_at = job.taken_at;
      if (call.input.check && call.input.check.target === undefined && job?.acceptance) call.input.check.target = job.acceptance.target;
    }
    let answer = await workCall(client, call.work, call.input);
    if (command === 'take' && object(answer?.taken)) context.state.hold(context.me.agent_id, answer.taken);
    if (['finish', 'fail', 'release', 'withdraw', 'remove'].includes(command) && answer?.moved) context.state.letGo(holderOf(context.me, context.state.held(), call.input.id), call.input.id);
    // What this AI holds changed, or it just sent work: its record says so (the move already stands, so a refusal is a note).
    if (settings.work.publish_after.includes(command)) {
      const note = await ensurePublished(client, context);
      if (note) answer = { ...answer, note: [answer?.note, note].filter(Boolean).join(' ') };
    }
    if (command === 'send' && flags.wait !== undefined && answer?.job_id) {
      const seconds = Number(flags.wait);
      if (!Number.isFinite(seconds) || seconds <= 0) throw new TrillionError('--wait is a number of seconds.', { status: 2 });
      const done = await waitFor(async () => {
        const seen = await workCall(client, 'see', { id: answer.job_id }, { idempotent: true });
        return settings.wait.finished_states.includes(seen?.jobs?.[0]?.status) ? seen : null;
      }, { seconds, sleep: context.wait });
      if (done) return print('work', done);
      answer = { ...answer, note: [answer.note, fill(settings.words.not_finished, { seconds, id: answer.job_id })].filter(Boolean).join(' ') };
    }
    if (command === 'send' && object(answer?.job)) answer = { ...answer, note: [answer.note, sendNote(answer)].filter(Boolean).join(' ') };
    if (command === 'work' && flags.result === true) return printResult(await kept(readResult(client, jobResultOf(answer, call.input.id), settings)), seams.stdout ?? process.stdout);
    return print(command, answer);
  }
  if (command === 'publish') {
    const written = await publishRecord(client, context, { dry: flags['dry-run'] === true });
    return flags['dry-run'] ? JSON.stringify(written.record, null, 2) : print('publish', written);
  }
  if (command === 'whoami') {
    // An engine started again holds no one until told: a pass it has not held is added again here, as login adds it.
    const kept = client.credential.kind === 'key' && client.credential.where !== 'TRILLION_KEY';
    // A key the Mac app kept long ago that the engine will not read is no sign-in: say so at once, never after retries.
    const known = await knownAs(context, client).catch(error => { throw kept && refusedBy(error) ? new TrillionError(settings.words.no_credential, { status: 3, detail: error.detail }) : error; });
    const { account } = known;
    const { agent_id, ai_id, held_as, app, model, provider, computer, harness } = context.me;
    return flags.json ? JSON.stringify({ account_id: account, agent_id, ai_id, held_as, app, model, provider, computer, harness, door: client.door.mcp, local: client.door.local }, null, 2)
      : [signedInWords(client.credential), fill(settings.words.whoami_ai, { ai: ai_id }), fill(settings.words.whoami_facts, { facts: [app, model, provider, computer].filter(Boolean).join(', ') }),
        ...(flags.verbose === true ? [`account ${account}`, ...(held_as.length ? [`jobs taken before this session had its own id are finished as ${held_as.join(', ')}`] : []), `door ${client.door.mcp}`] : [])].join('\n');
  }
  if (command === 'schedule') {
    const requestKey = flags['request-key'] ?? randomUUID();
    if (requestKey.length > 160) throw new TrillionError('A schedule --request-key may be at most 160 characters so its per-step keys remain unique.', { status: 2 });
    return print('schedule', await schedules(client, words, { requestKey, flags, rules: settings }));
  }
  if (command === 'tools') return print('tools', { tools: await allPages(client, engine.tools, engine.tools_list, {}, 'tools') });
  if (command === 'call' || command === 'op') {
    // An answer too large for one reply is read page by page, joined and checked (opWhole) before it is printed.
    const whole = answer => (typeof answer === 'string' ? answer : JSON.stringify(answer, null, 2));
    if (command === 'call') {
      const tool = need(words[0], 'Name the tool: trillion call TOOL JSON, with an id from trillion tools.');
      return whole(await opWhole(client, engine.tools, engine.tools_run, { tool, input: await readJson(words[1], '{"text": "..."}') }, { requestKey: flags['request-key'] }));
    }
    const address = need(words[0], 'Name the address: trillion op ADDRESS METHOD JSON, for example trillion op @own-records records:read \'{"id":"..."}\'.');
    const method = need(words[1], 'Name the method: trillion op ADDRESS METHOD JSON.');
    return whole(await opWhole(client, address, method, await readJson(words[2], '{"id": "..."}'), { requestKey: flags['request-key'] }));
  }
  if (command === 'who') {
    const now = Date.now();
    const { account } = await client.whoami();
    const rows = (await workCall(client, 'ais', {}, { idempotent: true }))?.ais ?? [];
    const recent = row => flags.all === true || aiOf(row, { now }).recent;
    const shown = rows.filter(recent);
    const names = await namesOf(client, shown.map(row => row.value ?? {}));
    const ais = shown.map((row, at) => aiOf(row, { name: names[at], now, owner: account }));
    return print('who', { you: account, all: flags.all === true, groups: groupsOf(ais, { you: account }), hidden: rows.length - shown.length });
  }
  return print('events', await client.op(engine.records, engine.history, { id: need(words[0], 'Name the job: trillion events ID.'), limit: engine.history_limit }, { idempotent: true }));
}


/** The Workshop copy of this command that the installed copy runs, or null (rules.install.follow). Only the installed copy follows:
 *  a copy run from anywhere else (the Workshop's own, a checkout) runs itself, so the two never hand off to each other. */
export function workshopProgram({ rules = settings, home = homedir(), here = HERE, self = fileURLToPath(import.meta.url) } = {}) {
  const follow = rules.install.follow;
  const real = path => { try { return realpathSync(path); } catch { return null; } };
  if (real(here) !== real(expand(rules.install.folder, home))) return null;
  for (const file of follow.runtime_files) {
    let state;
    try { state = JSON.parse(readFileSync(expand(file, home), 'utf8'))[follow.state_field]; } catch { continue; }
    if (typeof state !== 'string') continue;
    let current;
    try { current = JSON.parse(readFileSync(join(state, follow.installs_folder, follow.state_file), 'utf8'))[follow.current_field]; } catch { continue; }
    if (typeof current !== 'string' || !/^[\w.-]+$/.test(current)) continue;
    const program = real(join(state, follow.installs_folder, current, follow.program));
    if (program !== null && program !== real(self)) return program;
  }
  return null;
}

/** The node inside the Mac app (trillion.json `mac_app`) when this program is not already running under it, else null. */
export function appNodeToRunUnder({ rules = settings, execPath = process.execPath } = {}) {
  const real = path => { try { return realpathSync(path); } catch { return null; } };
  const appNode = real(join(rules.mac_app, 'Contents', 'MacOS', 'node'));
  return appNode !== null && appNode !== real(execPath) ? appNode : null;
}

// Run when started as a program (directly, or through the link setup puts on PATH).
const startedAsProgram = (() => { try { return realpathSync(process.argv[1] ?? '') === realpathSync(fileURLToPath(import.meta.url)); } catch { return false; } })();
if (startedAsProgram) {
  // The engine on this computer admits only code the Mac app signed, so a shell's own node runs this program again under the app's.
  const appNode = appNodeToRunUnder();
  if (appNode !== null) {
    const again = spawnSync(appNode, process.argv.slice(1), { stdio: 'inherit' });
    process.exit(again.status ?? 1);
  }
  // The installed copy runs the Workshop's copy when there is one; a copy that cannot be loaded leaves this one to run.
  let run = { main, TrillionError };
  const followed = workshopProgram();
  if (followed !== null) run = await import(pathToFileURL(followed).href).catch(() => run);
  run.main(process.argv.slice(2)).then(text => { if (text) process.stdout.write(`${text}\n`); }, error => {
    const known = error instanceof run.TrillionError || error instanceof TrillionError;
    const words = known ? error.message : `trillion: ${error.stack ?? error}`;
    // The technical line of a refusal is printed only with --verbose.
    const technical = known && error.detail && process.argv.includes('--verbose') ? error.detail : null;
    // With --json a refusal is {code, message} on the error line, so a program reads the engine's code and never the words.
    process.stderr.write(`${process.argv.includes('--json') ? JSON.stringify({ code: error.code ?? null, message: words, ...(technical ? { detail: technical } : {}) }) : [words, technical].filter(Boolean).join('\n')}\n`);
    process.exitCode = known ? error.status : 1;
  });
}
