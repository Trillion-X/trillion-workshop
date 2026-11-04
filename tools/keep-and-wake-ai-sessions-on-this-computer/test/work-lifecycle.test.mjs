// The work lifecycle of a handoff (src/agents.mjs): one work record, attempts fenced by generation, a next step for
// every unfinished item kept by the reconciler, strict and preferred targets, and effects that are never repeated.
import test from 'node:test';
import assert from 'node:assert/strict';
import { makeAgents, nextStepOf } from '../../shared-code/src/agents.mjs';
import { agentStoreForTests } from '../../shared-code/test/agent-store-for-tests.mjs';

function clock(start = '2026-09-30T08:00:00Z') {
  let time = new Date(start).getTime();
  return { now: () => new Date(time), advance: minutes => { time += minutes * 60_000; } };
}

function setUp(...ids) {
  const time = clock();
  const store = agentStoreForTests();
  const agents = makeAgents({ store, now: time.now });
  for (const agent_id of ids) agents.publish({ agent_id, name: agent_id, description: 'Does work', delivery: { url: `https://${agent_id}.example/events` } });
  return { time, store, agents };
}

// Every unfinished handoff has exactly one next step.
function everyOpenHasANextStep(agents, store) {
  for (const item of store.openHandoffs()) {
    const seen = agents.read({ handoff_id: item.handoff_id }).handoff;
    assert.ok(seen.next_step, `${item.handoff_id} has no next step`);
  }
}

test('an expired hold goes back to waiting on the same record, the attempt is kept, and the next take is a new generation', () => {
  const { time, store, agents } = setUp('first', 'second');
  const { handoff } = agents.handOff({ job: 'Write the report', request_key: 'expired-hold', hold_minutes: 10 });
  const first = agents.take({ agent_id: 'first', handoff_id: handoff.handoff_id });
  assert.equal(first.generation, 1);
  assert.equal(first.handoff.next_step.kind, 'attempt');
  time.advance(10);
  const done = agents.reconcile();
  assert.deepEqual(done.reopened, [handoff.handoff_id]);
  const waiting = agents.read({ handoff_id: handoff.handoff_id }).handoff;
  assert.equal(waiting.state, 'open');
  assert.equal(waiting.next_step.kind, 'due');
  assert.deepEqual(waiting.attempts.map(attempt => [attempt.agent_id, attempt.generation, attempt.ended]), [['first', 1, 'expired']]);
  const second = agents.take({ agent_id: 'second' });
  assert.equal(second.handoff.handoff_id, handoff.handoff_id);
  assert.equal(second.generation, 2);
  assert.equal(store.openHandoffs().length, 1);
  everyOpenHasANextStep(agents, store);
});

test('a write from an older generation is refused: finish, renew, what is in the way, and effects', () => {
  const { time, agents } = setUp('worker');
  const id = agents.handOff({ to_agent: 'worker', job: 'Update the page', request_key: 'fencing', hold_minutes: 10 }).handoff.handoff_id;
  const old = agents.take({ agent_id: 'worker', handoff_id: id }).generation;
  time.advance(11);
  agents.reconcile();
  const current = agents.take({ agent_id: 'worker', handoff_id: id }).generation;
  assert.equal(current, old + 1);
  assert.throws(() => agents.finish({ handoff_id: id, agent_id: 'worker', generation: old, result: 'late' }), /attempt 1 is no longer current/);
  assert.throws(() => agents.take({ agent_id: 'worker', handoff_id: id, generation: old }), /no longer current/);
  assert.throws(() => agents.sayInTheWay({ handoff_id: id, agent_id: 'worker', generation: old, in_the_way: 'stale' }), /no longer current/);
  assert.throws(() => agents.recordEffect({ handoff_id: id, agent_id: 'worker', generation: old, effect_id: 'post:1', state: 'starting' }), /no longer current/);
  assert.equal(agents.read({ handoff_id: id }).handoff.state, 'taken');
  const finished = agents.finish({ handoff_id: id, agent_id: 'worker', generation: current, result: 'done' });
  assert.equal(finished.handoff.state, 'finished');
  assert.equal(finished.handoff.attempts.at(-1).ended, 'finished');
});

