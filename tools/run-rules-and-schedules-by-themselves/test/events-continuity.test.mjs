// The real event owner with in-memory provider/fact seams: durable admission, bounded wakes and recovery.
import test from 'node:test';
import assert from 'node:assert/strict';
import { makeEventRules, receiveEvents } from '../../keep-and-wake-ai-sessions-on-this-computer/src/events.mjs';
import { makeSourceHealth } from '../../shared-code/src/automation-health.mjs';
import looks from '../src/automation-health-looks.json' with { type: 'json' };

const source = {
  id: 'events:continuity-test', label: 'Continuity test inbox',
  events: [{ name: 'message', each: [{ field: 'messages', as: 'm' }], fields: { message_id: ['m', 'id'], text: ['m', 'body'] }, required: ['message_id'] }],
  route_key: 'account', event_id: 'message_id',
  route_key_proof: { tool_id: 'tool:identify', output_selector: '$.account' },
  poll: { tool_id: 'tool:read', every_minutes: 1, cursor: { input_field: 'after', start: { tool_id: 'tool:identify', output_selector: '$.cursor' }, next: { output_selector: '$.cursor' } } },
};

function fixture({ row = source, beforeWrite = () => {}, readFact = null, routeBook = null, start = null, subscribe = 'completed', runTask = null, readTask = null } = {}) {
  const kept = new Map(), calls = [], reads = [], lists = [], started = [], seenAsked = [];
  let clock = Date.parse('2026-10-07T10:00:00Z');
  let messages = [], identifyCursor = 'opaque-start', nextCursor = 'opaque-end', detailFails = false;
  const facts = {
    read: async key => { const value = structuredClone(kept.get(key) ?? null); return readFact ? readFact(key, value) : value; },
    list: async (prefix, options) => {
      lists.push(prefix); if (prefix === 'event-seen:') seenAsked.push(options);
      const values = [...kept].filter(([key]) => key.startsWith(prefix)).map(([, value]) => structuredClone(value));
      if (!options?.next) return values;
      const { scopes, routes, pending, from_due } = options.next;
      const open = values.filter(value => prefix === 'event-attempt:' ? !value.done : value.pending)
        .filter(value => !scopes || scopes.includes(value.source_id)).filter(value => !routes || routes.includes(value.event_payload?.route_key));
      const times = open.map(value => prefix === 'event-attempt:' ? Date.parse(value.due_at) + 60_000 : value.retry_at)
        .filter(at => Number.isFinite(at) && (from_due === undefined || at >= from_due));
      return [{ at: pending || !times.length ? null : Math.min(...times), pending: Boolean(pending && open.length) }];
    },
    write: async (key, value) => { beforeWrite(key, value); kept.set(key, structuredClone(value)); },
  };
  const workshop = {
    data: async () => ({ tools: [] }),
    read: async args => { reads.push(args); if (readTask) return readTask(args); throw new Error('unexpected task read'); },
    run: async args => {
      const { tool_id, input } = args;
      calls.push(args);
      const override = await runTask?.(args);
      if (override) return override;
      if (tool_id === 'tool:identify') return { state: 'completed', output: { account: 'account-1', cursor: identifyCursor } };
      if (tool_id === 'tool:subscribe') return { state: subscribe, error: subscribe === 'completed' ? undefined : 'provider refused subscription', task_id: 'subscription' };
      if (tool_id === 'tool:detail') {
        if (detailFails) throw new Error('detail reader unavailable');
        return { state: 'completed', output: { body: 'full detail' } };
      }
      if (tool_id === 'tool:read') return { state: 'completed', output: { cursor: nextCursor, messages: input.after === 'opaque-start' ? messages : [] } };
      throw new Error(`unexpected tool ${tool_id}`);
    },
  };
  const workflows = { recipeOf: async () => ({}), start: async args => {
    if (start) await start(args);
    const prior = started.find(item => item.request_key === args.request_key);
    if (prior) return { state: 'running', run_id: prior.run_id };
    const run_id = `run:${started.length + 1}`;
    started.push({ ...args, run_id });
    return { state: 'running', run_id };
  } };
  const create = () => makeEventRules({ workshop, workflows, facts, sources: async () => [row], now: () => new Date(clock), routes: routeBook ?? { add: async () => {}, remove: async () => {} }, rearm: async () => {} });
  return { kept, calls, reads, lists, seenAsked, started, create,
    advance: minutes => { clock += minutes * 60000; },
    messages: count => { messages = Array.from({ length: count }, (_, i) => ({ id: `message-${i}`, body: `words ${i}` })); },
    cursor: value => { identifyCursor = value; }, detailFails: value => { detailFails = value; },
    addRule: async (rules, id = 'rule:one') => rules.set({ rule_id: id, source_id: row.id, event: 'message', then: { workflow_id: `workflow:${id}`, input: {} } }),
  };
}

