// Ported from old trillion test/judge-reads-the-case.test.mjs (tag old-trillion-before-worker-retire, b6ae0ebf81),
// deleted by Trillion-X/trillion #243. The old service called a check judge itself (src/check-judge.mjs) and handed it
// the goal, the current evidence and the step's other answers; here Trillion asks no model (README, decisions.mjs
// header): the calling AI's own judge grades each check and sends its verdicts (read-data/verdicts.mjs). So the first
// test now checks what the question tells the caller to hand its judge (the check, this answer, the case evidence) and
// that a retracted fact is not the case: a verdict or an answer resting on it is not taken. The refusal's words are
// takeCallerVerdicts' own (ported unchanged from check-judge.mjs): the check's id, the fixed why and the check words
// the judge says are missing, every problem in full.
// Left out, no running owner: keeping a refused call with what it sent (`calls.at(-1).submission`, `problems`) and the
// last test (only the latest few refused calls keep their payloads): this tool keeps no call log (searched the three
// repos for recordCall, handleCaseRequest and decision_call_payloads: only the moved import closure
// tools/keep-and-wake-ai-sessions-on-this-computer/src/decision-store.mjs, whose addCall no running decision tool calls).
import test from 'node:test';
import assert from 'node:assert/strict';
import { answerADecisionQuestion, keepDecision, startADecision } from '../read-data/decisions.mjs';
import { readDecision } from '../read-data/decision-records.mjs';
import { account, fill, judged } from './old-engine-for-tests.mjs';

const verbatim = 'Can you please get to the correct structure of how this is supposed to be, since things are not perfectly working.';
const input = {
  source_id: 'judge-reads-the-case', goal: 'Get to the correct structure for reliable handoffs between AIs.',
  evidence: [{ ref: 'user-verbatim', claim: verbatim }, { ref: 'old', claim: 'A fact later found false.' }],
  options: [{ id: 'reconcile', label: 'Durable reconciliation' }, { id: 'manual', label: 'Keep copying by hand' }],
};

// Retracts one evidence row of a case as a write of its own: the row is kept at its new content identity and the root moves with it.
async function retract(door, id, ref) {
  const record = await readDecision(door, id);
  record.input.evidence.find(item => item.ref === ref).retracted_at = new Date().toISOString();
  await keepDecision(door, record, `retract-decision-evidence:${id}:${ref}`);
}

async function atOutcome() {
  const door = account();
  const { case_id: id, question: scope } = await startADecision(input, { door });
  // The old engine's reviseEvidence({ retract: ['old'] }): the row stays, marked retracted, through the same write a change makes.
  await retract(door, id, 'old');
  const { question } = await answerADecisionQuestion({ decision_id: id, step_id: 'scope', answer: fill(scope, { refs: ['user-verbatim'] }) }, { door });
  assert.equal(question.step_id, 'outcome');
  return { door, id, question };
}

test('the judge gets the goal, the current evidence and the step\'s other answers with every check answer', async () => {
  const { door, id, question } = await atOutcome();
  // What the calling AI hands its judge: the check, this answer and the case's evidence.
  assert.match(question.verdicts, /Give it the check, this answer and the evidence of the case/);
  assert.deepEqual(question.verdict_checks, question.checklist.map(row => row.id));
  const answer = fill(question, { refs: ['user-verbatim'] });
  answer.desired_result = 'The correct structure is saved in Trillion and one copy-paste message goes to the local AI.';
  // A retracted fact is not read as the case: a verdict resting on it is not taken, and an answer citing it is refused.
  await assert.rejects(answerADecisionQuestion({ decision_id: id, step_id: 'outcome', answer, verdicts: judged(question, 'old') }, { door }), /have none taken/);
  await assert.rejects(answerADecisionQuestion({ decision_id: id, step_id: 'outcome', answer: { ...answer, evidence_refs: ['old'] }, verdicts: judged(question, 'user-verbatim') }, { door }), /evidence/);
  await answerADecisionQuestion({ decision_id: id, step_id: 'outcome', answer, verdicts: judged(question, 'user-verbatim') }, { door });
  const saved = await readDecision(door, id, ['outcome']);
  assert.equal(saved.input.goal, input.goal);
  assert.deepEqual(saved.input.evidence.filter(item => !item.retracted_at).map(({ ref, claim }) => ({ ref, claim })), [{ ref: 'user-verbatim', claim: verbatim }]);
  const step = saved.guidance.find(item => item.step_id === 'outcome');
  assert.equal(step.answer.desired_result, answer.desired_result);
  assert.ok('current_state' in step.answer);
});

test('a refused answer is kept with its call, with every problem in full and the check words it misses', async () => {
  const { door, id, question } = await atOutcome();
  const [check] = question.checklist;
  const missing = 'which state it should end up in';
  const verdicts = [{ check: check.id, meets: false, rests_on: 'user-verbatim', missing, why: 'It paraphrases the person.', graded_by: 'second-judge-test' }];
  const answer = fill(question, { refs: ['user-verbatim'] });
  await assert.rejects(answerADecisionQuestion({ decision_id: id, step_id: 'outcome', answer, verdicts }, { door }), error => {
    assert.deepEqual(error.problems, [`checklist.${check.id}: The answer does not meet this check. The check asks: "${missing}".`]);
    return true;
  });
  assert.equal((await readDecision(door, id)).guidance.length, 1, 'the refused answer is not kept as the step');
});

test('a retraction written under the new layout is read back as gone, and a refused retraction moves nothing', async () => {
  const door = account();
  const { case_id: id } = await startADecision(input, { door });
  const stale = await readDecision(door, id);
  await retract(door, id, 'old');
  const kept = await readDecision(door, id);
  assert.deepEqual(kept.input.evidence.filter(item => !item.retracted_at).map(item => item.ref), ['user-verbatim'], 'the retracted row reads back as gone');
  const before = [...door.records.entries()].map(([key, kept]) => [key, JSON.stringify(kept)]);
  stale.input.evidence.find(item => item.ref === 'user-verbatim').retracted_at = new Date().toISOString();
  await assert.rejects(keepDecision(door, stale, `retract-decision-evidence:${id}:user-verbatim`), /case changed/);
  assert.deepEqual([...door.records.entries()].map(([key, kept]) => [key, JSON.stringify(kept)]), before, 'a refused retraction moves nothing');
  assert.deepEqual((await readDecision(door, id)).input.evidence.filter(item => !item.retracted_at).map(item => item.ref), ['user-verbatim']);
});
