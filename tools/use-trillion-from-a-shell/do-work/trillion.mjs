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
//   app's local door when this computer has one (./local-door.mjs), else the public origin. The engine's own
//   checks and the Workshop work tools (tools/hand-work-to-ais) decide; nothing here decides, stores or routes work.
//
//     trillion setup                      sign in once, put `trillion` on PATH, write the skill for each AI app here
//     trillion whoami                     the account, this AI's id and facts, and the door that answered
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
//      own sign-in (OAuth: /oauth/register, /authorize, /oauth/token), used by login and to renew the sign-in it kept.
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
import { chmodSync, existsSync, lstatSync, mkdirSync, readFileSync, readlinkSync, realpathSync, renameSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { homedir, hostname } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runOnAgUi } from './ag-ui-agent.mjs';
import { makeHashCodeHexFromBytes, requestKeyForEngine } from './packs/read-data/identity.mjs';
import { settledWrite } from './packs/read-data/settled-write.mjs';
import { localDoorAddress } from './local-door.mjs';
import settings from './trillion.json' with { type: 'json' };

const HERE = dirname(fileURLToPath(import.meta.url));
const fill = (template, values) => template.replace(/\{(\w+)\}/g, (whole, name) => (values[name] === undefined ? whole : String(values[name])));
const pause = ms => new Promise(done => setTimeout(done, ms));
const object = value => Boolean(value) && typeof value === 'object' && !Array.isArray(value);

