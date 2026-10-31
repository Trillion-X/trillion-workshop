// Ported from bitfield-packages learning-progress (__tests__/learning-progress.test.ts and accept-evaluation-target.test.ts)
// and learning-path (project-progress-to-path.test.ts). The fixtures are a made-up bakery course, not anyone's records.
// The old tests that mocked the old engine's read and write requests are replaced by plain stored records: the tool only
// plans, so what a test checks is the plan.

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  acceptEvaluation,
  buildEvaluationWritePlan,
  evaluationReceiptRef,
  learningProgressViews,
  progressStateRef,
  structurallyEqual,
  validateEvaluationReceipt,
} from '../do-work/learning-progress.mjs';

const NOW = '2026-01-01T12:00:00.000Z';

function records() {
  return {
    tracks: [{ kind: 'progress-track', trackId: 'track:bread', label: 'Baking bread', summary: 'From dough to loaf.' }],
    steps: [
      { kind: 'progress-step', stepId: 'step:knead', trackId: 'track:bread', label: 'Knead the dough', cue: 'Work it until smooth.', sortOrder: 1 },
      { kind: 'progress-step', stepId: 'step:proof', trackId: 'track:bread', label: 'Proof the loaf', cue: 'Let it double.', sortOrder: 2 },
      { kind: 'progress-step', stepId: 'step:bake', trackId: 'track:bread', label: 'Bake', sortOrder: 3 },
    ],
    states: [{
      kind: 'progress-state', stateId: 'state:1', trackId: 'track:bread', learnerId: 'learner:1', revision: 1,
      currentStepId: 'step:proof', completedStepIds: ['step:knead'],
      evaluationReceiptRefs: [evaluationReceiptRef('evaluation:1')],
      percent: 100, status: 'mastered', updatedAt: NOW,
    }],
    evaluationReceipts: [receipt({ evaluationId: 'evaluation:1', stepId: 'step:knead', decisionKey: 'continue', decision: { completed: true, nextStepId: 'step:proof' } })],
    presentations: [{ kind: 'progress-presentation', key: 'continue', label: 'Keep building' }],
    evidence: [{ kind: 'progress-evidence', evidenceId: 'evidence:1', learnerId: 'learner:1', trackId: 'track:bread', stepId: 'step:knead', label: 'Dough photo saved', createdAt: NOW }],
  };
}

function receipt(overrides = {}) {
  return {
    kind: 'progress-evaluation-receipt',
    evaluationId: 'evaluation:1',
    learnerId: 'learner:1',
    trackId: 'track:bread',
    stepId: 'step:knead',
    evidenceRefs: ['evidence:1'],
    measureFactRef: 'measure-fact:1',
    measureDefinitionRef: 'measure-definition:1',
    decisionKey: 'complete',
    decision: { completed: true, nextStepId: 'step:proof' },
    score: 0.8,
    confidence: 0.9,
    provenance: { evaluator: 'evaluator:1', revision: 2 },
    evaluatedAt: NOW,
    ...overrides,
  };
}

test('projects the current focus from the steps, with no domain words in the logic', () => {
  const view = learningProgressViews(records(), 'learner:1')[0];
  assert.equal(view.currentStep.label, 'Proof the loaf');
  assert.equal(view.percent, 33);
  assert.equal(view.completedCount, 1);
  assert.equal(view.totalSteps, 3);
  assert.equal(view.statusLabel, 'Keep building');
  assert.equal(view.recentEvidence.length, 1);
  assert.equal(view.latestEvaluation.evaluationId, 'evaluation:1');
});

test('ignores a forged stored percent and status', () => {
  const view = learningProgressViews(records(), 'learner:1')[0];
  assert.equal(view.percent, 33);
  assert.notEqual(view.statusLabel, 'mastered');
});

test('the path marks finished steps complete, the current step active and the rest locked, in step order', () => {
  const view = learningProgressViews(records(), 'learner:1')[0];
  assert.deepEqual(view.path, [
    { id: 'step:knead', label: 'Knead the dough', status: 'complete' },
    { id: 'step:proof', label: 'Proof the loaf', status: 'active' },
    { id: 'step:bake', label: 'Bake', status: 'locked' },
  ]);
});

