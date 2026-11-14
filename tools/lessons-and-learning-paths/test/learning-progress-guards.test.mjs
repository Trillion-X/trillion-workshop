// Tests for what the retired Bitfield package guarded and the engine now guards: a state written under the retired
// receipt reference still names its receipt, and a write counts only when it is read back as written. The bakery
// course is made up.

import assert from 'node:assert/strict';
import test from 'node:test';

import {
  acceptEvaluation,
  evaluationReceiptRef,
  learningProgressViews,
  namesEvaluationReceipt,
  writesNotReadBack,
} from '../do-work/learning-progress.mjs';
import { OWNER_ADDRESS, progressRowsOf } from '../packages/learning-progress/read-data/progress-rows.mjs';
import rowTypes from '../packages/learning-progress/read-data/progress-row-types.json' with { type: 'json' };

const NOW = '2026-01-01T12:00:00.000Z';
const LEGACY = (id) => `package::learning-progress::evaluation::${encodeURIComponent(id)}`;

function receipt(overrides = {}) {
  return {
    kind: 'progress-evaluation-receipt', evaluationId: 'evaluation:1', learnerId: 'learner:1', trackId: 'track:bread', stepId: 'step:knead',
    evidenceRefs: ['evidence:1'], measureFactRef: 'measure-fact:1', measureDefinitionRef: 'measure-definition:1', decisionKey: 'complete',
    decision: { completed: true, nextStepId: 'step:proof' }, score: 0.8, confidence: 0.9, provenance: { evaluator: 'evaluator:1' }, evaluatedAt: NOW, ...overrides,
  };
}

test('a reference in either form names its receipt, and another evaluation does not match', () => {
  assert.equal(namesEvaluationReceipt([evaluationReceiptRef('evaluation:1')], 'evaluation:1'), true);
  assert.equal(namesEvaluationReceipt([LEGACY('evaluation:1')], 'evaluation:1'), true);
  assert.equal(namesEvaluationReceipt([LEGACY('evaluation:2')], 'evaluation:1'), false);
  assert.equal(namesEvaluationReceipt([], 'evaluation:1'), false);
});

test('a state written under the retired reference still gives the view its latest evaluation', () => {
  const input = {
    tracks: [{ kind: 'progress-track', trackId: 'track:bread', label: 'Baking bread' }],
    steps: [{ kind: 'progress-step', stepId: 'step:knead', trackId: 'track:bread', label: 'Knead', sortOrder: 1 }],
    states: [{ kind: 'progress-state', stateId: 'state:1', trackId: 'track:bread', learnerId: 'learner:1', revision: 1, currentStepId: 'step:knead', completedStepIds: [], evaluationReceiptRefs: [LEGACY('evaluation:1')], updatedAt: NOW }],
    evaluationReceipts: [receipt()],
    presentations: [{ kind: 'progress-presentation', key: 'complete', label: 'Done well' }],
  };
  const [view] = learningProgressViews(input, 'learner:1');
  assert.equal(view.latestEvaluation?.evaluationId, 'evaluation:1');
  assert.equal(view.statusLabel, 'Done well');
});

test('the same receipt again is accepted idempotently when the state holds the retired reference', () => {
  const first = acceptEvaluation({ receipt: receipt() }, null);
  const state = { ...first.writes[1].record, evaluationReceiptRefs: [LEGACY('evaluation:1')] };
  const again = acceptEvaluation({ receipt: receipt(), storedReceipt: first.writes[0].record }, state);
  assert.equal(again.idempotent, true);
});

test('a write counts only when it is read back as written', () => {
  const { writes } = acceptEvaluation({ receipt: receipt() }, null);
  const [receiptWrite, stateWrite] = writes;
  assert.deepEqual(writesNotReadBack(writes, { [receiptWrite.ref]: receiptWrite.record, [stateWrite.ref]: stateWrite.record }), []);
  assert.deepEqual(writesNotReadBack(writes, { [receiptWrite.ref]: receiptWrite.record }), [stateWrite.ref]);
  assert.deepEqual(writesNotReadBack(writes, { [receiptWrite.ref]: receiptWrite.record, [stateWrite.ref]: { ...stateWrite.record, revision: 9 } }), [stateWrite.ref]);
  assert.deepEqual(writesNotReadBack(writes, undefined), [receiptWrite.ref, stateWrite.ref]);
});

test('only the rows of the state and receipt lists carry the owner address, and a row takes its list kind when it has none', () => {
  const rows = progressRowsOf(rowTypes, {
    'record:progress-track': [{ id: 'record:progress-track:1', value: { trackId: 'track:bread', label: 'Baking bread' } }],
    'record:progress-state': [{ id: 'record:progress-state:1', value: { trackId: 'track:bread', learnerId: 'learner:1' } }],
    'record:progress-evidence': [{ id: 'record:progress-evidence:1', value: { kind: 'progress-state', trackId: 'track:bread' } }, { id: 'record:progress-evidence:2', value: null }],
  });
  assert.deepEqual(rows.map((row) => [row.address.startsWith(OWNER_ADDRESS), row.payload.kind]), [[false, 'progress-track'], [true, 'progress-state'], [false, 'progress-state']]);
  assert.equal(rows.length, 3);
});
