// test/work-time-budget.test.mjs
// A job with a time budget stops with a typed stop once its attempts have held it that long, and stays stopped until
// someone takes it by name; a job without one is unchanged (F-0196).
import assert from 'node:assert/strict';
import test from 'node:test';
import { makeAgents } from '../../shared-code/src/agents.mjs';
import { agentStoreForTests } from '../../shared-code/test/agent-store-for-tests.mjs';

function account() {
  let at = Date.parse('2026-10-19T09:00:00Z');
  const agents = makeAgents({ store: agentStoreForTests(), now: () => new Date(at) });
  agents.publish({ agent_id: 'maker', name: 'Maker', description: 'Takes work', takes_work: true });
  return { agents, advance: seconds => { at += seconds * 1000; } };
}

test('attempts that held a job for its whole time budget stop it with blocked_kind time_budget', () => {
  const { agents, advance } = account();
  const { handoff } = agents.handOff({ request_key: 'a', job: 'long job', to_agent: 'maker', time_budget_seconds: 600, hold_minutes: 5 });
  agents.take({ agent_id: 'maker', handoff_id: handoff.handoff_id });
  advance(6 * 60);
  agents.reconcile();
  let seen = agents.read({ handoff_id: handoff.handoff_id }).handoff;
  assert.notEqual(seen.blocked_kind, 'time_budget', 'six minutes of ten is not the budget');
  agents.take({ agent_id: 'maker', handoff_id: handoff.handoff_id });
  advance(6 * 60);
  agents.reconcile();
  seen = agents.read({ handoff_id: handoff.handoff_id }).handoff;
  assert.equal(seen.status, 'blocked');
  assert.match(seen.in_the_way, /held it for 720 of the 600 seconds/);
  agents.reconcile();
  assert.equal(agents.read({ handoff_id: handoff.handoff_id }).handoff.status, 'blocked', 'it stays stopped on the next look');
  assert.equal(seen.time_budget_seconds, 600);
  assert.ok(seen.time_used_seconds >= 600);
  console.log('readback', JSON.stringify({ state: seen.state, status: seen.status, in_the_way: seen.in_the_way, used: seen.time_used_seconds, budget: seen.time_budget_seconds }));
});

test('without a time budget a job is never stopped for time, and a bad budget is refused', () => {
  const { agents, advance } = account();
  const { handoff } = agents.handOff({ request_key: 'b', job: 'no budget', to_agent: 'maker', hold_minutes: 5 });
  agents.take({ agent_id: 'maker', handoff_id: handoff.handoff_id });
  advance(6 * 60);
  agents.reconcile();
  assert.notEqual(agents.read({ handoff_id: handoff.handoff_id }).handoff.blocked_kind, 'time_budget');
  assert.throws(() => agents.handOff({ request_key: 'c', job: 'x', to_agent: 'maker', time_budget_seconds: 0 }), /time_budget_seconds/);
});