test('two agents competing for one job: exactly one wins, the other gets nothing and cannot finish it', () => {
  const { agents } = setUp('a', 'b');
  const { handoff } = agents.handOff({ job: 'Only one should do this', request_key: 'race' });
  const claims = [agents.take({ agent_id: 'a' }), agents.take({ agent_id: 'b' })];
  const winners = claims.filter(claim => claim.handoff);
  assert.equal(winners.length, 1);
  assert.equal(winners[0].handoff.handoff_id, handoff.handoff_id);
  assert.equal(agents.take({ agent_id: 'b', handoff_id: handoff.handoff_id }).handoff, null);
  assert.throws(() => agents.finish({ handoff_id: handoff.handoff_id, agent_id: 'b', result: 'mine' }), /not taken by b/);
});

test('a take respects capacity: an agent full of work takes nothing more', () => {
  const { agents } = setUp('busy');
  agents.setCapacity({ agent_id: 'busy', max_concurrent: 1 });
  agents.handOff({ job: 'First', request_key: 'cap-1' });
  agents.handOff({ job: 'Second', request_key: 'cap-2' });
  assert.ok(agents.take({ agent_id: 'busy' }).handoff);
  const refused = agents.take({ agent_id: 'busy' });
  assert.equal(refused.handoff, null);
  assert.equal(refused.capacity.status, 'full');
});

test('the reconciler repairs a row with no next step, and blocks work nobody can take with its reason and way out', () => {
  const { time, store, agents } = setUp('worker');
  // A row kept before the lifecycle existed: open, no review time, nothing else.
  store.putHandoff({ handoff_id: 'h_legacy', asked: {}, job: 'Old job', input: null, to_agent: null, from_agent: null, case_id: null, parent_handoff_id: null, hold_minutes: 60, state: 'open', handed_at: '2026-09-29T00:00:00.000Z', taken_by: null, taken_at: null, hold_until: null, finished_at: null, result: null, summary: null });
  assert.equal(agents.read({ handoff_id: 'h_legacy' }).handoff.next_step, null);
  assert.equal(agents.nextReviewAt(), time.now().getTime());
  const done = agents.reconcile();
  assert.deepEqual(done.repaired, ['h_legacy']);
  assert.deepEqual(done.woken, ['h_legacy']);
  const repaired = agents.read({ handoff_id: 'h_legacy' });
  assert.equal(repaired.handoff.next_step.kind, 'due');
  assert.deepEqual(repaired.deliveries.map(event => event.agent_id), ['worker']);

  // With no AI taking work at all, the job is stuck with the reason, and it goes on when one connects.
  agents.publish({ agent_id: 'worker', name: 'worker', description: 'Does work', takes_work: false });
  time.advance(16);
  assert.deepEqual(agents.reconcile().blocked, ['h_legacy']);
  const stuck = agents.read({ handoff_id: 'h_legacy' }).handoff;
  assert.equal(stuck.status, 'blocked');
  assert.equal(stuck.next_step.kind, 'blocked');
  assert.equal(stuck.in_the_way_by, 'trillion');
  assert.match(stuck.next_step.recovery, /connects/);
  assert.equal(agents.take({ agent_id: 'worker' }).capacity.status, 'paused');
  agents.publish({ agent_id: 'worker', name: 'worker', description: 'Does work', takes_work: true });
  time.advance(6 * 60);
  assert.deepEqual(agents.reconcile().unblocked, ['h_legacy']);
  assert.equal(agents.read({ handoff_id: 'h_legacy' }).handoff.status, 'open');
  everyOpenHasANextStep(agents, store);
});

