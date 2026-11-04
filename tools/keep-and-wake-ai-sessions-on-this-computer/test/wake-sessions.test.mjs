// test/wake-sessions.test.mjs
// harness/wake-sessions.mjs with its handler modules, against a stand-in Trillion: a message for a hosted session
// starts that exact session through its harness row and is answered delivered; addressed work wakes its exact session
// even when its source turn failed there; a wake that fails twice is answered failed (a dead letter); a stream socket pulls what waited; and a
// run of a tool that lives on this computer is run from the tool's own files and answered on the run's road.

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { tarGz } from '../src/tar-gz.mjs';
import { fingerprintOf } from '../harness/wake-handlers/tool-reach.mjs';
import { chooseAi, loadHandlers, makeHelper, registerSession, run, settings, watchConnection } from '../harness/wake-sessions.mjs';

test('work addressed to the computer taker reaches its event handler', async () => {
  const handler = (await loadHandlers()).find(item => item.path === './wake-handlers/take-open-work.mjs');
  const event = { type: 'handoff.created', to_agent: 'take-open-work-sample-laptop', refs: {} };
  assert.equal(handler.wants({ event, helper: null, taker: { agent_id: event.to_agent } }), true);
  assert.equal(handler.wants({ event, helper: null, taker: null }), false);
});

function world() {
  const folder = mkdtempSync(join(tmpdir(), 'wake-sessions-'));
  const rules = { ...settings, folder, reconnect_seconds: [0.01] };
  const calls = [];
  const answers = {};
  const fetchImpl = async (url, init = {}) => {
    const path = new URL(url).pathname.replace('/mcp/api', '') + new URL(url).search;
    const body = init.body ? JSON.parse(init.body) : null;
    calls.push({ path, body });
    const pick = Object.entries(answers).find(([prefix]) => path.startsWith(prefix));
    const value = pick ? await pick[1](body, path) : {};
    return new Response(JSON.stringify(value), { status: 200 });
  };
  return { folder, rules, calls, answers, fetchImpl, done: () => rmSync(folder, { recursive: true, force: true }) };
}

const messageEvent = to_agent => ({ event_id: 'ev_message1', type: 'message.created', to_agent, subject_id: 'message:1', refs: { message_id: 'message:1' }, next_call: { tool: 'read_messages', arguments: { conversation_id: 'codex:0199aaaa-bbbb' } } });

test('a message for a hosted session starts that exact session with the wrapped words, and is answered delivered once', async () => {
  const w = world();
  try {
    const hosted = registerSession({ harness: 'codex', session_id: '0199aaaa-bbbb', cwd: w.folder }, w.rules);
    assert.equal(hosted.agent_id, 'session-codex-0199aaaa-bbbb');
    assert.equal(hosted.source_id, 'codex:0199aaaa-bbbb');
    w.answers['/messages?'] = () => ({ messages: [{ id: 'message:1', text: 'What is 2+2?', speaker: 'person', about: [{ kind: 'decision', id: 'source:one' }] }] });
    const ran = [];
    const runImpl = async (argv, options) => { ran.push({ argv, options }); return { code: 0, stdout: '4', stderr: '' }; };
    const helper = makeHelper({ rules: w.rules, key: 'k', fetchImpl: w.fetchImpl, handlers: await loadHandlers(w.rules), runImpl, log: () => {} });
    const first = await helper.handle(messageEvent(hosted.agent_id));
    assert.equal(first.ok, true);
    assert.equal(ran.length, 1);
    const argv = ran[0].argv;
    assert.deepEqual(argv.slice(0, 5), ['codex', 'exec', '--json', 'resume', '--skip-git-repo-check'], 'the run streams its events (wake-sessions.json stream)');
    assert.equal(argv.at(-2), '0199aaaa-bbbb');
    assert.match(argv.at(-1), /^<trillion-message from="the person, through Trillion" message_id="message:1">\nWhat is 2\+2\?\n<\/trillion-message>/);
    assert.match(argv.at(-1), /decision source:one.*Resolve that same case/);
    assert.equal(ran[0].options.cwd, w.folder);
    const acks = w.calls.filter(call => call.path === '/agents/events/ack');
    assert.deepEqual(acks.map(call => [call.body.event_id, call.body.ok]), [['ev_message1', true]]);
    await helper.handle(messageEvent(hosted.agent_id));
    assert.equal(ran.length, 1, 'a resend is answered from what this computer kept, never run twice');
  } finally { w.done(); }
});