test('an explicit resume records new intent before proof and keeps its real failure visible after restart', async () => {
  for (const legacy of [false, true]) {
    let denied = false;
    const f = fixture({ row: { ...source, poll: undefined }, runTask: async () => {
      if (denied) { const error = new Error('Insufficient authentication scopes on explicit resume'); error.retryable = false; throw error; }
    } });
    let rules = f.create();
    await rules.listen({ source_id: source.id });
    await rules.listen({ source_id: source.id, stop: true });
    const stopped = f.kept.get(`event-listen:${source.id}`);
    if (legacy) { delete stopped.stop_requested; f.kept.set(`event-listen:${source.id}`, stopped); }
    const stoppedRevision = stopped.control_revision;
    denied = true; f.advance(1);
    await assert.rejects(rules.listen({ source_id: source.id }), /Insufficient authentication scopes on explicit resume/);
    rules = f.create();
    const listener = f.kept.get(`event-listen:${source.id}`);
    const attempt = f.kept.get(`event-listen-task:${source.id}:proof`);
    const health = (await rules.health())[0], state = await rules.listenerState();
    assert.equal(health.connected, false, 'failed proof never invents a connection');
    assert.equal(listener.stopped, true, 'only verified setup can start listening');
    assert.equal(listener.stop_requested, false, 'the new explicit start supersedes the prior stop');
    assert.ok(listener.control_revision > stoppedRevision, 'old setup completions remain fenced out');
    assert.equal(attempt.control_revision, listener.control_revision);
    assert.equal(health.connection_attempts.length, 1, 'the current proof failure survives restart');
    assert.match(health.connection_attempts[0].problem, /Insufficient authentication scopes on explicit resume/);
    assert.equal(health.connection_attempts[0].retryable, false);
    assert.deepEqual(state.attempts, health.connection_attempts);
    assert.deepEqual(state.stopped, []);
    denied = false; f.advance(1);
    await rules.listen({ source_id: source.id });
    assert.equal((await rules.health())[0].connected, true);
    assert.deepEqual((await rules.health())[0].connection_attempts, [], 'verified recovery clears the current failure');
  }
});

test('a stop while explicit resume proof is pending wins and retires that setup attempt', async () => {
  let resumed = false, entered, finish;
  const wasEntered = new Promise(resolve => { entered = resolve; });
  const pending = new Promise(resolve => { finish = resolve; });
  const f = fixture({ row: { ...source, poll: undefined }, runTask: async () => {
    if (resumed) { entered(); await pending; }
  } });
  const rules = f.create();
  await rules.listen({ source_id: source.id });
  await rules.listen({ source_id: source.id, stop: true });
  resumed = true; f.advance(1);
  const opening = rules.listen({ source_id: source.id });
  await wasEntered;
  const starting = f.kept.get(`event-listen:${source.id}`);
  try {
    assert.equal(starting.stopped, true);
    assert.equal(starting.stop_requested, false, 'the pending explicit resume is current intent');
    assert.equal((await rules.health())[0].connection_attempts.length, 1);
    await rules.listen({ source_id: source.id, stop: true });
  } finally { finish(); }
  await assert.rejects(opening, /was stopped or changed/);
  const latest = f.kept.get(`event-listen:${source.id}`);
  assert.equal(latest.stopped, true);
  assert.equal(latest.stop_requested, true);
  assert.ok(latest.control_revision > starting.control_revision);
  const state = await f.create().listenerState();
  assert.equal(state.stopped.length, 1);
  assert.deepEqual(state.attempts, []);
  assert.deepEqual((await f.create().health())[0].connection_attempts, []);
  const asks = f.calls.length;
  assert.equal((await f.create().listen({ source_id: source.id, automatic: true })).stopped, true);
  assert.equal(f.calls.length, asks, 'automatic recovery never overrides the later explicit stop');
});

