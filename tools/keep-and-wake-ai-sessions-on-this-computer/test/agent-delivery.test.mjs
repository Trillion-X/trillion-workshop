import test from 'node:test';
import assert from 'node:assert/strict';
import { makeAgents } from '../../shared-code/src/agents.mjs';
import { agentStoreForTests } from '../../shared-code/test/agent-store-for-tests.mjs';
import { deliveryHolds, MAX_RESEND_REQUESTS, RETRY_SECONDS, signDelivery } from '../../shared-code/src/agent-delivery.mjs';

function clock(start = '2026-09-27T12:00:00Z') {
  let time = new Date(start).getTime();
  return { now: () => new Date(time), advance: seconds => { time += seconds * 1000; } };
}

// A receiver that checks each signature with the secret its agent was given, and answers from a script of statuses.
function receivers(time, secrets, statuses = []) {
  const got = [];
  const send = async (url, body, headers) => {
    const agent_id = new URL(url).searchParams.get('agent');
    const holds = deliveryHolds(secrets[agent_id], headers['trillion-signature'], body, Math.floor(time.now().getTime() / 1000));
    const status = statuses.length ? statuses.shift() : 200;
    got.push({ agent_id, holds, status, event: JSON.parse(body), event_id: headers['trillion-event-id'] });
    if (status === 'throw') throw new Error('connection refused');
    return { ok: status >= 200 && status < 300, status };
  };
  return { got, send };
}

function twoAgents(time) {
  const store = agentStoreForTests();
  const agents = makeAgents({ store, now: time.now });
  const secrets = {};
  for (const agent_id of ['asker', 'worker']) {
    const published = agents.publish({ agent_id, name: agent_id, description: `the ${agent_id}`, delivery: { url: `https://receiver.example/in?agent=${agent_id}` } });
    secrets[agent_id] = published.delivery_secret;
    assert.match(published.delivery_secret, /^[0-9a-f]{64}$/);
  }
  return { store, agents, secrets };
}

test('handoff.created reaches the worker, handoff.finished reaches the asker, each signed with its own secret and carrying no job', async () => {
  const time = clock();
  const { agents, secrets } = twoAgents(time);
  const net = receivers(time, secrets);
  const { handoff } = agents.handOff({ to_agent: 'worker', from_agent: 'asker', job: 'Private job words', input: { secret: 'x' }, notice: 'Add two numbers', request_key: 'k1' });
  assert.equal(agents.nextDeliveryAt(), time.now().getTime());
  await agents.deliver(net.send);
  assert.equal(net.got.length, 1);
  assert.deepEqual([net.got[0].agent_id, net.got[0].holds, net.got[0].event.type, net.got[0].event.summary], ['worker', true, 'handoff.created', 'Add two numbers']);
  assert.ok(!JSON.stringify(net.got[0].event).includes('Private job words') && !JSON.stringify(net.got[0].event).includes('"secret"'));
  assert.deepEqual(net.got[0].event.next_call, { tool: 'take_work', arguments: { agent_id: 'worker', handoff_id: handoff.handoff_id } });

  agents.take({ agent_id: 'worker', handoff_id: handoff.handoff_id });
  agents.finish({ handoff_id: handoff.handoff_id, agent_id: 'worker', result: { sum: 5 }, summary: 'The sum is 5' });
  await agents.deliver(net.send);
  assert.deepEqual([net.got[1].agent_id, net.got[1].holds, net.got[1].event.type, net.got[1].event.summary, net.got[1].event.refs.taken_by], ['asker', true, 'handoff.finished', 'The sum is 5', 'worker']);
  assert.ok(!JSON.stringify(net.got[1].event).includes('"sum"'));
  assert.equal(deliveryHolds(secrets.worker, signDelivery(secrets.asker, 'body'), 'body'), false, 'one agent\'s secret never checks another\'s events');

  const read = agents.read({ handoff_id: handoff.handoff_id });
  assert.deepEqual(read.deliveries.map(item => [item.type, item.state, item.attempts]).sort(), [['handoff.created', 'delivered', 1], ['handoff.finished', 'delivered', 1]]);
  assert.equal(agents.nextDeliveryAt(), null);
  await agents.deliver(net.send);
  assert.equal(net.got.length, 2, 'nothing is sent twice');
});

