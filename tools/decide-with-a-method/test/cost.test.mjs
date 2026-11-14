// Ported from old trillion test/cost.test.mjs (tag old-trillion-before-worker-retire, b6ae0ebf81), deleted by
// Trillion-X/trillion #243. The old run kept each step's usage and summed it with src/engine.mjs costOf; here a step's
// usage is no longer kept per answer (tool:record-method-answers keeps no usage; the step walk is gone); the decision's is kept by
// tool:make-the-decision (decisions.mjs usageOf), and a layout that still holds a step's usage sums with it, as the Decisions screen counts
// (read-data/work-screen.mjs helpedItem and whatHelpedOf). The sum keeps numbers only (work-screen.mjs `numbers`), so the
// model's name is asserted on the step and the decision where it is kept, not in the sum.
// Left out, no running owner: the markdown export's "What it took" lines (src/report.mjs exportCase; searched the three
// repos for exportCase and "What it took": nothing), and the whole second test, the service logging every answer an app
// sends, accepted or refused, with its app (src/routes.mjs handleCaseRequest and costOf().calls; searched for
// handleCaseRequest, recordCall, costOf and "x-trillion-app" call logs: no running code keeps a decision's calls; this
// tool keeps no call log and reads `decision-call` records only of a decision once kept whole, decision-records.mjs).
import test from 'node:test';
import assert from 'node:assert/strict';
import { makeTheDecision, startADecision } from '../read-data/decisions.mjs';
import { helpedItem, whatHelpedOf } from '../read-data/work-screen.mjs';
import { readDecision } from '../read-data/decision-records.mjs';
import { account, answerAll, seedSteps } from './old-engine-for-tests.mjs';

test('a decision keeps what it cost, sums it with a step that kept its own, and refuses a usage report that is not countable', async () => {
  const door = account();
  const record = await startADecision({
    source_id: 'snack-1', goal: 'Pick a snack',
    evidence: [{ ref: 'person:words', claim: 'Wants something to eat.' }],
    options: [{ id: 'fruit', label: 'Fruit' }, { id: 'skip', label: 'Skip' }],
  }, { door });
  const id = record.case_id;
  await answerAll(door, id, { ref: 'person:words' });
  const decision = { option_id: 'fruit', reason: 'Fruit is quick to eat.', evidence_refs: ['person:words'], next_action: 'Eat an apple', success_measure: 'Not hungry in an hour' };
  await assert.rejects(makeTheDecision({ decision_id: id, decision, usage: { input_tokens: -1 } }, { door }), /usage/);
  await assert.rejects(makeTheDecision({ decision_id: id, decision, usage: ['tokens'] }, { door }), /usage/);
  await makeTheDecision({ decision_id: id, decision, usage: { model: 'test-model', model_calls: 1, output_tokens: 50 } }, { door });
  const saved = await readDecision(door, id);
  assert.equal(saved.decision_usage.model, 'test-model');
  // A step an earlier decision kept with its cost (the layout stays readable).
  saved.guidance = [{ step_id: 'scope', usage: { model: 'test-model', model_calls: 2, output_tokens: 300 } }];
  // Opened, then decided ninety seconds later.
  saved.decided_at = new Date(Date.parse(saved.created_at) + 90000).toISOString();
  const cost = helpedItem(saved);
  assert.deepEqual(cost.cost, { model_calls: 3, output_tokens: 350 });
  assert.equal(saved.guidance.filter(step => step.usage).length, 1, 'one step reported its cost');
  const helped = whatHelpedOf([cost]);
  assert.equal(helped.series[0].seconds, 90);
});