test('a provider page larger than one wake is kept, resumed after restart, and checkpointed only after every event', async () => {
  const f = fixture(); let rules = f.create();
  await f.addRule(rules); await rules.listen({ source_id: source.id });
  f.messages(31); f.advance(1);
  await rules.pollDue();
  assert.equal(f.started.length, 25);
  assert.equal(f.kept.get(`event-poll:${source.id}`).cursor, 'opaque-start');
  assert.equal(f.kept.get(`event-poll:${source.id}`).pending.events.length, 6);
  rules = f.create(); f.advance(0.1); await rules.pollDue();
  assert.equal(f.started.length, 31);
  assert.equal(f.kept.get(`event-poll:${source.id}`).cursor, 'opaque-end');
  assert.equal(f.kept.get(`event-poll:${source.id}`).pending, undefined);
  assert.equal(f.calls.filter(call => call.tool_id === 'tool:read').length, 1, 'the saved page is drained before another provider read');
  f.advance(1); await rules.pollDue(); assert.equal(f.started.length, 31);
});

test('a poll which finishes after its first wake is resumed by task id after restart', async () => {
  const f = fixture({ runTask: async args => args.tool_id === 'tool:read' ? { state: 'working', task_id: 'read:pending' } : null,
    readTask: async ({ task_id }) => ({ task_id, state: 'completed', output: { cursor: 'opaque-end', messages: [{ id: 'delayed', body: 'arrived later' }] } }) });
  let rules = f.create(); await f.addRule(rules); await rules.listen({ source_id: source.id });
  f.advance(1); await rules.pollDue(); assert.equal(f.started.length, 0);
  rules = f.create(); f.advance(1); await rules.pollDue();
  assert.equal(f.calls.filter(call => call.tool_id === 'tool:read').length, 1, 'a pending task is not replaced by a new timestamp key');
  assert.deepEqual(f.reads, [{ task_id: 'read:pending' }]); assert.equal(f.started.length, 1);
});

test('pending identity and subscription tasks keep their identities, retry time and explicit stop distinction', async () => {
  const row = { ...source, signature: { header: 'x-signature' }, listen_tool_id: 'tool:subscribe', poll: undefined };
  const f = fixture({ row, runTask: async args => ({ state: 'working', task_id: args.tool_id === 'tool:identify' ? 'proof:pending' : 'subscribe:pending' }),
    readTask: async ({ task_id }) => ({ task_id, state: 'completed', output: task_id === 'proof:pending' ? { account: 'account-1' } : {} }) });
  let rules = f.create(); await assert.rejects(rules.listen({ source_id: source.id }), error => Number.isFinite(error.retry_at));
  await assert.rejects(rules.listen({ source_id: source.id })); assert.equal(f.calls.length, 1, 'an immediate retry does not ask the provider again');
  f.advance(1); rules = f.create(); await assert.rejects(rules.listen({ source_id: source.id }), /has not started sending/);
  let state = await rules.list(); assert.equal(state.listening.length, 0); assert.equal(state.stopped.length, 0); assert.ok(state.attempts.length);
  f.advance(1); rules = f.create(); await rules.listen({ source_id: source.id });
  assert.equal(f.calls.filter(call => call.tool_id === 'tool:identify').length, 1);
  assert.equal(f.calls.filter(call => call.tool_id === 'tool:subscribe').length, 1);
  await rules.listen({ source_id: source.id, stop: true }); state = await rules.list(); assert.equal(state.stopped[0].source_id, source.id);
});

test('pending admissions ask only for the open ones on every scheduler wake, never the event history', async () => {
  const f = fixture({ start: async () => { throw new Error('temporarily unavailable'); } }); const rules = f.create();
  await f.addRule(rules); await rules.listen({ source_id: source.id });
  await rules.receive({ source_id: source.id, events: [{ name: 'message', event_id: 'one', route_key: 'account-1' }] });
  f.seenAsked.length = 0;
  for (let i = 0; i < 100; i++) await rules.nextCheck();
  assert.equal(f.seenAsked.length, 100);
  assert.ok(f.seenAsked.every(options => options?.next), 'each wake asks only for scalar open-admission timing');
});

