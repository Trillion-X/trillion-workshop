import type {
  LearningProgressState,
  ProgressEvaluationReceiptRecord,
  ProgressEvidenceRecord,
  ProgressPresentationRecord,
  ProgressStateRecord,
  ProgressStepRecord,
  ProgressTrackRecord,
} from './learning-progress-types';

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
