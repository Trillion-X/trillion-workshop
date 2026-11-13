// A verdict sent with a confirmation is taken or refused by name: one that is not taken for a check already kept is never
// dropped while the kept verdict stands. A repeated answer sent with different verdicts is refused, not replayed as if the
// verdicts it sent had been kept.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { answerADecisionQuestion, startADecision } from '../read-data/decisions.mjs';
import { plainChecks, plainMethod, memoryDoor } from './fixtures.mjs';

const settings = JSON.parse(readFileSync(new URL('../read-data/decide-with-a-method.json', import.meta.url), 'utf8'));
const opened = {
  source_id: 'chat:pottery-1', goal: 'Decide the pottery camp price for spring',
  evidence: [{ ref: 'e1', claim: 'Last spring twelve families signed up at the old price' }, { ref: 'e2', claim: 'The kiln costs went up this year' }],
  options: [{ id: 'keep', label: 'Keep the price' }, { id: 'raise', label: 'Raise the price' }],
};
const scope = { decision_context: { worth_weighing: true, compare_existing: false }, omission_reasons: { compare_existing: { searched: ['the camp price list'], evidence_refs: ['e1'] } }, evidence_refs: ['e1'] };
const outcomeAnswer = {
  desired_result: 'Twelve families sign up at a price covering the kiln',
  current_state: 'The old price no longer covers the kiln costs',
  checklist: { 'outcome-before-after': { handled: true, how: 'Before: price below kiln costs; after: twelve families at a covering price', evidence_refs: ['e2'] } },
  evidence_refs: ['e1', 'e2'],
};
const judged = [{ check: 'outcome-before-after', meets: true, rests_on: 'e2', graded_by: 'second-judge-test' }];
const refusedOnce = [{ check: 'outcome-before-after', meets: false, rests_on: 'e2', missing: 'which state it should end up in', graded_by: 'second-judge-test' }];
const ungrounded = [{ check: 'outcome-before-after', meets: false, rests_on: 'e2', missing: 'a spreadsheet of costs', graded_by: 'second-judge-test' }];

function account() {
  const door = memoryDoor();
  door.put(`record:${settings.records.method_row}:plain`, `record:${settings.records.method_row}`, plainMethod());
  for (const check of plainChecks()) door.put(`record:${settings.records.check_row}:${check.id}`, `record:${settings.records.check_row}`, check);
  return door;
}
async function answeredScope(door) {
  const { case_id: id } = await startADecision(opened, { door });
  await answerADecisionQuestion({ decision_id: id, step_id: 'scope', answer: scope }, { door });
  return id;
}

test('a confirmation whose verdict is not taken for a check already kept is refused, and nothing is written', async () => {
  const door = account();
  const id = await answeredScope(door);
  await answerADecisionQuestion({ decision_id: id, step_id: 'outcome', answer: outcomeAnswer, verdicts: judged }, { door });
  const before = JSON.stringify([...door.records]);
  await assert.rejects(
    answerADecisionQuestion({ decision_id: id, step_id: 'outcome', confirm: true, verdicts: ungrounded }, { door }),
    /Check outcome-before-after already has a different verdict.*Not taken: outcome-before-after \(missing must copy words of the check/,
  );
  assert.equal(JSON.stringify([...door.records]), before, 'the refusal writes nothing');
});

test('the same answer sent with different verdicts is refused, not replayed', async () => {
  const door = account();
  const id = await answeredScope(door);
  await answerADecisionQuestion({ decision_id: id, step_id: 'outcome', answer: outcomeAnswer, verdicts: judged }, { door });
  const before = JSON.stringify([...door.records]);
  await assert.rejects(
    answerADecisionQuestion({ decision_id: id, step_id: 'outcome', answer: outcomeAnswer, verdicts: refusedOnce }, { door }),
    /already has a different verdict on this answer/,
  );
  assert.equal(JSON.stringify([...door.records]), before, 'the refusal writes nothing');
});

test('the same answer sent with the verdicts already kept still replays', async () => {
  const door = account();
  const id = await answeredScope(door);
  await answerADecisionQuestion({ decision_id: id, step_id: 'outcome', answer: outcomeAnswer, verdicts: judged }, { door });
  const again = await answerADecisionQuestion({ decision_id: id, step_id: 'outcome', answer: outcomeAnswer, verdicts: judged }, { door });
  assert.equal(again.replayed, true);
});