test('an explicit stop during identity setup is not overwritten when that setup finally answers', async () => {
  let entered, finish;
  const wasEntered = new Promise(resolve => { entered = resolve; });
  const pendingProof = new Promise(resolve => { finish = resolve; });
  const f = fixture({ runTask: async args => {
    if (args.tool_id !== 'tool:identify') return null;
    entered(); await pendingProof;
    return { state: 'completed', output: { account: 'account-1', cursor: 'opaque-start' } };
  } });
  const rules = f.create(); const opening = rules.listen({ source_id: source.id });
  await wasEntered; await rules.listen({ source_id: source.id, stop: true }); finish();
  await assert.rejects(opening, /was stopped/);
  assert.equal((await rules.list()).listening.length, 0);
  assert.equal((await rules.list()).stopped[0].source_id, source.id);
});

test('a stop cannot be overwritten between the final control read and listener publication', { timeout: 2000 }, async () => {
  const row = { ...source, signature: { header: 'x-signature' }, poll: undefined };
  const key = `event-listen:${source.id}`;
  let routeAdded = false, routed = false, intercepted = false, entered, release;
  const finalRead = new Promise(resolve => { entered = resolve; });
  const readMayReturn = new Promise(resolve => { release = resolve; });
  const f = fixture({ row, readFact: async (name, value) => {
    if (name === key && routeAdded && !intercepted) {
      intercepted = true; entered(); await readMayReturn;
    }
    return value;
  }, routeBook: { add: async () => { routed = true; routeAdded = true; }, remove: async () => { routed = false; } } });
  f.kept.set(key, { source_id: source.id, route_key: 'account-1', control_revision: 0 });
  const rules = f.create(), opening = rules.listen({ source_id: source.id });
  await finalRead;
  const stopping = rules.listen({ source_id: source.id, stop: true });
  // Let the stop reach the control section while the earlier read still holds its old snapshot.
  await new Promise(resolve => setImmediate(resolve));
  release();
  const settled = await Promise.allSettled([opening, stopping]);
  assert.equal(settled[1].status, 'fulfilled');
  assert.equal(settled[1].value.listening, false);
  assert.equal(f.kept.get(key).stop_requested, true);
  assert.equal(f.kept.get(key).control_revision, 1);
  assert.equal((await rules.list()).listening.length, 0);
  assert.equal(routed, false, 'the stopped source has no route left behind');
});

test('a stop is durable during remote cleanup and a later restart keeps its own route', { timeout: 2000 }, async () => {
  const row = { ...source, signature: { header: 'x-signature' }, poll: undefined };
  const key = `event-listen:${source.id}`;
  let entered, release, routed = true;
  const cleanupEntered = new Promise(resolve => { entered = resolve; });
  const cleanupMayFinish = new Promise(resolve => { release = resolve; });
  const f = fixture({ row, routeBook: {
    add: async () => { routed = true; },
    remove: async () => { entered(); await cleanupMayFinish; routed = false; },
  } });
  f.kept.set(key, { source_id: source.id, route_key: 'account-1', control_revision: 0 });
  const rules = f.create(), stopping = rules.listen({ source_id: source.id, stop: true });
  await cleanupEntered;
  assert.equal(f.kept.get(key).stop_requested, true, 'remote cleanup cannot hold back the durable stop');
  const stoppedRevision = f.kept.get(key).control_revision;
  const restarting = rules.listen({ source_id: source.id });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(f.calls.filter(call => call.tool_id === 'tool:identify').length, 1, 'identity work does not wait behind remote cleanup');
  release();
  await Promise.all([stopping, restarting]);
  assert.equal((await rules.list()).listening.length, 1);
  assert.equal(f.kept.get(key).control_revision, stoppedRevision + 1, 'the later explicit restart has its own control revision');
  assert.equal(routed, true, 'the old stop cleanup cannot remove the newer restart route');
});

