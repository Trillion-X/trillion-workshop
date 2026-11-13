// A call's fields are checked against its tool row's input_schema: a field the call does not declare is refused by name, and
// a field a free-form object holds that the call declares at its top level (answer.verdicts) is refused where it belongs,
// not as verdicts_missing (the answer read no verdicts there and said nothing about them).
import test from 'node:test';
import assert from 'node:assert/strict';
import { answerADecisionQuestion, startADecision } from '../read-data/decisions.mjs';
import { account, fill, judged } from './old-engine-for-tests.mjs';

const input = {
  source_id: 'input-fields', goal: 'Get the call fields checked by name',
  evidence: [{ ref: 'user-verbatim', claim: 'Check the fields a caller sends' }],
  options: [{ id: 'check', label: 'Check every field' }, { id: 'skip', label: 'Skip the check' }],
};

async function atOutcome() {
  const door = account();
  const { case_id: id, question: scope } = await startADecision(input, { door });
  const { question } = await answerADecisionQuestion({ decision_id: id, step_id: 'scope', answer: fill(scope, { refs: ['user-verbatim'] }) }, { door });
  assert.equal(question.step_id, 'outcome');
  return { door, id, question };
}

test('verdicts sent inside the answer are refused where they belong, not as verdicts_missing', async () => {
  const { door, id, question } = await atOutcome();
  const answer = { ...fill(question, { refs: ['user-verbatim'] }), verdicts: judged(question, 'user-verbatim') };
  await assert.rejects(answerADecisionQuestion({ decision_id: id, step_id: 'outcome', answer }, { door }), error => {
    assert.doesNotMatch(error.message, /verdicts_missing|have none taken|waiting for/, error.message);
    assert.match(error.message, /"verdicts" belongs at the top level of the call, not inside "answer"/, error.message);
    return true;
  });
});

test('a field the call does not declare is refused by name, with the fields it does declare', async () => {
  const { door, id, question } = await atOutcome();
  const answer = fill(question, { refs: ['user-verbatim'] });
  await assert.rejects(answerADecisionQuestion({ decision_id: id, step_id: 'outcome', answer, verdicts: judged(question, 'user-verbatim'), verdict_notes: 'extra' }, { door }), error => {
    assert.match(error.message, /"verdict_notes" is not a field of this call/, error.message);
    assert.match(error.message, /decision_id, step_id, answer, verdicts, usage, from, revise, confirm/, error.message);
    return true;
  });
});
