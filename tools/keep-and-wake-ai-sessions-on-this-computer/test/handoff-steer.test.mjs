// A steer (hand_off with steer_handoff_id) is a later word to work already running: kept on that job in order, never a second job.
import test from 'node:test';
import assert from 'node:assert/strict';
import { makeAgents } from '../../shared-code/src/agents.mjs';
import { agentStoreForTests } from '../../shared-code/test/agent-store-for-tests.mjs';

function setup() {
  const store = agentStoreForTests();
  const agents = makeAgents({ store });
  agents.publish({ agent_id: 'worker', name: 'Worker', description: 'Takes work', takes_work: true });
  const { handoff } = agents.handOff({ request_key: 'long-job', job: 'Write the report', to_agent: 'worker' });
  return { store, agents, handoff };
}

test('a steer on a taken job is kept on that job in order, read with it, and a repeat is one steer', () => {
  const { agents, handoff } = setup();
  const taken = agents.take({ agent_id: 'worker', only_mine: true }).handoff;
  assert.equal(taken.handoff_id, handoff.handoff_id);
  const one = agents.handOff({ steer_handoff_id: handoff.handoff_id, request_key: 's1', job: 'Make it shorter', from_agent: 'person-ai' });
  assert.equal(one.steered, true);
  agents.handOff({ steer_handoff_id: handoff.handoff_id, request_key: 's2', job: 'Use plain words' });
  const repeat = agents.handOff({ steer_handoff_id: handoff.handoff_id, request_key: 's1', job: 'Make it shorter' });
  assert.equal(repeat.repeated, true);
  const read = agents.read({ handoff_id: handoff.handoff_id }).handoff;
  assert.deepEqual(read.steers.map(steer => steer.job), ['Make it shorter', 'Use plain words']);
  assert.equal(read.job, 'Write the report', 'the job itself is unchanged and no second job exists');
  assert.equal(read.state, 'taken');
  assert.equal(read.taken_by, 'worker');
});

test('a finished or unknown job cannot be steered, and a plain hand-off still queues new work', () => {
  const { agents, handoff } = setup();
  agents.take({ agent_id: 'worker', only_mine: true });
  agents.finish({ handoff_id: handoff.handoff_id, agent_id: 'worker', result: { summary: 'done' } });
  assert.throws(() => agents.handOff({ steer_handoff_id: handoff.handoff_id, request_key: 's', job: 'late' }), /over, so it cannot be steered/);
  assert.throws(() => agents.handOff({ steer_handoff_id: 'h_nothing', request_key: 's', job: 'x' }), /not a handoff on this account/);
  const queued = agents.handOff({ request_key: 'next', job: 'Another job', to_agent: 'worker' });
  assert.equal(queued.handoff.steers, undefined);
  assert.notEqual(queued.handoff.handoff_id, handoff.handoff_id);
});