test('a stop and restart re-prove identity and reject the superseded setup result', { timeout: 2000 }, async () => {
  const row = { ...source, signature: { header: 'x-signature' }, poll: undefined };
  let entered, finish, identities = 0;
  const oldProofEntered = new Promise(resolve => { entered = resolve; });
  const oldProofMayFinish = new Promise(resolve => { finish = resolve; });
  const routed = [];
  const f = fixture({ row, routeBook: { add: async (_, account) => { routed.push(account); }, remove: async () => {} },
    runTask: async args => {
      if (args.tool_id !== 'tool:identify') return null;
      if (++identities === 1) {
        entered(); await oldProofMayFinish;
        return { state: 'completed', task_id: 'old-proof', output: { account: 'old-account' } };
      }
      return { state: 'completed', task_id: 'new-proof', output: { account: 'new-account' } };
    } });
  const rules = f.create(), opening = rules.listen({ source_id: source.id });
  const superseded = assert.rejects(opening, error => error.retryable === false && /stopped or changed/.test(error.message));
  await oldProofEntered;
  await rules.listen({ source_id: source.id, stop: true });
  const stoppedRevision = f.kept.get(`event-listen:${source.id}`).control_revision;
  await rules.listen({ source_id: source.id });
  finish(); await superseded;
  const calls = f.calls.filter(call => call.tool_id === 'tool:identify');
  assert.equal(calls.length, 2);
  assert.notEqual(calls[0].request_key, calls[1].request_key, 'the old proof key must not be reused after an explicit stop');
  assert.deepEqual(routed, ['new-account']);
  assert.equal(f.kept.get(`event-listen:${source.id}`).route_key, 'new-account');
  const held = f.kept.get(`event-listen-task:${source.id}:proof`);
  assert.equal(held.task_id, 'new-proof');
  assert.equal(held.control_revision, stoppedRevision + 1);
  assert.equal(held.control_revision, f.kept.get(`event-listen:${source.id}`).control_revision);
});

test('an automatic setup cannot resume an explicit stop from an older scheduler snapshot', async () => {
  for (const explicit of [true, undefined]) {
    const row = { ...source, poll: undefined };
    const f = fixture({ row }), rules = f.create();
    f.kept.set(`event-listen:${source.id}`, { source_id: source.id, stopped: true,
      ...(explicit === undefined ? {} : { stop_requested: explicit }), control_revision: 1 });
    const automatic = await rules.listen({ source_id: source.id, automatic: true });
    assert.equal(automatic.listening, false);
    assert.equal(automatic.retryable, false);
    assert.equal(f.calls.length, 0, 'an explicit or legacy stop does not call the provider again');
    assert.equal((await rules.listen({ source_id: source.id })).listening, true, 'a direct restart remains available');
  }
  const f = fixture({ row: { ...source, poll: undefined } }), rules = f.create();
  f.kept.set(`event-listen:${source.id}`, { source_id: source.id, stopped: true, stop_requested: false, control_revision: 0 });
  assert.equal((await rules.listen({ source_id: source.id, automatic: true })).listening, true, 'a provider failure is still eligible for automatic recovery');
});

test('scheduler listener state does not read rules or event history', async () => {
  const f = fixture({ row: { ...source, poll: undefined } }), rules = f.create();
  await rules.listen({ source_id: source.id });
  f.lists.length = 0;
  for (let index = 0; index < 25; index++) {
    const state = await rules.listenerState();
    assert.equal(state.listening[0].source_id, source.id);
    assert.deepEqual(state.stopped, []);
    assert.deepEqual(state.attempts, []);
  }
  assert.ok(f.lists.every(prefix => ['event-listen:', 'event-listen-task:'].includes(prefix)), 'an unrelated wake cannot scan the event inbox');
  assert.equal(f.lists.length, 50, 'each read touches just the two bounded source prefixes');
});

