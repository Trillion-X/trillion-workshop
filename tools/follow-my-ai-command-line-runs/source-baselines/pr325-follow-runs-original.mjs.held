#!/usr/bin/env node
// harness/wake-sessions.mjs
//
// Purpose
//   The helper that makes this computer's AI sessions reachable from Trillion the moment something is sent to them,
//   with no public address: a message the person sends from their phone to one exact Codex or Claude Code session
//   starts that session on it and its reply comes back to the same conversation. It is a client program on the
//   person's own computer, never part of the hosted service.
//     node harness/wake-sessions.mjs            start it (one command; it keeps running and reconnects by itself)
//     node harness/wake-sessions.mjs --once     connect, handle what is waiting, and stop (for a check)
//     node harness/wake-sessions.mjs --choose-ai <id>   keep the person's chosen AI (a row id of take-open-work.json ais)
//     node harness/wake-sessions.mjs --keep-running     start it now and at every login, restarted if it stops (a LaunchAgent)
//     node harness/wake-sessions.mjs --stop-running     stop it and stop starting it at login
//     node harness/wake-sessions.mjs --allow-tools <folder> <Tool,Tool>   the tools the person allows their AI in that
//         workspace folder (passed as the CLI's own allow-list flag, wake-sessions.json `allowed_tools`); --tools [folder]
//         reads them, --clear-tools <folder> takes the list away (harness/session-runs.mjs)
//     node harness/wake-sessions.mjs --key-stdin [--skip <handler>]...   the account key is the first line of standard
//         input, and each named handler row is left out: the Trillion Mac app runs it this way as its own child
//         (macos/computer-reader.json `children`), skipping the reader it already runs, so no second program needs
//         Full Disk Access and no LaunchAgent is needed on a Mac with the app
//
// How it works
//   1. Each session registers itself when it starts (harness/register-session.mjs, a SessionStart hook), as one row in
//      ~/.trillion/wake-sessions/hosted.json: its harness, session id, folder and the agent id it is published under.
//   2. The helper publishes each hosted session, and one agent for this computer (helper_agent in the DATA file, which
//      runs Workshop tools that live on the person's own computer), with delivery { stream: true }: the stream route
//      in src/agent-delivery.mjs.
//   3. It holds one outbound, authenticated WebSocket per 10 agents to /mcp/api/live?agent=<id>..., pings it every
//      ping_seconds (answered by the platform, so an idle connection costs nothing), and reconnects with backoff.
//      Trillion sends each event for those agents down it at once; on every connect the helper pulls what arrived
//      while it was away (/agents/events/pull).
//   4. Each event goes to the handler modules listed in wake-sessions.json `handlers`, in order; the first whose
//      wants(context) is true handles it. A handler that fails is tried again `retries` times, then the event is
//      answered as failed (a dead letter the sender can read, sent again when the agent is present).
//      Otherwise it is answered delivered (/agents/events/ack).
//
// Non-negotiable invariants
//   1. Nothing here names a harness, a tool or a kind of work: harness commands, event types, messages and handler
//      modules are DATA (wake-sessions.json), and each handler decides for itself which events it takes.
//   2. The account key is read from the macOS Keychain by name, kept in this process's memory, and sent only in the
//      Authorization header.
//   3. Each event is handled once per computer: ~/.trillion/wake-sessions/events keeps each event id's outcome
//      (harness/receiver-inbox.mjs), so a resend after a reconnect is answered from it, never run twice.
//   4. One session is started on one event at a time (events for the same agent wait their turn), and at most
//      most_at_once run together.
//   5. A handler's working folder is made by that handler under ~/.trillion/wake-sessions/work and deleted by it.
//   6. A command a handler runs (context.run: a harness's resume command, a tool's command) is started by the program that
//      take-open-work.mjs resolveProgram finds for its first word (this PATH, the program_paths folders, the login shell),
//      since the Mac app starts this helper with a short PATH. A program found nowhere is answered as code -1 with the words
//      "<program> is not installed where Trillion looks (<folders tried>)", and the helper keeps running.
//
// Handler module contract
//   export function wants(context) -> boolean
//   export async function handle(context) -> any JSON value (kept with the event); throw to fail it.
//   context: { event, hosted (the session row the event is for, or null), helper (the computer's own agent row, when
//     the event is for it), rules (wake-sessions.json), key (the account key), origin, call(path, body) (POST to
//     /mcp/api<path>), read(path) (GET), chosen (the person's chosen AI from settings.json, or null), run(argv,
//     { cwd, timeout_ms, on_output }) -> { code, stdout, stderr }, fill(template, values), workFolder(prefix) -> a new private
//     folder, log(entry) }
//   export function start({ key, origin, rules, log, helper }) (optional): runs beside the connection from the start;
//     helper is the computer's own agent row.
//   export const answers_at_once = true (optional): its events take milliseconds and are handled as they arrive,
//     never queued behind an AI's turn or an execution slot.
//
// Persistence
//   Kept running by whatever the person uses to keep a program running (a login item, a terminal left open, or the
//   operating system's service manager pointed at the command above). It holds no state that needs saving on exit.
//
import { execFileSync, spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, renameSync, writeFileSync } from 'node:fs';
import { homedir, hostname } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { receiverInbox } from './receiver-inbox.mjs';
import { aiOrder, chooseAi, chosenAi } from './chosen-ai.mjs';
import { childEnv, computerName, programMissingWords, programReady, readSettings as readTakeWorkSettings, resolveProgram, takerCard } from './take-open-work.mjs';
import { hasPendingSourceReturns } from './source-return-pending.mjs';
import { clearWorkspaceTools, setWorkspaceTools, workspaceTools } from './session-runs.mjs';
import { SIGN_IN_ENDED } from '../src/live-screen.mjs';
import { endWithTheApp } from '../computer/end-with-the-app.mjs';
import { requireAccountKey } from './account-key.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
export const settings = JSON.parse(readFileSync(join(HERE, 'wake-sessions.json'), 'utf8'));

