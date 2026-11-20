// tool:decide-in-one-pass: opening, answering every row of the method and deciding in one call, with every check the three tools keep.
import test from 'node:test';
import assert from 'node:assert/strict';
import { decideInOnePass } from '../read-data/decide-in-one-pass.mjs';
import { account } from './old-engine-for-tests.mjs';
import { METHOD_VIEW, STEP_ROW } from './fixtures.mjs';

const opened = { source_id: 'owed:synthetic-one-pass-1', goal: 'Choose a plan', evidence: [{ ref: 'e1', claim: 'The person asked to compare two plans' }],
  options: [{ id: 'a', label: 'Plan A' }, { id: 'b', label: 'Plan B' }] };
const answers = ['scope', 'outcome', 'proof'].map(step => ({ row: STEP_ROW(step), answer: `A made-up answer to ${step} in its own words`, evidence_refs: ['e1'] }));
const decision = { option_id: 'a', reason: 'Plan A is cheaper.', evidence_refs: ['e1'], next_action: 'Sign up', success_measure: 'Paid', move: 'Review in a month' };
const records = () => account().all();

test('one call opens the decision, answers every row of its method and makes it, keeping every record it changed', () => {
  const one = decideInOnePass({ ...opened, method: METHOD_VIEW, answers, decision, records: records() });
  assert.ok(one.case_id.startsWith('source:'));
  assert.equal(one.decision.option_id, 'a');
  assert.ok(one.keep.some(item => item.type === 'decision' && item.value?.status === 'needs_outcome'), 'the decision root is kept');
  assert.ok(one.keep.every(item => 'expected' in item), 'each kept record carries what it was handed in with');
});

test('a call missing one row of the method refuses, and keeps nothing', () => {
  assert.throws(() => decideInOnePass({ ...opened, method: METHOD_VIEW, answers: answers.slice(1), decision, records: records() }));
});

test('a decision that names no known option is refused by the decision step, not written', () => {
  assert.throws(() => decideInOnePass({ ...opened, method: METHOD_VIEW, answers, decision: { ...decision, option_id: 'maybe' }, records: records() }), /unknown option/);
});

test('a call that is not given its answers and its decision is refused', () => {
  assert.throws(() => decideInOnePass({ ...opened }), /needs its answers/);
});
