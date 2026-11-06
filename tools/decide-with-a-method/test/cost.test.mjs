// Ported from old trillion test/cost.test.mjs (tag old-trillion-before-worker-retire, b6ae0ebf81), deleted by
// Trillion-X/trillion #243. The old run kept each step's usage and summed it with src/engine.mjs costOf; here a step's
// usage is kept by tool:answer-a-decision-question (decisions.mjs usageOf) and the decision's by tool:make-the-decision,
// and their sum, the seconds from opening to deciding and the steps counted are what the Decisions screen counts
// (read-data/work-screen.mjs helpedItem and whatHelpedOf). The sum keeps numbers only (work-screen.mjs `numbers`), so the
// model's name is asserted on the step and the decision where it is kept, not in the sum.
// Left out, no running owner: the markdown export's "What it took" lines (src/report.mjs exportCase; searched the three
// repos for exportCase and "What it took": nothing), and the whole second test, the service logging every answer an app
// sends, accepted or refused, with its app (src/routes.mjs handleCaseRequest and costOf().calls; searched for
// handleCaseRequest, recordCall, costOf and "x-trillion-app" call logs: no running code keeps a decision's calls; this
// tool keeps no call log and reads `decision-call` records only of a decision once kept whole, decision-records.mjs).
import test from 'node:test';
import assert from 'node:assert/strict';
import { answerADecisionQuestion, makeTheDecision, nextDecisionQuestion, startADecision } from '../read-data/decisions.mjs';
import { helpedItem, whatHelpedOf } from '../read-data/work-screen.mjs';
import { readDecision } from '../read-data/decision-records.mjs';
import { account, fill, judged } from './old-engine-for-tests.mjs';

test('a run keeps what each step cost, sums it, and refuses a usage report that is not countable', async () => {
  const door = account();
  const record = await startADecision({
    source_id: 'snack-1', goal: 'Pick a snack',
    evidence: [{ ref: 'person:words', claim: 'Wants something to eat.' }],
    options: [{ id: 'fruit', label: 'Fruit' }, { id: 'skip', label: 'Skip' }],
  }, { door });
  const id = record.case_id;
  const scope = fill(record.question, { refs: ['person:words'] });
  await assert.rejects(answerADecisionQuestion({ decision_id: id, step_id: 'scope', answer: scope, usage: { input_tokens: -1 } }, { door }), /usage/);
  await assert.rejects(answerADecisionQuestion({ decision_id: id, step_id: 'scope', answer: scope, usage: ['tokens'] }, { door }), /usage/);
  await answerADecisionQuestion({ decision_id: id, step_id: 'scope', answer: scope, usage: { model: 'test-model', model_calls: 2, output_tokens: 300 } }, { door });
  // The rest of the walk, so the decision can be made with its own usage.
  for (let step = 0; step < 4; step += 1) {
    const { question } = await nextDecisionQuestion({ decision_id: id }, { door });
    if (!question) break;
    await answerADecisionQuestion({ decision_id: id, step_id: question.step_id, answer: fill(question, { refs: ['person:words'] }), verdicts: judged(question, 'person:words') }, { door });
  }
  await makeTheDecision({ decision_id: id, decision: { option_id: 'fruit', reason: 'Fruit is quick to eat.', evidence_refs: ['person:words'], next_action: 'Eat an apple', success_measure: 'Not hungry in an hour' }, usage: { model: 'test-model', model_calls: 1, output_tokens: 50 } }, { door });
  const saved = await readDecision(door, id, ['scope']);
  assert.deepEqual(saved.guidance[0].usage, { model: 'test-model', model_calls: 2, output_tokens: 300 }, 'the step keeps what it cost, the model with it');
  assert.equal(saved.decision_usage.model, 'test-model');
  // Opened, then decided ninety seconds later.
  saved.decided_at = new Date(Date.parse(saved.created_at) + 90000).toISOString();
  const cost = helpedItem(saved);
  assert.deepEqual(cost.cost, { model_calls: 3, output_tokens: 350 });
  assert.equal(saved.guidance.filter(step => step.usage).length, 1, 'one step reported its cost');
  const helped = whatHelpedOf([cost]);
  assert.equal(helped.series[0].seconds, 90);
  assert.equal(saved.guidance[0].step_id, 'scope');
});
