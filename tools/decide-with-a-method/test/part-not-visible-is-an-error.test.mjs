// A split record whose part is not visible at the read is an error, never a missing value. Before, the reader returned null,
// the step became lost, and the next write carried a stub in its place. A part read that the door refuses (503) is an error too.
import test from 'node:test';
import assert from 'node:assert/strict';
import { addDecisionEvidence, startADecision } from '../read-data/decisions.mjs';
import { readDecision } from '../read-data/decision-records.mjs';
import { account, seedSteps } from './old-engine-for-tests.mjs';
import { refsOfCase } from './fixtures.mjs';
import { readFileSync } from 'node:fs';

const settings = JSON.parse(readFileSync(new URL('../read-data/decide-with-a-method.json', import.meta.url), 'utf8'));
const ANSWERED = settings.records.laid_apart.answered_steps.type;
const PART = settings.records.part.type;
const input = {
  source_id: 'part-not-visible', goal: 'A split step summary whose part is not visible',
  evidence: [{ ref: 'user-verbatim', claim: 'Last spring twelve families signed up at the old price' }, { ref: 'e2', claim: 'The kiln costs went up this year' }],
  options: [{ id: 'keep', label: 'Keep the price' }, { id: 'raise', label: 'Raise the price' }],
};

// A case with two answered steps, where the second summary is split into two parts and its second part is not in the door.
async function caseWithMissingPart() {
  const door = account();
  const { case_id: id } = await startADecision(input, { door });
  await seedSteps(door, id, ['scope', 'outcome'], { ref: 'user-verbatim' });
  const refs = await refsOfCase(door, id);
  const summaryKey = `${ANSWERED}:${id}:001:c${refs.items.answered_steps[1]}`;
  const partKey = n => `${summaryKey}:part:00${n}`;
  door.records.set(summaryKey, { type: ANSWERED, value: { kept_in_parts: 2, parts_of: summaryKey, step_id: 'outcome', version: 1 } });
  door.records.set(partKey(0), { type: PART, value: { of: summaryKey, at: 0, text: '{"step_id":"outcome",' } });
  door.records.delete(partKey(1));
  return { door, id, partKey };
}

test('a split part that is not visible is an error when the case is read', async () => {
  const { door, id } = await caseWithMissingPart();
  await assert.rejects(() => readDecision(door, id), /not visible/);
});

test('adding evidence refuses a case with a split part that is not visible, and writes nothing', async () => {
  const { door, id } = await caseWithMissingPart();
  const keysBefore = [...door.records.keys()].sort();
  await assert.rejects(() => addDecisionEvidence({ decision_id: id, evidence: [{ ref: 'e3', claim: 'The waiting list grew this month' }] }, { door }), /not visible/);
  assert.deepEqual([...door.records.keys()].sort(), keysBefore);
});

test('a part the door refuses (503) is an error, not a missing value', async () => {
  const { door, id, partKey } = await caseWithMissingPart();
  door.records.set(partKey(1), { type: PART, value: { of: 'x', at: 1, text: '' } });
  const read = door.read.bind(door);
  door.read = async (type, key) => {
    if (type === PART && key === partKey(1)) throw Object.assign(new Error('The records door answered 503.'), { code: 'http_503' });
    return read(type, key);
  };
  await assert.rejects(() => readDecision(door, id), /503/);
});
