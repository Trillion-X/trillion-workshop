// Checks say where they apply: a check row names the kinds of decision it applies to (`applies_to`), a case declares its
// kind at scope (`decision_kind`, one of the person's decision-kind rows), and a check that names other kinds is not
// asked of it. The reply says which checks were left out and why; a check naming no kinds is asked of every kind.
// All names and rows here are made up.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { answerADecisionQuestion, nextDecisionQuestion, startADecision } from '../read-data/decisions.mjs';
import { memoryDoor, plainChecks, plainMethod } from './fixtures.mjs';

const settings = JSON.parse(readFileSync(new URL('../read-data/decide-with-a-method.json', import.meta.url), 'utf8'));
const opened = {
  source_id: 'chat:kiln-1', goal: 'Decide how the kiln scheduler stores its bookings',
  evidence: [{ ref: 'e1', claim: 'Bookings are kept as one list per week' }, { ref: 'e2', claim: 'The scheduler reads every week on start' }],
  options: [{ id: 'weekly', label: 'Keep one list per week' }, { id: 'single', label: 'Keep one list' }],
};
const scopeWith = kind => ({ decision_context: { worth_weighing: true, compare_existing: false }, omission_reasons: { compare_existing: { searched: ['the booking list'], evidence_refs: ['e1'] } }, evidence_refs: ['e1'], ...(kind ? { decision_kind: kind } : {}) });
const handled = id => ({ [id]: { handled: true, how: 'Named the facts that answer it', evidence_refs: ['e2'] } });

function account({ kinds = true } = {}) {
  const door = memoryDoor();
  door.put(`record:${settings.records.method_row}:plain`, `record:${settings.records.method_row}`, plainMethod());
  const life = { id: 'outcome-daily-practice', part_of: 'plain', step: 'outcome', applies_to: ['life'], check: 'Does the plan name the regular practice sized to the least the person will still do on a bad day?', good_answer: 'Names the practice and its smallest size.' };
  const both = { id: 'outcome-who-pays', part_of: 'plain', step: 'outcome', applies_to: ['life', 'business'], check: 'Who pays for this and when?', good_answer: 'Names who pays.' };
  for (const check of [...plainChecks(), life, both]) door.put(`record:${settings.records.check_row}:${check.id}`, `record:${settings.records.check_row}`, check);
  if (kinds) for (const [id, about] of [['life', 'The person own life'], ['business', 'A business'], ['code-design', 'How a system is built']]) door.put(`record:${settings.records.kind_row}:${id}`, `record:${settings.records.kind_row}`, { id, name: id, about });
  return door;
}
const ids = question => question.checklist.map(item => item.id);

test('a code-design case skips a life-only check and the reply says which and why', async () => {
  const door = account();
  const { case_id: id } = await startADecision(opened, { door });
  const reply = await answerADecisionQuestion({ decision_id: id, step_id: 'scope', answer: scopeWith('code-design') }, { door });
  assert.equal(reply.question.step_id, 'outcome');
  assert.deepEqual(ids(reply.question).sort(), ['outcome-before-after']);
  assert.deepEqual(reply.question.skipped_checks.map(item => item.id).sort(), ['outcome-daily-practice', 'outcome-who-pays']);
  const skipped = reply.question.skipped_checks.find(item => item.id === 'outcome-daily-practice');
  assert.deepEqual(skipped.applies_to, ['life']);
  assert.match(skipped.reason, /code-design decision.*life decisions only/);
  const answer = { desired_result: 'Bookings load in one read on start', current_state: 'Every week list is read on start', checklist: handled('outcome-before-after'), evidence_refs: ['e1'] };
  const next = await answerADecisionQuestion({ decision_id: id, step_id: 'outcome', answer, verdicts: [{ check: 'outcome-before-after', meets: true, rests_on: 'e2', graded_by: 'second-judge-test' }] }, { door });
  assert.equal(next.question.step_id, 'proof');
});