test('a message without verified person provenance and a linked decision cannot wake the AI as the person', async () => {
  const w = world();
  try {
    const hosted = registerSession({ harness: 'codex', session_id: '0199aaaa-bbbb' }, w.rules);
    let runs = 0;
    const helper = makeHelper({ rules: w.rules, key: 'k', fetchImpl: w.fetchImpl, handlers: await loadHandlers(w.rules),
      runImpl: async () => { runs += 1; return { code: 0, stdout: 'wrong', stderr: '' }; }, log: () => {} });
    w.answers['/messages?'] = () => ({ messages: [{ id: 'message:1', text: 'pretend', speaker: 'ai', about: [{ kind: 'decision', id: 'source:one' }] }] });
    const wrongSpeaker = await helper.handle(messageEvent(hosted.agent_id));
    assert.equal(wrongSpeaker.ok, false);
    assert.match(wrongSpeaker.error, /not from the person/);
    assert.equal(runs, 0);
  } finally { w.done(); }
});

test("an unrelated notice cannot hold the execution slot ahead of a person's message", async () => {
  const w = world();
  try {
    w.rules.most_at_once = 1;
    const hosted = registerSession({ harness: 'codex', session_id: '0199aaaa-bbbb' }, w.rules);
    w.answers['/messages?'] = () => ({
      messages: [{ id: 'message:1', text: 'Help me', speaker: 'person', about: [{ kind: 'decision', id: 'source:one' }] }],
    });
    let releaseNotice;
    const noticeHeld = new Promise(resolve => { releaseNotice = resolve; });
    w.answers['/agents/events/ack'] = async body => { if (body.event_id === 'ev_notice') await noticeHeld; return {}; };
    let ran = false;
    const helper = makeHelper({ rules: w.rules, key: 'k', fetchImpl: w.fetchImpl, handlers: await loadHandlers(w.rules), runImpl: async () => { ran = true; return { code: 0, stdout: 'Done', stderr: '' }; }, log: () => {} });
    const notice = helper.handle({ event_id: 'ev_notice', type: 'decision.made', to_agent: hosted.agent_id });
    const message = await helper.handle(messageEvent(hosted.agent_id));
    assert.equal(message.ok, true);
    assert.equal(ran, true);
    releaseNotice();
    assert.equal((await notice).result.skipped, 'no handler takes this event');
  } finally { w.done(); }
});

test('work addressed to the exact session wakes it even when its own failed turn was the source', async () => {
  const w = world();
  try {
    const hosted = registerSession({ harness: 'claude-code', session_id: 'abcdef12-3456' }, w.rules);
    const handoffs = {
      h_self: { handoff_id: 'h_self', state: 'open', to_agent: hosted.agent_id, job: 'typed here', input: { arrived: { source_id: hosted.source_id } } },
      h_other: { handoff_id: 'h_other', state: 'open', to_agent: hosted.agent_id, job: 'check the build', input: {} },
    };
    w.answers['/handoffs/read'] = body => ({ handoff: handoffs[body.handoff_id] });
    const ran = [];
    const helper = makeHelper({ rules: w.rules, key: 'k', fetchImpl: w.fetchImpl, handlers: await loadHandlers(w.rules), runImpl: async argv => {
      ran.push(argv);
      const handoff = ran.length === 1 ? handoffs.h_self : handoffs.h_other;
      handoff.state = 'taken'; handoff.taken_by = hosted.agent_id;
      return { code: 0, stdout: 'done', stderr: '' };
    }, log: () => {} });
    const self = await helper.handle({ event_id: 'ev_self', type: 'handoff.created', to_agent: hosted.agent_id, refs: { handoff_id: 'h_self', handed_to: hosted.agent_id } });
    assert.equal(self.ok, true);
    await helper.handle({ event_id: 'ev_other', type: 'handoff.created', to_agent: hosted.agent_id, refs: { handoff_id: 'h_other', handed_to: hosted.agent_id } });
    assert.equal(ran.length, 2);
    assert.deepEqual(ran[0].slice(0, 7), ['claude', '--output-format', 'stream-json', '--verbose', '--resume', 'abcdef12-3456', '--mcp-config']);
    const [first, second] = ran.map(argv => argv.slice(4));
    assert.match(JSON.parse(first[3]).mcpServers.trillion.args[0], /keychain-mcp-bridge\.mjs$/);
    assert.equal(first[4], '--append-system-prompt');
    assert.match(first[5], /call take_work first/);
    assert.match(first[7], /take_work with exactly \{"agent_id":"session-claude-code-abcdef12-3456","handoff_id":"h_self"\}/);
    assert.match(second[7], /take_work with exactly \{"agent_id":"session-claude-code-abcdef12-3456","handoff_id":"h_other"\}/);
    assert.doesNotMatch(first[7], /typed here/, 'the returned job is read after the owner claim');
  } finally { w.done(); }
});

