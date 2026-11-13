// A root that names its refs record is refused when that record reads as absent: it is never read as an empty case, and no write
// follows. A decision-evidence row that cannot be read is refused the same way. Before, the absent refs read as empty refs, and the
// next write carried the case's legacy keys and lost rows in place of what was there.
import test from 'node:test';
import assert from 'node:assert/strict';
import { addDecisionEvidence, answerADecisionQuestion, startADecision } from '../read-data/decisions.mjs';
import { readDecision } from '../read-data/decision-records.mjs';
import { account, fill, judged } from './old-engine-for-tests.mjs';
import { refsOfCase } from './fixtures.mjs';
import { readFileSync } from 'node:fs';

const settings = JSON.parse(readFileSync(new URL('../read-data/decide-with-a-method.json', import.meta.url), 'utf8'));
const EVIDENCE = settings.records.laid_apart.evidence.type;
const input = {
  source_id: 'refs-not-visible', goal: 'A root whose refs record is not visible',
  evidence: [{ ref: 'user-verbatim', claim: 'Last spring twelve families signed up at the old price' }, { ref: 'e2', claim: 'The kiln costs went up this year' }],
  options: [{ id: 'keep', label: 'Keep the price' }, { id: 'raise', label: 'Raise the price' }],
};

async function caseWithScope() {
  const door = account();
  const { case_id: id, question: scope } = await startADecision(input, { door });
  await answerADecisionQuestion({ decision_id: id, step_id: 'scope', answer: fill(scope, { refs: ['user-verbatim'] }) }, { door });
  return { door, id };
}

test('a root whose refs record is absent is refused on read, and the record stays absent', async () => {
  const { door, id } = await caseWithScope();
  const root = door.value(id);
  const refsKey = `decision-refs:${id}:c${root.refs}`;
  assert.ok(door.records.has(refsKey), 'the refs record is in the case');
  door.records.delete(refsKey);
  await assert.rejects(() => readDecision(door, id), /not visible/);
});

test('adding evidence to a case whose refs record is absent refuses, and writes nothing', async () => {
  const { door, id } = await caseWithScope();
  const refsKey = `decision-refs:${id}:c${door.value(id).refs}`;
  door.records.delete(refsKey);
  const keysBefore = [...door.records.keys()].sort();
  await assert.rejects(() => addDecisionEvidence({ decision_id: id, evidence: [{ ref: 'e3', claim: 'The waiting list grew this month' }] }, { door }), /not visible/);
  assert.deepEqual([...door.records.keys()].sort(), keysBefore);
});

test('a decision-evidence row that cannot be read is refused, and nothing is written', async () => {
  const { door, id } = await caseWithScope();
  const { items } = await refsOfCase(door, id);
  const rowKey = `${EVIDENCE}:${id}:0000:c${items.evidence[0]}`;
  assert.ok(door.records.has(rowKey), 'the first evidence row is in the case');
  door.records.delete(rowKey);
  const keysBefore = [...door.records.keys()].sort();
  await assert.rejects(() => addDecisionEvidence({ decision_id: id, evidence: [{ ref: 'e3', claim: 'The waiting list grew this month' }] }, { door }), /not visible/);
  assert.deepEqual([...door.records.keys()].sort(), keysBefore);
});
