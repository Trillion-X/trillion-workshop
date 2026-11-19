import { run, heldOf } from './fixtures.mjs';
// A case whose root names its refs record reads that record and the keys it names, from the records its caller hands in: a
// 130-evidence case with 8 answered steps reads whole, each item and step at the identity its refs record names.
import test from 'node:test';
import assert from 'node:assert/strict';
import { startADecision } from '../read-data/decisions.mjs';
import { readDecision } from '../read-data/decision-records.mjs';
import { account, seedSteps } from './old-engine-for-tests.mjs';

async function caseOf(rows) {
  const door = account();
  const evidence = Array.from({ length: rows }, (_, i) => ({ ref: `e${i + 1}`, claim: `Synthetic fact ${i}: a made-up detail about the camp price.` }));
  const { case_id: id } = await run(door, startADecision, { source_id: 'chat:reads-first', goal: 'Decide the camp price', evidence, options: [{ id: 'keep', label: 'Keep' }, { id: 'raise', label: 'Raise' }] });
  await seedSteps(door, id, ['scope', ...Array.from({ length: 7 }, (_, n) => `s${n + 1}`)]);
  return { door, id };
}

test('reading a 130-evidence case with 8 answered steps reads it whole from the records handed in', async () => {
  const { door, id } = await caseOf(130);
  const record = readDecision(heldOf(door), id, ['scope']);
  assert.equal(record.input.evidence.length, 130);
  assert.equal(record.guidance.length, 8);
  assert.equal(record.guidance[0].step_id, 'scope');
});
