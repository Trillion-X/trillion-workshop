// A derived question (kind check, a step, part_of its branch) is asked by next-decision-question with no other change:
// the calling AI is sent its id and question. Synthetic method and rows only.
import test from 'node:test';
import assert from 'node:assert/strict';
import { answerADecisionQuestion, nextDecisionQuestion, startADecision } from '../read-data/decisions.mjs';
import { memoryDoor, plainChecks, plainMethod, today } from './fixtures.mjs';
import { readFileSync } from 'node:fs';

const settings = JSON.parse(readFileSync(new URL('../read-data/decide-with-a-method.json', import.meta.url), 'utf8'));
const account = () => {
  const door = memoryDoor();
  door.put(`record:${settings.records.method_row}:plain`, `record:${settings.records.method_row}`, plainMethod());
  for (const check of plainChecks()) door.put(`record:${settings.records.check_row}:${check.id}`, `record:${settings.records.check_row}`, check);
  return door;
};

test('a derived question row on a step is asked by next-decision-question', async () => {
  const door = account();
  const { case_id: id } = await startADecision({ source_id: 'synthetic:derived', goal: 'Synthetic derived question', evidence: [{ ref: 'e1', claim: 'A synthetic fact' }, { ref: 'e2', claim: 'A second synthetic fact' }], options: [{ id: 'a', label: 'A' }, { id: 'b', label: 'B' }] }, { door });
  const before = await nextDecisionQuestion({ decision_id: id }, { door });
  const scopeDone = await answerADecisionQuestion({ decision_id: id, step_id: 'scope', answer: { decision_context: { worth_weighing: true, compare_existing: false }, omission_reasons: { compare_existing: { searched: ['the price list'], evidence_refs: ['e1'] } }, evidence_refs: ['e1'] } }, { door });
  assert.equal(scopeDone.question.step_id, 'outcome');
  door.put(`record:${settings.records.check_row}:derived-outcome-1`, `record:${settings.records.check_row}`, { id: 'derived-outcome-1', step: 'outcome', part_of: 'plain', check: 'Derived: is the before state written with its facts?', kind: 'check', on: 'On' });
  const after = await nextDecisionQuestion({ decision_id: id }, { door });
  assert.ok(before.question && after.question, 'both reads ask a question');
  assert.ok(after.question.checks?.some(c => c.id === 'derived-outcome-1') || after.question.verdict_checks?.includes('derived-outcome-1'), 'the derived question is asked on its step');
});

test('a question row switched Off is not asked, and switching it On asks it', async () => {
  const door = account();
  const { case_id: id } = await startADecision({ source_id: 'synthetic:off', goal: 'Synthetic off switch', evidence: [{ ref: 'e1', claim: 'A synthetic fact' }, { ref: 'e2', claim: 'A second synthetic fact' }], options: [{ id: 'a', label: 'A' }, { id: 'b', label: 'B' }] }, { door });
  await answerADecisionQuestion({ decision_id: id, step_id: 'scope', answer: { decision_context: { worth_weighing: true, compare_existing: false }, omission_reasons: { compare_existing: { searched: ['the price list'], evidence_refs: ['e1'] } }, evidence_refs: ['e1'] } }, { door });
  const row = `record:${settings.records.check_row}:derived-off-1`;
  door.put(row, `record:${settings.records.check_row}`, { id: 'derived-off-1', step: 'outcome', part_of: 'plain', check: 'Derived: is the Off question kept out?', kind: 'check', on: 'Off' });
  const off = await nextDecisionQuestion({ decision_id: id }, { door });
  assert.ok(!JSON.stringify(off.question).includes('derived-off-1'), 'an Off question is not asked');
  door.put(row, `record:${settings.records.check_row}`, { id: 'derived-off-1', step: 'outcome', part_of: 'plain', check: 'Derived: is the Off question kept out?', kind: 'check', on: 'On' });
  const on = await nextDecisionQuestion({ decision_id: id }, { door });
  assert.ok(JSON.stringify(on.question).includes('derived-off-1'), 'an On question is asked');
});