const expand = path => path.replace(/^~(?=\/|$)/, homedir());
export const folderOf = rules => expand(rules.folder);
const readJsonFile = path => { try { return JSON.parse(readFileSync(path, 'utf8')); } catch { return null; } };
function writeJsonFile(path, value) {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const part = `${path}.${process.pid}.part`;
  writeFileSync(part, JSON.stringify(value, null, 2), { mode: 0o600 });
  renameSync(part, path);
}
const slug = text => String(text).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 60) || 'computer';

/** The agent id a session is published under: its harness and session id, so it is the same on every start. */
export const agentIdOf = (harness, sessionId) => `session-${harness}-${sessionId}`.slice(0, 200);

/** The sessions this computer hosts, newest first. */
export const hostedSessions = (rules = settings) => readJsonFile(join(folderOf(rules), rules.hosted_file))?.sessions ?? [];

/** Adds or refreshes one session row (from the SessionStart hook), keeping the newest keep_sessions. */
export function registerSession({ harness, session_id, cwd = null, at = new Date().toISOString() }, rules = settings) {
  const row = rules.harnesses[harness];
  if (!row) throw new Error(`No harness ${harness} in wake-sessions.json.`);
  if (typeof session_id !== 'string' || !/^[0-9A-Za-z-]{8,200}$/.test(session_id)) throw new Error('session_id is the session\'s own id.');
  const hosted = { agent_id: agentIdOf(harness, session_id), harness, session_id, app: row.app, source_id: `${harness}:${session_id}`, cwd, registered_at: at };
  const others = hostedSessions(rules).filter(item => item.agent_id !== hosted.agent_id);
  writeJsonFile(join(folderOf(rules), rules.hosted_file), { sessions: [hosted, ...others].slice(0, rules.keep_sessions) });
  return hosted;
}

/** How a hosted session is published: named as its app, found by its own conversation (source_id), on the stream route. */
export const sessionCard = hosted => ({ agent_id: hosted.agent_id, name: hosted.app, description: `A ${hosted.app} session on this computer${hosted.cwd ? `, in ${hosted.cwd.split('/').filter(Boolean).at(-1)}` : ''}.`, source_id: hosted.source_id, delivery: { stream: true } });

// The person's chosen AI is kept in one place, read by this helper's handlers and the taker alike (chosen-ai.mjs).
export { chooseAi, chosenAi } from './chosen-ai.mjs';

/** Fills {name} holes in a string; a part that is exactly one hole becomes that value as text. */
export const fill = (template, values) => String(template).replace(/\{(\w+)\}/g, (hole, name) => (values[name] === undefined ? hole : String(values[name])));
export const fillArgv = (argv, values) => argv.map(part => fill(part, values));