test('a strict target that stops taking work leaves the job stuck for it, never handed to another AI', () => {
  const { time, agents } = setUp('chosen', 'other');
  const id = agents.handOff({ to_agent: 'chosen', job: 'Only the chosen AI may do this', request_key: 'strict', target: { strict: true } }).handoff.handoff_id;
  agents.publish({ agent_id: 'chosen', name: 'chosen', description: 'Does work', takes_work: false });
  time.advance(16);
  const done = agents.reconcile();
  assert.deepEqual(done.blocked, [id]);
  assert.deepEqual(done.released, []);
  const stuck = agents.read({ handoff_id: id }).handoff;
  assert.equal(stuck.to_agent, 'chosen');
  assert.equal(stuck.next_step.kind, 'blocked');
  assert.match(stuck.in_the_way, /chosen has stopped taking work, and this job is only for it/);
  assert.equal(agents.take({ agent_id: 'other' }).handoff, null);
  assert.equal(agents.take({ agent_id: 'other', handoff_id: id }).handoff, null);
  agents.publish({ agent_id: 'chosen', name: 'chosen', description: 'Does work', takes_work: true });
  time.advance(6 * 60);
  assert.deepEqual(agents.reconcile().unblocked, [id]);
  assert.equal(agents.take({ agent_id: 'chosen' }).handoff.handoff_id, id);
});

test('a preferred agent is only a preference: when it runs out, any AI takes the same job', () => {
  const { time, agents } = setUp('preferred', 'other');
  const id = agents.handOff({ to_agent: 'preferred', job: 'Preferred but not required', request_key: 'prefer', target: { prefer_minutes: 30 } }).handoff.handoff_id;
  assert.equal(agents.take({ agent_id: 'other' }).handoff, null);
  time.advance(30);
  // Even before the reconciler runs, the preference is over.
  assert.equal(agents.take({ agent_id: 'other', handoff_id: id }).handoff.handoff_id, id);

  const second = agents.handOff({ to_agent: 'preferred', job: 'Another preferred job', request_key: 'prefer-2', target: { prefer_minutes: 30 } }).handoff.handoff_id;
  time.advance(30);
  assert.deepEqual(agents.reconcile().released, [second]);
  const released = agents.read({ handoff_id: second }).handoff;
  assert.equal(released.to_agent, null);
  assert.equal(released.preferred_agent, 'preferred');
  assert.equal(released.handoff_id, second);
});

test('an effect is never repeated: a lost answer after starting leaves it unknown until its target is checked', () => {
  const { time, agents } = setUp('payer', 'other');
  const id = agents.handOff({ job: 'Pay invoice 42', request_key: 'effects', hold_minutes: 10 }).handoff.handoff_id;
  const first = agents.take({ agent_id: 'payer' }).generation;
  const start = agents.recordEffect({ handoff_id: id, agent_id: 'payer', generation: first, effect_id: 'payment:invoice-42', state: 'starting', target: 'bank' });
  assert.equal(start.proceed, true);
  assert.equal(agents.recordEffect({ handoff_id: id, agent_id: 'payer', generation: first, effect_id: 'payment:invoice-42', state: 'starting' }).repeated, true);
  // The payer's answer is lost and its hold runs out: the effect may or may not have happened.
  time.advance(10);
  agents.reconcile();
  assert.equal(agents.read({ handoff_id: id }).handoff.effects[0].state, 'unknown');
  const next = agents.take({ agent_id: 'other' }).generation;
  const again = agents.recordEffect({ handoff_id: id, agent_id: 'other', generation: next, effect_id: 'payment:invoice-42', state: 'starting' });
  assert.equal(again.proceed, false);
  assert.equal(again.effect.state, 'unknown');
  assert.throws(() => agents.finish({ handoff_id: id, agent_id: 'other', generation: next, result: 'paid' }), /payment:invoice-42 is unknown/);
  assert.throws(() => agents.recordEffect({ handoff_id: id, agent_id: 'other', generation: next, effect_id: 'payment:invoice-42', state: 'done' }), /give the receipt/);
  const settled = agents.recordEffect({ handoff_id: id, agent_id: 'other', generation: next, effect_id: 'payment:invoice-42', state: 'done', receipt: { bank_reference: 'tx-981' } });
  assert.equal(settled.effect.state, 'done');
  assert.equal(agents.recordEffect({ handoff_id: id, agent_id: 'other', generation: next, effect_id: 'payment:invoice-42', state: 'starting' }).proceed, false);
  assert.equal(agents.finish({ handoff_id: id, agent_id: 'other', generation: next, result: 'paid once' }).handoff.state, 'finished');
});