test('a refused account proof remains visible after restart and clears only after a successful connection check', async () => {
  let denied = true;
  const f = fixture({ row: { ...source, poll: undefined }, runTask: async () => {
    if (denied) { const error = new Error('Insufficient authentication scopes'); error.retryable = false; throw error; }
  } });
  let rules = f.create();
  await assert.rejects(rules.listen({ source_id: source.id }), /Insufficient authentication scopes/);
  rules = f.create();
  const before = (await rules.health())[0];
  assert.equal(before.connected, false);
  assert.equal(before.connection_attempts.length, 1);
  assert.equal(before.connection_attempts[0].problem, 'Insufficient authentication scopes');
  assert.equal(before.connection_attempts[0].retryable, false);
  assert.deepEqual(before.connection_attempts, (await rules.listenerState()).attempts);
  assert.deepEqual(before.connection_attempts[0].next_call, { tool: 'listen_for_events', arguments: { source_id: source.id } });
  assert.equal(before.runs.length, 0, 'a setup failure is not a fabricated arrival or workflow run');
  denied = false; f.advance(1);
  await rules.listen({ source_id: source.id });
  assert.equal((await rules.health())[0].connected, true);
  assert.deepEqual((await rules.health())[0].connection_attempts, []);
});

test('an explicit stop and a newer control revision retire old setup failures from health and scheduler retries', async () => {
  const row = { ...source, signature: { header: 'x-signature' }, listen_tool_id: 'tool:subscribe', poll: undefined };
  const f = fixture({ row, subscribe: 'failed' }), rules = f.create();
  await assert.rejects(rules.listen({ source_id: source.id }), /has not started sending/);
  const failed = (await rules.health())[0].connection_attempts[0];
  assert.equal(failed.task_id, 'subscription');
  assert.equal(failed.state, 'failed');
  assert.match(failed.problem, /provider refused/);
  await rules.listen({ source_id: source.id, stop: true });
  assert.deepEqual((await rules.health())[0].connection_attempts, []);
  assert.deepEqual((await rules.listenerState()).attempts, []);
  assert.equal((await rules.listenerState()).stopped.length, 1);
  assert.ok(f.kept.has(`event-listen-task:${source.id}:subscribe`), 'retiring the attempt does not erase its evidence');
  const listener = f.kept.get(`event-listen:${source.id}`);
  f.kept.set(`event-listen:${source.id}`, { ...listener, stopped: false });
  assert.deepEqual((await f.create().health())[0].connection_attempts, [], 'a superseded control cannot make a replacement connection fail');
});

test('a genuine pending setup exposes its task without being labelled a provider failure', async () => {
  const f = fixture({ row: { ...source, poll: undefined }, runTask: async () => ({ state: 'working', task_id: 'identify-pending' }) });
  const rules = f.create();
  await assert.rejects(rules.listen({ source_id: source.id }), /nothing is listening yet/);
  const attempt = (await rules.health())[0].connection_attempts[0];
  assert.equal(attempt.state, 'working');
  assert.equal(attempt.problem, null);
  assert.deepEqual(attempt.next_call, { tool: 'read_task', arguments: { task_id: 'identify-pending' } });
});

test('a rejected cursor leaves an explicit gap after new polling recovers', async () => {
  let refuse = true;
  const row = { ...source, poll: { ...source.poll, restart_when_error_contains: ['cursor expired'] } };
  const f = fixture({ row, runTask: async args => { if (refuse && args.tool_id === 'tool:read') return { state: 'failed', task_id: 'expired', error: 'cursor expired' }; return null; } });
  const rules = f.create(); await rules.listen({ source_id: source.id }); f.advance(1); await rules.pollDue();
  assert.equal(f.kept.get(`event-poll:${source.id}`).cursor, null);
  refuse = false; f.advance(1); await rules.pollDue(); f.advance(1); await rules.pollDue();
  const sourceHealth = (await rules.health())[0]; assert.ok(sourceHealth.poll.gap);
  assert.equal(sourceHealth.poll.gap.from_cursor, 'opaque-start'); assert.equal(sourceHealth.poll.problem, null);
});

test('a failed durable page write cannot advance the cursor or dispatch unkept events', async () => {
  let reject = true;
  const f = fixture({ beforeWrite: (key, value) => { if (reject && key.startsWith('event-poll:') && value.pending) throw new Error('store unavailable'); } });
  const rules = f.create(); await f.addRule(rules); await rules.listen({ source_id: source.id });
  f.messages(1); f.advance(1); await rules.pollDue();
  assert.equal(f.started.length, 0); assert.equal(f.kept.get(`event-poll:${source.id}`).cursor, 'opaque-start');
  reject = false; f.advance(1); await rules.pollDue();
  assert.equal(f.started.length, 1); assert.equal(f.kept.get(`event-poll:${source.id}`).cursor, 'opaque-end');
});