test('a model reply without taking the addressed handoff is failed, so delivery can recover', async () => {
  const w = world();
  try {
    w.rules.retries = 0;
    const hosted = registerSession({ harness: 'claude-code', session_id: 'abcdef12-3456' }, w.rules);
    w.answers['/handoffs/read'] = () => ({ handoff: { handoff_id: 'h_open', state: 'open', to_agent: hosted.agent_id, job: 'Finish the source request' } });
    const helper = makeHelper({ rules: w.rules, key: 'k', fetchImpl: w.fetchImpl, handlers: await loadHandlers(w.rules), runImpl: async () => ({ code: 0, stdout: 'No response requested.', stderr: '' }), log: () => {} });
    const outcome = await helper.handle({ event_id: 'ev_open', type: 'handoff.created', to_agent: hosted.agent_id, refs: { handoff_id: 'h_open', handed_to: hosted.agent_id } });
    assert.equal(outcome.ok, false);
    assert.match(outcome.error, /returned without taking handoff h_open/);
    assert.equal(w.calls.find(call => call.path === '/agents/events/ack').body.ok, false);
  } finally { w.done(); }
});

test('a wake that fails is tried once more, then answered failed with the error (a dead letter)', async () => {
  const w = world();
  try {
    const hosted = registerSession({ harness: 'codex', session_id: '0199aaaa-bbbb' }, w.rules);
    w.answers['/messages?'] = () => ({ messages: [{ id: 'message:1', text: 'hi', speaker: 'person', about: [{ kind: 'decision', id: 'source:one' }] }] });
    let tries = 0;
    const helper = makeHelper({ rules: w.rules, key: 'k', fetchImpl: w.fetchImpl, handlers: await loadHandlers(w.rules), runImpl: async () => { tries += 1; return { code: 1, stdout: '', stderr: 'no such session' }; }, log: () => {} });
    const outcome = await helper.handle(messageEvent(hosted.agent_id));
    assert.equal(tries, 2);
    assert.equal(outcome.ok, false);
    const ack = w.calls.find(call => call.path === '/agents/events/ack').body;
    assert.deepEqual({ ok: ack.ok, attempts: ack.attempts }, { ok: false, attempts: 2 });
    assert.match(ack.error, /Codex exited 1: no such session/);
  } finally { w.done(); }
});

test('a failed Claude wake reports the API failure after a connector warning', async () => {
  const w = world();
  try {
    w.rules.retries = 0;
    const hosted = registerSession({ harness: 'claude-code', session_id: 'abcdef12-3456' }, w.rules);
    w.answers['/handoffs/read'] = () => ({ handoff: { handoff_id: 'h_rate', state: 'open', to_agent: hosted.agent_id, job: 'Finish the source request' } });
    const helper = makeHelper({ rules: w.rules, key: 'k', fetchImpl: w.fetchImpl, handlers: await loadHandlers(w.rules),
      runImpl: async () => ({ code: 1, stderr: 'connectors are disabled', stdout: 'API Error: Request rejected (429)' }), log: () => {} });
    const outcome = await helper.handle({ event_id: 'ev_rate', type: 'handoff.created', to_agent: hosted.agent_id, refs: { handoff_id: 'h_rate', handed_to: hosted.agent_id } });
    assert.equal(outcome.ok, false);
    assert.match(outcome.error, /connectors are disabled/);
    assert.match(outcome.error, /Request rejected \(429\)/);
  } finally { w.done(); }
});

