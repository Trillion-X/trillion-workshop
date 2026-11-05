// Ported from old trillion test/instant-wake.test.mjs (tag old-trillion-before-worker-retire, b6ae0ebf81), deleted by
// Trillion-X/trillion #243. makeAgents, agent-delivery and the agent test store are tools/shared-code's; live-screen and
// the Workshop are this tool's src/. The held workshop-tasks-for-tests taskQuestions is stood in below (taskCards
// answers none: no test here lists run cards). Left out: the last test, which read the retired src/person-store.mjs
// source for the methods it called on its event rules and agents; there is no person store left to call them (searched
// the three repos for person-store.mjs: only held copies and comments). Every other assertion is the old one.
// test/instant-wake.test.mjs
// The stream route (src/agent-delivery.mjs): an agent on a computer the internet cannot reach is sent each event down
// the live socket its helper holds, answers delivered or dead after one retry, and is described truthfully to the
// sender. Also: priority and the per-agent queue bound, initialize pickup of named work, the Workshop's answer road for
// runs on the caller's own computer, and the guard that every store call into an owner names a function it has.

import test from 'node:test';
import assert from 'node:assert/strict';
import { makeAgents } from '../../shared-code/src/agents.mjs';
import { agentStoreForTests } from '../../shared-code/test/agent-store-for-tests.mjs';
import { deliverDue, reachabilityOf, routeOf, STREAM_FRESH_SECONDS } from '../../shared-code/src/agent-delivery.mjs';
import { liveScreen } from '../src/live-screen.mjs';
import { makeWorkshop, readToolData } from '../src/workshop.mjs';

// The store's task questions over a test's list of current tasks (old test/workshop-tasks-for-tests.mjs taskQuestions,
// held in tools/keep-each-workshop-task-whole-and-a-small-index): what is due, when next, a tool's last completed run.
const scheduled = task => task.state === 'scheduled' && Number.isFinite(Date.parse(task.due_at));
const taskQuestions = current => ({
  dueTasks: async atMs => (await current()).filter(task => scheduled(task) && Date.parse(task.due_at) <= atMs).sort((a, b) => Date.parse(a.due_at) - Date.parse(b.due_at)),
  nextDueAt: async () => { const times = (await current()).filter(scheduled).map(task => Date.parse(task.due_at)); return times.length ? Math.min(...times) : null; },
  lastCompleted: async toolId => (await current()).filter(task => task.tool_id === toolId && task.state === 'completed').at(-1) ?? null,
  taskCards: async () => [],
});

function clock(start = '2026-09-30T08:00:00Z') {
  let time = new Date(start).getTime();
  return { now: () => new Date(time), advance: seconds => { time += seconds * 1000; } };
}

// A stand-in for the store's live socket: what was sent down each agent's stream, and whether one is listening.
function fakeStream(listening = new Set()) {
  const sent = [];
  return { sent, listening, send: (agent_id, event) => { sent.push({ agent_id, event }); return listening.has(agent_id); }, live: agent_id => listening.has(agent_id) };
}

function withStream(time, stream = fakeStream(new Set(['codex-session']))) {
  const store = agentStoreForTests();
  const agents = makeAgents({ store, stream, now: time.now });
  agents.publish({ agent_id: 'codex-session', name: 'Codex', description: 'one Codex session on this Mac', source_id: 'codex:session-1', delivery: { stream: true } });
  agents.publish({ agent_id: 'web-chat', name: 'ChatGPT', description: 'ChatGPT on the web' });
  return { store, agents, stream };
}

const message = (to_agent, key = 'message:one') => ({ type: 'message.created', to_agent, idempotency_key: key, subject_id: key, summary: 'New message from you in Codex.', refs: { message_id: key }, next_call: { tool: 'read_messages', arguments: { conversation_id: 'codex:session-1' } } });

test('a stream agent is published with no address, a secret of its own to attest its answers, and its route is stream', () => {
  const time = clock();
  const { agents, store } = withStream(time);
  const card = store.card('codex-session');
  assert.deepEqual(card.delivery, { stream: true, since: '2026-09-30T08:00:00.000Z' });
  // The socket itself uses the account's sign-in; the secret lets the helper attest that an answer is in its transcript.
  assert.match(store.deliverySecret('codex-session') ?? '', /^[0-9a-f]{64}$/);
  assert.equal(routeOf(card), 'stream');
  assert.equal(routeOf(store.card('web-chat')), 'next_connection');
  assert.equal(routeOf({ delivery: { url: 'https://x.example/in' } }), 'push');
  assert.throws(() => agents.publish({ agent_id: 'x', name: 'x', description: 'x', delivery: { stream: 'yes' } }), /stream: true/);
});