test('a failed delivery is tried again after each wait, then kept dead; presence sends it again and never returns work', async () => {
  const time = clock();
  const { agents, secrets } = twoAgents(time);
  const net = receivers(time, secrets, [500, 'throw', ...RETRY_SECONDS.slice(2).map(() => 503), 503, 200]);
  const { handoff } = agents.handOff({ to_agent: 'worker', from_agent: 'asker', job: 'Job', request_key: 'k2' });
  for (const wait of [...RETRY_SECONDS, null]) {
    await agents.deliver(net.send);
    if (wait !== null) { assert.equal(agents.nextDeliveryAt(), time.now().getTime() + wait * 1000); time.advance(wait - 1); await agents.deliver(net.send); time.advance(1); }
  }
  assert.equal(net.got.length, RETRY_SECONDS.length + 1, 'no attempt before its wait is over');
  const [dead] = agents.read({ handoff_id: handoff.handoff_id }).deliveries;
  assert.deepEqual([dead.state, dead.attempts, dead.last_error], ['dead', RETRY_SECONDS.length + 1, 'The address answered 503.']);
  assert.equal(agents.nextDeliveryAt(), null);
  assert.ok(agents.find({ job: 'worker' }).agents.find(agent => agent.agent_id === 'worker').last_undelivered_at);

  const present = agents.presence({ agent_id: 'worker' });
  assert.deepEqual(Object.keys(present).sort(), ['agent_id', 'last_seen_at', 'sending_again']);
  assert.equal(present.sending_again, 1);
  await agents.deliver(net.send);
  assert.equal(net.got.at(-1).status, 200);
  assert.equal(net.got.at(-1).event_id, net.got[0].event_id, 'the same event id, so a receiver that already has it ignores it');
  assert.equal(agents.read({ handoff_id: handoff.handoff_id }).deliveries[0].state, 'delivered');
  assert.equal(agents.presence({ agent_id: 'worker' }).sending_again, 0);
});

test('work handed to nobody is sent to every reachable agent that takes work except the asker; unreachable agents get nothing', async () => {
  const time = clock();
  const { agents, secrets } = twoAgents(time);
  agents.publish({ agent_id: 'third', name: 'third', description: 'no address' });
  const extra = agents.publish({ agent_id: 'paused', name: 'paused', description: 'paused', takes_work: false, delivery: { url: 'https://receiver.example/in?agent=paused' } });
  secrets.paused = extra.delivery_secret;
  const net = receivers(time, secrets);
  agents.handOff({ from_agent: 'asker', job: 'Anyone', request_key: 'k3' });
  await agents.deliver(net.send);
  assert.deepEqual(net.got.map(item => item.agent_id), ['worker']);
});

test('the secret is shown once, never on the card; a new address or rotation makes a new one; only https is accepted', () => {
  const time = clock();
  const { agents, secrets } = twoAgents(time);
  const again = agents.publish({ agent_id: 'worker', name: 'worker', description: 'the worker' });
  assert.equal(again.delivery_secret, undefined);
  assert.equal(again.agent.delivery.url, 'https://receiver.example/in?agent=worker');
  assert.ok(!JSON.stringify(agents.find({}).agents).includes(secrets.worker));
  const rotated = agents.publish({ agent_id: 'worker', name: 'worker', description: 'the worker', rotate_delivery_secret: true });
  assert.ok(rotated.delivery_secret && rotated.delivery_secret !== secrets.worker);
  assert.throws(() => agents.publish({ agent_id: 'worker', name: 'worker', description: 'w', delivery: { url: 'http://plain.example/' } }), /https/);
  assert.equal(agents.publish({ agent_id: 'worker', name: 'worker', description: 'w', delivery: null }).agent.delivery, null);
});

test('a signature is refused when stale, altered or made with another secret', () => {
  const secret = 'ab'.repeat(32);
  const now = 1_800_000_000;
  const header = signDelivery(secret, '{"a":1}', now);
  assert.equal(deliveryHolds(secret, header, '{"a":1}', now + 10), true);
  assert.equal(deliveryHolds(secret, header, '{"a":2}', now), false);
  assert.equal(deliveryHolds(secret, header, '{"a":1}', now + 301), false);
  assert.equal(deliveryHolds('cd'.repeat(32), header, '{"a":1}', now), false);
  assert.equal(deliveryHolds(secret, null, '{"a":1}', now), false);
});

