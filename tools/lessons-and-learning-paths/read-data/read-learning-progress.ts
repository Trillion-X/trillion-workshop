import type {
  LearningProgressFocusView,
  LearningProgressState,
  ProgressEvaluationReceiptRecord,
  ProgressEvidenceRecord,
  ProgressPresentationRecord,
  ProgressStateRecord,
  ProgressStepRecord,
  ProgressTrackRecord,
} from './learning-progress-types.ts';

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function payloadFromRow(row: unknown): unknown {
  if (!isRecord(row)) return row;
  return row.payload ?? row.value ?? row;
}

function addressFromRow(row: unknown): string {
  if (!isRecord(row)) return '';
  return typeof row.address === 'string'
    ? row.address
    : typeof row.address_text === 'string'
      ? row.address_text
      : '';
}

function kind(value: unknown): string {
  return isRecord(value) && typeof value.kind === 'string' ? value.kind : '';
}

function toDateText(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function latestState(states: readonly ProgressStateRecord[], trackId: string, learnerId?: string): ProgressStateRecord | undefined {
  return [...states]
    .filter((state) => state.trackId === trackId && (!learnerId || state.learnerId === learnerId))
    .sort((a, b) => toDateText(b.updatedAt).localeCompare(toDateText(a.updatedAt)))[0];
}

function statusLabel(
  receipt: ProgressEvaluationReceiptRecord | undefined,
  presentations: readonly ProgressPresentationRecord[],
): string {
  if (!receipt) return 'In progress';
  return presentations.find((item) => item.key === receipt.decisionKey)?.label ?? 'Evaluated';
}

export function readLearningProgressState(rows: unknown): LearningProgressState {
  const sourceRows = Array.isArray(rows) ? rows : [];
  const values = sourceRows.map(payloadFromRow);
  const ownerValues = sourceRows
    .filter((row) => addressFromRow(row).startsWith('package::learning-progress::'))
    .map(payloadFromRow);
  return {
    tracks: values.filter((value): value is ProgressTrackRecord => kind(value) === 'progress-track'),
    steps: values.filter((value): value is ProgressStepRecord => kind(value) === 'progress-step'),
    states: ownerValues.filter((value): value is ProgressStateRecord => kind(value) === 'progress-state'),
    evidence: values.filter((value): value is ProgressEvidenceRecord => kind(value) === 'progress-evidence'),
    evaluationReceipts: ownerValues.filter((value): value is ProgressEvaluationReceiptRecord => kind(value) === 'progress-evaluation-receipt'),
    presentations: values.filter((value): value is ProgressPresentationRecord => kind(value) === 'progress-presentation'),
  };
}

export function learningProgressViews(state: LearningProgressState, learnerId?: string): LearningProgressFocusView[] {
  return state.tracks
    .map((track) => {
      const steps = state.steps
        .filter((step) => step.trackId === track.trackId)
        .sort((a, b) => a.sortOrder - b.sortOrder || a.label.localeCompare(b.label));
      const currentState = latestState(state.states, track.trackId, learnerId);
      const completed = new Set(currentState?.completedStepIds ?? []);
      const currentStep = steps.find((step) => step.stepId === currentState?.currentStepId)
        ?? steps.find((step) => !completed.has(step.stepId))
        ?? steps[0];
      const completedCount = steps.filter((step) => completed.has(step.stepId)).length;
      const percent = steps.length > 0
        ? Math.round((completedCount / steps.length) * 100)
        : 0;
      const receiptRefs = new Set(currentState?.evaluationReceiptRefs ?? []);
      const latestEvaluation = state.evaluationReceipts
        .filter((receipt) => receipt.trackId === track.trackId
          && (!learnerId || receipt.learnerId === learnerId)
          && receiptRefs.has(`package::learning-progress::evaluation::${encodeURIComponent(receipt.evaluationId)}`))
        .sort((a, b) => b.evaluatedAt.localeCompare(a.evaluatedAt))[0];
      const recentEvidence = state.evidence
        .filter((item) => item.trackId === track.trackId && (!learnerId || item.learnerId === learnerId))
        .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
        .slice(0, 3);

      return {
        track,
        steps,
        state: currentState,
        latestEvaluation,
        currentStep,
        completedCount,
        totalSteps: steps.length,
        percent,
        statusLabel: statusLabel(latestEvaluation, state.presentations),
        recentEvidence,
      };
    })
    .sort((a, b) => a.track.label.localeCompare(b.track.label));
}