test('an event for a stream agent is sent down its socket at once, is never posted, and waits for the helper to answer', async () => {
  const time = clock();
  const { agents, store, stream } = withStream(time);
  const sent = agents.sendEvent(message('codex-session'));
  assert.equal(sent.receiver.route, 'stream');
  assert.equal(sent.receiver.live, true);
  assert.equal(stream.sent.length, 1);
  assert.equal(stream.sent[0].event.type, 'message.created');
  assert.equal(stream.sent[0].event.refs.message_id, 'message:one');
  assert.equal(store.delivery(sent.event.event_id).next_at, null, 'no send time: the rail never posts it');
  const posted = [];
  await deliverDue({ store, send: async (...args) => { posted.push(args); return { ok: true, status: 200 }; }, now: time.now });
  assert.equal(posted.length, 0);
  assert.equal(store.delivery(sent.event.event_id).state, 'waiting');
});

test('what arrived while the helper was away is pulled when it connects, oldest first, and only for stream agents', () => {
  const time = clock();
  const { agents } = withStream(time, fakeStream(new Set()));
  const away = agents.sendEvent(message('codex-session', 'message:a'));
  assert.equal(away.receiver.live, false, 'no socket answers, so the sender is told it is away');
  time.advance(1);
  agents.sendEvent(message('codex-session', 'message:b'));
  const pulled = agents.pull({ agent_ids: ['codex-session'] }).events;
  assert.deepEqual(pulled.map(event => event.refs.message_id), ['message:a', 'message:b']);
  assert.throws(() => agents.pull({ agent_ids: ['web-chat'] }), /not on the stream route/);
  assert.throws(() => agents.pull({ agent_ids: [] }), /1 to 10/);
});

test('ack delivered ends the event; ack failed after the retry is a dead letter, sent again when the agent is present', () => {
  const time = clock();
  const { agents, store, stream } = withStream(time);
  const one = agents.sendEvent(message('codex-session', 'message:one')).event;
  const two = agents.sendEvent(message('codex-session', 'message:two')).event;
  assert.equal(agents.ack({ event_id: one.event_id, agent_id: 'codex-session', ok: true, attempts: 1 }).delivery.state, 'delivered');
  assert.equal(agents.ack({ event_id: one.event_id, agent_id: 'codex-session', ok: true }).repeated, true, 'a repeated ack changes nothing');
  const dead = agents.ack({ event_id: two.event_id, agent_id: 'codex-session', ok: false, attempts: 2, error: 'codex exited 1 twice' });
  assert.equal(dead.delivery.state, 'dead');
  assert.equal(store.delivery(two.event_id).last_error, 'codex exited 1 twice');
  assert.equal(store.delivery(two.event_id).attempts, 2);
  assert.deepEqual(agents.pull({ agent_ids: ['codex-session'] }).events, [], 'nothing waits any more');
  assert.equal(store.card('codex-session').delivered, 1);
  stream.sent.length = 0;
  agents.presence({ agent_id: 'codex-session' });
  assert.equal(store.delivery(two.event_id).state, 'waiting');
  assert.equal(store.delivery(two.event_id).next_at, null);
  assert.deepEqual(stream.sent.map(item => item.event.event_id), [two.event_id], 'the dead letter is sent down the stream again');
  assert.throws(() => agents.ack({ event_id: two.event_id, agent_id: 'web-chat', ok: true }), /No event/);
  assert.throws(() => agents.ack({ event_id: two.event_id, agent_id: 'codex-session' }), /ok is true/);
});

test('an agent with no route is sent nothing and the sender learns it reads its work when it next connects', () => {
  const time = clock();
  const { agents, stream } = withStream(time);
  const sent = agents.sendEvent(message('web-chat'));
  assert.equal(sent.event, null);
  assert.deepEqual({ route: sent.receiver.route, live: sent.receiver.live }, { route: 'next_connection', live: false });
  assert.equal(stream.sent.length, 0);
});

test('a stream is live only while its socket answers', () => {
  const agent = { delivery: { stream: true } };
  assert.equal(reachabilityOf(agent, new Date(), true).live, true);
  assert.equal(reachabilityOf(agent, new Date(), false).live, false);
  assert.equal(STREAM_FRESH_SECONDS, 90);
});

test('the stream carries at most 10 agents, only those on the stream route', () => {
  const time = clock();
  const { agents } = withStream(time);
  for (let index = 0; index < 12; index += 1) agents.publish({ agent_id: `s${index}`, name: `s${index}`, description: 'x', delivery: { stream: true } });
  assert.deepEqual(agents.streamHosts(['codex-session', 'web-chat', 'nobody']), ['codex-session']);
  assert.equal(agents.streamHosts(Array.from({ length: 12 }, (_, index) => `s${index}`)).length, 10);
});