test('steps come back in sortOrder whatever order they were given', () => {
  const given = records();
  given.steps.reverse();
  assert.deepEqual(learningProgressViews(given, 'learner:1')[0].steps.map((s) => s.stepId), ['step:knead', 'step:proof', 'step:bake']);
});

test('a track with no steps is empty, not an error', () => {
  const view = learningProgressViews({ tracks: records().tracks }, 'learner:1')[0];
  assert.equal(view.percent, 0);
  assert.equal(view.currentStep, null);
  assert.deepEqual(view.path, []);
  assert.equal(view.statusLabel, 'In progress');
});

test('another learner sees none of this learner\'s state, receipts or evidence', () => {
  const view = learningProgressViews(records(), 'learner:2')[0];
  assert.equal(view.state, null);
  assert.equal(view.percent, 0);
  assert.equal(view.latestEvaluation, null);
  assert.deepEqual(view.recentEvidence, []);
  assert.equal(view.currentStep.stepId, 'step:knead');
});

test('only the three newest pieces of evidence are kept, newest first', () => {
  const given = records();
  given.evidence = [1, 2, 3, 4].map((n) => ({ kind: 'progress-evidence', evidenceId: `e${n}`, learnerId: 'learner:1', trackId: 'track:bread', label: `E${n}`, createdAt: `2026-01-0${n}T00:00:00Z` }));
  assert.deepEqual(learningProgressViews(given, 'learner:1')[0].recentEvidence.map((e) => e.evidenceId), ['e4', 'e3', 'e2']);
});

test('a receipt the state does not name is not the latest evaluation', () => {
  const given = records();
  given.states[0].evaluationReceiptRefs = [];
  assert.equal(learningProgressViews(given, 'learner:1')[0].latestEvaluation, null);
});

test('accepting an evaluation writes the receipt once and derives the next state', () => {
  const plan = acceptEvaluation({ receipt: receipt(), expectedStateRevision: 0 }, null);
  assert.equal(plan.idempotent, false);
  assert.equal(plan.revision, 1);
  assert.equal(plan.decision_key, 'complete');
  assert.equal(plan.writes.length, 2);
  assert.deepEqual(plan.writes[0].expect, { stored: false });
  assert.deepEqual(plan.writes[1].expect, { revision: 0 });
  assert.equal(plan.writes[0].ref, plan.receipt_ref);
  assert.equal(plan.writes[1].ref, plan.state_ref);
  assert.deepEqual(plan.writes[1].record, {
    kind: 'progress-state',
    stateId: progressStateRef('learner:1', 'track:bread'),
    learnerId: 'learner:1',
    trackId: 'track:bread',
    revision: 1,
    currentStepId: 'step:proof',
    completedStepIds: ['step:knead'],
    evaluationReceiptRefs: [plan.receipt_ref],
    updatedAt: NOW,
  });
});

test('a false decision does not finish the step, whatever the decision key says', () => {
  const plan = acceptEvaluation({ receipt: receipt({ decisionKey: 'mastered-label-cannot-unlock', decision: { completed: false } }) }, null);
  assert.deepEqual(plan.writes[1].record.completedStepIds, []);
  assert.equal(plan.writes[1].record.currentStepId, 'step:knead');
});

test('a later evaluation keeps what was finished and moves the revision on', () => {
  const state = records().states[0];
  const second = receipt({ evaluationId: 'evaluation:2', stepId: 'step:proof', decision: { completed: true, nextStepId: 'step:bake' } });
  const plan = buildEvaluationWritePlan({ receipt: second, expectedStateRevision: 1 }, state);
  assert.equal(plan.state.revision, 2);
  assert.deepEqual(plan.state.completedStepIds, ['step:knead', 'step:proof']);
  assert.deepEqual(plan.state.evaluationReceiptRefs, [evaluationReceiptRef('evaluation:1'), evaluationReceiptRef('evaluation:2')]);
  assert.equal(plan.state.currentStepId, 'step:bake');
  assert.equal(plan.state.stateId, 'state:1');
});

