import type {
  ProgressEvaluationReceiptRecord,
  ProgressStateRecord,
} from '../read-data/learning-progress-types.ts';

export type AcceptEvaluationRequest = {
  partition_label: string;
  expected_state_revision?: number;
  receipt: ProgressEvaluationReceiptRecord;
};

export type EvaluationWritePlan = {
  receiptRef: string;
  stateRef: string;
  receipt: ProgressEvaluationReceiptRecord;
  state: ProgressStateRecord;
};

export function evaluationReceiptRef(evaluationId: string): string {
  return `package::learning-progress::evaluation::${encodeURIComponent(nonEmpty(evaluationId, 'evaluationId'))}`;
}

export function progressStateRef(learnerId: string, trackId: string): string {
  return `package::learning-progress::state::${encodeURIComponent(nonEmpty(learnerId, 'learnerId'))}::${encodeURIComponent(nonEmpty(trackId, 'trackId'))}`;
}

export function validateEvaluationReceipt(value: ProgressEvaluationReceiptRecord): ProgressEvaluationReceiptRecord {
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

export function buildEvaluationWritePlan(
  request: AcceptEvaluationRequest,
  currentState: ProgressStateRecord | null,
): EvaluationWritePlan {
  const receipt = validateEvaluationReceipt(request.receipt);
  const expectedRevision = request.expected_state_revision ?? 0;
  const currentRevision = currentState?.revision ?? 0;
  if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 0) {
    throw new TypeError('expected_state_revision must be a non-negative integer');
  }
  if (expectedRevision !== currentRevision) {
    throw new Error(`progress state revision conflict: expected ${expectedRevision}, current ${currentRevision}`);
  }
  if (currentState && (currentState.learnerId !== receipt.learnerId || currentState.trackId !== receipt.trackId)) {
    throw new Error('progress state identity does not match the evaluation receipt');
  }

  const receiptRef = evaluationReceiptRef(receipt.evaluationId);
  const completedStepIds = new Set(currentState?.completedStepIds ?? []);
  if (receipt.decision.completed && receipt.stepId) completedStepIds.add(receipt.stepId);
  const evaluationReceiptRefs = new Set(currentState?.evaluationReceiptRefs ?? []);
  evaluationReceiptRefs.add(receiptRef);
  const stateRef = progressStateRef(receipt.learnerId, receipt.trackId);

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

export function structurallyEqual(left: unknown, right: unknown): boolean {
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

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function nonEmpty(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) throw new TypeError(`${label} must be non-empty`);
  return value.trim();
}