test('a failed sibling rule resumes without duplicating the successful rule or losing the event', async () => {
  let fail = true;
  const f = fixture({ start: async args => { if (fail && args.workflow_id === 'workflow:rule:two') throw new Error('dispatch refused'); } });
  let rules = f.create(); await f.addRule(rules); await f.addRule(rules, 'rule:two'); await rules.listen({ source_id: source.id });
  f.messages(1); f.advance(1); await rules.pollDue();
  assert.equal(f.started.length, 1);
  assert.equal(f.kept.get(`event-poll:${source.id}`).cursor, 'opaque-end', 'durably queued work does not prevent the next provider read');
  assert.equal(f.kept.get(`event-seen:${source.id}:message-0`).pending, true);
  fail = false; rules = f.create(); f.advance(1); await rules.retryFailed(); await rules.pollDue();
  assert.equal(f.started.length, 2); assert.equal(f.kept.get(`event-poll:${source.id}`).cursor, 'opaque-end');
  assert.equal(f.kept.get(`event-seen:${source.id}:message-0`).pending, undefined);
});

test('an interruption after a rule starts reuses its request key and retains the saved page', async () => {
  let interrupt = true;
  const f = fixture({ beforeWrite: (key, value) => { if (interrupt && key.startsWith('event-seen:') && value.rules?.some(rule => rule.run_id)) throw new Error('isolate interrupted'); } });
  let rules = f.create(); await f.addRule(rules); await rules.listen({ source_id: source.id });
  f.messages(1); f.advance(1); await rules.pollDue();
  assert.equal(f.started.length, 1); assert.equal(f.kept.get(`event-poll:${source.id}`).cursor, 'opaque-start');
  interrupt = false; rules = f.create(); f.advance(1); await rules.pollDue();
  assert.equal(f.started.length, 1, 'the workflow owner receives the same idempotency key');
  assert.equal(f.kept.get(`event-poll:${source.id}`).cursor, 'opaque-end');
});

test('a required detail read is retried and cannot silently become an incomplete event', async () => {
  const row = { ...source, poll: { ...source.poll, detail: { tool_id: 'tool:detail', input: {}, fields: { text: ['body'] } } } };
  const f = fixture({ row }); const rules = f.create(); await f.addRule(rules); await rules.listen({ source_id: source.id });
  f.messages(1); f.detailFails(true); f.advance(1); await rules.pollDue();
  assert.equal(f.started.length, 0); assert.equal(f.kept.get(`event-poll:${source.id}`).cursor, 'opaque-end', 'the missing detail is durably queued, allowing later provider pages');
  assert.match(f.kept.get(`event-seen:${source.id}:message-0`).read_problem, /unavailable/);
  f.detailFails(false); f.advance(1); await rules.retryFailed();
  assert.equal(f.started.length, 1); assert.equal(f.kept.get(`event-seen:${source.id}:message-0`).text, 'full detail');
});

test('one unavailable detail does not block other items or the next provider page', async () => {
  let fail = true;
  const row = { ...source, poll: { ...source.poll, detail: { tool_id: 'tool:detail', input: { id: { fill: { from: 'event', field: 'message_id' } } }, fields: { text: ['body'] } } } };
  const f = fixture({ row, runTask: async args => { if (fail && args.tool_id === 'tool:detail' && args.input.id === 'message-0') throw new Error('one detail unavailable'); return null; } });
  let rules = f.create(); await f.addRule(rules); await rules.listen({ source_id: source.id });
  f.messages(3); f.advance(1); await rules.pollDue();
  assert.equal(f.started.length, 2); assert.equal(f.kept.get(`event-poll:${source.id}`).cursor, 'opaque-end');
  assert.equal((await rules.health())[0].pending_admissions, 1);
  f.advance(1); await rules.pollDue(); assert.equal(f.calls.filter(call => call.tool_id === 'tool:read').length, 2);
  fail = false; rules = f.create(); await rules.retryFailed(); assert.equal(f.started.length, 3);
  assert.equal((await rules.health())[0].pending_admissions, 0);
});