test('the stream socket names the agents it carries, pings, and pulls what waited when it opens', async () => {
  const w = world();
  try {
    chooseAi('codex', w.rules);
    const hosted = registerSession({ harness: 'codex', session_id: '0199aaaa-bbbb' }, w.rules);
    w.answers['/agents/events/pull'] = () => ({ events: [] });
    const opened = [];
    let replayed = 0;
    class FakeSocket extends EventTarget {
      constructor(url, init) { super(); this.url = url; this.init = init; this.sent = []; opened.push(this); queueMicrotask(() => this.dispatchEvent(new Event('open'))); }
      send(value) { this.sent.push(value); }
      close() { this.dispatchEvent(new Event('close')); }
    }
    const helper = makeHelper({ rules: w.rules, key: 'secret-key', fetchImpl: w.fetchImpl, WebSocketImpl: FakeSocket, handlers: [], log: () => {}, host: 'Test Mac', replaySourceReturns: () => { replayed += 1; } });
    const ids = await helper.publishAll();
    assert.equal(ids[0], 'computer-test-mac');
    assert.match(ids[1], /^take-open-work-/);
    assert.equal(ids[2], hosted.agent_id);
    const published = w.calls.filter(call => call.path === '/agents/publish').map(call => call.body);
    assert.deepEqual(published[0].runs, settings.helper_agent.runs);
    assert.ok(published[0].runs.includes('placement:caller-sandbox'));
    assert.deepEqual(published[0].delivery, { stream: true });
    assert.equal(published[1].takes_work, true);
    assert.deepEqual(published[1].delivery, { stream: true });
    assert.equal(published[2].source_id, 'codex:0199aaaa-bbbb');
    helper.connectAll(ids);
    await new Promise(resolve => setTimeout(resolve, 10));
    assert.equal(opened[0].url, `wss://app.gettrillion.ai/mcp/api/live?agent=computer-test-mac&agent=${ids[1]}&agent=${hosted.agent_id}`);
    assert.equal(opened[0].init.headers.authorization, 'Bearer secret-key');
    assert.deepEqual(w.calls.find(call => call.path === '/agents/events/pull').body, { agent_ids: ids });
    assert.equal(replayed, 1);
    helper.stop();
  } finally { w.done(); }
});

test('before choosing an AI, the computer and exact chats still connect without a work taker', async () => {
  const w = world();
  try {
    const hosted = registerSession({ harness: 'codex', session_id: '0199cccc-dddd' }, w.rules);
    const helper = makeHelper({ rules: w.rules, key: 'k', fetchImpl: w.fetchImpl, handlers: [], log: () => {}, host: 'Test Mac' });
    assert.deepEqual(await helper.publishAll(), ['computer-test-mac', hosted.agent_id]);
    assert.ok(w.calls.filter(call => call.path === '/agents/publish').every(call => !call.body.takes_work));
  } finally { w.done(); }
});

test('a run of a tool that lives on this computer is run from its own files and answered on the run\'s road', async () => {
  const w = world();
  try {
    const script = "const args = new Map(); for (let at = 2; at < process.argv.length; at += 2) args.set(process.argv[at].replace(/^--/, ''), process.argv[at + 1]);\nconst moves = JSON.parse(args.get('moves'));\nconsole.log('working');\nconsole.log(JSON.stringify({ changed: moves.length, projects: args.get('projects') ?? null }));\n";
    const archive = tarGz([{name: 'do-work/move.mjs', bytes: new TextEncoder().encode(script)}]);
    const fingerprint = fingerprintOf(archive);
    const descriptor = {id: 'tool:here', needs: {expected_seconds: 5}, invoke: {kind: 'container', files: fingerprint,
      stdout: 'json', argv: [process.execPath, 'do-work/move.mjs', '--moves', {from: 'moves'}, '--projects', {from: 'projects', optional: true}]}};
    w.answers['/tasks/task_1/claim'] = () => ({claimed: true, state: 'for_you_to_run', descriptor, made_by: 'shared', bytes_base64: Buffer.from(archive).toString('base64')});
    w.answers['/tasks/task_1/answer'] = body => ({ state: 'completed', contract: { passed: true }, got: body });
    w.answers['/tasks/task_1'] = () => ({ task_id: 'task_1', tool_id: 'tool:here', state: 'for_you_to_run', placement: 'placement:caller-sandbox', input: { moves: [{ from: '/a', to: '/b' }] } });
    const helper = makeHelper({ rules: w.rules, key: 'k', fetchImpl: w.fetchImpl, handlers: await loadHandlers(w.rules), runImpl: run, log: () => {}, host: 'Test Mac' });
    const outcome = await helper.handle({ event_id: 'ev_tool', type: 'tool.run.requested', to_agent: 'computer-test-mac', refs: { task_id: 'task_1', tool_id: 'tool:here' } });
    assert.equal(outcome.ok, true, JSON.stringify(outcome));
    assert.ok(w.calls.findIndex(call => call.path === '/tasks/task_1/claim') < w.calls.findIndex(call => call.path === '/tasks/task_1/answer'), 'claimed before it ran and answered');
    const answered = w.calls.find(call => call.path === '/tasks/task_1/answer').body;
    assert.equal(answered.error, undefined, JSON.stringify(answered));
    assert.equal(w.calls.some(call => call.path === '/tools/describe'), false, 'execution uses the original claim and its exact saved archive');
    assert.deepEqual(answered.raw.result, { changed: 1, projects: null });
    assert.equal(answered.raw.exit_code, 0);
    assert.match(answered.raw.stdout, /^working\n/);
  } finally { w.done(); }
});

