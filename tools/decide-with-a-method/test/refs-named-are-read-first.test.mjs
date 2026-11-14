// A case whose root names its refs record reads that record first and then only the keys it names: no item or step is asked
// under its legacy key first. A 130-evidence case with 8 answered steps costs about 155 door reads to read whole (286 when the
// legacy keys were asked first too), and what it reads is the same.
import test from 'node:test';
import assert from 'node:assert/strict';
import { startADecision } from '../read-data/decisions.mjs';
import { readDecision } from '../read-data/decision-records.mjs';
import { account, seedSteps } from './old-engine-for-tests.mjs';

async function caseOf(rows) {
  const door = account();
  const evidence = Array.from({ length: rows }, (_, i) => ({ ref: `e${i + 1}`, claim: `Synthetic fact ${i}: a made-up detail about the camp price.` }));
  const { case_id: id } = await startADecision({ source_id: 'chat:reads-first', goal: 'Decide the camp price', evidence, options: [{ id: 'keep', label: 'Keep' }, { id: 'raise', label: 'Raise' }] }, { door });
  await seedSteps(door, id, ['scope', ...Array.from({ length: 7 }, (_, n) => `s${n + 1}`)]);
  return { door, id };
}

test('reading a 130-evidence case with 8 answered steps reads its refs first and makes about 155 door reads, not 286', async () => {
  const { door, id } = await caseOf(130);
  let reads = 0;
  const read = door.read.bind(door);
  door.read = async (...args) => { reads += 1; return read(...args); };
  const record = await readDecision(door, id, ['scope']);
  assert.ok(reads <= 170, `door reads for the case: ${reads}`);
  assert.equal(record.input.evidence.length, 130);
  assert.equal(record.guidance.length, 8);
  assert.equal(record.guidance[0].step_id, 'scope');
});
