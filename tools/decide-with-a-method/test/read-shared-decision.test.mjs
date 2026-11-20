// tool:read-shared-decision returns the anonymous entry a share kept, and refuses a decision that was never shared.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readSharedDecision } from '../read-data/read-shared-decision.mjs';
import { makeTheDecision, startADecision } from '../read-data/decisions.mjs';
import { shareADecision } from '../read-data/share-a-decision.mjs';
import { account, answerAll, seedSteps } from './old-engine-for-tests.mjs';
import { run } from './fixtures.mjs';

const opened = { source_id: 'owed:synthetic-share-1', goal: 'Choose a plan', evidence: [{ ref: 'e1', claim: 'The person asked to compare two plans' }],
  options: [{ id: 'a', label: 'Plan A' }, { id: 'b', label: 'Plan B' }] };

async function decided(door) {
  const { case_id } = await run(door, startADecision, opened);
  await seedSteps(door, case_id, ['scope', 'outcome', 'proof']);
  await answerAll(door, case_id);
  await run(door, makeTheDecision, { decision_id: case_id, decision: { option_id: 'a', reason: 'Plan A is cheaper.', evidence_refs: ['e1'], next_action: 'Sign up', success_measure: 'Paid', move: 'Review in a month' } });
  return case_id;
}

test('a shared decision reads back its anonymous entry and the review it was checked under, and nothing else', async () => {
  const door = account();
  const id = await decided(door);
  const rewrite = { situation: 'Choosing between two plans', options: ['a cheaper plan', 'a dearer plan'], chosen: 'the cheaper plan', why: 'it costs less', measured_by: 'payment made' };
  const asked = await run(door, shareADecision, { decision_id: id, never_publish: ['Sample Studio'], rewrite });
  const verdict = { accepted: true, review_binding: { input_identity: asked.check.input_identity } };
  const offered = await run(door, shareADecision, { decision_id: id, never_publish: ['Sample Studio'], rewrite, reidentification: verdict });
  const read = await run(door, readSharedDecision, { decision_id: id });
  assert.equal(read.case_id, id);
  assert.deepEqual(Object.keys(read.shared).sort(), ['at', 'entry', 'review_identity']);
  assert.deepEqual(read.shared.entry, offered.send.entry);
  assert.equal(read.shared.entry.goal, undefined, 'the goal is not read');
  assert.ok(read.shared.review_identity);
});

test('a decision that was never shared is refused, not answered with an empty entry', async () => {
  const door = account();
  const id = await decided(door);
  assert.throws(() => run(door, readSharedDecision, { decision_id: id }), /never shared/);
});