// The helper loads its handler modules while its own top-level await is still running, so a handler that imports the
// helper back (directly or through what it imports) waits on itself forever and the helper never starts.
test('no handler module imports the helper back, however deep', async () => {
  const { readFileSync } = await import('node:fs');
  const { dirname, resolve } = await import('node:path');
  const { fileURLToPath } = await import('node:url');
  const harness = resolve(dirname(fileURLToPath(import.meta.url)), '../harness');
  const helper = resolve(harness, 'wake-sessions.mjs');
  const seen = new Set();
  const walk = file => {
    if (seen.has(file)) return;
    seen.add(file);
    assert.notEqual(file, helper, `a handler reaches ${helper} through its imports`);
    for (const [, spec] of readFileSync(file, 'utf8').matchAll(/^\s*(?:import|export)\s[^'"]*?from\s+['"](\.{1,2}\/[^'"]+)['"]/gm)) walk(resolve(dirname(file), spec));
  };
  for (const path of settings.handlers) walk(resolve(harness, path));
  assert.ok(seen.size > settings.handlers.length);
});

test('an answer that says to send again is sent again after the wait it names; any other refusal is the answer', async () => {
  const w = world();
  try {
    let calls = 0;
    const waits = [];
    const fetchImpl = async () => { calls += 1; return calls < 3 ? new Response(JSON.stringify({ error: 'busy' }), { status: 503, headers: { 'retry-after': '0' } }) : new Response(JSON.stringify({ ok: true }), { status: 200 }); };
    const helper = makeHelper({ rules: w.rules, key: 'k', fetchImpl, wait: async seconds => { waits.push(seconds); }, handlers: [], log: () => {} });
    assert.deepEqual(await helper.call('/agents/publish', {}), { ok: true });
    assert.deepEqual(waits, [1, 2]);
    const refused = makeHelper({ rules: w.rules, key: 'k', fetchImpl: async () => new Response(JSON.stringify({ error: 'No such agent.' }), { status: 400 }), wait: async () => {}, handlers: [], log: () => {} });
    await assert.rejects(refused.call('/agents/events/ack', {}), /No such agent/);
  } finally { w.done(); }
});

test('an event that arrives again while it is being handled joins that run; a new session reopens the sockets without starting it twice', async () => {
  const w = world();
  try {
    const hosted = registerSession({ harness: 'codex', session_id: '0199aaaa-bbbb' }, w.rules);
    w.answers['/messages?'] = () => ({ messages: [{ id: 'message:1', text: 'hi', speaker: 'person', about: [{ kind: 'decision', id: 'source:one' }] }] });
    w.answers['/agents/events/pull'] = () => ({ events: [] });
    let runs = 0;
    let finish;
    const runImpl = () => { runs += 1; return new Promise(done => { finish = () => done({ code: 0, stdout: 'ok', stderr: '' }); }); };
    const opened = [];
    class FakeSocket extends EventTarget {
      constructor(url) { super(); this.url = url; opened.push(this); queueMicrotask(() => this.dispatchEvent(new Event('open'))); }
      send() {}
      close() { this.closed = true; this.dispatchEvent(new Event('close')); }
    }
    const helper = makeHelper({ rules: w.rules, key: 'k', fetchImpl: w.fetchImpl, WebSocketImpl: FakeSocket, handlers: await loadHandlers(w.rules), runImpl, log: () => {}, host: 'Test Mac' });
    helper.connectAll(await helper.publishAll());
    const first = helper.handle(messageEvent(hosted.agent_id));
    await new Promise(resolve => setTimeout(resolve, 20));
    registerSession({ harness: 'claude-code', session_id: 'abcdef12-3456' }, w.rules);
    await helper.refresh();
    const again = helper.handle(messageEvent(hosted.agent_id));
    assert.equal(again, first, 'the second arrival joins the run already going');
    finish();
    await first;
    assert.equal(runs, 1);
    assert.equal(opened[0].closed, true);
    assert.equal(opened.length, 2, 'the old connection closes and one new one opens, with no reconnect of the old one');
    assert.match(opened[1].url, /agent=session-claude-code-abcdef12-3456/);
    helper.stop();
  } finally { w.done(); }
});

test('the LaunchAgent that keeps the helper running starts it at login, restarts it, and finds the AI tools on the given PATH', async () => {
  const { launchAgentPlist, LAUNCH_LABEL } = await import('../harness/wake-sessions.mjs');
  const plist = launchAgentPlist({ node: '/opt/node', script: '/x/wake-sessions.mjs', path: '/a:/b&c', log: '/l/helper.log' });
  assert.match(plist, new RegExp(`<string>${LAUNCH_LABEL}</string>`));
  assert.match(plist, /<array><string>\/opt\/node<\/string><string>\/x\/wake-sessions\.mjs<\/string><\/array>/);
  assert.match(plist, /<key>PATH<\/key><string>\/a:\/b&amp;c<\/string>/);
  assert.match(plist, /<key>RunAtLoad<\/key><true\/>/);
  assert.match(plist, /<key>KeepAlive<\/key><true\/>/);
});

test('a woken session never inherits ANTHROPIC_API_KEY, which would turn off its claude.ai connectors', async () => {
  const before = process.env.ANTHROPIC_API_KEY;
  process.env.ANTHROPIC_API_KEY = 'inherited';
  try {
    const { code, stdout } = await run([process.execPath, '-e', 'process.stdout.write(String(process.env.ANTHROPIC_API_KEY) + "|" + Boolean(process.env.PATH))']);
    assert.equal(code, 0);
    assert.equal(stdout, 'undefined|true');
  } finally {
    if (before === undefined) delete process.env.ANTHROPIC_API_KEY; else process.env.ANTHROPIC_API_KEY = before;
  }
});

test('a handler that answers at once is never queued behind a long turn on the same agent', async () => {
  const w = world();
  try {
    w.rules.most_at_once = 1;
    let releaseSlow;
    const slowHeld = new Promise(resolve => { releaseSlow = resolve; });
    const handlers = [
      { path: 'slow', wants: ({ event }) => event.type === 'slow.work', handle: () => slowHeld },
      { path: 'button', answers_at_once: true, wants: ({ event }) => event.type === 'button.pressed', handle: () => ({ pressed: true }) },
    ];
    const helper = makeHelper({ rules: w.rules, key: 'k', fetchImpl: w.fetchImpl, handlers, log: () => {} });
    const agent = 'computer-test';
    const slow = helper.handle({ event_id: 'ev_slow', type: 'slow.work', to_agent: agent, subject_id: 's' });
    const pressed = await helper.handle({ event_id: 'ev_button', type: 'button.pressed', to_agent: agent, subject_id: 'b' });
    assert.deepEqual(pressed.result, { pressed: true }, 'answered while the slow turn still holds the only slot');
    releaseSlow({ done: true });
    assert.equal((await slow).ok, true);
  } finally { w.done(); }
});

test('a failed connection refresh is tried again on the next tick, and an order change across it is still handled', async () => {
  let state = JSON.stringify({ sessions: [], ai_order: ['ai-two'], taker_card: null });
  const refreshes = [];
  const orders = [];
  const failures = [];
  let failNext = true;
  const tick = watchConnection({
    read: () => state,
    refresh: async () => { refreshes.push(state); if (failNext) { failNext = false; throw new Error('store restarted'); } },
    onOrderChange: () => orders.push(state),
    log: error => failures.push(error.message),
  });
  state = JSON.stringify({ sessions: [], ai_order: ['ai-one'], taker_card: null });
  await tick();
  assert.deepEqual(failures, ['store restarted']);
  assert.equal(refreshes.length, 1);
  await tick();
  assert.equal(refreshes.length, 2, 'the next tick refreshes again, and does not throw');
  assert.deepEqual(orders, [state], 'the order changed across the failure is handled');
  await tick();
  assert.equal(refreshes.length, 2, 'a handled state is not refreshed again');
});
