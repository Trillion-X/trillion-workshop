// A case whose root reads back as a storage envelope ({kind, meta, protected, sequence, stored}) is refused by name, not read
// as a case with no answers: the root has no id, counts or answered steps at the top level, so the identity check refuses it.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { addDecisionEvidence, answerADecisionQuestion, nextDecisionQuestion, startADecision } from '../read-data/decisions.mjs';
import { plainChecks, plainMethod, memoryDoor } from './fixtures.mjs';

const settings = JSON.parse(readFileSync(new URL('../read-data/decide-with-a-method.json', import.meta.url), 'utf8'));
const opened = {
  source_id: 'chat:envelope-root', goal: 'Decide the camp price for spring',
  evidence: [{ ref: 'e1', claim: 'Last spring twelve families signed up at the old price' }],
  options: [{ id: 'keep', label: 'Keep the price' }, { id: 'raise', label: 'Raise the price' }],
};
const scope = { decision_context: { worth_weighing: true, compare_existing: false }, omission_reasons: { compare_existing: { searched: ['the camp price list'], evidence_refs: ['e1'] } }, evidence_refs: ['e1'] };

function account() {
  const door = memoryDoor();
  door.put(`record:${settings.records.method_row}:plain`, `record:${settings.records.method_row}`, plainMethod());
  for (const check of plainChecks()) door.put(`record:${settings.records.check_row}:${check.id}`, `record:${settings.records.check_row}`, check);
  return door;
}
async function caseWithEnvelopeRoot() {
  const door = account();
  const { case_id: id } = await startADecision(opened, { door });
  await answerADecisionQuestion({ decision_id: id, step_id: 'scope', answer: scope }, { door });
  const root = door.value(id);
  door.put(id, 'decision', { kind: 'decision', meta: {}, protected: false, sequence: 7, stored: JSON.stringify(root) });
  return { door, id };
}

test('a root read back as a storage envelope is refused by name when the next question is asked', async () => {
  const { door, id } = await caseWithEnvelopeRoot();
  await assert.rejects(nextDecisionQuestion({ decision_id: id }, { door }), new RegExp(`decision ${id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')} is not visible to this read`));
});

test('a root read back as a storage envelope is refused by name when evidence is added, and nothing is written', async () => {
  const { door, id } = await caseWithEnvelopeRoot();
  const before = JSON.stringify([...door.records]);
  await assert.rejects(addDecisionEvidence({ decision_id: id, evidence: [{ ref: 'e2', claim: 'A second synthetic fact' }] }, { door }), /is not visible to this read/);
  assert.equal(JSON.stringify([...door.records]), before, 'the refusal writes nothing');
});
