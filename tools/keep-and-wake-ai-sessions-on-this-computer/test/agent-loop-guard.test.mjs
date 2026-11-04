// The same two agents passing one chain of work back and forth is refused past the repeats in src/agent-loop-guard.json.
import test from 'node:test';
import assert from 'node:assert/strict';
import { makeAgents } from '../../shared-code/src/agents.mjs';
import guard from '../../shared-code/src/agent-loop-guard.json' with { type: 'json' };
import { agentStoreForTests } from '../../shared-code/test/agent-store-for-tests.mjs';

const agentsWith = () => {
  const agents = makeAgents({ store: agentStoreForTests() });
  for (const agent_id of ['alpha', 'beta', 'gamma']) agents.publish({ agent_id, name: agent_id, description: 'Takes work', takes_work: true });
  return agents;
};

test('a chain that keeps going from alpha to beta is refused after max_repeats, while another pair or a new chain is not', () => {
  const agents = agentsWith();
  let parent;
  for (let i = 0; i < guard.max_repeats; i += 1) {
    parent = agents.handOff({ request_key: `link-${i}`, job: `Pass it on ${i}`, from_agent: 'alpha', to_agent: 'beta', ...(parent ? { parent_handoff_id: parent } : {}) }).handoff.handoff_id;
  }
  assert.throws(() => agents.handOff({ request_key: 'one-too-many', job: 'Again', from_agent: 'alpha', to_agent: 'beta', parent_handoff_id: parent }),
    error => { assert.match(error.message, new RegExp(`alpha has already handed this chain of work to beta ${guard.max_repeats} times`)); return true; });
  assert.ok(agents.handOff({ request_key: 'other-pair', job: 'Another agent', from_agent: 'alpha', to_agent: 'gamma', parent_handoff_id: parent }).handoff.handoff_id);
  assert.ok(agents.handOff({ request_key: 'new-chain', job: 'Fresh', from_agent: 'alpha', to_agent: 'beta' }).handoff.handoff_id);
});

test('rate.per_minute refuses a flood from one agent, ignores a repeated request_key and other senders, and lets the minute pass', () => {
  const clock = { at: Date.parse('2026-10-19T10:00:00Z') };
  const agents = makeAgents({ store: agentStoreForTests(), now: () => new Date(clock.at) });
  for (const agent_id of ['alpha', 'beta']) agents.publish({ agent_id, name: agent_id, description: 'Takes work', takes_work: true });
  const was = guard.rate.per_minute;
  guard.rate.per_minute = 2;
  try {
    const send = (key, from = 'alpha') => agents.handOff({ request_key: key, job: `Job ${key}`, from_agent: from, to_agent: 'beta' });
    send('a'); send('b');
    assert.equal(send('a').repeated, true, 'a returning request_key is not a new hand-off');
    assert.throws(() => send('c'), /alpha has handed off 2 jobs in the last minute/);
    assert.ok(send('d', 'beta'), 'another sender is counted apart');
    clock.at += 61_000;
    assert.ok(send('c'));
  } finally { guard.rate.per_minute = was; }
});
