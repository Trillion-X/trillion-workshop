// A case whose answered-step pointer names a summary with no step in it (the live shape of 2026-11-13: step_id absent, flags only)
// is refused where it is read or answered, with the step named, instead of being returned as a step or answered again.
import test from 'node:test';
import assert from 'node:assert/strict';
import { addDecisionEvidence, makeTheDecision, startADecision } from '../read-data/decisions.mjs';
import { readDecision } from '../read-data/decision-records.mjs';
import { account, seedSteps } from './old-engine-for-tests.mjs';
import { refsOfCase } from './fixtures.mjs';
import { readFileSync } from 'node:fs';

const settings = JSON.parse(readFileSync(new URL('../read-data/decide-with-a-method.json', import.meta.url), 'utf8'));
const ANSWERED = settings.records.laid_apart.answered_steps.type;
const input = {
  source_id: 'live-stub-entries', goal: 'Refuse a case whose answered step has no step in it',
  evidence: [{ ref: 'user-verbatim', claim: 'Last spring twelve families signed up at the old price' }, { ref: 'e2', claim: 'The kiln costs went up this year' }],
  options: [{ id: 'keep', label: 'Keep the price' }, { id: 'raise', label: 'Raise the price' }],
};

// Builds a case with two answered steps, then points the second step's summary at a summary record with flags only, as the
// live case holds it: { needs_recheck, version } and no step_id.
async function caseWithStubStep() {
  const door = account();
  const { case_id: id } = await startADecision(input, { door });
  await seedSteps(door, id, ['scope', 'outcome'], { ref: 'user-verbatim' });
  const refs = await refsOfCase(door, id);
  const stubKey = `${ANSWERED}:${id}:001:c${refs.items.answered_steps[1]}`;
  assert.ok(door.records.has(stubKey), 'the second summary is in the case');
  door.records.set(stubKey, { type: ANSWERED, value: { needs_recheck: false, version: 1 } });
  return { door, id };
}

test('reading a case with a step that has no step in it refuses, and names the step', async () => {
  const { door, id } = await caseWithStubStep();
  await assert.rejects(() => readDecision(door, id), /not visible/);
});

test('adding evidence refuses a case with a step that has no step in it', async () => {
  const { door, id } = await caseWithStubStep();
  await assert.rejects(() => addDecisionEvidence({ decision_id: id, evidence: [{ ref: 'e3', claim: 'The waiting list grew this month' }] }, { door }), /not visible/);
});

test('making the decision refuses a case with a step that has no step in it', async () => {
  const { door, id } = await caseWithStubStep();
  await assert.rejects(() => makeTheDecision({ decision_id: id, decision: { option_id: 'keep', reason: 'Kept.', next_action: 'Keep it', success_measure: 'Families stay', evidence_refs: ['user-verbatim'] } }, { door }), /not visible/);
});
