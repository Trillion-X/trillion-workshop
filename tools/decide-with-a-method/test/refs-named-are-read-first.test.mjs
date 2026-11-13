// A case whose root names its refs record reads that record first and then only the keys it names: no item or step is asked
// under its legacy key first. A 130-evidence case with 8 answered steps costs about 155 door reads for the next question
// (286 when the legacy keys were asked first too), and the answer it gives is the same.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { answerADecisionQuestion, nextDecisionQuestion, startADecision } from '../read-data/decisions.mjs';
import { plainChecks, plainMethod, memoryDoor } from './fixtures.mjs';
import { canonical } from '../read-data/decision-records.mjs';
import { makeHashCodeHexFromBytes } from '../../content-identity/read-data/identity.mjs';

const settings = JSON.parse(readFileSync(new URL('../read-data/decide-with-a-method.json', import.meta.url), 'utf8'));
const extra = Array.from({ length: 7 }, (_, n) => ({ id: `s${n + 1}`, question: `Synthetic step ${n + 1}?`, fields: [{ name: 'note', label: 'Note' }] }));
const method = { ...plainMethod(), backbone: [{ id: 'name', name: 'Name the change', steps: extra.map(step => step.id) }], steps: [plainMethod().steps[0], ...extra] };
const scope = { decision_context: { worth_weighing: true, compare_existing: false }, omission_reasons: { compare_existing: { searched: ['the camp price list'], evidence_refs: ['e1'] } }, evidence_refs: ['e1'] };
const note = n => ({ note: `Synthetic note for step ${n} here`, evidence_refs: ['e1'] });

async function caseOf(rows) {
  const door = memoryDoor();
  door.put(`record:${settings.records.method_row}:plain`, `record:${settings.records.method_row}`, method);
  for (const check of plainChecks()) door.put(`record:${settings.records.check_row}:${check.id}`, `record:${settings.records.check_row}`, check);
  const evidence = Array.from({ length: rows }, (_, i) => ({ ref: `e${i + 1}`, claim: `Synthetic fact ${i}: a made-up detail about the camp price.` }));
  const { case_id: id } = await startADecision({ source_id: 'chat:reads-first', goal: 'Decide the camp price', evidence, options: [{ id: 'keep', label: 'Keep' }, { id: 'raise', label: 'Raise' }] }, { door });
  await answerADecisionQuestion({ decision_id: id, step_id: 'scope', answer: scope }, { door });
  for (let k = 1; k <= 7; k += 1) await answerADecisionQuestion({ decision_id: id, step_id: `s${k}`, answer: note(k) }, { door });
  return { door, id };
}

test('the next question on a 130-evidence case reads its refs first and makes about 155 door reads, not 286', async () => {
  const { door, id } = await caseOf(130);
  let reads = 0;
  const read = door.read.bind(door);
  door.read = async (...args) => { reads += 1; return read(...args); };
  await nextDecisionQuestion({ decision_id: id }, { door });
  assert.ok(reads <= 170, `door reads for the next question: ${reads}`);
});

// The reply the next question gave on origin/main for this case, by its content identity (the reply is not kept in a file).
const ORIGIN_REPLY = '1f:70c3f9078b6caa5dfc18fdd039f2a3978fe25ace43888371aaa50f5c330157e5';
test('the same case answers the same as it did before its reads changed', async () => {
  const { door, id } = await caseOf(130);
  const reply = await nextDecisionQuestion({ decision_id: id }, { door });
  assert.equal(makeHashCodeHexFromBytes(new TextEncoder().encode(canonical(reply))), ORIGIN_REPLY);
});
