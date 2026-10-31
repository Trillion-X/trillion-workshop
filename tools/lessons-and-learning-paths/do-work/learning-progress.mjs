// tools/lessons-and-learning-paths/do-work/learning-progress.mjs
//
// Where a learner stands on a track, and the write that accepts an evaluation of a step. Pure functions over the
// records the caller read: no disk, no clock, no storage. A track is a list of ordered steps; a learner's state on it
// names the current step, the steps finished and the evaluations that moved it; an evaluation receipt is the one thing
// that can finish a step. A label such as "mastered" or a stored percent never finishes anything: only the receipt's
// own `decision.completed` does, and the percent is always counted from the steps.

const DEFAULT_IN_PROGRESS = 'In progress';
const DEFAULT_EVALUATED = 'Evaluated';

/** The reference a state keeps for one evaluation receipt. */
export function evaluationReceiptRef(evaluationId) {
  return `evaluation::${encodeURIComponent(nonEmpty(evaluationId, 'evaluationId'))}`;
}

/** The reference of the one state a learner has on one track. */
export function progressStateRef(learnerId, trackId) {
  return `progress-state::${encodeURIComponent(nonEmpty(learnerId, 'learnerId'))}::${encodeURIComponent(nonEmpty(trackId, 'trackId'))}`;
}

function latestState(states, trackId, learnerId) {
  return [...states]
    .filter((state) => state.trackId === trackId && (!learnerId || state.learnerId === learnerId))
    .sort((a, b) => text(b.updatedAt).localeCompare(text(a.updatedAt)))[0];
}

function statusLabel(receipt, presentations) {
  if (!receipt) return DEFAULT_IN_PROGRESS;
  return presentations.find((item) => item.key === receipt.decisionKey)?.label ?? DEFAULT_EVALUATED;
}

/**
 * One view per track (ordered by track label): its ordered steps, the learner's latest state, the step to do next,
 * how many steps are finished, the percent, the latest evaluation the state names, the three newest pieces of
 * evidence, and the steps as path nodes (complete, active or locked).
 */
export function learningProgressViews({ tracks = [], steps = [], states = [], evidence = [], evaluationReceipts = [], presentations = [] }, learnerId) {
  return tracks
    .map((track) => {
      const ordered = steps
        .filter((step) => step.trackId === track.trackId)
        .sort((a, b) => a.sortOrder - b.sortOrder || a.label.localeCompare(b.label));
      const state = latestState(states, track.trackId, learnerId);
      const completed = new Set(state?.completedStepIds ?? []);
      const currentStep = ordered.find((step) => step.stepId === state?.currentStepId)
        ?? ordered.find((step) => !completed.has(step.stepId))
        ?? ordered[0];
      const completedCount = ordered.filter((step) => completed.has(step.stepId)).length;
      const percent = ordered.length > 0 ? Math.round((completedCount / ordered.length) * 100) : 0;
      const receiptRefs = new Set(state?.evaluationReceiptRefs ?? []);
      const latestEvaluation = evaluationReceipts
        .filter((receipt) => receipt.trackId === track.trackId
          && (!learnerId || receipt.learnerId === learnerId)
          && receiptRefs.has(evaluationReceiptRef(receipt.evaluationId)))
        .sort((a, b) => b.evaluatedAt.localeCompare(a.evaluatedAt))[0];
      const recentEvidence = evidence
        .filter((item) => item.trackId === track.trackId && (!learnerId || item.learnerId === learnerId))
        .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
        .slice(0, 3);
      return {
        track,
        steps: ordered,
        state: state ?? null,
        latestEvaluation: latestEvaluation ?? null,
        currentStep: currentStep ?? null,
        completedCount,
        totalSteps: ordered.length,
        percent,
        statusLabel: statusLabel(latestEvaluation, presentations),
        recentEvidence,
        path: ordered.map((step) => ({
          id: step.stepId,
          label: step.label,
          status: completed.has(step.stepId) ? 'complete' : step.stepId === currentStep?.stepId ? 'active' : 'locked',
        })),
      };
    })
    .sort((a, b) => a.track.label.localeCompare(b.track.label));
}

/** The receipt as given when every part of it is sound; otherwise a TypeError naming the part and how to fix it. */
export function validateEvaluationReceipt(value) {
  if (!value || value.kind !== 'progress-evaluation-receipt') {
    throw new TypeError('receipt.kind must be progress-evaluation-receipt');
  }
  nonEmpty(value.evaluationId, 'evaluationId');
  nonEmpty(value.learnerId, 'learnerId');
  nonEmpty(value.trackId, 'trackId');
  if (value.stepId !== undefined) nonEmpty(value.stepId, 'stepId');
  if (!Array.isArray(value.evidenceRefs) || value.evidenceRefs.length === 0) {
    throw new TypeError('receipt.evidenceRefs must contain at least one reference');
  }
  value.evidenceRefs.forEach((ref) => nonEmpty(ref, 'evidenceRef'));
  nonEmpty(value.measureFactRef, 'measureFactRef');
  nonEmpty(value.measureDefinitionRef, 'measureDefinitionRef');
  nonEmpty(value.decisionKey, 'decisionKey');
  if (!value.decision || typeof value.decision.completed !== 'boolean') {
    throw new TypeError('receipt.decision.completed must be boolean');
  }
  if (value.decision.completed && !value.stepId) {
    throw new TypeError('a completed decision requires receipt.stepId');
  }
  if (value.decision.nextStepId !== undefined) nonEmpty(value.decision.nextStepId, 'decision.nextStepId');
  if (!Number.isFinite(value.score)) throw new TypeError('receipt.score must be finite');
  if (!Number.isFinite(value.confidence) || value.confidence < 0 || value.confidence > 1) {
    throw new TypeError('receipt.confidence must be within [0, 1]');
  }
  if (!value.provenance || typeof value.provenance !== 'object' || Array.isArray(value.provenance)) {
    throw new TypeError('receipt.provenance must be an object');
  }
  nonEmpty(value.evaluatedAt, 'evaluatedAt');
  if (Number.isNaN(Date.parse(value.evaluatedAt))) throw new TypeError('receipt.evaluatedAt must be an ISO date');
  return value;
}

