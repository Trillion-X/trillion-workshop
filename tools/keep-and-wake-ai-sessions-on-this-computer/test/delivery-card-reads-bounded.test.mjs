// The delivery loop (src/agent-delivery.mjs deliverDue) reads an agent's card a fixed number of times per event, never
// once per check. Before 2026-10-13 it read the card three times for every event (stream check, address, then the
// write-back), so a receiver that answered slowly paid three card reads for each of its events. These tests send
// N events and 4N events to one receiver and hold the card reads per event to a constant.
import test from 'node:test';
import assert from 'node:assert/strict';
import { makeAgents } from '../../shared-code/src/agents.mjs';
import { agentStoreForTests } from '../../shared-code/test/agent-store-for-tests.mjs';
import { deliverDue, signDelivery } from '../../shared-code/src/agent-delivery.mjs';

const at = '2026-10-13T12:00:00Z';
const now = () => new Date(at);

function workerWithEvents(count) {
  const store = agentStoreForTests();
  const agents = makeAgents({ store, now });
  agents.publish({ agent_id: 'worker', name: 'worker', description: 'the worker', delivery: { url: 'https://receiver.example/in?agent=worker' } });
  for (let index = 0; index < count; index += 1) agents.handOff({ to_agent: 'worker', from_agent: 'asker', job: `job ${index}`, input: {}, notice: `Job ${index}`, request_key: `k${index}` });
  return store;
}

async function cardReadsFor(count) {
  const store = workerWithEvents(count);
  let reads = 0;
  const counted = { ...store, card: id => { reads += 1; return store.card(id); } };
  const sent = [];
  const results = await deliverDue({ store: counted, now, send: async (url, body, headers) => { sent.push(body); return { ok: true, status: 200 }; } });
  assert.equal(results.length, count, `${count} events were due`);
  assert.equal(sent.length, count, `${count} events were sent`);
  assert.ok(results.every(result => result.state === 'delivered'), 'each event was delivered');
  return reads;
}

test('card reads per delivered event do not grow with the number of events', { timeout: 120000 }, async () => {
  const small = await cardReadsFor(10);
  const large = await cardReadsFor(40);
  assert.ok(small <= 2 * 10 + 2, `10 events read the card ${small} times`);
  assert.ok(large <= 2 * 40 + 2, `40 events read the card ${large} times`);
  assert.ok(large <= small * 4 + 2, `4x the events read ${large} times, against ${small}`);
});