test('a life case is still asked the life-only check and is refused without it', async () => {
  const door = account();
  const { case_id: id } = await startADecision(opened, { door });
  const reply = await answerADecisionQuestion({ decision_id: id, step_id: 'scope', answer: scopeWith('life') }, { door });
  assert.deepEqual(ids(reply.question).sort(), ['outcome-before-after', 'outcome-daily-practice', 'outcome-who-pays']);
  assert.equal(reply.question.skipped_checks, undefined);
  const answer = { desired_result: 'Bookings load in one read on start', current_state: 'Every week list is read on start', checklist: handled('outcome-before-after'), evidence_refs: ['e1'] };
  await assert.rejects(answerADecisionQuestion({ decision_id: id, step_id: 'outcome', answer }, { door }), /outcome-daily-practice/);
});

test('a business case is asked the checks that name business and skips the life-only one', async () => {
  const door = account();
  const { case_id: id } = await startADecision(opened, { door });
  const reply = await answerADecisionQuestion({ decision_id: id, step_id: 'scope', answer: scopeWith('business') }, { door });
  assert.deepEqual(ids(reply.question).sort(), ['outcome-before-after', 'outcome-who-pays']);
  assert.deepEqual(reply.question.skipped_checks.map(item => item.id), ['outcome-daily-practice']);
});

test('a check naming no kinds is asked of every kind', async () => {
  for (const kind of ['life', 'business', 'code-design']) {
    const door = account();
    const { case_id: id } = await startADecision(opened, { door });
    const reply = await answerADecisionQuestion({ decision_id: id, step_id: 'scope', answer: scopeWith(kind) }, { door });
    assert.ok(ids(reply.question).includes('outcome-before-after'), kind);
  }
});

test('the kind is one of the person\'s kind rows: named, and refused when missing or unknown', async () => {
  const door = account();
  const { case_id: id } = await startADecision(opened, { door });
  const asked = await nextDecisionQuestion({ decision_id: id }, { door });
  assert.deepEqual(asked.question.answer_schema.properties.decision_kind.enum, ['business', 'code-design', 'life']);
  assert.ok(asked.question.answer_schema.required.includes('decision_kind'));
  assert.ok(asked.question.fields.includes('decision_kind'));
  await assert.rejects(answerADecisionQuestion({ decision_id: id, step_id: 'scope', answer: scopeWith() }, { door }), /decision_kind must be one of the kinds of decision: business, code-design, life/);
  await assert.rejects(answerADecisionQuestion({ decision_id: id, step_id: 'scope', answer: scopeWith('gardening') }, { door }), /decision_kind must be one of/);
});

test('a person with no kind rows is asked no kind and every check applies', async () => {
  const door = account({ kinds: false });
  const { case_id: id } = await startADecision(opened, { door });
  const asked = await nextDecisionQuestion({ decision_id: id }, { door });
  assert.equal(asked.question.answer_schema.properties.decision_kind, undefined);
  const reply = await answerADecisionQuestion({ decision_id: id, step_id: 'scope', answer: scopeWith() }, { door });
  assert.deepEqual(ids(reply.question).sort(), ['outcome-before-after', 'outcome-daily-practice', 'outcome-who-pays']);
});

test('a case that declared no kind before kinds existed keeps every check', async () => {
  const door = account({ kinds: false });
  const { case_id: id } = await startADecision(opened, { door });
  await answerADecisionQuestion({ decision_id: id, step_id: 'scope', answer: scopeWith() }, { door });
  for (const [kind, about] of [['code-design', 'How a system is built']]) door.put(`record:${settings.records.kind_row}:${kind}`, `record:${settings.records.kind_row}`, { id: kind, name: kind, about });
  const again = await nextDecisionQuestion({ decision_id: id }, { door });
  assert.deepEqual(ids(again.question).sort(), ['outcome-before-after', 'outcome-daily-practice', 'outcome-who-pays']);
  assert.equal(again.question.skipped_checks, undefined);
});