/**
 * The two records to write when an evaluation is accepted: the receipt (written once, never changed) and the learner's
 * next state (revision + 1; the step finished only when the receipt says so; the current step the receipt's next step,
 * else the one it was). Refuses a stale revision and a state that belongs to another learner or track.
 */
export function buildEvaluationWritePlan({ receipt: given, expectedStateRevision = 0 }, currentState) {
  const receipt = validateEvaluationReceipt(given);
  const currentRevision = currentState?.revision ?? 0;
  if (!Number.isSafeInteger(expectedStateRevision) || expectedStateRevision < 0) {
    throw new TypeError('expected_state_revision must be a non-negative integer');
  }
  if (expectedStateRevision !== currentRevision) {
    throw new Error(`progress state revision conflict: expected ${expectedStateRevision}, current ${currentRevision}`);
  }
  if (currentState && (currentState.learnerId !== receipt.learnerId || currentState.trackId !== receipt.trackId)) {
    throw new Error('progress state identity does not match the evaluation receipt');
  }
  const receiptRef = evaluationReceiptRef(receipt.evaluationId);
  const stateRef = progressStateRef(receipt.learnerId, receipt.trackId);
  const completedStepIds = new Set(currentState?.completedStepIds ?? []);
  if (receipt.decision.completed && receipt.stepId) completedStepIds.add(receipt.stepId);
  const evaluationReceiptRefs = new Set(currentState?.evaluationReceiptRefs ?? []);
  evaluationReceiptRefs.add(receiptRef);
  return {
    receiptRef,
    stateRef,
    receipt,
    state: {
      kind: 'progress-state',
      stateId: currentState?.stateId ?? stateRef,
      learnerId: receipt.learnerId,
      trackId: receipt.trackId,
      revision: currentRevision + 1,
      currentStepId: receipt.decision.nextStepId ?? currentState?.currentStepId ?? receipt.stepId,
      completedStepIds: [...completedStepIds],
      evaluationReceiptRefs: [...evaluationReceiptRefs],
      updatedAt: receipt.evaluatedAt,
    },
  };
}

/**
 * What to do with an evaluation, given what is stored now: the receipt already stored (or null) and the state stored
 * now (or null). The same receipt twice is accepted without a second write; a different receipt under the same id is
 * refused; a new one gets its write plan.
 */
export function acceptEvaluation({ receipt, expectedStateRevision = 0, storedReceipt = null }, currentState) {
  const checked = validateEvaluationReceipt(receipt);
  const receiptRef = evaluationReceiptRef(checked.evaluationId);
  const stateRef = progressStateRef(checked.learnerId, checked.trackId);
  if (storedReceipt) {
    if (!structurallyEqual(storedReceipt, checked)) throw new Error(`evaluation receipt conflict: ${checked.evaluationId}`);
    if (!currentState || !currentState.evaluationReceiptRefs.includes(receiptRef)) {
      throw new Error('idempotent receipt exists without its derived progress state');
    }
    return { idempotent: true, receipt_ref: receiptRef, state_ref: stateRef, revision: currentState.revision, decision_key: checked.decisionKey, writes: [] };
  }
  const plan = buildEvaluationWritePlan({ receipt: checked, expectedStateRevision }, currentState);
  return {
    idempotent: false,
    receipt_ref: plan.receiptRef,
    state_ref: plan.stateRef,
    revision: plan.state.revision,
    decision_key: checked.decisionKey,
    writes: [
      { ref: plan.receiptRef, record: plan.receipt, expect: { stored: false } },
      { ref: plan.stateRef, record: plan.state, expect: { revision: currentState?.revision ?? 0 } },
    ],
  };
}

export function structurallyEqual(left, right) {
  if (Object.is(left, right)) return true;
  if (Array.isArray(left) || Array.isArray(right)) {
    return Array.isArray(left)
      && Array.isArray(right)
      && left.length === right.length
      && left.every((item, index) => structurallyEqual(item, right[index]));
  }
  if (!isObject(left) || !isObject(right)) return false;
  const leftKeys = Object.keys(left).sort();
  const rightKeys = Object.keys(right).sort();
  return leftKeys.length === rightKeys.length
    && leftKeys.every((key, index) => key === rightKeys[index] && structurallyEqual(left[key], right[key]));
}

function isObject(value) {
  return typeof value === 'object' && value !== null;
}

function text(value) {
  return typeof value === 'string' ? value : '';
}

function nonEmpty(value, label) {
  if (typeof value !== 'string' || value.trim().length === 0) throw new TypeError(`${label} must be non-empty`);
  return value.trim();
}
