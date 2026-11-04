// A harness receiver (a client program on the agent's own computer, like extension/ and ios/, never part of the hosted
// service): keeps one agent reachable, so work handed to it wakes it instead of it asking again and again.
//   node harness/agent-receiver.mjs --agent-id <id> --name <name> --description <what it does> --port <port>
//     --public-url <https address that reaches this port> [--origin https://app.gettrillion.ai]
//     [--source-id <exact chat id>] [--work "<command>" | --wake "<command>"]
//     [--verify-source-return "<command>"] [--on-finished "<command>"]
//     [--on "<event type>=<command>"]... [--presence-minutes 5]
//     [--keychain-item <name>] [--fail-first <n>]
// The account's personal key is read from the macOS Keychain item named by --keychain-item, or else the first line of
// stdin; it stays in this process's memory. On start the agent publishes with its delivery address and a new delivery
// secret (kept in memory only). Then:
//   handoff.created   take_work for that handoff; when taken, --work runs with the job as JSON on stdin, and its
//                     output becomes the result of finish_work; a failing command stays unfinished for recovery
//   handoff.finished  read_handoff; --on-finished runs with the finished handoff as JSON on stdin
//   any other type    the command given for it with --on runs with the event as JSON on stdin (for example a run
//                     request for a tool on this computer: the command reads what to run from the event's owner,
//                     runs it here); when its last output line is {"reply":{"type","summary","refs"}}, this receiver
//                     sends that event back to the sender about the same subject, once per event (the command never
//                     holds the account key); a type with no command is logged only
// Every --presence-minutes it reports it is present (agent_presence) and renews its capacity; neither returns work.
// Each event is checked against its signature and saved before 202; unfinished events replay after restart or presence.
// --fail-first answers the first n events
// with 503, to show that the service tries again. One JSON line per thing that happened goes to stdout.
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { deliveryHolds, signDelivery } from '../src/agent-delivery.mjs';
import { receiverInbox } from './receiver-inbox.mjs';
import { requireAccountKey } from './account-key.mjs';

const pairs = process.argv.slice(2).reduce((found, value, index, all) => (value.startsWith('--') ? [...found, [value.slice(2), all[index + 1]?.startsWith('--') || all[index + 1] === undefined ? 'true' : all[index + 1]]] : found), []);
const args = Object.fromEntries(pairs.filter(([name]) => name !== 'on'));
// Which command wakes for which event type: DATA given on the command line, never a list in this file.
const handlers = new Map(pairs.filter(([name]) => name === 'on').map(([, value]) => [value.slice(0, value.indexOf('=')), value.slice(value.indexOf('=') + 1)]));
const need = name => args[name] ?? (() => { throw new Error(`--${name} is needed.`); })();
const origin = (args.origin ?? 'https://app.gettrillion.ai').replace(/\/$/, '');
const agentId = need('agent-id');
if (args.work && args.wake) throw new Error('Choose --work or --wake, not both.');
if (args.wake && !args['source-id']) throw new Error('--wake needs the exact --source-id.');
const takesWork = Boolean(args.work || args.wake);
const inbox = receiverInbox(join(homedir(), '.trillion', 'agent-receiver', agentId.replace(/[^A-Za-z0-9_-]/g, '_')));
const log = entry => process.stdout.write(`${JSON.stringify({ at: new Date().toISOString(), agent_id: agentId, ...entry })}\n`);
// What this receiver can never act on: the event stays settled instead of pending, so it is not read again.
class NotForThisReceiver extends Error {}

async function readKey() {
  if (args['keychain-item']) return requireAccountKey({ item: args['keychain-item'], timeout: 0 });
  for await (const line of createInterface({ input: process.stdin })) return line.trim();
  throw new Error('No personal key on stdin.');
}
const key = await readKey();

