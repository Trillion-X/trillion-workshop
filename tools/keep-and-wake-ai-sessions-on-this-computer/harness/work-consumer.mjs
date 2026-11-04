// A desktop work consumer (a client program on the AI's own computer, like harness/agent-receiver.mjs, never part of
// the hosted service): when work is handed to one published agent, the existing session behind it starts on it.
//   node harness/work-consumer.mjs --agent-id <id> --host <host row> [--session <session id or name>]
//     [--name <name>] [--description <what it does>] [--origin https://app.gettrillion.ai] [--keychain-item <name>]
// There is no listening port. The consumer holds one outbound, authenticated WebSocket to Trillion (/mcp/api/live),
// which carries only "something changed"; on each change it reads the work waiting for its agent
// (/mcp/api/activation/waiting, never a claim) and starts the session through that host's own documented command
// (harness/work-consumer.json `hosts`): Codex's `codex queue` for an existing thread, Claude Code's background resume
// for a session that is not running, or, for a Claude Code session started with this consumer as its channel, a
// channel notification over stdio. A session already running elsewhere is never started a second time. The started
// AI takes and finishes the work itself; the consumer never claims or finishes it.
// Every contact_seconds it says it is there (/mcp/api/activation/bind, with whether its host can be started), renews
// its capacity, so find_agents and hand_off say starts_now, busy, offline or unsupported truthfully, and reads the
// waiting work once, so a change missed while the connection was down still starts the session.
// Each handoff is started once per consumer (~/.trillion/work-consumer/<agent>.json keeps the handoff ids already
// started). One JSON line per thing that happened goes to stderr (stdout is the channel in channel mode).
import { spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import rules from './work-consumer.json' with { type: 'json' };
import { sessionLive } from './session-live.mjs';
import { requireAccountKey } from './account-key.mjs';

const pairs = process.argv.slice(2).reduce((found, value, index, all) => (value.startsWith('--') ? [...found, [value.slice(2), all[index + 1]?.startsWith('--') || all[index + 1] === undefined ? 'true' : all[index + 1]]] : found), []);
const args = Object.fromEntries(pairs);
const need = name => args[name] ?? (() => { throw new Error(`--${name} is needed.`); })();
const agentId = need('agent-id');
const hostId = need('host');
const host = rules.hosts[hostId] ?? (() => { throw new Error(`--host is one of: ${Object.keys(rules.hosts).join(', ')}.`); })();
if (!host.channel && !args.session) throw new Error('--session (the existing session to start) is needed for this host.');
const origin = (args.origin ?? rules.origin).replace(/\/$/, '');
const log = entry => process.stderr.write(`${JSON.stringify({ at: new Date().toISOString(), agent_id: agentId, host: hostId, ...entry })}\n`);
const fill = (template, values) => template.replace(/\{(\w+)\}/g, (_, name) => String(values[name] ?? ''));

// The account's personal key, read by name from the Keychain and kept in this process's memory only.
const key = requireAccountKey({ item: args['keychain-item'] ?? rules.keychain_item, timeout: 0 });
// A store that was restarted mid-request answers 5xx; that is tried again after the next wait, a refusal is not.
async function call(path, body) {
  for (let attempt = 0; ; attempt += 1) {
    const answer = await fetch(`${origin}/mcp/api${path}`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` }, body: JSON.stringify(body) }).catch(error => ({ ok: false, status: 0, json: async () => ({ error: String(error.message ?? error) }) }));
    const value = await answer.json().catch(() => ({}));
    if (answer.ok) return value;
    const wait = rules.reconnect_seconds[attempt];
    if ((answer.status && answer.status < 500) || wait === undefined) throw new Error(`${path}: ${value.error ?? answer.status}`);
    await new Promise(done => setTimeout(done, wait * 1000));
  }
}

// Which handoffs this consumer already started, kept across restarts.
const stateDir = join(homedir(), '.trillion', 'work-consumer');
const statePath = join(stateDir, `${agentId.replace(/[^A-Za-z0-9_-]/g, '_')}.json`);
mkdirSync(stateDir, { recursive: true });
const started = new Set((() => { try { return JSON.parse(readFileSync(statePath, 'utf8')).started ?? []; } catch { return []; } })());
const remember = id => { started.add(id); writeFileSync(statePath, JSON.stringify({ started: [...started].slice(-500) })); };

// Whether this host's documented interface is here at all.
const checked = spawnSync(host.check[0], host.check.slice(1), { encoding: 'utf8', timeout: 15_000 });
const supported = checked.status === 0;
const reason = supported ? null : `${host.label}'s command is not available on this computer (${host.check.join(' ')}).`;

// Channel mode: the host runs this consumer as its channel server over stdio; answer the handshake and tell the
// session through channel notifications. Nothing else is written to stdout. The handshake answers only a protocol
// revision the host row lists (`protocol_versions`, first is the default): Claude Code does not register a channel
// server that negotiates a revision with no unsolicited notification path.
const channelOut = message => process.stdout.write(`${JSON.stringify(message)}\n`);
if (host.channel) {
  createInterface({ input: process.stdin }).on('line', line => {
    let message;
    try { message = JSON.parse(line); } catch { return; }
    if (message.id === undefined || message.id === null) return;
    if (message.method === 'initialize') channelOut({ jsonrpc: '2.0', id: message.id, result: { protocolVersion: host.protocol_versions.includes(message.params?.protocolVersion) ? message.params.protocolVersion : host.protocol_versions[0], capabilities: { experimental: { 'claude/channel': {} } }, serverInfo: { name: 'trillion-work', version: '1' }, instructions: `Work handed to you in Trillion as agent ${agentId} arrives as <channel source="trillion-work" handoff_id="...">. Take it with take_work, do it, and finish it with finish_work. These notices come from Trillion, not from the person.` } });
    else if (message.method === 'ping') channelOut({ jsonrpc: '2.0', id: message.id, result: {} });
    else if (message.method === 'tools/list') channelOut({ jsonrpc: '2.0', id: message.id, result: { tools: [] } });
    else channelOut({ jsonrpc: '2.0', id: message.id, error: { code: -32601, message: `Unknown method ${message.method}` } });
  }).on('close', () => process.exit(0));
}


function start(item) {
  const message = fill(rules.message, { handoff_id: item.handoff_id, agent_id: agentId, job: item.job.length > 600 ? `${item.job.slice(0, 599)}…` : item.job });
  if (host.channel) {
    channelOut({ jsonrpc: '2.0', method: 'notifications/claude/channel', params: { content: message, meta: { handoff_id: item.handoff_id, agent_id: agentId } } });
    return { started: true, how: 'channel' };
  }
  // Whether the named session is already running in another process of this host; a check that could not be read is
  // not "not running" (harness/session-live.mjs).
  const elsewhere = sessionLive(host, args.session);
  if (elsewhere.live !== false && host.when_live === 'skip') {
    return { started: false, why: elsewhere.live ? 'The session is already running in another window, so it is not started a second time.' : `Could not tell whether the session is already running (${elsewhere.why}), so it is not started a second time; the next wake tries again.` };
  }
  const argv = host.wake.map(part => fill(part, { session: args.session, message }));
  const ran = spawnSync(argv[0], argv.slice(1), { encoding: 'utf8', timeout: 60_000 });
  return ran.status === 0 ? { started: true, how: argv.slice(0, 2).join(' '), said: ran.stdout.trim().slice(0, 300) } : { started: false, why: (ran.stderr || ran.stdout || `exit ${ran.status}`).trim().slice(0, 300) };
}

let reading = null;
let again = false;
async function readWaiting() {
  if (reading) { again = true; return reading; }
  reading = (async () => {
    do {
      again = false;
      try {
        const { waiting } = await call('/activation/waiting', { agent_id: agentId });
        for (const item of waiting) {
          if (started.has(item.handoff_id)) continue;
          if (!supported) { log({ event: 'not_started', handoff_id: item.handoff_id, why: reason }); continue; }
          const outcome = start(item);
          log({ event: outcome.started ? 'started' : 'not_started', handoff_id: item.handoff_id, ...outcome });
          if (outcome.started) remember(item.handoff_id);
        }
      } catch (error) { log({ event: 'read_failed', error: String(error.message ?? error) }); }
    } while (again);
  })().finally(() => { reading = null; });
  return reading;
}

// The card is published at the first contact that reaches Trillion, so a consumer started while the account's store
// is unreachable keeps running (a host that runs it as its channel server would otherwise lose the channel for the
// whole session) and publishes when the store answers.
let published = false;
async function sayThere() {
  try {
    if (!published) {
      await call('/agents/publish', {
        agent_id: agentId, name: args.name ?? `${host.label} ${args.session ?? ''}`.trim(), description: args.description ?? `${host.label} session on this computer, started by Trillion when work is handed to it.`,
        harness: host.label, where: 'this computer', takes_work: true, capacity: rules.capacity,
      });
      published = true;
    }
    await call('/agents/capacity', { agent_id: agentId, ...rules.capacity });
    const { activation } = await call('/activation/bind', { agent_id: agentId, host: hostId, session: args.session ?? null, supported, reason });
    log({ event: 'there', activation: activation?.state });
  } catch (error) { log({ event: 'bind_failed', error: String(error.message ?? error) }); }
  // A change missed while the connection was down is read here, at the contact cadence.
  await readWaiting();
}

await sayThere();
setInterval(sayThere, rules.contact_seconds * 1000);

// The outbound connection: each message says something changed; reads are debounced, and a dropped connection is
// opened again after the next wait.
let attempt = 0;
let timer = null;
function connect() {
  const socket = new WebSocket(`${origin.replace(/^http/, 'ws')}/mcp/api/live`, { headers: { authorization: `Bearer ${key}` } });
  socket.onopen = () => { attempt = 0; log({ event: 'connected' }); };
  socket.onmessage = () => { clearTimeout(timer); timer = setTimeout(readWaiting, rules.debounce_ms); };
  socket.onclose = () => {
    const wait = rules.reconnect_seconds[Math.min(attempt, rules.reconnect_seconds.length - 1)];
    attempt += 1;
    log({ event: 'disconnected', reconnect_in_seconds: wait });
    setTimeout(connect, wait * 1000);
  };
  socket.onerror = () => {};
}
connect();