/** Runs one command with no shell; resolves { code, stdout, stderr } and never rejects (`on_output` sees standard output
 * as it arrives, for a run whose events are read live). The program (argv[0]) is found by
 * resolveProgram, the same way the taker finds its AIs; one installed nowhere Trillion looks is answered at once as code -1,
 * with the words that say so (programMissingWords), never started. */
export function run(argv, { cwd = homedir(), timeout_ms = 900_000, stdin = null, on_output = null } = {}) {
  return new Promise(done => {
    let stdout = '';
    let stderr = '';
    let child;
    // An inherited ANTHROPIC_API_KEY outranks the claude.ai sign-in and turns off its connectors, Trillion's MCP included.
    const { ANTHROPIC_API_KEY, ...env } = process.env;
    const program = resolveProgram(argv[0]);
    if (!program) { done({ code: -1, stdout, stderr: programMissingWords(argv[0]) }); return; }
    try { child = spawn(program, argv.slice(1), { cwd, env: childEnv(env), stdio: [stdin === null ? 'ignore' : 'pipe', 'pipe', 'pipe'] }); }
    catch (error) { done({ code: -1, stdout, stderr: error.message }); return; }
    const timer = setTimeout(() => { stderr += `\nStopped after ${Math.round(timeout_ms / 1000)} seconds.`; child.kill('SIGTERM'); }, timeout_ms);
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', chunk => { stdout += chunk; on_output?.(chunk); });
    child.stderr.on('data', chunk => { stderr += chunk; });
    if (stdin !== null) child.stdin.end(stdin);
    child.on('error', error => { clearTimeout(timer); done({ code: -1, stdout, stderr: `${stderr}${error.message}` }); });
    child.on('close', code => { clearTimeout(timer); done({ code: code ?? -1, stdout, stderr }); });
  });
}

/** The computer's own agent row: runs Workshop tools that live here. */
export const helperAgentOf = (rules = settings, host = hostname()) => ({ agent_id: `computer-${slug(host)}`, ...rules.helper_agent });

/** Loads the handler modules named in the DATA file, in order. */
export const loadHandlers = async (rules = settings) => Promise.all(rules.handlers.map(async path => ({ path, ...(await import(pathToFileURL(resolve(HERE, path)).href)) })));

/**
 * The helper, with every outside thing handed in so it can be tested: fetch, WebSocket, the key, the handlers and
 * run. Returns { publishAll, handle(event), connect(), stop() }.
 */