test('a failed effect may be tried again; an effect must be started before it is done', () => {
  const { agents } = setUp('poster');
  const id = agents.handOff({ job: 'Post it', request_key: 'failed-effect' }).handoff.handoff_id;
  const generation = agents.take({ agent_id: 'poster' }).generation;
  assert.throws(() => agents.recordEffect({ handoff_id: id, agent_id: 'poster', generation, effect_id: 'post:1', state: 'done' }), /as starting before/);
  agents.recordEffect({ handoff_id: id, agent_id: 'poster', generation, effect_id: 'post:1', state: 'starting' });
  agents.recordEffect({ handoff_id: id, agent_id: 'poster', generation, effect_id: 'post:1', state: 'failed', receipt: 'rejected: 503' });
  const retry = agents.recordEffect({ handoff_id: id, agent_id: 'poster', generation, effect_id: 'post:1', state: 'starting' });
  assert.equal(retry.proceed, true);
  assert.equal(retry.effect.tries, 2);
});

test('duplicate and reordered take and finish events change nothing twice', () => {
  const { agents, store } = setUp('worker');
  const asked = { job: 'Do it once', request_key: 'duplicates' };
  const id = agents.handOff(asked).handoff.handoff_id;
  assert.equal(agents.handOff(asked).repeated, true);
  assert.equal(store.openHandoffs().length, 1);
  // A finish that arrives before its take is refused and changes nothing.
  assert.throws(() => agents.finish({ handoff_id: id, agent_id: 'worker', result: 'early' }), /take it first/);
  assert.equal(agents.read({ handoff_id: id }).handoff.state, 'open');
  const taken = agents.take({ agent_id: 'worker', handoff_id: id });
  const again = agents.take({ agent_id: 'worker', handoff_id: id, generation: taken.generation });
  assert.equal(again.renewed, true);
  assert.equal(again.generation, taken.generation);
  const done = agents.finish({ handoff_id: id, agent_id: 'worker', generation: taken.generation, result: 'once' });
  const revision = done.handoff.revision;
  assert.equal(agents.finish({ handoff_id: id, agent_id: 'worker', generation: taken.generation, result: 'once' }).repeated, true);
  assert.throws(() => agents.finish({ handoff_id: id, agent_id: 'worker', result: 'a different result' }), /already finished/);
  assert.equal(agents.take({ agent_id: 'worker', handoff_id: id }).handoff, null);
  assert.equal(agents.read({ handoff_id: id }).handoff.revision, revision);
  assert.equal(agents.read({ handoff_id: id }).handoff.attempts.length, 1);
});

test('work that depends on other work waits for it, then is announced and taken', () => {
  const { store, agents } = setUp('worker');
  const first = agents.handOff({ job: 'Build it', request_key: 'dep-first' }).handoff.handoff_id;
  const second = agents.handOff({ job: 'Ship it', request_key: 'dep-second', depends_on: [first], outcome: 'It is live', success_condition: 'The live page shows it' });
  assert.equal(second.handoff.next_step.kind, 'dependency');
  assert.deepEqual(second.handoff.next_step.on, [first]);
  assert.equal(second.handoff.success_condition, 'The live page shows it');
  assert.deepEqual(agents.read({ handoff_id: second.handoff.handoff_id }).deliveries, []);
  assert.equal(agents.take({ agent_id: 'worker' }).handoff.handoff_id, first);
  assert.equal(agents.take({ agent_id: 'worker', handoff_id: second.handoff.handoff_id }).handoff, null);
  agents.finish({ handoff_id: first, agent_id: 'worker', result: 'built' });
  assert.equal(agents.read({ handoff_id: second.handoff.handoff_id }).handoff.next_step.kind, 'due');
  assert.deepEqual(agents.reconcile().woken, [second.handoff.handoff_id]);
  assert.equal(agents.take({ agent_id: 'worker' }).handoff.handoff_id, second.handoff.handoff_id);
  assert.throws(() => agents.handOff({ job: 'x', request_key: 'dep-bad', depends_on: ['h_nothing'] }), /not a handoff/);
  everyOpenHasANextStep(agents, store);
});

