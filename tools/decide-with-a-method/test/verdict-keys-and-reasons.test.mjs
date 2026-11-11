// A verdict sent under the documented key (`check`, the id the step lists) is matched, a due workflow's id included; a
// verdict that is not taken says why; and a workflow run that is not a candidate says which switch or step it belongs to.
import test from 'node:test';
import assert from 'node:assert/strict';
import { takeCallerVerdicts } from '../read-data/verdicts.mjs';
import { methodCatalogue } from '../read-data/method.mjs';
import { plainChecks, plainMethod } from './fixtures.mjs';

const answer = { decision_context: { worth_weighing: true, compare_existing: false }, evidence_refs: ['e1'], note: 'Change the session proof in computer and forwarder code' };
const rows = [
  { id: 'workflow_runs.workflow:method-change-code', check: 'Does the case need an additional run of this workflow, and when is its proof required?' },
  { id: 'outcome-before-after', check: 'Have you named what is in which state now and which state it should end up in?' },
];

test('a verdict sent under the documented check key is matched to its workflow check', () => {
  const given = [{ check: 'workflow_runs.workflow:method-change-code', meets: true, rests_on: 'Change the session proof in computer and forwarder code', graded_by: 'fresh-judge' }];
  const { verdicts, rest, dropped } = takeCallerVerdicts(rows, given, { answer, refs: ['e1'] });
  assert.deepEqual(verdicts.map(item => item.id), ['workflow_runs.workflow:method-change-code']);
  assert.deepEqual(rest.map(row => row.id), ['outcome-before-after']);
  assert.deepEqual(dropped, []);
});

test('a verdict that is not taken names the reason, so the caller sends it again right', () => {
  const given = [
    { check: 'workflow_runs.workflow:method-change-code', meets: true, rests_on: 'a sentence this answer never says', graded_by: 'fresh-judge' },
    { check: 'outcome-before-after', meets: false, rests_on: 'e1', missing: 'the answer is long and vague', graded_by: 'fresh-judge' },
  ];
  const { dropped } = takeCallerVerdicts(rows, given, { answer, refs: ['e1'] });
  assert.equal(dropped.length, 2);
  assert.match(dropped[0].why, /rests_on must name a case evidence ref, or quote at least 8 characters of this answer/);
  assert.match(dropped[1].why, /missing must copy words of the check: Have you named what is in which state now/);
});

test('a workflow run that is not a candidate names its switch and the step it belongs to', () => {
  const method = plainMethod();
  method.workflows = [{ workflow_id: 'workflow:method-change-code', when: 'compare_existing', use: 'Change code when the proof needs a new hop.' }];
  const cat = methodCatalogue([method], plainChecks());
  const guidance = [{ step_id: 'scope', answer: { decision_context: { worth_weighing: true, compare_existing: false }, evidence_refs: ['e1'] }, version: 1 }];
  const record = { id: 'd1', input: { goal: 'Pick the next training focus', evidence: [{ ref: 'e1', claim: 'The last match video' }], options: [] }, method: cat.snapshotMethod('plain'), guidance };
  const outcome = cat.stepsFor(record).find(step => step.id === 'outcome');
  const refusal = (() => { try { cat.validateMethodAnswer(record, outcome, { desired_result: 'a plan', current_state: 'no plan', checklist: { 'outcome-before-after': { handled: true, how: 'Before: no plan, after: a plan', evidence_refs: ['e1'] } }, evidence_refs: ['e1'], workflow_runs: { 'workflow:method-change-code': { applicable: false, because: 'the switch is off', evidence_refs: ['e1'] } } }, new Set(['e1'])); } catch (error) { return error; } })();
  const named = refusal.problems.find(problem => problem.includes('workflow_runs.workflow:method-change-code is not a candidate'));
  assert.ok(named, 'the refusal names the workflow');
  assert.match(named, /its switch compare_existing is off for this case/);
  assert.match(named, /belongs at the decide step, with make-the-decision/);
  assert.match(named, /after it has run, it belongs at say_what_was_done/);
});
