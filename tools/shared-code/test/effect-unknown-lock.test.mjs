// Ported from old trillion test/effect-unknown-lock.test.mjs (tag old-trillion-before-worker-retire, b6ae0ebf81),
// deleted by Trillion-X/trillion #243. The four effect tests are the old ones over src/agents.mjs and src/failure.mjs here.
// The fifth ran a failed tool run through src/tool-run-owner.mjs, which no repository keeps (searched toolRunOwner,
// tool-run-owner, required_next in trillion-workshop tools/, trillion-rust src/ including src/tool_runs, trillion-apps web/),
// so it is left out.
// An effect left unknown (src/agents.mjs recordEffect, src/effect-outcomes.json): the holder may only look until a
// receipt from checking the target settles it or the person's own next message in the conversation the work came from
// releases it; a released effect stays unknown and is never started blindly again. Every failed receipt, of a handoff
// effect and of a tool run (src/tool-run-owner.mjs), carries retryable, side_effect and required_next (src/failure.mjs).
import test from 'node:test';
import assert from 'node:assert/strict';
import { makeAgents } from '../src/agents.mjs';
import { effectOutcome } from '../src/failure.mjs';
import { agentStoreForTests } from './agent-store-for-tests.mjs';

function setUp() {
  let time = Date.parse('2026-10-19T08:00:00Z');
  const agents = makeAgents({ store: agentStoreForTests(), now: () => new Date(time) });
  for (const agent_id of ['payer']) agents.publish({ agent_id, name: agent_id, description: 'Does work', source_id: 'chat-7', delivery: { url: `https://${agent_id}.example/events` } });
  const id = agents.handOff({ job: 'Pay invoice 42 and tell the supplier', request_key: 'lock', hold_minutes: 10,
    input: { arrived: { source_id: 'chat-7', from_person: true } } }).handoff.handoff_id;
  const first = agents.take({ agent_id: 'payer' }).generation;
  agents.recordEffect({ handoff_id: id, agent_id: 'payer', generation: first, effect_id: 'payment:invoice-42', state: 'starting', target: 'bank' });
  // The payer's answer is lost and its hold runs out: the payment may or may not have happened.
  time += 10 * 60_000;
  agents.reconcile();
  const generation = agents.take({ agent_id: 'payer' }).generation;
  return { agents, id, generation, advance: ms => { time += ms; }, iso: () => new Date(time).toISOString() };
}

test('an unknown effect leaves its holder only looking: no further effect starts and finishing is refused', () => {
  const { agents, id, generation } = setUp();
  const locked = agents.recordEffect({ handoff_id: id, agent_id: 'payer', generation, effect_id: 'mail:supplier', state: 'starting' });
  assert.equal(locked.proceed, false);
  assert.equal(locked.locked_by, 'payment:invoice-42');
  assert.deepEqual(locked.outcome, effectOutcome('unknown'));
  assert.equal(locked.outcome.required_next, 'check_target');
  // Looking is still allowed.
  assert.equal(agents.read({ handoff_id: id }).handoff.effects.find(effect => effect.effect_id === 'mail:supplier'), undefined);
  assert.throws(() => agents.finish({ handoff_id: id, agent_id: 'payer', generation, result: 'done' }), /payment:invoice-42 is unknown/);
});

test('words in the conversation from anyone but the person keep the lock; the person\'s next message releases it', () => {
  const { agents, id, generation, advance, iso } = setUp();
  advance(60_000);
  agents.sourceActive({ source_id: 'chat-7', active_at: iso() });
  assert.equal(agents.recordEffect({ handoff_id: id, agent_id: 'payer', generation, effect_id: 'mail:supplier', state: 'starting' }).proceed, false);
  // A message the person said before the effect became unknown releases nothing.
  agents.sourceActive({ source_id: 'chat-7', active_at: iso(), person_said_at: '2026-10-19T07:00:00Z' });
  assert.equal(agents.recordEffect({ handoff_id: id, agent_id: 'payer', generation, effect_id: 'mail:supplier', state: 'starting' }).proceed, false);
  advance(60_000);
  const spoke = iso();
  const released = agents.sourceActive({ source_id: 'chat-7', active_at: spoke, person_said_at: spoke });
  assert.ok(released.handoff_ids.includes(id));
  const payment = agents.read({ handoff_id: id }).handoff.effects.find(effect => effect.effect_id === 'payment:invoice-42');
  assert.equal(payment.state, 'unknown', 'what happened is still not known');
  assert.equal(payment.released_by_person, spoke);
  // The holder may act again, but the unknown payment itself is never started blindly again.
  assert.equal(agents.recordEffect({ handoff_id: id, agent_id: 'payer', generation, effect_id: 'mail:supplier', state: 'starting' }).proceed, true);
  assert.equal(agents.recordEffect({ handoff_id: id, agent_id: 'payer', generation, effect_id: 'payment:invoice-42', state: 'starting' }).proceed, false);
  agents.recordEffect({ handoff_id: id, agent_id: 'payer', generation, effect_id: 'mail:supplier', state: 'done', receipt: { message_id: 'm-1' } });
  assert.equal(agents.finish({ handoff_id: id, agent_id: 'payer', generation, result: 'told the supplier; the person decides about the payment' }).handoff.state, 'finished');
});

test('a receipt from checking the target also lifts the lock', () => {
  const { agents, id, generation } = setUp();
  agents.recordEffect({ handoff_id: id, agent_id: 'payer', generation, effect_id: 'payment:invoice-42', state: 'done', receipt: { bank_reference: 'tx-981' } });
  assert.equal(agents.recordEffect({ handoff_id: id, agent_id: 'payer', generation, effect_id: 'mail:supplier', state: 'starting' }).proceed, true);
});

test('a failed effect receipt carries retryable, side_effect and required_next, narrowed only toward caution', () => {
  const { agents, id, generation } = setUp();
  agents.recordEffect({ handoff_id: id, agent_id: 'payer', generation, effect_id: 'payment:invoice-42', state: 'failed', receipt: 'bank: declined' });
  const declined = agents.read({ handoff_id: id }).handoff.effects.find(effect => effect.effect_id === 'payment:invoice-42');
  assert.deepEqual(declined.outcome, { retryable: true, side_effect: 'none', required_next: 'retry', next_said: 'It did not happen; it may be asked again.' });
  agents.recordEffect({ handoff_id: id, agent_id: 'payer', generation, effect_id: 'mail:supplier', state: 'starting' });
  agents.recordEffect({ handoff_id: id, agent_id: 'payer', generation, effect_id: 'mail:supplier', state: 'failed', receipt: 'bounced', retryable: false, required_next: 'check_target', side_effect: 'a draft was left' });
  const bounced = agents.read({ handoff_id: id }).handoff.effects.find(effect => effect.effect_id === 'mail:supplier');
  assert.equal(bounced.outcome.retryable, false);
  assert.equal(bounced.outcome.required_next, 'check_target');
  assert.equal(bounced.outcome.side_effect, 'a draft was left');
  // An unknown effect is never declared safe to repeat by what a caller says, and an unnamed next step is ignored.
  assert.deepEqual(effectOutcome('unknown', { retryable: true, side_effect: 'none', required_next: 'made-up' }), effectOutcome('unknown'));
  assert.equal(effectOutcome('a-state-with-no-row').retryable, false);
});