export class TrillionError extends Error {
  constructor(message, { status = 1, answer = null } = {}) { super(message); this.status = status; this.answer = answer; }
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

const VALUE_FLAGS = new Set(['request-key', 'as', 'timeout', 'wait', 'summary', 'because', 'reason', 'priority', 'key', 'origin', 'harness', 'outcome', 'limit', 'status', 'to', 'from', 'taker', 'label', 'ag-ui', 'since', 'inventory']);

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

/** Runs one work tool (`work.tools[name]`) with `input`: tools:run at the door. Answers the tool's own answer. */
export async function workCall(client, name, input, { idempotent = false, rules = settings } = {}) {
  const answer = await client.op(rules.engine.tools, rules.engine.tools_run, { tool: rules.work.tools[name], input }, { idempotent });
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
      return { work: 'send', input: {
        as: me.ai_id, job, key: flags.key ?? requestKey, to: to === 'any' ? null : aiIdOf(to, rules),
        ...(flags.priority !== undefined ? { priority: wholeNumber(flags.priority, 'priority') } : {}),
        ...(flags.outcome ? { outcome: flags.outcome } : {}),
        ...(flags.label ? { label: flags.label } : {}),
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
      return move(rules.work.actions[command], { result, ...(command === 'finish' ? { summary: flags.summary ?? result.split('\n')[0].slice(0, 300) } : {}) });
    }
    case 'stuck': {
      need(first, 'Name the job: trillion stuck ID "WHAT IS IN THE WAY".');
      return flags.clear ? move(rules.work.actions.unstuck, {}) : move(rules.work.actions.stuck, { words: need(joined(more), 'Say what is in the way, or pass --clear.') });
    }
    case 'release': need(first, 'Name the job: trillion release ID --because "WHY".'); return move(rules.work.actions.release, flags.because ? { because: flags.because } : {});
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
        return key.startsWith('nm_') ? key : null;
      }
      try { const key = readFileSync(file, 'utf8').trim(); return key.startsWith('nm_') ? key : null; } catch { return null; }
    },
    // The value goes to `security -i` on standard input, never into an argument another process can list.
    write(key) {
      if (!/^nm_[0-9a-f]+$/.test(key)) throw new TrillionError('The account answered something that is not a Trillion key.');
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
        if (answer.status !== 0) throw new TrillionError(`The sign-in could not be kept in the Keychain (${String(answer.stderr ?? '').trim() || answer.status}).`);
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
async function asJson(response, what) {
  const value = await response.json().catch(() => ({}));
  if (!response.ok) throw new TrillionError(`${what} failed: ${value.error_description ?? value.error ?? response.status}.`);
  return value;
}
const grantOf = (tokens, { client_id, origin, now = Date.now }) => ({ access_token: tokens.access_token, refresh_token: tokens.refresh_token ?? null,
  expires_at_ms: Number.isFinite(tokens.expires_in) ? now() + tokens.expires_in * 1000 : null, client_id, origin });

/** A kept sign-in renewed at its origin's /oauth/token with its refresh token. A refused renewal means the sign-in ended. */
export async function refreshGrant(grant, { fetchImpl = fetch, rules = settings, now = Date.now } = {}) {
  const response = await fetchImpl(`${grant.origin}/oauth/token`, form({ grant_type: 'refresh_token', refresh_token: grant.refresh_token, client_id: grant.client_id, resource: `${grant.origin}/mcp` }));
  if (response.status === 400 || response.status === 401) throw new TrillionError(rules.words.sign_in_ended, { status: 3 });
  return grantOf(await asJson(response, 'Renewing this computer\'s sign-in'), { client_id: grant.client_id, origin: grant.origin, now });
}

/** The credential for this run: TRILLION_KEY (a machine with no Keychain or file), else the kept key, else the sign-in
 *  login kept, renewed first when it ends within `grant.refresh_before_seconds`. { kind: 'key'|'sign-in', bearer, where,
 *  origin? }, or null when there is none. */
export async function credentialFor({ env = process.env, store = keyStore(), grants = grantStore(), fetchImpl = fetch, rules = settings, now = Date.now } = {}) {
  if (env.TRILLION_KEY?.startsWith('nm_')) return { kind: 'key', bearer: env.TRILLION_KEY, where: 'TRILLION_KEY' };
  const key = store.read();
  if (key) return { kind: 'key', bearer: key, where: store.where };
  let grant = grants.read();
  if (!grant) return null;
  if (grant.refresh_token && Number.isFinite(grant.expires_at_ms) && grant.expires_at_ms - now() < rules.grant.refresh_before_seconds * 1000) {
    grant = await refreshGrant(grant, { fetchImpl, rules, now });
    grants.write(grant);
  }
  return { kind: 'sign-in', bearer: grant.access_token, where: grants.where, origin: grant.origin };
}

// ── The door ─────────────────────────────────────────────────────────────────────────────────────────────────────

/** The Mac app's local door on this computer (./local-door.mjs, run against the app trillion.json `mac_app` names),
 *  or null when this computer has none. */
export function findLocalDoor({ rules = settings, home = homedir() } = {}) {
  try { return localDoorAddress({ runtime: join(rules.mac_app, 'Contents', 'MacOS', 'node'), home }); } catch { return null; }
}

/** The door this run talks to: `asked` (--origin or TRILLION_ORIGIN); else, for the account's key, the Mac app's local door
 *  when this computer has one; else the public origin (where a sign-in was made). { mcp, origin, name, local, public,
 *  localMcp }: `localMcp` is this computer's local door, named when another door refuses the key. */
export function doorFor({ asked = null, credential = null, rules = settings, localMcp = findLocalDoor({ rules }) } = {}) {
  const at = mcp => ({ mcp, origin: new URL(mcp).origin, localMcp });
  if (!asked && credential?.kind === 'key' && localMcp) return { ...at(localMcp), name: fill(rules.words.local_door, { mcp: localMcp }), local: true, public: false };
  const origin = (asked ?? credential?.origin ?? rules.origin).replace(/\/$/, '');
  const isPublic = origin === rules.origin;
  return { ...at(`${origin}/mcp`), name: fill(isPublic ? rules.words.public_door : rules.words.named_door, { mcp: `${origin}/mcp` }), local: false, public: isPublic };
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

/**
 * One account's door: `rpc(method, params)`, `tool(name, args)`, `op(address, method, input)` (one run_resource_operation
 * with one request_key, reused on every retry) and `whoami()` (MCP initialize: the account in result._meta). A refusal
 * names the door: 401 is the door refusing this credential, 404 is a route the door does not serve.
 */
export function trillionClient({ door, credential, fetchImpl = fetch, rules = settings, wait = pause, timeoutSeconds = rules.call_timeout_seconds } = {}) {
  if (!credential?.bearer) throw new TrillionError(rules.words.no_credential, { status: 3 });
  // A call waits at most this many seconds: the caller's --timeout, never more than the engine's call deadline in DATA.
  const deadline = Math.min(timeoutSeconds, rules.call_timeout_seconds);
  const headers = { 'content-type': 'application/json', accept: 'application/json, text/event-stream', authorization: `Bearer ${credential.bearer}`, 'user-agent': 'trillion-cli' };
  let next = 0;
  const signal = () => AbortSignal.timeout(deadline * 1000);
  const refused = () => new TrillionError(credential.kind === 'key' && !door.local && door.localMcp !== door.mcp && (door.public || door.localMcp)
    ? fill(rules.words.refused_key_at_door, { door: door.name, local: door.localMcp ? fill(rules.words.local_door_named, { mcp: door.localMcp }) : '' })
    : fill(rules.words.refused, { door: door.name }), { status: 3 });
  async function send(body, { idempotent }) {
    for (let attempt = 0; ; attempt += 1) {
      let response = null, failure = null;
      try { response = await fetchImpl(door.mcp, { method: 'POST', headers, body, signal: signal() }); } catch (error) { failure = error; }
      const later = rules.retry_seconds[attempt];
      const passing = failure || response.status === 429 || response.status >= 500;
      // A call that already waited its whole time is not sent again: the answer is slow, not lost.
      const timedOut = failure?.name === 'TimeoutError';
      if (passing && !timedOut && later !== undefined) { await wait(later * 1000); continue; }
      const maybe = idempotent ? '' : ' It may have happened; read it back before trying again.';
      if (timedOut) throw new TrillionError(`${door.name} did not answer within ${deadline} seconds.${maybe}`, { status: 4 });
      if (failure) throw new TrillionError(fill(rules.words.unreachable, { door: door.name, why: failure.cause?.code ?? failure.message }) + maybe, { status: 4 });
      if (response.status === 401) throw refused();
      if (response.status === 404) throw new TrillionError(fill(rules.words.missing_route, { door: door.name, route: new URL(door.mcp).pathname }), { status: 4 });
      if (passing || !response.ok) throw new TrillionError(`${door.name} answered ${response.status}.${maybe}`, { status: 4 });
      return response;
    }
  }
  async function rpc(method, params, { idempotent = true } = {}) {
    const id = (next += 1);
    const response = await send(JSON.stringify({ jsonrpc: '2.0', id, method, params }), { idempotent });
    const text = await response.text();
    let reply;
    try { reply = repliesOf(text).find(item => item?.id === id); } catch { reply = null; }
    if (!reply) throw new TrillionError(`${door.name} answered ${response.status} with no reply to ${method}.`, { status: 4 });
    if (reply.error) throw new TrillionError(reply.error.message ?? `${door.name} refused ${method}.`, { answer: reply.error });
    return reply.result;
  }
  async function tool(name, args, { idempotent = false } = {}) {
    for (let attempt = 0; ; attempt += 1) {
      const result = await rpc('tools/call', { name, arguments: args }, { idempotent });
      const answer = answerOf(result);
      if (!result?.isError) return answer;
      const error = answer?.error ?? {};
      const later = Number.isFinite(error.retry_after_seconds) ? error.retry_after_seconds : rules.retry_seconds[attempt];
      // The same request_key rides on every attempt, so a retried call is answered as the first one was.
      if (error.retryable === true && attempt < rules.retry_seconds.length && later <= 60) { await wait(later * 1000); continue; }
      // The engine names why in a code (structuredContent.code); its words say which door refused what.
      const code = answer?.code ?? error.code ?? null;
      const words = code ? rules.words.codes[code] ?? rules.words.refused_code : null;
      // The engine names the step that refused in `cause` (file, line, and the error); the message names the door and the code.
      const cause = typeof answer?.cause === 'string' ? ` Cause: ${answer.cause}` : '';
      throw Object.assign(new TrillionError((error.message ?? answer?.text ?? (words ? fill(words, { door: door.name, code, tool: args?.input?.tool ?? name }) : `${name} was refused.`)) + cause, { answer }), { code });
    }
  }
  const op = (address, method, input = {}, { idempotent = false, requestKey = randomUUID() } = {}) =>
    tool(rules.engine.tool, { address, method, request_key: requestKeyForEngine(requestKey), input }, { idempotent });
  async function whoami() {
    const result = await rpc('initialize', { protocolVersion: rules.engine.protocol_version, capabilities: {}, clientInfo: { name: rules.client_name, version: rules.client_version } });
    const account = result?._meta?.[rules.engine.account_meta]?.account_id;
    if (typeof account !== 'string' || !account) throw new TrillionError(fill(rules.words.no_account, { door: door.name }), { status: 4 });
    return { account, server: result.serverInfo ?? null };
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
    if (seen.has(next) || next === after) throw new TrillionError(fill(rules.words.pager_stuck, { method, next: short(next, 80) }), { status: 4 });
    seen.add(next);
    after = next;
  }
  throw new TrillionError(fill(rules.words.too_many_pages, { method, pages: rules.engine.most_pages }), { status: 4 });
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
  const broken = why => new TrillionError(fill(rules.words.byte_page_broken, { method, why }), { status: 4 });
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
    if (count >= rules.engine.most_pages) throw new TrillionError(fill(rules.words.too_many_pages, { method, pages: rules.engine.most_pages }), { status: 4 });
    const next = await client.op(address, method, { ...input, after_byte: at }, { idempotent: true, requestKey });
    page = bytePageOf(next);
    if (!page) throw broken(`the page after byte ${at} is not a byte_page`);
  }
  const joined = Buffer.concat(parts);
  const got = blake3Hex(joined);
  if (got !== blake3.toLowerCase()) throw new TrillionError(fill(rules.words.byte_page_mismatch, { method, bytes: joined.length, got, want: blake3 }), { status: 4 });
  const text = joined.toString('utf8');
  try { return JSON.parse(text); } catch { return text; }
}

/** One operation answered whole: `op` under one request key for the call and every page of its answer, and when the
 *  answer is a byte page, every page after it (wholeAnswer). */
async function opWhole(client, address, method, input, { requestKey = randomUUID(), rules = settings } = {}) {
  try {
    return await opWholeOnce(client, address, method, input, { requestKey, rules });
  } catch (error) {
    // A call that times out may still have landed under this key: the same key answers it, so the way to ask again is the key.
    if (error instanceof TrillionError && error.status === 4) {
      const hint = fill(rules.words.retry_with_key, { key: requestKey, flag: '--request-key' });
      throw Object.assign(new TrillionError(`${error.message} ${hint}`, { status: error.status }), { answer: error.answer, code: error.code });
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
    expired: () => new TrillionError(fill(rules.words.write_pending, { method }), { status: 4 }),
  });
  return bytePageOf(first) ? wholeAnswer(client, address, method, input, first, { requestKey, rules }) : first;
}

// ── Signing in once ──────────────────────────────────────────────────────────────────────────────────────────────

const base64url = bytes => Buffer.from(bytes).toString('base64url');

/** A PKCE pair (RFC 7636, S256 as OAuth requires) and the state that ties the browser's answer to this login. */
export function pkce(random = randomBytes) {
  const verifier = base64url(random(32));
  return { verifier, challenge: createHash('sha256').update(verifier).digest('base64url'), state: base64url(random(16)) };
}

/** The account's own browser sign-in: register this program as an OAuth client, open /authorize with PKCE, take the code
 *  on a loopback address and exchange it. Answers the sign-in (grantOf: access and refresh tokens, when the access token
 *  ends, the client id and the origin), kept by the caller. `open(url)` shows the page; the person signs in there. */
export async function signInWithBrowser({ origin = settings.origin, rules = settings, fetchImpl = fetch, open = openInBrowser, say = line => process.stderr.write(`${line}\n`), now = Date.now } = {}) {
  const { verifier, challenge, state } = pkce();
  let resolveCode, rejectCode;
  const arrived = new Promise((resolve, reject) => { resolveCode = resolve; rejectCode = reject; });
  const server = createServer((request, response) => {
    const url = new URL(request.url, 'http://127.0.0.1');
    if (url.pathname !== '/callback') { response.writeHead(404).end(); return; }
    const done = url.searchParams.get('state') === state && url.searchParams.get('code');
    response.writeHead(done ? 200 : 400, { 'content-type': 'text/plain; charset=utf-8' })
      .end(done ? 'Signed in. You can close this tab and go back to the terminal.' : `Sign-in did not finish: ${url.searchParams.get('error_description') ?? url.searchParams.get('error') ?? 'the answer did not match this sign-in'}.`);
    if (done) resolveCode(url.searchParams.get('code'));
    else rejectCode(new TrillionError(`Sign-in did not finish: ${url.searchParams.get('error_description') ?? url.searchParams.get('error') ?? 'the answer did not match this sign-in'}.`));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const redirect = `http://127.0.0.1:${server.address().port}/callback`;
  try {
    const client = await asJson(await fetchImpl(`${origin}/oauth/register`, { method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ client_name: rules.client_name, redirect_uris: [redirect], grant_types: ['authorization_code', 'refresh_token'], response_types: ['code'], token_endpoint_auth_method: 'none' }) }), 'Registering this program');
    const authorize = new URL(`${origin}/authorize`);
    for (const [name, value] of Object.entries({ response_type: 'code', client_id: client.client_id, redirect_uri: redirect, code_challenge: challenge, code_challenge_method: 'S256', state, scope: rules.scope, resource: `${origin}/mcp` })) authorize.searchParams.set(name, value);
    say(`Sign in to Trillion in your browser. If it did not open, open this address:\n  ${authorize.href}`);
    Promise.resolve().then(() => open(authorize.href)).catch(error => rejectCode(new TrillionError(`The browser could not open the sign-in: ${error.message.split('\n')[0]}`)));
    let timer;
    const late = new Promise((resolve, reject) => { timer = setTimeout(() => reject(new TrillionError(`No sign-in arrived within ${rules.sign_in_wait_seconds} seconds. Run trillion login again.`)), rules.sign_in_wait_seconds * 1000); });
    const code = await Promise.race([arrived, late]).finally(() => clearTimeout(timer));
    const tokens = await asJson(await fetchImpl(`${origin}/oauth/token`, form({ grant_type: 'authorization_code', code, redirect_uri: redirect, client_id: client.client_id, code_verifier: verifier, resource: `${origin}/mcp` })), 'Finishing the sign-in');
    if (typeof tokens.access_token !== 'string' || !tokens.access_token) throw new TrillionError('The sign-in answered no access token.');
    return grantOf(tokens, { client_id: client.client_id, origin, now });
  } finally { server.close(); }
}

/** Ends a sign-in this program made: its refresh token is revoked at its origin's /oauth/token, which ends the grant and
 *  every token it gave. */
export async function endSignIn(grant, { fetchImpl = fetch } = {}) {
  if (!grant?.refresh_token) return;
  await fetchImpl(`${grant.origin}/oauth/token`, form({ token: grant.refresh_token, token_type_hint: 'refresh_token', client_id: grant.client_id })).catch(() => null);
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
    const child = spawnImpl(command[0], command.slice(1), { stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, TRILLION_JOB_ID: job.id, TRILLION_AGENT: me.agent_id } });
    let output = '', errors = '';
    const timer = setTimeout(() => child.kill('SIGTERM'), rules.serve.run_timeout_minutes * 60_000);
    child.stdout.on('data', chunk => { output = (output + chunk).slice(-rules.serve.result_chars); });
    child.stderr.on('data', chunk => { errors = (errors + chunk).slice(-2000); });
    child.on('error', error => { clearTimeout(timer); resolve({ ok: false, output: `${command[0]} could not start: ${error.message}` }); });
    child.on('close', code => { clearTimeout(timer); resolve(code === 0 ? { ok: true, output: output.trim() || '(the command printed nothing)' } : { ok: false, output: (errors || output).trim().slice(-500) || `${command[0]} stopped with ${code}.` }); });
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
  const { ok, output, stuck = null } = await runImpl(command, job, { rules, me, client });
  const [action, extra] = stuck ? ['stuck', { words: stuck }] : ok ? ['finish', { result: output, summary: output.split('\n')[0].slice(0, 300) }] : ['release', { because: output }];
  const moved = await workCall(client, 'change', { as: me.ai_id, id: job.id, action: rules.work.actions[action], ...extra }, { rules });
  // A job that says what is in the way stays taken (an AG-UI agent's interrupt); any other move ends this AI's hold.
  if (!stuck) state.letGo(me.agent_id, job.id);
  await refresh();
  log({ event: moved?.moved === false ? `not_${action}` : action, job_id: job.id, ...(moved?.moved === false ? { reason: moved.reason } : {}) });
  return true;
}

// ── The commands ─────────────────────────────────────────────────────────────────────────────────────────────────

const HELP = `trillion: see your AIs and their work, and run your Trillion's tools, from any shell.

  trillion setup [--harness claude-code,codex,cursor]   sign in once, put trillion on PATH, write each app's skill
  trillion login | logout | whoami                       this computer's credential, the account and the door it reaches
  trillion connection [--write]                          the address and key source local bridges read, with a command per app
  trillion who [--all]                                   your AIs seen lately (--all: every one): ready or away
  trillion publish [--dry-run]                           write this AI's own record: its facts and that it was seen now
  trillion tools | call TOOL JSON|-                      your Workshop tools, and run one by its id
  trillion op ADDRESS METHOD JSON|-                      any engine operation (run_resource_operation)
  --timeout SECONDS  wait at most this long for one call: 1 to ${settings.call_timeout_seconds} (the engine's call deadline, the default)
  trillion update                                        who updates this command (it never updates itself)
  ${basename(settings.install.link)} records replay-from-transcripts --since TIME            list the rows this computer's AIs wrote (writes nothing)
  ${basename(settings.install.link)} records replay-from-transcripts --write --inventory DIR write that list's rows back, then read some back

  AI jobs (each runs the Workshop work tool trillion.json names for it):
  trillion work [ID] [--status S --to AI --from AI --taker AI --limit N]   the newest jobs, or one with its result
  trillion events ID                                     one job's versions, newest first
  trillion send any "JOB" | send AI "JOB"                hand off a job (--wait SECONDS, --priority 0-9, --outcome "DONE WHEN", --label)
  trillion take [ID] [--mine]                            take the oldest waiting job you may take (or that one)
  trillion finish ID "RESULT" | fail ID "WHY"            record what came of a job you took
  trillion stuck ID "WORDS" | stuck ID --clear           say what is in the way, or that nothing is now
  trillion release ID [--because WHY]                    give a job back
  trillion withdraw ID --reason "WHY" | remove ID        take back a job you sent; delete a finished one
  trillion serve -- COMMAND ARGS | serve --ag-ui URL     stay ready: run COMMAND (or an AG-UI agent) for each job taken

  AI ids are ai:NAME (the ai: may be left off); job ids are ai-job:KEY. --as AI acts as another AI id (default: from
  TRILLION_AGENT or the AI running this). --json prints the answer.`;

/** The door and client for this run; a run with no credential says to log in, and only then. */
/** --timeout SECONDS: how long this call may wait, a whole number from 1 up to the engine's call deadline (trillion.json
 *  call_timeout_seconds), which is also the wait when no --timeout is given. */
const timeoutOf = value => {
  const number = Number(value);
  if (!Number.isInteger(number) || number < 1 || number > settings.call_timeout_seconds) throw new TrillionError(fill(settings.words.timeout_range, { max: settings.call_timeout_seconds }), { status: 2 });
  return number;
};

async function signedInClient(context) {
  const credential = await credentialFor({ env: context.env, store: context.store, grants: context.grants, fetchImpl: context.fetchImpl });
  if (!credential) throw new TrillionError(settings.words.no_credential, { status: 3 });
  const door = doorFor({ asked: context.asked, credential, localMcp: context.localMcp() });
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

async function login(context, { again = false } = {}) {
  const existing = await credentialFor({ env: context.env, store: context.store, grants: context.grants, fetchImpl: context.fetchImpl });
  if (existing && !again) {
    const client = trillionClient({ door: doorFor({ asked: context.asked, credential: existing, localMcp: context.localMcp() }), credential: existing, fetchImpl: context.fetchImpl, wait: context.wait });
    const { account } = await client.whoami();
    keepConnection(context, client.door, account);
    return `Already signed in to Trillion as account ${account}, with the ${existing.kind} in ${existing.where}, at ${client.door.name}.`;
  }
  if (context.flags['key-stdin']) {
    const chunks = [];
    for await (const chunk of process.stdin) chunks.push(chunk);
    const key = Buffer.concat(chunks).toString('utf8').trim();
    if (!key.startsWith('nm_')) throw new TrillionError('Standard input did not hold a Trillion key.', { status: 2 });
    context.store.write(key);
  } else {
    const grant = await signInWithBrowser({ origin: context.asked ?? settings.origin, fetchImpl: context.fetchImpl, ...(context.open ? { open: context.open } : {}) });
    // A sign-in this program made before is ended when a new one replaces it; the Mac app's key is never touched.
    if (context.state.madeKey()?.where === context.grants.where) await endSignIn(context.grants.read(), { fetchImpl: context.fetchImpl });
    context.grants.write(grant);
    context.state.keepMade({ kind: 'sign-in', where: context.grants.where, at: new Date().toISOString() });
  }
  const client = await signedInClient(context);
  const { account } = await client.whoami();
  keepConnection(context, client.door, account);
  return `Signed in to Trillion as account ${account}, at ${client.door.name}. The ${client.credential.kind} is in ${client.credential.where}.`;
}

async function logout(context) {
  const made = context.state.madeKey();
  if (made?.kind === 'sign-in' && made.where === context.grants.where) {
    await endSignIn(context.grants.read(), { fetchImpl: context.fetchImpl });
    context.grants.forget();
    context.state.forgetMade();
    context.state.forgetConnection();
    return 'Signed out: this computer\'s sign-in is ended and removed from this computer.';
  }
  const kept = await credentialFor({ env: context.env, store: context.store, grants: context.grants, fetchImpl: context.fetchImpl }).catch(() => null);
  if (!kept) return 'Not signed in; there is nothing to sign out of.';
  return `The ${kept.kind} in ${kept.where} was not made by this program (the Trillion Mac app keeps it), so it was left on. Turn it off in your account's list of connected AIs.`;
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


/** `trillion update`: this program never updates itself. The Workshop installer owns the copy and updates it only when
 *  `trillion setup` runs from a newer Workshop program. */
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
    return JSON.stringify(await replay.dryRun({ host, since: flags.since, env: context.env }), null, 2);
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

/** Runs one command line; answers the text to print. `seams` carries what tests replace: store, grants, state, open, env,
 *  fetchImpl, wait, place, localDoor (the local door's MCP address, or null), computerName and model. */
export async function main(argv, seams = {}) {
  const parsed = parseArgs(argv);
  const [command = 'help', ...words] = parsed.words;
  const flags = parsed.flags;
  const env = seams.env ?? process.env;
  const asked = (flags.origin ?? env.TRILLION_ORIGIN)?.replace(/\/$/, '') || null;
  const context = { asked, flags, env, rest: parsed.rest, fetchImpl: seams.fetchImpl ?? fetch, wait: seams.wait ?? pause,
    store: seams.store ?? keyStore(), grants: seams.grants ?? grantStore(), state: seams.state ?? stateOf(), open: seams.open ?? null,
    localMcp: seams.localDoor ?? (() => findLocalDoor()),
    me: agentOf({ as: flags.as ?? null, env, computerName: seams.computerName ?? computerNameOf(), ...(seams.model !== undefined ? { model: seams.model } : {}) }),
    placeImpl: seams.place ?? (() => placeOf()) };
  const print = (name, answer) => (flags.json ? JSON.stringify(answer, null, 2) : render(name, answer));
  const engine = settings.engine;
  if (command === 'help' || flags.help) return HELP;
  if (command === 'login') return login(context, { again: flags.again === true });
  if (command === 'logout') return logout(context);
  if (command === 'connection') {
    const credential = await credentialFor({ env, store: context.store, grants: context.grants, fetchImpl: context.fetchImpl }).catch(() => null);
    const kept = context.state.connection() ?? connectionOf({ origin: doorFor({ asked, credential, localMcp: context.localMcp() }).origin, store: context.store });
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
  if (!WORK_COMMANDS.has(command) && !['whoami', 'tools', 'call', 'op', 'who', 'events', 'publish'].includes(command)) throw new TrillionError(`Unknown command ${command}. Run trillion help.`, { status: 2 });
  // A work command's words are checked before anything is sent.
  const call = WORK_COMMANDS.has(command) ? argumentsFor(command, { words, flags }, { me: context.me, held: context.state.held() }) : null;
  const client = await signedInClient(context);
  if (call) {
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
    return print(command, answer);
  }
  if (command === 'publish') {
    const written = await publishRecord(client, context, { dry: flags['dry-run'] === true });
    return flags['dry-run'] ? JSON.stringify(written.record, null, 2) : print('publish', written);
  }
  if (command === 'whoami') {
    const { account } = await client.whoami();
    const { agent_id, ai_id, held_as, app, model, provider, computer, harness } = context.me;
    return flags.json ? JSON.stringify({ account_id: account, agent_id, ai_id, held_as, app, model, provider, computer, harness, door: client.door.mcp, local: client.door.local }, null, 2)
      : [`account ${account}`, `ai ${ai_id}`, `facts ${[app, model, provider, computer].filter(Boolean).join(', ')}`,
        ...(held_as.length ? [`jobs taken before this session had its own id are finished as ${held_as.join(', ')}`] : []), `door ${client.door.name}`].join('\n');
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


// Run when started as a program (directly, or through the link setup puts on PATH).
const startedAsProgram = (() => { try { return realpathSync(process.argv[1] ?? '') === realpathSync(fileURLToPath(import.meta.url)); } catch { return false; } })();
if (startedAsProgram) {
  main(process.argv.slice(2)).then(text => { if (text) process.stdout.write(`${text}\n`); }, error => {
    process.stderr.write(`${error instanceof TrillionError ? error.message : `trillion: ${error.stack ?? error}`}\n`);
    process.exitCode = error instanceof TrillionError ? error.status : 1;
  });
}
