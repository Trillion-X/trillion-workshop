// A case whose answered step lost its summary's grading (a summary was written for a step the door could not read, and the
// case's refs were pointed at it) is put right from the step's own record: the refs name the summary the step makes, and no
// step record, answer, verdict or other summary changes. A step whose record is gone is left as it is.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { answerADecisionQuestion, repairDecisionSteps, startADecision } from '../read-data/decisions.mjs';
import { canonical } from '../read-data/decision-records.mjs';
import { makeHashCodeHexFromBytes } from '../../content-identity/read-data/identity.mjs';
import { account, fill, judged } from './old-engine-for-tests.mjs';
import { caseView, refsOfCase } from './fixtures.mjs';

const settings = JSON.parse(readFileSync(new URL('../read-data/decide-with-a-method.json', import.meta.url), 'utf8'));
const { answered_steps: ANSWERED } = settings.records.laid_apart;
const identity = value => makeHashCodeHexFromBytes(new TextEncoder().encode(canonical(value)));
const input = {
  source_id: 'repair-refs', goal: 'Put back the answered steps of a case whose summaries lost their steps',
  evidence: [{ ref: 'user-verbatim', claim: 'Last spring twelve families signed up at the old price' }, { ref: 'e2', claim: 'The kiln costs went up this year' }],
  options: [{ id: 'keep', label: 'Keep the price' }, { id: 'raise', label: 'Raise the price' }],
};

async function answeredCase() {
  const door = account();
  const { case_id: id, question: scope } = await startADecision(input, { door });
  const scoped = await answerADecisionQuestion({ decision_id: id, step_id: 'scope', answer: fill(scope, { refs: ['user-verbatim'] }) }, { door });
  await answerADecisionQuestion({ decision_id: id, step_id: 'outcome', answer: fill(scoped.question, { refs: ['user-verbatim'] }), verdicts: judged(scoped.question, 'user-verbatim') }, { door });
  return { door, id };
}

// The damage as it was done: the step's summary rewritten without its grading, at a new identity, and the refs pointed at it;
// with `unnamed` the refs no longer name the step's own record either.
function damage(door, id, n, { unnamed = false } = {}) {
  const root = door.value(id);
  const refs = refsOfCase(door, id);
  const was = door.value(`${ANSWERED.type}:${id}:${String(n).padStart(ANSWERED.digits, '0')}${refs.items.answered_steps[n] ? `:c${refs.items.answered_steps[n]}` : ''}`);
  const stub = { step_id: was.step_id, answered_at: was.answered_at, version: was.version, needs_recheck: was.needs_recheck };
  const ref = identity(stub);
  door.put(`${ANSWERED.type}:${id}:${String(n).padStart(ANSWERED.digits, '0')}:c${ref}`, ANSWERED.type, stub);
  const items = { ...refs.items, answered_steps: refs.items.answered_steps.map((was_ref, at) => (at === n ? ref : was_ref)) };
  const next = { ...refs, items, ...(unnamed ? { step_refs: refs.step_refs.map((was_ref, at) => (at === n ? null : was_ref)) } : {}) };
  const refsRef = identity(next);
  door.put(`${settings.records.refs}:${id}:c${refsRef}`, settings.records.refs, next);
  door.put(id, 'decision', { ...root, refs: refsRef });
}
const stepsOf = (door, id) => Object.fromEntries([...door.records].filter(([, kept]) => kept.type === 'decision-step').map(([key, kept]) => [key, canonical(kept.value)]));

test('a summary that lost its step is put back from the step record, and nothing else in the case changes', async () => {
  const { door, id } = await answeredCase();
  const before = caseView(door, id).answered_steps;
  assert.equal(before.length, 2);
  const stepsBefore = stepsOf(door, id);
  damage(door, id, 1);
  assert.equal(caseView(door, id).answered_steps[1].checks, undefined, 'the damage is in place: the outcome summary has no grading');
  const result = await repairDecisionSteps({ decision_id: id }, { door });
  assert.deepEqual(result.repaired, [{ index: 1, step_id: 'outcome', from: 'step' }]);
  assert.equal(result.answered_before, 1);
  assert.equal(result.answered_after, 2);
  assert.deepEqual(caseView(door, id).answered_steps, before, 'both summaries read as they did before the damage');
  assert.deepEqual(stepsOf(door, id), stepsBefore, 'no step record is written or changed');
});

test('a case with nothing to put right is not written again', async () => {
  const { door, id } = await answeredCase();
  const writes = door.writes.length;
  const result = await repairDecisionSteps({ decision_id: id }, { door });
  assert.deepEqual(result.repaired, []);
  assert.equal(door.writes.length, writes);
});

test('a step the refs no longer name is put back from the refs the case had before', async () => {
  const { door, id } = await answeredCase();
  const before = caseView(door, id).answered_steps;
  const stepsBefore = stepsOf(door, id);
  damage(door, id, 1, { unnamed: true });
  assert.equal(caseView(door, id).answered_steps[1].checks, undefined, 'the damage is in place: the outcome summary has no grading');
  const result = await repairDecisionSteps({ decision_id: id }, { door });
  assert.deepEqual(result.repaired, [{ index: 1, step_id: 'outcome', from: 'history' }]);
  assert.equal(result.answered_before, 1);
  assert.equal(result.answered_after, 2);
  assert.deepEqual(caseView(door, id).answered_steps, before);
  assert.deepEqual(stepsOf(door, id), stepsBefore, 'no step record is written or changed');
  assert.equal((await repairDecisionSteps({ decision_id: id }, { door })).repaired.length, 0, 'a second call finds nothing to put right');
});

test('a summary whose step record is gone from the case and its history stays as it is', async () => {
  const { door, id } = await answeredCase();
  damage(door, id, 1, { unnamed: true });
  for (const [key, kept] of [...door.records]) if (kept.type === 'decision-step' && key.startsWith(`decision-step:${id}:001`)) door.records.delete(key);
  const writes = door.writes.length;
  const result = await repairDecisionSteps({ decision_id: id }, { door });
  assert.deepEqual(result.repaired, []);
  assert.equal(door.writes.length, writes);
});