test('higher priority is taken first, equal priorities keep their order, and one named agent holds at most 50 waiting jobs', () => {
  const time = clock();
  const { agents } = withStream(time);
  agents.handOff({ job: 'low', request_key: 'r1' });
  time.advance(1);
  agents.handOff({ job: 'urgent', request_key: 'r2', priority: 9 });
  time.advance(1);
  agents.handOff({ job: 'also low', request_key: 'r3' });
  assert.throws(() => agents.handOff({ job: 'x', request_key: 'r4', priority: 10 }), /0 to 9/);
  assert.equal(agents.take({ agent_id: 'codex-session' }).handoff.job, 'urgent');
  assert.equal(agents.take({ agent_id: 'codex-session' }).handoff.job, 'low');
  for (let index = 0; index < 50; index += 1) agents.handOff({ job: `for codex ${index}`, request_key: `n${index}`, to_agent: 'codex-session' });
  assert.throws(() => agents.handOff({ job: 'one more', request_key: 'n50', to_agent: 'codex-session' }), /already has 50 jobs waiting/);
  for (let index = 0; index < 5; index += 1) agents.handOff({ job: `foreground ${index}`, request_key: `foreground${index}`, to_agent: 'codex-session', priority: 6 });
  assert.throws(() => agents.handOff({ job: 'sixth foreground', request_key: 'foreground5', to_agent: 'codex-session', priority: 6 }), /already has 55 jobs waiting/);
  assert.equal(agents.handOff({ job: 'for codex 0', request_key: 'n0', to_agent: 'codex-session' }).repeated, true, 'a repeat is still answered at the bound');
});

test('work handed to an agent by name waits for it when it next connects (initialize pickup), highest priority first', () => {
  const time = clock();
  const { agents } = withStream(time);
  agents.publish({ agent_id: 'web-chat', name: 'ChatGPT', description: 'ChatGPT on the web' }, { reader: 'reader:chatgpt' });
  agents.handOff({ job: 'later', request_key: 'p1', to_agent: 'web-chat' });
  time.advance(1);
  agents.handOff({ job: 'first', request_key: 'p2', to_agent: 'web-chat', priority: 5 });
  assert.deepEqual(agents.pendingForReader('reader:chatgpt').map(item => item.title), ['first', 'later']);
});

test('a run of a tool that lives on the caller\'s computer is told to every agent that runs that placement', () => {
  const time = clock();
  const { agents, stream } = withStream(time);
  agents.publish({ agent_id: 'mac-helper', name: 'Mac helper', description: 'runs tools on this Mac', delivery: { stream: true }, runs: ['placement:caller-sandbox'] });
  const told = agents.tellRunners({ placement: 'placement:caller-sandbox', type: 'tool.run.requested', key: 'task:1', subject_id: 'task:1', summary: 'Run a tool here.', refs: { task_id: 'task:1', tool_id: 'tool:x' }, next_call: { tool: 'read_task', arguments: { task_id: 'task:1' } } });
  assert.equal(told.told, 1);
  assert.deepEqual(stream.sent.map(item => [item.agent_id, item.event.type, item.event.refs.task_id]), [['mac-helper', 'tool.run.requested', 'task:1']]);
  assert.equal(agents.tellRunners({ placement: 'placement:nowhere', type: 'tool.run.requested', key: 'task:2', subject_id: 'task:2' }).told, 0);
});