export function makeHelper({ rules = settings, key, origin = rules.origin, fetchImpl = fetch, wait = seconds => new Promise(done => setTimeout(done, seconds * 1000)), WebSocketImpl = globalThis.WebSocket, handlers, runImpl = run, log = entry => process.stderr.write(`${JSON.stringify({ at: new Date().toISOString(), ...entry })}\n`), host = hostname(), sessions = () => hostedSessions(rules), published = new Set(), replaySourceReturns = () => {} }) {
  const base = origin.replace(/\/$/, '');
  const inbox = receiverInbox(join(folderOf(rules), 'events'));
  const helper = helperAgentOf(rules, host);
  let taker = null;
  const takerForChoice = () => {
    const chosen = chosenAi(rules);
    return chosen ? takerCard({ ...readTakeWorkSettings(), use_ai: chosen, ai_order: aiOrder(rules) }, computerName(), new Date().toISOString(), programReady) : null;
  };
  const headers = { authorization: `Bearer ${key}`, 'content-type': 'application/json' };
  // An answer that says when to send again (retry-after) is sent again, waiting at least busy_backoff_seconds[n];
  // any other refusal is the answer.
  async function request(path, init) {
    for (let attempt = 0; ; attempt += 1) {
      const answer = await fetchImpl(`${base}/mcp/api${path}`, { headers, ...init });
      const value = await answer.json().catch(() => ({}));
      if (answer.ok) return value;
      const after = Number(answer.headers?.get?.('retry-after') ?? NaN);
      if (!Number.isFinite(after) || attempt >= rules.busy_backoff_seconds.length) throw new Error(`${path}: ${value.error ?? answer.status}`);
      await wait(Math.max(after, rules.busy_backoff_seconds[attempt]));
    }
  }
  const call = (path, body) => request(path, { method: 'POST', body: JSON.stringify(body ?? {}) });
  const read = path => request(path, {});
  const workFolder = prefix => { mkdirSync(join(folderOf(rules), 'work'), { recursive: true, mode: 0o700 }); return mkdtempSync(join(folderOf(rules), 'work', `${prefix}-`)); };

  // Publishes the computer's agent and each hosted session once per helper run (`published` is kept across the
  // helper's own restarts when a session registers), and returns every agent id the stream carries.
  const sourceSecrets = new Map();
  let publishedTakerChoice = null;
  async function publishAll() {
    taker = takerForChoice();
    // The taker's card also says which AIs rest and what went wrong with one (take-open-work.mjs takerCard), so it is
    // published again whenever that changes, not only when the person's choice does.
    const choice = `${aiOrder(rules).join(',')}|${JSON.stringify(taker?.capacity ?? null)}|${taker?.description ?? ''}`;
    if (taker && choice !== publishedTakerChoice) published.delete(taker.agent_id);
    const cards = [{ agent_id: helper.agent_id, name: helper.name, description: helper.description, runs: helper.runs, takes_work: false, delivery: { stream: true } }, ...(taker ? [taker] : []), ...sessions().map(sessionCard)];
    for (const card of cards) {
      if (published.has(card.agent_id) && (!card.source_id || sourceSecrets.has(card.agent_id))) continue;
      const publishedCard = await call('/agents/publish', card.source_id ? { ...card, rotate_delivery_secret: true } : card);
      if (card.source_id && publishedCard.delivery_secret) sourceSecrets.set(card.agent_id, publishedCard.delivery_secret);
      published.add(card.agent_id);
    }
    publishedTakerChoice = choice;
    return cards.map(card => card.agent_id);
  }

  // Events for one agent run one at a time, in order; at most most_at_once run together.
  const lanes = new Map();
  let running = 0;
  const waiting = [];
  const slot = () => (running < rules.most_at_once ? (running += 1, Promise.resolve()) : new Promise(next => waiting.push(next)).then(() => { running += 1; }));
  const release = () => { running -= 1; waiting.shift()?.(); };

  async function handleNow(event) {
    const earlier = inbox.read(event.event_id);
    if (earlier?.state === 'done') {
      await call('/agents/events/ack', { event_id: event.event_id, agent_id: event.to_agent, ok: earlier.ok !== false, attempts: earlier.attempts ?? 1, ...(earlier.error ? { error: earlier.error } : {}) }).catch(() => null);
      return earlier;
    }
    inbox.accept(event.event_id, event);
    const hosted = sessions().find(item => item.agent_id === event.to_agent) ?? null;
    const context = { event, hosted, helper: event.to_agent === helper.agent_id ? helper : null, taker: event.to_agent === taker?.agent_id ? taker : null, rules, key, origin: base, call, read, sourceSecret: sourceSecrets.get(event.to_agent), chosen: chosenAi(rules), run: runImpl, fill, fillArgv, workFolder, log };
    const handler = handlers.find(item => item.wants(context));
    let outcome;
    if (!handler) outcome = { ok: true, attempts: 0, result: { skipped: 'no handler takes this event' } };
    else {
      let attempts = 0;
      let error = null;
      while (attempts <= rules.retries) {
        attempts += 1;
        try { outcome = { ok: true, attempts, result: await handler.handle(context) }; break; }
        catch (failure) { error = String(failure?.message ?? failure).slice(0, 600); log({ event_id: event.event_id, type: event.type, to_agent: event.to_agent, handler: handler.path, attempt: attempts, error }); }
      }
      outcome ??= { ok: false, attempts, error };
    }
    await call('/agents/events/ack', { event_id: event.event_id, agent_id: event.to_agent, ok: outcome.ok, attempts: Math.max(outcome.attempts, 1), ...(outcome.error ? { error: outcome.error } : {}) });
    const entry = { event, state: 'done', ...outcome, answered_at: new Date().toISOString() };
    writeJsonFile(join(folderOf(rules), 'events', `${event.event_id}.json`), entry);
    log({ event_id: event.event_id, type: event.type, to_agent: event.to_agent, ok: outcome.ok, attempts: outcome.attempts, ...(outcome.result ? { result: outcome.result } : {}) });
    return entry;
  }

  // The same event arriving again while it is being handled (down the socket and again in a pull after a reconnect)
  // joins the run already going; it is never started twice.
  const inFlight = new Map();
  function handle(event) {
    const going = inFlight.get(event.event_id);
    if (going) return going;
    log({ event_id: event.event_id, type: event.type, to_agent: event.to_agent, received_at: new Date().toISOString() });
    const hosted = sessions().find(item => item.agent_id === event.to_agent) ?? null;
    const taking = handlers.find(item => item.wants({ event, hosted, helper: event.to_agent === helper.agent_id ? helper : null, taker: event.to_agent === taker?.agent_id ? taker : null, rules }));
    // Notices with no local handler still get acknowledged, but cannot use a scarce execution slot or sit in front
    // of a person's actionable work. In particular, decision notices arrive for every registered AI at once. A handler
    // that answers at once (it exports answers_at_once, such as a button the person pressed) never waits behind an AI's
    // turn either.
    const addressed = Boolean(taking) && !taking.answers_at_once;
    const before = lanes.get(event.to_agent) ?? Promise.resolve();
    const turn = addressed
      ? before.catch(() => null).then(async () => { await slot(); try { return await handleNow(event); } finally { release(); } })
      : handleNow(event);
    if (addressed) lanes.set(event.to_agent, turn);
    inFlight.set(event.event_id, turn);
    turn.finally(() => inFlight.delete(event.event_id)).catch(() => null);
    return turn;
  }

  const sockets = new Set();
  const retired = new WeakSet();
  let stopped = false;
  function connect(ids, attempt = 0) {
    const query = ids.map(id => `agent=${encodeURIComponent(id)}`).join('&');
    const socket = new WebSocketImpl(`${base.replace(/^http/, 'ws')}/mcp/api/live?${query}`, { headers: { authorization: `Bearer ${key}` } });
    sockets.add(socket);
    let ping;
    socket.addEventListener('open', async () => {
      attempt = 0;
      log({ connected: ids });
      replaySourceReturns();
      ping = setInterval(() => { try { socket.send('ping'); } catch { /* closing */ } replaySourceReturns(); }, rules.ping_seconds * 1000);
      try { for (const event of (await call('/agents/events/pull', { agent_ids: ids })).events ?? []) handle(event); }
      catch (error) { log({ pull: ids, error: error.message }); }
    });
    socket.addEventListener('message', message => {
      let value;
      try { value = JSON.parse(typeof message.data === 'string' ? message.data : String(message.data)); } catch { return; }
      if (value?.event?.event_id) handle(value.event);
    });
    socket.addEventListener('close', event => {
      clearInterval(ping);
      sockets.delete(socket);
      if (stopped || retired.has(socket)) return;
      // The person took this key back (4401, src/live-screen.mjs SIGN_IN_ENDED): asking again would only be refused.
      if (event?.code === SIGN_IN_ENDED) { log({ disconnected: ids, signed_out: 'This key was turned off. Make a new key to connect again.' }); return; }
      const wait = rules.reconnect_seconds[Math.min(attempt, rules.reconnect_seconds.length - 1)];
      log({ disconnected: ids, reconnect_in_seconds: wait });
      setTimeout(() => { if (!stopped) connect(ids, attempt + 1); }, wait * 1000);
    });
    socket.addEventListener('error', () => { /* close follows */ });
    return socket;
  }

  // One socket per 10 agents (a socket carries at most 10 names).
  const connectAll = ids => { for (let at = 0; at < ids.length; at += 10) connect(ids.slice(at, at + 10)); };
  // A session registered while the helper runs: publish what is new and open the connections again with it, keeping
  // this helper's queues so work already going is never started a second time.
  async function refresh() {
    const ids = await publishAll();
    for (const socket of sockets) { retired.add(socket); socket.close(); }
    connectAll(ids);
    return ids;
  }
  return { helper, call, read, publishAll, handle, connectAll, refresh, stop: () => { stopped = true; for (const socket of sockets) socket.close(); }, idle: () => Promise.all(lanes.values()) };
}

