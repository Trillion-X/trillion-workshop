// A step whose record cannot be read is kept as it was: a later write that touches its case leaves its reference where it
// stood. Before this, the reader gave that step a summary with no step in it, and the write kept that summary in place of the
// step's own record, so the case lost its answered steps for good.
import test from 'node:test';
import assert from 'node:assert/strict';
import { addDecisionEvidence, answerADecisionQuestion, startADecision } from '../read-data/decisions.mjs';
import { account, fill, judged } from './old-engine-for-tests.mjs';
import { refsOfCase } from './fixtures.mjs';
import { readFileSync } from 'node:fs';

const settings = JSON.parse(readFileSync(new URL('../read-data/decide-with-a-method.json', import.meta.url), 'utf8'));
const ANSWERED = settings.records.laid_apart.answered_steps.type;
const input = {
  source_id: 'lost-steps', goal: 'Keep the answered steps of a case that a later write touches',
  evidence: [{ ref: 'user-verbatim', claim: 'Last spring twelve families signed up at the old price' }, { ref: 'e2', claim: 'The kiln costs went up this year' }],
  options: [{ id: 'keep', label: 'Keep the price' }, { id: 'raise', label: 'Raise the price' }],
};

test('a later write refuses a case whose unreadable step is gone, and changes nothing', async () => {
  const door = account();
  const { case_id: id, question: scope } = await startADecision(input, { door });
  const scoped = await answerADecisionQuestion({ decision_id: id, step_id: 'scope', answer: fill(scope, { refs: ['user-verbatim'] }) }, { door });
  await answerADecisionQuestion({ decision_id: id, step_id: 'outcome', answer: fill(scoped.question, { refs: ['user-verbatim'] }), verdicts: judged(scoped.question, 'user-verbatim') }, { door });
  const before = (await refsOfCase(door, id)).items.answered_steps;
  assert.equal(before.length, 2, 'two answered steps are kept');
  // The outcome step's own record cannot be read (it is gone from the door), while the decision still holds the step.
  door.records.delete(`${ANSWERED}:${id}:001:c${before[1]}`);
  const keysBefore = [...door.records.keys()].sort();
  await assert.rejects(() => addDecisionEvidence({ decision_id: id, evidence: [{ ref: 'e3', claim: 'The waiting list grew this month' }] }, { door }), /not visible/);
  assert.deepEqual([...door.records.keys()].sort(), keysBefore, 'nothing is written in place of the unreadable step');
  assert.equal((await refsOfCase(door, id)).items.answered_steps[1], before[1], 'the reference to the unreadable step stands');
});