test('work taken again and again without finishing stops after its attempts, stuck with its reason', () => {
  const { time, agents } = setUp('flaky');
  const id = agents.handOff({ job: 'Keeps failing', request_key: 'budget', hold_minutes: 5, max_attempts: 2 }).handoff.handoff_id;
  for (let round = 0; round < 2; round += 1) {
    assert.equal(agents.take({ agent_id: 'flaky' }).handoff.handoff_id, id);
    time.advance(5);
    agents.reconcile();
  }
  const stopped = agents.read({ handoff_id: id }).handoff;
  assert.equal(stopped.status, 'blocked');
  assert.match(stopped.in_the_way, /Taken 2 times/);
  assert.equal(agents.take({ agent_id: 'flaky' }).handoff, null);
  // Taking it by name is the way out.
  const retaken = agents.take({ agent_id: 'flaky', handoff_id: id });
  assert.equal(retaken.handoff.status, 'taken');
  assert.equal(retaken.generation, 3);
});

test('waiting work is announced again with backoff, a bounded number of times, and is never lost', () => {
  const { time, store, agents } = setUp('sleepy');
  const id = agents.handOff({ job: 'Waiting for a long time', request_key: 'backoff' }).handoff.handoff_id;
  const gaps = [];
  let last = time.now().getTime();
  for (let round = 0; round < 8; round += 1) {
    const due = agents.nextReviewAt();
    gaps.push((due - last) / 60_000);
    time.advance((due - time.now().getTime()) / 60_000);
    last = due;
    agents.reconcile();
  }
  assert.deepEqual(gaps, [15, 15, 30, 60, 120, 240, 360, 360]);
  // One wake when it was handed off, then MAX_WAKES more, then only the review.
  assert.equal(agents.read({ handoff_id: id }).deliveries.length, 6);
  assert.equal(store.openHandoffs().length, 1);
  everyOpenHasANextStep(agents, store);
});

test('a handoff and the event announcing it are kept in one transaction', () => {
  const store = agentStoreForTests();
  const writes = [];
  let open = 0;
  const watched = { ...store,
    transaction: fn => { open += 1; try { return fn(); } finally { open -= 1; } },
    putHandoff: item => { writes.push(['handoff', open]); store.putHandoff(item); },
    putDelivery: item => { writes.push(['event', open]); store.putDelivery(item); } };
  const agents = makeAgents({ store: watched });
  agents.publish({ agent_id: 'worker', name: 'worker', description: 'Does work', delivery: { url: 'https://worker.example/events' } });
  agents.handOff({ job: 'Kept together', request_key: 'together' });
  assert.deepEqual(writes, [['handoff', 1], ['event', 1]]);
});

test('nextStepOf names exactly one step', () => {
  const nowIso = '2026-09-30T08:00:00.000Z';
  assert.equal(nextStepOf({ state: 'finished' }, { nowIso }), null);
  assert.equal(nextStepOf({ state: 'taken', hold_until: '2026-09-30T09:00:00.000Z', taken_by: 'a', generation: 2 }, { nowIso }).kind, 'attempt');
  assert.equal(nextStepOf({ state: 'open', in_the_way: 'Needs a sign-in' }, { nowIso }).kind, 'blocked');
  assert.equal(nextStepOf({ state: 'open' }, { nowIso, waitingOn: ['h_1'] }).kind, 'dependency');
  assert.equal(nextStepOf({ state: 'open', review_at: nowIso }, { nowIso }).kind, 'due');
  assert.equal(nextStepOf({ state: 'open' }, { nowIso }), null);
});