test('the same receipt again is accepted without a second write; a changed one is refused', () => {
  const first = acceptEvaluation({ receipt: receipt() }, null);
  const state = first.writes[1].record;
  const again = acceptEvaluation({ receipt: receipt(), storedReceipt: first.writes[0].record }, state);
  assert.equal(again.idempotent, true);
  assert.deepEqual(again.writes, []);
  assert.equal(again.revision, 1);
  assert.throws(() => acceptEvaluation({ receipt: receipt({ score: 0.7 }), storedReceipt: first.writes[0].record }, state), /receipt conflict/);
});

test('a stored receipt with no state naming it is refused', () => {
  assert.throws(() => acceptEvaluation({ receipt: receipt(), storedReceipt: receipt() }, null), /without its derived progress state/);
});

test('a stale revision, a foreign state and bad receipts are refused before any write', () => {
  const state = records().states[0];
  const second = receipt({ evaluationId: 'evaluation:2' });
  assert.throws(() => acceptEvaluation({ receipt: second, expectedStateRevision: 0 }, state), /revision conflict/);
  assert.throws(() => acceptEvaluation({ receipt: second, expectedStateRevision: 1 }, { ...state, learnerId: 'learner:9' }), /identity does not match/);
  assert.throws(() => acceptEvaluation({ receipt: receipt({ evaluationId: 'evaluation:3', confidence: 2 }), expectedStateRevision: 1 }, state), /confidence/);
  assert.throws(() => acceptEvaluation({ receipt: second, expectedStateRevision: -1 }, state), /non-negative/);
});

test('every part of a receipt is checked', () => {
  const bad = (overrides, pattern) => assert.throws(() => validateEvaluationReceipt(receipt(overrides)), pattern);
  bad({ kind: 'other' }, /receipt.kind/);
  bad({ evaluationId: ' ' }, /evaluationId/);
  bad({ evidenceRefs: [] }, /evidenceRefs/);
  bad({ measureFactRef: '' }, /measureFactRef/);
  bad({ decision: { completed: 'yes' } }, /completed must be boolean/);
  bad({ stepId: undefined }, /requires receipt.stepId/);
  bad({ score: Number.NaN }, /score/);
  bad({ provenance: [] }, /provenance/);
  bad({ evaluatedAt: 'someday' }, /ISO date/);
  assert.doesNotThrow(() => validateEvaluationReceipt(receipt({ stepId: undefined, decision: { completed: false } })));
});

test('structural equality ignores key order and compares arrays in order', () => {
  assert.equal(structurallyEqual({ a: 1, b: [1, { c: 2 }] }, { b: [1, { c: 2 }], a: 1 }), true);
  assert.equal(structurallyEqual({ a: [1, 2] }, { a: [2, 1] }), false);
  assert.equal(structurallyEqual({ a: 1 }, { a: 1, b: undefined }), false);
  assert.equal(structurallyEqual(null, {}), false);
});

function run(script, input) {
  const here = fileURLToPath(new URL('../do-work/', import.meta.url));
  const result = spawnSync('node', [`${here}${script}`], { input: JSON.stringify(input), encoding: 'utf8' });
  return result;
}

test('the two scripts read their input on standard input and print the answer on the last line', () => {
  const views = run('work-out-where-a-learner-stands.mjs', { ...records(), learner_id: 'learner:1' });
  assert.equal(views.status, 0);
  assert.equal(JSON.parse(views.stdout.trim().split('\n').pop()).views[0].percent, 33);

  const planned = run('plan-an-evaluation-write.mjs', { receipt: receipt(), expected_state_revision: 0 });
  assert.equal(planned.status, 0);
  assert.equal(JSON.parse(planned.stdout.trim().split('\n').pop()).writes.length, 2);

  const refused = run('plan-an-evaluation-write.mjs', { receipt: receipt(), expected_state_revision: 5 });
  assert.notEqual(refused.status, 0);
  assert.match(refused.stderr, /revision conflict/);
});