// The LaunchAgent that keeps the helper running on a Mac: started at login, started again if it stops. Its PATH is the
// one the command was given, so the AI command-line tools it wakes are found the same way they were in the terminal.
export const LAUNCH_LABEL = 'ai.gettrillion.wake-sessions';
const escapeXml = text => String(text).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
export function launchAgentPlist({ node, script, path, log }) {
  const string = value => `<string>${escapeXml(value)}</string>`;
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
	<key>Label</key>${string(LAUNCH_LABEL)}
	<key>ProgramArguments</key><array>${string(node)}${string(script)}</array>
	<key>EnvironmentVariables</key><dict><key>PATH</key>${string(path)}</dict>
	<key>RunAtLoad</key><true/>
	<key>KeepAlive</key><true/>
	<key>ThrottleInterval</key><integer>30</integer>
	<key>StandardOutPath</key>${string(log)}
	<key>StandardErrorPath</key>${string(log)}
</dict>
</plist>
`;
}

function keepRunning(on) {
  const plist = join(homedir(), 'Library', 'LaunchAgents', `${LAUNCH_LABEL}.plist`);
  const domain = `gui/${process.getuid()}`;
  try { execFileSync('launchctl', ['bootout', `${domain}/${LAUNCH_LABEL}`], { stdio: 'ignore' }); } catch {}
  if (!on) {
    try { renameSync(plist, `${plist}.stopped`); } catch {}
    return 'Stopped. It no longer starts at login.';
  }
  const folder = join(homedir(), '.trillion', 'wake-sessions');
  mkdirSync(folder, { recursive: true });
  mkdirSync(dirname(plist), { recursive: true });
  writeFileSync(plist, launchAgentPlist({ node: process.execPath, script: fileURLToPath(import.meta.url), path: process.env.PATH ?? '/usr/bin:/bin', log: join(folder, 'helper.log') }));
  execFileSync('launchctl', ['bootstrap', domain, plist], { stdio: 'ignore' });
  return `Running, and it starts at every login. Its log: ${join(folder, 'helper.log')}`;
}

/**
 * Starts each handler that also runs by itself (it exports start); one that fails to start is logged, the rest start.
 * `helper` is this computer's own agent, so a handler can name it as the one that answers what it offers the person.
 */
export function startHandlers({ handlers, key, rules = settings, origin = rules.origin, log = line => process.stderr.write(`${JSON.stringify({ at: new Date().toISOString(), started: line })}\n`) }) {
  const started = [];
  for (const handler of handlers) {
    if (typeof handler.start !== 'function') continue;
    try { started.push(handler.start({ key, origin, rules, log, helper: helperAgentOf(rules) })); }
    catch (error) { log(`${handler.path} did not start: ${error.message}`); }
  }
  return started;
}

// The connection watcher's tick: refreshes the helper when the connection state changed, or when the last refresh failed
// (the state is then retried, and the order is compared with the last state handled, not with the failed one).
export function watchConnection({ read, refresh, onOrderChange, log = () => {} }) {
  let seen = read();
  let retry = false;
  let running = false;
  return async function tick() {
    const now = read();
    if (running || (now === seen && !retry)) return;
    const prior = JSON.parse(seen).ai_order.join(',');
    running = true;
    try {
      await refresh();
      seen = now;
      retry = false;
      if (prior !== JSON.parse(now).ai_order.join(',')) await onOrderChange();
    }
    catch (error) { retry = true; log(error); }
    finally { running = false; }
  };
}

const keychainKey = name => requireAccountKey({ item: name, timeout: 5000 });

// The account key: the first line of standard input when the app that started this helper hands it there, else this
// computer's Keychain item.
async function keyFromStdin() {
  let text = '';
  for await (const chunk of process.stdin) { text += chunk; if (text.includes('\n')) break; }
  return text.split('\n')[0].trim();
}

const isEntryScript = () => {
  try {
    return realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
};
if (isEntryScript()) {
  const choose = process.argv.indexOf('--choose-ai');
  if (choose > 0) { process.stdout.write(`Chosen: ${chooseAi(process.argv[choose + 1])}\n`); process.exit(0); }
  const toolsFlag = ['--allow-tools', '--tools', '--clear-tools'].find(flag => process.argv.includes(flag));
  if (toolsFlag) {
    const [folder, tools] = process.argv.slice(process.argv.indexOf(toolsFlag) + 1);
    const answer = toolsFlag === '--allow-tools' ? setWorkspaceTools(settings, folder, tools)
      : toolsFlag === '--clear-tools' ? clearWorkspaceTools(settings, folder)
      : folder ? { folder, tools: workspaceTools(settings, folder) } : { workspace_tools: workspaceTools(settings) };
    process.stdout.write(`${JSON.stringify(answer, null, 2)}\n`); process.exit(0);
  }
  if (process.argv.includes('--keep-running') || process.argv.includes('--stop-running')) { process.stdout.write(`${keepRunning(process.argv.includes('--keep-running'))}\n`); process.exit(0); }
  const skipped = process.argv.flatMap((arg, at) => (arg === '--skip' && process.argv[at + 1] ? [process.argv[at + 1]] : []));
  const handlerRules = { ...settings, handlers: settings.handlers.filter(path => !skipped.includes(path)) };
  const accountKey = process.argv.includes('--key-stdin') ? await keyFromStdin() : keychainKey(settings.keychain_item);
  if (!accountKey) { process.stderr.write('No account key was given on standard input.\n'); process.exit(1); }
  // Started by the app: ends with it, so a replaced app never leaves this helper polling beside the new one.
  if (process.argv.includes('--key-stdin')) endWithTheApp();
  // Publishing waits out a service that cannot answer yet, with the reconnect backoff, instead of stopping.
  const published = new Set();
  let replayingSourceReturns = false;
  const replaySourceReturns = () => {
    if (replayingSourceReturns || !hasPendingSourceReturns()) return;
    replayingSourceReturns = true;
    const child = spawn(process.execPath, [join(dirname(fileURLToPath(import.meta.url)), 'request-source-return-check.mjs'), '--replay'], { stdio: 'ignore' });
    child.once('exit', () => { replayingSourceReturns = false; });
    child.once('error', () => { replayingSourceReturns = false; });
  };
  const start = async () => {
    const helper = makeHelper({ key: accountKey, handlers: await loadHandlers(handlerRules), published, replaySourceReturns });
    // Existing cards can receive work while the service retries publishing older hosted sessions.
    // The full refresh replaces these sockets once every card is current.
    if (!process.argv.includes('--once')) {
      const chosen = chosenAi(settings);
      const taker = chosen ? takerCard({ ...readTakeWorkSettings(), use_ai: chosen, ai_order: aiOrder(settings) }, computerName()) : null;
      helper.connectAll([helper.helper.agent_id, taker?.agent_id].filter(Boolean));
    }
    for (let attempt = 0; ; attempt += 1) {
      try { return { helper, ids: await helper.publishAll() }; }
      catch (error) {
        const seconds = settings.reconnect_seconds[Math.min(attempt, settings.reconnect_seconds.length - 1)];
        process.stderr.write(`${JSON.stringify({ at: new Date().toISOString(), publish: 'failed', error: error.message, again_in_seconds: seconds })}\n`);
        await new Promise(done => setTimeout(done, seconds * 1000));
      }
    }
  };
  // These handlers have their own account retry loops. Start them even when publishing the
  // hosted session cards is waiting on a busy account, so this Mac can still take its jobs.
  if (!process.argv.includes('--once')) startHandlers({ handlers: await loadHandlers(handlerRules), key: accountKey });
  let current = await start();
  if (process.argv.includes('--once')) {
    const pulled = (await current.helper.call('/agents/events/pull', { agent_ids: current.ids.slice(0, 10) })).events ?? [];
    await Promise.all(pulled.map(event => current.helper.handle(event)));
    process.exit(0);
  }
  current.ids = await current.helper.refresh();
  // A session that registers while the helper runs is published and carried by the same helper (refresh).
  // The taker's card (resting AIs, trouble) is part of the state, so a rest written by a run refreshes what Trillion shows.
  const connectionState = () => JSON.stringify({ sessions: hostedSessions().map(item => item.agent_id), ai_order: aiOrder(), taker_card: (() => { try { const card = takerCard({ ...readTakeWorkSettings(), use_ai: chosenAi(settings), ai_order: aiOrder(settings) }, computerName()); return [card.capacity, card.description]; } catch { return null; } })() });
  const tick = watchConnection({
    read: connectionState,
    refresh: async () => { current.ids = await current.helper.refresh(); },
    onOrderChange: async () => {
      if (!aiOrder().length) return;
      const takerHandler = (await loadHandlers(handlerRules)).find(item => item.path === './wake-handlers/take-open-work.mjs');
      takerHandler?.start?.({ key: accountKey, origin: settings.origin, rules: settings, log: line => process.stderr.write(`${line}\n`) });
    },
    log: error => process.stderr.write(`${JSON.stringify({ at: new Date().toISOString(), refresh: 'failed', error: error.message })}\n`),
  });
  setInterval(tick, 5000);
}