test('the store end of a helper stream is tagged per agent, is sent that agent\'s events, and is live only while pings are fresh', () => {
  const sockets = [];
  const pinged = new Map();
  const make = () => ({ sentValues: [], send(value) { this.sentValues.push(value); }, serializeAttachment(value) { this.attachment = value; }, deserializeAttachment() { return this.attachment; } });
  const saved = { WebSocketPair: globalThis.WebSocketPair, Response: globalThis.Response };
  globalThis.WebSocketPair = class { constructor() { return { 0: make(), 1: make() }; } };
  globalThis.Response = class { constructor(body, init) { this.status = init?.status; this.webSocket = init?.webSocket; } };
  const ctx = {
    acceptWebSocket: (socket, tags) => sockets.push({ socket, tags }),
    getWebSockets: tag => sockets.filter(item => item.tags.includes(tag)).map(item => item.socket),
    getWebSocketAutoResponseTimestamp: socket => pinged.get(socket) ?? null,
    setWebSocketAutoResponse: () => {},
  };
  const sql = { exec: () => ({ one: () => ({ n: 0 }), toArray: () => [] }) };
  try {
    const live = liveScreen(ctx, sql);
    assert.equal(live.openStream(['codex-session']).status, 101);
    assert.deepEqual(sockets[0].tags, ['agent:codex-session']);
    assert.deepEqual(JSON.parse(sockets[0].socket.sentValues[0]), { hosted: ['codex-session'] });
    assert.equal(live.sendTo('codex-session', { event: { event_id: 'e1' } }), true);
    assert.equal(live.sendTo('someone-else', { event: {} }), false);
    const opened = sockets[0].socket.attachment.opened_at;
    assert.equal(live.listening('codex-session', opened + 60_000), true);
    assert.equal(live.listening('codex-session', opened + 120_000), false, 'silent for two minutes: not listening');
    pinged.set(sockets[0].socket, new Date(opened + 100_000));
    assert.equal(live.listening('codex-session', opened + 120_000), true, 'a recent ping keeps it live');
  } finally {
    globalThis.WebSocketPair = saved.WebSocketPair;
    globalThis.Response = saved.Response;
  }
});

test('a run handed to the caller\'s computer is announced, and its answer is checked like any run', async () => {
  const facts = [];
  const latest = prefix => { const map = new Map(); for (const [entity, value] of facts) if (entity.startsWith(prefix)) map.set(entity, value); return [...map.values()]; };
  const handed = [];
  const payloads = [
    { kind: 'tool-placement', id: 'placement:caller-sandbox', label: 'Your computer', executor: 'caller', reachable_from: ['hosted'] },
    { kind: 'tool-licence-class', id: 'licence:mine', label: 'Mine', licences: ['NONE'], allowed_placements: ['placement:caller-sandbox'] },
    { kind: 'ai-tool-descriptor', id: 'tool:here', label: 'Here', job: 'Count moved files on this computer', input_schema: { type: 'object', required: ['moves'], properties: { moves: { type: 'array' } } }, output_schema: { type: 'object', required: ['changed'], properties: { changed: { type: 'number' } } }, invoke: { kind: 'container', argv: ['node', 'x.mjs', { from: 'moves' }], stdout: 'json' }, result_selector: '$.result', licence_class: 'licence:mine', placements: ['placement:caller-sandbox'] },
  ];
  const workshop = makeWorkshop({
    host: 'hosted', handedToCaller: task => handed.push(task),
    data: async () => readToolData(payloads.map(payload => ({ payload }))),
    store: {
      readTask: async id => latest(`task:${id}`).at(-1) ?? null,
      writeTask: async task => { facts.push([`task:${task.task_id}`, structuredClone(task)]); },
      ...taskQuestions(async () => latest('task:')), readSavedTools: async () => [], writeSavedTool: async () => {},
      putBytes: async () => {}, readBytes: async () => null, readEffect: async () => null, writeEffect: async () => {},
    },
    pool: { recordRun: async () => {}, recordReport: async () => {}, stats: async ids => Object.fromEntries(ids.map(id => [id, { runs: 0, contract_passed: 0, reported_met: 0, reported_failed: 0 }])) },
    executors: { caller: async () => null },
    fetchBytes: async () => new Response(new Uint8Array()),
  });
  const run = await workshop.run({ tool_id: 'tool:here', input: { moves: [{ from: '/a', to: '/b' }] }, request_key: 'k1' });
  assert.equal(run.state, 'for_you_to_run');
  assert.deepEqual(run.input, { moves: [{ from: '/a', to: '/b' }] });
  assert.equal(run.placement, 'placement:caller-sandbox');
  assert.equal(handed.length, 1);
  assert.equal(handed[0].task_id, run.task_id);
  const done = await workshop.answer({ task_id: run.task_id, raw: { stdout: '{"changed":2}\n', stderr: '', exit_code: 0, result: { changed: 2 } } });
  assert.equal(done.state, 'completed');
  assert.deepEqual(done.output, { changed: 2 });
  assert.equal(done.contract.passed, true);
  assert.equal((await workshop.answer({ task_id: run.task_id, raw: { result: { changed: 3 } } })).repeated, true);
  const second = await workshop.run({ tool_id: 'tool:here', input: { moves: [] }, request_key: 'k2' });
  assert.equal((await workshop.answer({ task_id: second.task_id, error: 'node exited 1' })).state, 'failed');
  await assert.rejects(workshop.answer({ task_id: 'task:none', raw: {} }), /no run/);
});

// The live error "this.eventRules(...).nextPoll is not a function" came from a Worker built from a tree where the store
// called a method its owner did not have. Every `this.<owner>().<method>` the store calls must be a function there.
