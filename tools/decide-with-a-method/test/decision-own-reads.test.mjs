import test from 'node:test';
import assert from 'node:assert/strict';
import { startADecision } from '../read-data/decisions.mjs';
import { laidTogether } from '../read-data/decision-records.mjs';
import { similarDecisions } from '../read-data/similar-decisions.mjs';
import { account, counting, seedSteps } from './old-engine-for-tests.mjs';
import { run, heldOf } from './fixtures.mjs';
// Ported from old trillion test/decision-own-reads.test.mjs (tag old-trillion-before-worker-retire, b6ae0ebf81),
// deleted by Trillion-X/trillion #243. engine.related is tool:bring-back-similar-decisions (read-data/
// similar-decisions.mjs) and engine.ownOf is laidTogether with no lists (read-data/decision-records.mjs), both over the
// records the caller hands in. The old test counted SQL statements naming a `decision-step:` or `decision-call:` key; here
// the records a caller hands are counted (old-engine-for-tests.mjs `counting`). The long decisions are opened with
// tool:start-a-decision and given 30 logged tries each as this layout keeps a call (`decision-call:<id>:<nnnnnn>`,
// decide-with-a-method.json `records.call`) and an answered step.

// An answered step and a logged call: the records the similar-decisions read never asks for.
const ANSWERS_AND_TRIES = /^decision-(step|answered-step|call)$/;

// The records a caller hands the similar-decisions read: every decision's root and its laid-apart lists, not its answers or tries.
const withoutAnswersOrTries = store => ({
  all: () => store.all().filter(record => !ANSWERS_AND_TRIES.test(record.type)),
  write: list => store.write(list),
});

test('similar decisions and a decision\'s own fields answer the same without its answers or tries handed in', async () => {
  const base = account();
  const ids = [];
  for (let i = 0; i < 8; i += 1) {
    const { case_id: id } = await run(base, startADecision, {
      source_id: `long-${i}`, goal: `Decide how the bakery prices its sourdough loaves in season ${i}`,
      evidence: [{ ref: 'e', claim: 'The bakery sells out by noon.' }],
      options: [{ id: 'a', label: 'Raise the price' }, { id: 'b', label: 'Bake more' }],
    });
    await seedSteps(base, id, ['scope'], { ref: 'e' });
    // A long decision: many tries, each keeping what it sent.
    for (let n = 0; n < 30; n += 1) base.put(`decision-call:${id}:${String(n).padStart(6, '0')}`, 'decision-call', { route: 'guide', step_id: 'outcome', accepted: false, reason: 'refused', at: new Date().toISOString(), bytes: 4000, submission: { answer: 'x'.repeat(4000) } });
    base.put(id, 'decision', { ...base.value(id), call_count: 30 });
    ids.push(id);
  }
  const everything = await run(base, similarDecisions, { decision_id: ids[0], limit: 5 });
  const door = counting(withoutAnswersOrTries(base));
  const { similar_decisions: similar } = await run(door, similarDecisions, { decision_id: ids[0], limit: 5 });
  assert.equal(similar.length, 5);
  assert.ok(similar.every(item => item.goal.includes('sourdough') && Array.isArray(item.observed)));
  assert.deepEqual(similar, everything.similar_decisions, 'the answer is the same whether the answers and tries are handed in or not');
  assert.equal(door.take().handed.some(item => ANSWERS_AND_TRIES.test(item.type)), false, 'no answer or try is handed to the read');

  // A decision's own fields are read from its root and laid-apart lists even with its tries in the store: they are not embedded.
  const { record: own } = laidTogether(heldOf(base), ids[1], base.value(ids[1]), []);
  assert.equal(own.input.goal, 'Decide how the bakery prices its sourdough loaves in season 1');
  assert.equal(own.calls, undefined, 'its tries are not read');
});
