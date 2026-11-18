import test from 'node:test';
import assert from 'node:assert/strict';
import fixtures from './policy-fixtures.json' with { type: 'json' };
import { createInteractions } from '../read-data/interactions.mjs';

const { interactionsToKeep, readRequests, shardOf, serverEvent } = createInteractions(fixtures.interactions, fixtures.consent);
const event = serverEvent('tool_run', { tool: 'x', client: 'chatgpt' }, {});

test('a keep is the events the Worker saw, once, in their shard; nothing is kept when every event was withheld', () => {
  assert.equal(interactionsToKeep([null, undefined]), null);
  assert.deepEqual(interactionsToKeep([event, null]), { shard: 0, events: [event], visitor: null });
  const visitor = { address: '203.0.113.7', agent: 'Mozilla/5.0' };
  assert.deepEqual(interactionsToKeep([event], visitor), { shard: shardOf(visitor.address, visitor.agent), events: [event], visitor });
});

test('a read asks every shard for the same range, and nothing is read from a store here', () => {
  const range = { since: '2026-11-01T00', until: '2026-11-18T12' };
  const requests = readRequests(range);
  assert.equal(requests.length, Math.max(1, fixtures.interactions.shards));
  assert.deepEqual(requests.map(request => request.shard), requests.map((_, index) => index));
  assert.ok(requests.every(request => request.range === range));
});
