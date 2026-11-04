import test from 'node:test';
import assert from 'node:assert/strict';
import { blake3 } from '@noble/hashes/blake3.js';
import { bytesToHex } from '@noble/hashes/utils.js';
import { handleAgentsRequest, makeAgents } from '../../shared-code/src/agents.mjs';
import { agentStoreForTests } from '../../shared-code/test/agent-store-for-tests.mjs';

function claimed(reader = 'app:claimant') {
  const store = agentStoreForTests(), agents = makeAgents({ store });
  agents.publish({ agent_id: 'worker', name: 'Worker', description: 'Works on handoffs' });
  const handoff = agents.handOff({ request_key: `claim-${reader}`, job: 'Complete this work', to_agent: 'worker' }).handoff;
  const lease = agents.take({ handoff_id: handoff.handoff_id, agent_id: 'worker' }, { reader });
  return { store, agents, input: { handoff_id: handoff.handoff_id, agent_id: 'worker', generation: lease.generation } };
}

test('a different authenticated reader cannot renew, finish, release, report a blocker, or record an effect', () => {
  const { agents, input } = claimed();
  const wrong = { reader: 'app:other' };
  assert.throws(() => agents.take(input, wrong), /different authenticated reader/);
  assert.throws(() => agents.finish({ ...input, result: 'done' }, wrong), /different authenticated reader/);
  assert.throws(() => agents.release({ ...input, because: 'done' }, wrong), /different authenticated reader/);
  assert.throws(() => agents.sayInTheWay({ ...input, in_the_way: 'blocked' }, wrong), /different authenticated reader/);
  assert.throws(() => agents.recordEffect({ ...input, effect_id: 'external-write', state: 'starting' }, wrong), /different authenticated reader/);
  assert.equal(agents.read({ handoff_id: input.handoff_id }).handoff.state, 'taken');
});

test('claim identity remains the original reader when the mutable agent card changes', () => {
  const { agents, input } = claimed('app:first');
  agents.publish({ agent_id: 'worker', name: 'Worker', description: 'Updated card' }, { reader: 'app:second' });
  assert.throws(() => agents.finish({ ...input, result: 'done' }, { reader: 'app:second' }), /different authenticated reader/);
  assert.equal(agents.finish({ ...input, result: 'done' }, { reader: 'app:first' }).handoff.state, 'finished');
});

test('result-source pre-admission refuses a different reader before resolving the source', async () => {
  const { agents, input } = claimed('app:claimant');
  const bytes = new TextEncoder().encode('{"text":"whole"}');
  const source = { identity: `1f:${bytesToHex(blake3(bytes))}`, byte_length: bytes.length, format: 'application/json' };
  let resolutions = 0;
  const request = new Request('https://fixture.test/handoffs/finish', {
    method: 'POST', headers: { 'x-trillion-reader': 'app:other' },
    body: JSON.stringify({ ...input, result_source: source }),
  });
  const response = await handleAgentsRequest(agents, request, { resolveResultSource: async () => { resolutions++; return { text: 'whole' }; } });
  assert.equal(response.status, 400);
  assert.match((await response.json()).error, /different authenticated reader/);
  assert.equal(resolutions, 0);
  assert.equal(agents.read({ handoff_id: input.handoff_id }).handoff.state, 'taken');
});

test('legacy reader-less claims retain the internal contract without retroactive identity assignment', () => {
  const { agents, input } = claimed(null);
  assert.throws(() => agents.finish({ ...input, result: 'done' }, { reader: 'app:late' }), /no authenticated reader recorded/);
  assert.equal(agents.finish({ ...input, result: 'done' }).handoff.state, 'finished');
});

test('an explicitly present but invalid claim principal fails closed', () => {
  const { store, agents, input } = claimed();
  const current = store.handoff(input.handoff_id);
  store.putHandoff({ ...current, attempts: current.attempts.map(attempt => attempt.generation === input.generation
    ? { ...attempt, claim_reader: null } : attempt) });
  assert.throws(() => agents.finish({ ...input, result: 'done' }), /different authenticated reader/);
});