test('a run request and its result ride the same rail: ids and a summary only, sent once per idempotency key', async () => {
  const time = clock();
  const { agents, secrets } = twoAgents(time);
  const net = receivers(time, secrets);
  agents.presence({ agent_id: 'worker' });
  const asked = agents.sendEvent({ type: 'tool.run.requested', to_agent: 'worker', from_agent: 'asker', idempotency_key: 'run-1', subject_id: 'run_1', summary: 'Transcribe one clip', refs: { tool_id: 'tool:transcribe', input_ref: 'file:1f:abc' }, next_call: { tool: 'read_run', arguments: { run_id: 'run_1' } } });
  assert.deepEqual([asked.receiver.present, asked.receiver.delivery, asked.delivery.state], [true, true, 'waiting']);
  assert.deepEqual(Object.keys(asked.event).sort(), ['event_id', 'from_agent', 'next_call', 'occurred_at', 'refs', 'subject_id', 'summary', 'to_agent', 'type']);
  const again = agents.sendEvent({ type: 'tool.run.requested', to_agent: 'worker', from_agent: 'asker', idempotency_key: 'run-1', subject_id: 'run_1', summary: 'Transcribe one clip', refs: { tool_id: 'tool:transcribe', input_ref: 'file:1f:abc' }, next_call: { tool: 'read_run', arguments: { run_id: 'run_1' } } });
  assert.equal(again.repeated, true);
  assert.equal(again.event.event_id, asked.event.event_id);
  assert.throws(() => agents.sendEvent({ type: 'tool.run.requested', to_agent: 'worker', idempotency_key: 'run-1', subject_id: 'run_2' }), /different event/);
  agents.sendEvent({ type: 'tool.run.finished', to_agent: 'asker', from_agent: 'worker', idempotency_key: 'run-1-done', subject_id: 'run_1', summary: 'Done in 4 s', refs: { result_ref: 'file:1f:def' } });
  await agents.deliver(net.send);
  assert.deepEqual(net.got.map(item => [item.agent_id, item.event.type, item.holds]), [['worker', 'tool.run.requested', true], ['asker', 'tool.run.finished', true]]);
  assert.deepEqual(agents.readEvents({ subject_id: 'run_1' }).events.map(item => [item.type, item.state]).sort(), [['tool.run.finished', 'delivered'], ['tool.run.requested', 'delivered']]);
  assert.equal(agents.find({ job: 'worker' }).agents.find(agent => agent.agent_id === 'worker').delivered, 1);
});

test('the rail refuses what it cannot carry (and sends nothing to an agent with no route): bad type, payload in refs, and more than the waiting limit', async () => {
  const time = clock();
  const { agents } = twoAgents(time);
  agents.publish({ agent_id: 'silent', name: 'silent', description: 'no address' });
  const base = { to_agent: 'worker', idempotency_key: 'k', subject_id: 's', type: 'tool.run.requested' };
  // An agent with no route is sent nothing and the answer says so, rather than refusing (a web chat reads its work
  // when it next connects).
  const silent = agents.sendEvent({ ...base, to_agent: 'silent' });
  assert.equal(silent.event, null);
  assert.equal(silent.receiver.route, 'next_connection');
  assert.equal(silent.receiver.live, false);
  assert.throws(() => agents.sendEvent({ ...base, to_agent: 'nobody' }), /No agent nobody/);
  assert.throws(() => agents.sendEvent({ ...base, type: 'Tool Run' }), /lower-case/);
  assert.throws(() => agents.sendEvent({ ...base, refs: { input: { text: 'the whole file' } } }), /must be an id/);
  assert.throws(() => agents.sendEvent({ ...base, refs: { input: 'x'.repeat(201) } }), /must be an id/);
  const { MAX_WAITING } = await import('../../shared-code/src/agent-delivery.mjs');
  for (let index = 0; index < MAX_WAITING; index += 1) agents.sendEvent({ ...base, idempotency_key: `k${index}` });
  assert.throws(() => agents.sendEvent({ ...base, idempotency_key: 'one-more' }), /already has at least 200 events waiting/);
  assert.equal(agents.sendEvent({ ...base, idempotency_key: 'k0' }).repeated, true, 'a repeat is still answered at the limit');
});

test('a receiver that cannot use a delivered event asks for it again: it goes back to waiting, the requests are counted, and the count is capped', async () => {
  const time = clock();
  const { agents, secrets } = twoAgents(time);
  const net = receivers(time, secrets);
  const { handoff } = agents.handOff({ to_agent: 'worker', from_agent: 'asker', job: 'Job', request_key: 'k-resend' });
  await agents.deliver(net.send);
  const [delivered] = agents.read({ handoff_id: handoff.handoff_id }).deliveries;
  assert.deepEqual([delivered.state, delivered.resend_requests], ['delivered', 0]);
  assert.throws(() => agents.resend({ event_id: delivered.event_id, agent_id: 'asker' }), /No event/);
  const asked = agents.resend({ event_id: delivered.event_id, agent_id: 'worker', reason: 'could not read the body' });
  assert.deepEqual([asked.delivery.state, asked.delivery.attempts, asked.delivery.resend_requests], ['waiting', 0, 1]);
  await agents.deliver(net.send);
  assert.equal(net.got.length, 2);
  assert.equal(net.got[1].event_id, delivered.event_id, 'the same event id comes again');
  for (let index = 2; index <= MAX_RESEND_REQUESTS; index += 1) agents.resend({ event_id: delivered.event_id, agent_id: 'worker' });
  const refused = agents.resend({ event_id: delivered.event_id, agent_id: 'worker' });
  assert.match(refused.refused, /already asked for again 5 times/);
  assert.equal(refused.delivery.resend_requests, MAX_RESEND_REQUESTS);
});
