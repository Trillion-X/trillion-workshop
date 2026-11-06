// Ported from old trillion test/guided.test.mjs (tag old-trillion-before-worker-retire, b6ae0ebf81), deleted by
// Trillion-X/trillion #243. The walk ran DecisionEngine (src/engine.mjs guide, decideGuided) over the shipped universal
// method; here it runs this tool's door tools over the made-up method of fixtures.mjs (scope, outcome, proof, and
// existing switched off by compare_existing), each step filled to its declared shape as scripts/fill-answer.mjs did and
// judged by the caller's second judge (every check needs a verdict here, read-data/decisions.mjs invariant 7).
// Changed as the owner behaves: a replayed answer's reply carries `replayed: true` (decisions.mjs `replayed`) and the
// first reply `ready_for_decision`, so the two replies are compared without those two marks. A decision has no `actions`
// list of its own here (the old record's `actions` was always empty after deciding); its root keeps `actions: []`.
import test from 'node:test';
import assert from 'node:assert/strict';
import { answerADecisionQuestion, makeTheDecision, nextDecisionQuestion, startADecision } from '../read-data/decisions.mjs';
import { caseView } from './fixtures.mjs';
import { account, fill, judged } from './old-engine-for-tests.mjs';

const without = ({ replayed, ready_for_decision, ...rest }) => rest;

test('an agent completes applicable checks, explains omissions, and resumes its own task', async () => {
  const door = account();
  const record = await startADecision({
    source_id: 'customer-request-1', goal: 'Make signup work',
    evidence: [{ ref: 'browser:signup', claim: 'Submit did not create an account.' }],
    options: [{ id: 'repair', label: 'Repair signup' }, { id: 'rewrite', label: 'Rewrite page copy' }],
  }, { door });
  const id = record.case_id;
  await assert.rejects(makeTheDecision({ decision_id: id, decision: { option_id: 'repair' } }, { door }), /guided questions/);
  await assert.rejects(answerADecisionQuestion({ decision_id: id, step_id: 'proof', answer: {} }, { door }), /waiting for its "scope" question \(0 answered so far\), not "proof"/);
  const decision_context = { worth_weighing: true, compare_existing: false };
  await assert.rejects(answerADecisionQuestion({ decision_id: id, step_id: 'scope', answer: {
    decision_context, omission_reasons: {}, evidence_refs: ['browser:signup'],
  } }, { door }), /Explain why compare_existing is omitted/);
  const answers = [
    ['scope', {}],
    ['outcome', { desired_result: 'One completed signup', current_state: 'Submit fails' }],
    ['proof', { measure: 'A new account appears in the account owner' }],
  ];
  for (const [step_id, values] of answers) {
    const before = await nextDecisionQuestion({ decision_id: id }, { door });
    assert.equal(before.question.step_id, step_id);
    // Every part the step asks for is filled to its declared shape, the way a careful caller reads the schema.
    const filled = fill(before.question, { refs: ['browser:signup'], switches: decision_context });
    const submission = { decision_id: id, step_id, answer: { ...filled, ...values, evidence_refs: ['browser:signup'] }, verdicts: judged(before.question, 'browser:signup') };
    const after = await answerADecisionQuestion(submission, { door });
    assert.equal(after.source_id, 'customer-request-1');
    const again = await answerADecisionQuestion(submission, { door });
    assert.equal(again.replayed, true);
    assert.deepEqual(without(again), without(after));
  }
  const ready = await nextDecisionQuestion({ decision_id: id }, { door });
  assert.equal(ready.question, null);
  assert.equal(ready.method_coverage.selected.length, answers.length);
  assert.deepEqual(ready.method_coverage.omitted.map(item => item.step_id), ['existing'], 'the step its switch turned off is omitted');
  // A weighty decision names who it changes beyond the person; the reply that asks for the decision says so.
  assert.deepEqual(ready.decision_fields.map(field => field.name), ['who_it_changes']);
  const chosen = { option_id: 'repair', reason: 'The observed failure is in the submit path.', evidence_refs: ['browser:signup'], next_action: 'Repair the signup field contract', success_measure: 'A new account appears after submit' };
  await assert.rejects(makeTheDecision({ decision_id: id, decision: chosen }, { door }), /Decision needs who_it_changes/);
  const result = await makeTheDecision({ decision_id: id, decision: { ...chosen, who_it_changes: 'People trying to sign up can finish creating an account instead of losing what they typed' } }, { door });
  assert.equal(result.decision.option_id, 'repair');
  assert.equal(result.resume.next_action, 'Repair the signup field contract');
  assert.equal(result.method_coverage.omitted.length, 1);
  const saved = caseView(door, id);
  assert.equal(saved.answered_steps.length, answers.length);
  assert.equal(saved.actions.length, 0);
  assert.equal(saved.status, 'needs_outcome');
});
