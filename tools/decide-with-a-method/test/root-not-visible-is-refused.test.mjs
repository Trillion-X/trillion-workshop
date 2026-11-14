// A case whose root reads back as a storage envelope ({kind, meta, protected, sequence, stored}) is refused by name, not read
// as a case with no answers: the root has no id, counts or answered steps at the top level, so the identity check refuses it.
import test from 'node:test';
import assert from 'node:assert/strict';
import { addDecisionEvidence, makeTheDecision, startADecision } from '../read-data/decisions.mjs';
import { account, seedSteps } from './old-engine-for-tests.mjs';

const opened = {
  source_id: 'chat:envelope-root', goal: 'Decide the camp price for spring',
  evidence: [{ ref: 'e1', claim: 'Last spring twelve families signed up at the old price' }],
  options: [{ id: 'keep', label: 'Keep the price' }, { id: 'raise', label: 'Raise the price' }],
};
async function caseWithEnvelopeRoot() {
  const door = account();
  const { case_id: id } = await startADecision(opened, { door });
  await seedSteps(door, id, ['scope'], { ref: 'e1' });
  const root = door.value(id);
  door.put(id, 'decision', { kind: 'decision', meta: {}, protected: false, sequence: 7, stored: JSON.stringify(root) });
  return { door, id };
}

test('a root read back as a storage envelope is refused by name when the decision is made', async () => {
  const { door, id } = await caseWithEnvelopeRoot();
  await assert.rejects(makeTheDecision({ decision_id: id, decision: { option_id: 'keep', reason: 'Kept.', next_action: 'Keep it', success_measure: 'Families stay', evidence_refs: ['e1'] } }, { door }), new RegExp(`decision ${id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')} is not visible to this read`));
});

test('a root read back as a storage envelope is refused by name when evidence is added, and nothing is written', async () => {
  const { door, id } = await caseWithEnvelopeRoot();
  const before = JSON.stringify([...door.records]);
  await assert.rejects(addDecisionEvidence({ decision_id: id, evidence: [{ ref: 'e2', claim: 'A second synthetic fact' }] }, { door }), /is not visible to this read/);
  assert.equal(JSON.stringify([...door.records]), before, 'the refusal writes nothing');
});