test('same-account listen and stop/resume preserve the cursor and undelivered page', async () => {
  const f = fixture(); const rules = f.create(); await f.addRule(rules); await rules.listen({ source_id: source.id });
  f.messages(26); f.advance(1); await rules.pollDue(); f.cursor('a-newer-provider-position');
  await rules.listen({ source_id: source.id, stop: true });
  await rules.listen({ source_id: source.id });
  assert.equal(f.kept.get(`event-poll:${source.id}`).cursor, 'opaque-start');
  assert.equal(f.kept.get(`event-poll:${source.id}`).pending.events.length, 1);
  await rules.pollDue(); assert.equal(f.started.length, 26);
});

test('a failed subscription is never listed as listening and a wrong-account delivery starts nothing', async () => {
  const row = { ...source, signature: { header: 'x-signature' }, listen_tool_id: 'tool:subscribe', poll: undefined };
  const f = fixture({ row, subscribe: 'failed' }); const rules = f.create(); await f.addRule(rules);
  await assert.rejects(rules.listen({ source_id: source.id }), /has not started sending/);
  assert.equal((await rules.list()).listening.length, 0);
  await rules.receive({ source_id: source.id, events: [{ name: 'message', event_id: 'one', route_key: 'someone-else' }] });
  assert.equal(f.started.length, 0);
});

test('a failed webhook dispatch is retried from its durable admission with no repeated provider delivery', async () => {
  let fail = true;
  const f = fixture({ start: async () => { if (fail) throw new Error('service interrupted'); } }); let rules = f.create();
  await f.addRule(rules); await rules.listen({ source_id: source.id });
  await rules.receive({ source_id: source.id, events: [{ name: 'message', event_id: 'webhook-1', route_key: 'account-1', text: 'kept words' }] });
  assert.ok(await rules.nextCheck()); assert.equal(f.started.length, 0);
  rules = f.create(); fail = false; f.advance(1); await rules.retryFailed();
  assert.equal(f.started.length, 1); assert.equal(f.kept.get(`event-seen:${source.id}:webhook-1`).pending, undefined);
});

test('an account refusing a verified webhook makes the sender retry', async () => {
  const row = { ...source, signature: { header: 'x-signature', hmac: 'SHA-256', encoding: 'hex', secret_name: 'test' } };
  const reply = await receiveEvents(new Request('https://example.test/events/test', { method: 'POST', headers: { 'x-signature': 'signed' }, body: JSON.stringify({ messages: [{ id: 'one', body: 'hi' }] }) }), {
    sourceId: source.id, sources: async () => [row], sign: async () => 'signed', kv: { get: async () => '["account"]' }, storeFor: () => ({ fetch: async () => new Response('busy', { status: 503 }) }),
  });
  assert.equal(reply.status, 503); assert.equal((await reply.json()).failed_accounts, 1);
});

test('a recent arrival does not hide an overdue or absent poll schedule', async () => {
  const filterRows = async ({ tree, rows }) => {
    const holds = (node, row) => node.kind === 'group'
      ? (node.combinator === 'and' ? node.rules.every(item => holds(item, row)) : node.rules.some(item => holds(item, row)))
      : node.operator === 'is_any_of' ? node.params.values.includes(row[node.field]) : node.operator === 'greater_than' ? row[node.field] > node.params.value : false;
    return { matches: rows.map((row, i) => holds(tree, row) ? i : -1).filter(i => i >= 0) };
  };
  const health = makeSourceHealth({ looks, filterRows });
  const input = { source_id: source.id, kind: 'event-source', label: source.label, connected: true, arrived: [{ id: 'recent', at: '2026-10-07T10:00:00Z' }], runs: [], poll: { every_minutes: 1, next_at: '2026-10-07T10:01:00Z' } };
  assert.equal((await health.readSourceHealth({ now: '2026-10-07T10:05:00Z', sources: [input] })).sources[0].state, 'failing');
  input.poll.next_at = null;
  assert.equal((await health.readSourceHealth({ now: '2026-10-07T10:05:00Z', sources: [input] })).sources[0].state, 'failing');
  input.poll.next_at = '2026-10-07T10:06:00Z';
  assert.equal((await health.readSourceHealth({ now: '2026-10-07T10:05:00Z', sources: [input] })).sources[0].state, 'healthy');
});