async function call(path, body) {
  const answer = await fetch(`${origin}/mcp/api${path}`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` }, body: JSON.stringify(body) });
  const value = await answer.json();
  if (!answer.ok) throw new Error(`${path}: ${value.error ?? answer.status}`);
  return value;
}

async function signedCall(path, body) {
  const raw = JSON.stringify(body);
  const answer = await fetch(`${origin}/mcp/api${path}`, { method: 'POST', headers: {
    'content-type': 'application/json', authorization: `Bearer ${key}`, 'trillion-source-signature': signDelivery(secret, raw),
  }, body: raw });
  const value = await answer.json();
  if (!answer.ok) throw new Error(`${path}: ${value.error ?? answer.status}`);
  return value;
}

function run(command, input) {
  return new Promise(resolve => {
    const child = spawn('/bin/sh', ['-c', command], { stdio: ['pipe', 'pipe', 'pipe'] });
    let out = '';
    let err = '';
    child.stdout.on('data', chunk => { out += chunk; });
    child.stderr.on('data', chunk => { err += chunk; });
    child.on('close', code => resolve({ code, out: out.trim(), err: err.trim() }));
    child.stdin.end(JSON.stringify(input));
  });
}

const published = await call('/agents/publish', { agent_id: agentId, name: need('name'), description: need('description'), harness: args.harness ?? 'agent receiver', where: args.where ?? 'a harness receiver', ...(args['source-id'] ? { source_id: args['source-id'] } : {}), takes_work: takesWork, delivery: { url: need('public-url') }, rotate_delivery_secret: true, capacity: { max_concurrent: takesWork ? 1 : 0, ttl_minutes: 60 } });
const secret = published.delivery_secret;
if (!secret) throw new Error('The publish answer carried no delivery secret.');
log({ did: 'published', delivery: published.agent.delivery });

const inFlight = new Set();
// Unfinished events are replayed one at a time, never all at once: a burst of hundreds of reads at the same moment
// overloads the person's store for every other caller.
let replaying = null;
const replayPending = () => {
  replaying ??= (async () => {
    try { for (const [eventId] of inbox.pending()) await processEvent(eventId); }
    finally { replaying = null; }
  })();
  return replaying;
};
const presence = async () => {
  try {
    const present = await call('/agents/presence', { agent_id: agentId });
    await call('/agents/capacity', { agent_id: agentId, max_concurrent: takesWork ? 1 : 0, ttl_minutes: 60 });
    log({ did: 'present', sending_again: present.sending_again });
    void replayPending();
  } catch (error) { log({ did: 'presence failed', error: error.message }); }
};
await presence();
setInterval(presence, Number(args['presence-minutes'] ?? 5) * 60_000).unref?.();

let failFirst = Number(args['fail-first'] ?? 0);

function processEvent(eventId) {
  if (inFlight.has(eventId)) return Promise.resolve();
  const entry = inbox.read(eventId);
  if (entry?.state !== 'pending') return Promise.resolve();
  inFlight.add(eventId);
  return handle(entry.event, eventId).then(() => {
    inbox.done(eventId);
    log({ did: 'handled', event_id: eventId });
  }).catch(error => {
    if (error instanceof NotForThisReceiver) {
      inbox.refused(eventId, error.message);
      return log({ did: 'not for this receiver', event_id: eventId, subject_id: entry.event.subject_id, reason: error.message });
    }
    log({ did: 'failed', event_id: eventId, subject_id: entry.event.subject_id, error: error.message });
  }).finally(() => inFlight.delete(eventId));
}

async function handle(event, eventId) {
  if (event.type === 'source.return.check') {
    if (!args['verify-source-return'] || !args['source-id'] || event.to_agent !== agentId
      || event.refs?.handoff_id !== event.subject_id || !event.refs?.transcript_message_id)
      throw new NotForThisReceiver('This source return check is not addressed to a configured source receiver.');
    const handoff = (await call('/handoffs/read', { handoff_id: event.subject_id })).handoff;
    if (handoff?.to_agent !== agentId || handoff?.input?.arrived?.source_id !== args['source-id'])
      throw new NotForThisReceiver('The handoff is not bound to this original chat.');
    const checked = await run(args['verify-source-return'], { handoff, transcript_message_id: event.refs.transcript_message_id });
    if (checked.code !== 0) throw new Error(checked.err || 'The original final answer could not be verified.');
    let proof;
    try { proof = JSON.parse(checked.out.split('\n').at(-1)); } catch { throw new Error('The source verifier returned no result identity.'); }
    const answer = await signedCall('/handoffs/confirm-source-return', {
      handoff_id: handoff.handoff_id, agent_id: agentId, source_id: args['source-id'],
      message_id: proof.message_id, transcript_message_id: proof.transcript_message_id,
    });
    return log({ did: 'source result verified', handoff_id: handoff.handoff_id,
      message_id: answer.handoff.source_return.message_id });
  }
  if (event.type === 'handoff.created') {
    if (!takesWork) return log({ did: 'not a work receiver', handoff_id: event.subject_id });
    const handoffId = event.subject_id;
    if (event.to_agent !== agentId || event.refs?.handoff_id !== handoffId) throw new NotForThisReceiver('The signed event is not addressed to this agent and handoff.');
    let current;
    if (args['source-id'] || args.wake) {
      current = (await call('/handoffs/read', { handoff_id: handoffId })).handoff;
      if (args.wake && current?.to_agent === null) return log({ did: 'not addressed to this chat', handoff_id: handoffId });
      if (current?.to_agent !== agentId || current?.input?.arrived?.source_id !== args['source-id']) {
        throw new NotForThisReceiver('The handoff is not from this registered source chat.');
      }
    }
    if (args.wake) {
      if (current.state === 'finished') return log({ did: 'already finished', handoff_id: handoffId });
      const previous = inbox.read(eventId)?.wake;
      if (!previous) {
        const sent = await run(args.wake, { handoff_id: handoffId, agent_id: agentId, source_id: args['source-id'] });
        if (sent.code !== 0) throw new Error(sent.err || `Wake command ended with ${sent.code}.`);
        inbox.woke(eventId, { at: new Date().toISOString(), output: sent.out.slice(0, 200) });
        log({ did: 'woke', handoff_id: handoffId });
      }
      // The queue accepted the message for this exact chat. Handoff completion is a separate account fact;
      // replaying the delivery until finish would create another user-visible turn for the same event.
      return log({ did: 'wake queued', handoff_id: handoffId });
    }
    const taken = await call('/handoffs/take', { agent_id: agentId, handoff_id: handoffId, only_mine: true });
    if (!taken.handoff) {
      const read = await call('/handoffs/read', { handoff_id: handoffId });
      if (read.handoff?.state === 'finished' || (read.handoff?.to_agent && read.handoff.to_agent !== agentId)) return log({ did: 'not mine or already finished', handoff_id: handoffId });
      throw new Error(taken.note ?? `${handoffId} is still waiting.`);
    }
    log({ did: 'took', handoff_id: handoffId });
    const done = await run(args.work, taken.handoff);
    if (done.code !== 0 || !done.out) throw new Error(done.err || `The work command ended with ${done.code} or returned no result.`);
    await call('/handoffs/finish', { handoff_id: handoffId, agent_id: agentId, result: done.out, summary: done.out.slice(0, 200) });
    return log({ did: 'finished', handoff_id: handoffId, ok: true });
  }
  if (event.type === 'handoff.finished') {
    const read = await call('/handoffs/read', { handoff_id: event.subject_id });
    log({ did: 'woke on result', handoff_id: event.subject_id, taken_by: read.handoff.taken_by, summary: read.handoff.summary });
    if (args['on-finished']) await run(args['on-finished'], read.handoff);
    return;
  }
  const command = handlers.get(event.type);
  if (!command) return log({ did: 'no command for this type', type: event.type, subject_id: event.subject_id });
  const done = await run(command, event);
  log({ did: 'ran', type: event.type, subject_id: event.subject_id, ok: done.code === 0, output: done.out.slice(0, 200) });
  let reply = null;
  try { reply = JSON.parse(done.out.split('\n').at(-1)).reply ?? null; } catch { reply = null; }
  if (!reply || !event.from_agent) return;
  const sent = await call('/agents/events', { type: reply.type, to_agent: event.from_agent, from_agent: agentId, idempotency_key: `${event.event_id}:reply`, subject_id: event.subject_id, summary: reply.summary, refs: reply.refs });
  log({ did: 'replied', type: reply.type, subject_id: event.subject_id, event_id: sent.event.event_id });
}

createServer((request, response) => {
  let body = '';
  request.on('data', chunk => { body += chunk; if (body.length > 100_000) request.destroy(); });
  request.on('end', () => {
    if (request.method !== 'POST' || !deliveryHolds(secret, request.headers['trillion-signature'], body)) {
      log({ did: 'refused', reason: 'signature' });
      response.writeHead(401).end();
      return;
    }
    const eventId = request.headers['trillion-event-id'];
    if (failFirst > 0) {
      failFirst -= 1;
      log({ did: 'answered 503 on purpose', event_id: eventId });
      response.writeHead(503).end();
      return;
    }
    try {
      const event = JSON.parse(body);
      if (!eventId || event.event_id !== eventId || event.to_agent !== agentId) throw new Error('Event identity or recipient does not match.');
      const previous = inbox.read(eventId);
      inbox.accept(eventId, event);
      response.writeHead(202).end();
      if (previous?.state === 'done') return log({ did: 'already handled', event_id: eventId });
      log({ did: previous ? 'already received' : 'received', event_id: eventId, type: event.type, subject_id: event.subject_id, handoff_id: event.refs?.handoff_id, summary: event.summary });
      processEvent(eventId);
    } catch (error) {
      log({ did: 'refused', reason: error.message });
      response.writeHead(503).end();
    }
  });
}).listen(Number(need('port')), '127.0.0.1', () => log({ did: 'listening', port: Number(args.port) }));

void replayPending();
