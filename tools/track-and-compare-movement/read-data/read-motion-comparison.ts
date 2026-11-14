import type {
  KnownMotionComparisonFactorKind,
  MotionCalibrationSummary,
  MotionComparisonFactorKind,
  MotionComparisonResultRecord,
  MotionComparisonState,
  MotionComparisonView,
  MotionFactorMeasurement,
  MotionIntentWeights,
  MotionNullCalibration,
  MotionSyncEvidenceSummary,
  MotionSyncWindow,
  MotionWindow,
  MotionWindowSummary,
} from './motion-comparison-factor-types.ts';

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function payloadFromRow(row: unknown): unknown {
  if (!isRecord(row)) return row;
  return row.payload ?? row.value ?? row;
}

function kind(value: unknown): string {
  return isRecord(value) && typeof value.kind === 'string' ? value.kind : '';
}

function latestByCreatedAt<T extends { createdAt: string }>(items: readonly T[]): T | undefined {
  return [...items].sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0];
}

export function readMotionComparisonState(rows: unknown): MotionComparisonState {
  const values = Array.isArray(rows) ? rows.map(payloadFromRow) : [];
  return {
    requests: values.filter((value): value is MotionComparisonState['requests'][number] => kind(value) === 'motion-comparison-request'),
    results: values.filter((value): value is MotionComparisonResultRecord => kind(value) === 'motion-comparison-result'),
    sourceAttachments: values.filter((value): value is MotionComparisonState['sourceAttachments'][number] => kind(value) === 'motion-source-attachment'),
    coachingAttachments: values.filter((value): value is MotionComparisonState['coachingAttachments'][number] => kind(value) === 'motion-coaching-attachment'),
    renders: values.filter((value): value is MotionComparisonState['renders'][number] => kind(value) === 'motion-comparison-render'),
  };
}

export function weightedFactorScore(
  measurements: readonly MotionFactorMeasurement[],
  weights: MotionIntentWeights,
): number {
  let totalWeight = 0;
  let total = 0;
  for (const measurement of measurements) {
    const weight = weights[measurement.factorKind] ?? 0;
    if (weight <= 0) continue;
    totalWeight += weight;
    total += measurement.confidence * weight;
  }
  return totalWeight > 0 ? total / totalWeight : 0;
}

export function selectedFactorForWeights(
  measurements: readonly MotionFactorMeasurement[],
  weights: MotionIntentWeights,
): MotionFactorMeasurement | undefined {
  return [...measurements].sort((a, b) => {
    const weightedA = a.confidence * (weights[a.factorKind] ?? 0);
    const weightedB = b.confidence * (weights[b.factorKind] ?? 0);
    return weightedB - weightedA || b.confidence - a.confidence;
  })[0];
}

function roundSeconds(value: number): number {
  return Number(value.toFixed(3));
}

export function summarizeMotionWindow(window: MotionWindow): MotionWindowSummary {
  const startSeconds = roundSeconds(window.startSeconds);
  const endSeconds = roundSeconds(window.endSeconds);
  return {
    startSeconds,
    endSeconds,
    durationSeconds: roundSeconds(Math.max(0, endSeconds - startSeconds)),
    midpointSeconds: roundSeconds(startSeconds + Math.max(0, endSeconds - startSeconds) / 2),
  };
}

export function summarizeSyncWindow(sync: MotionSyncWindow): MotionSyncEvidenceSummary {
  const offsets = sync.frameOffsets.map((offset) => offset.offsetSeconds);
  const averageOffsetSeconds = offsets.length
    ? offsets.reduce((total, offset) => total + offset, 0) / offsets.length
    : 0;
  const maxOffsetDriftSeconds = offsets.length
    ? Math.max(...offsets.map((offset) => Math.abs(offset - averageOffsetSeconds)))
    : 0;
  return {
    sourceWindow: summarizeMotionWindow(sync.sourceWindow),
    referenceWindow: summarizeMotionWindow(sync.referenceWindow),
    phaseAlignment: sync.phaseAlignment,
    frameOffsetCount: sync.frameOffsets.length,
    averageOffsetSeconds: roundSeconds(averageOffsetSeconds),
    maxOffsetDriftSeconds: roundSeconds(maxOffsetDriftSeconds),
  };
}

export function summarizeNullCalibration(
  calibration: MotionNullCalibration,
  confidence: number,
  noMatchReason?: string,
): MotionCalibrationSummary {
  const passed = confidence >= calibration.minimumConfidence;
  return {
    minimumConfidence: calibration.minimumConfidence,
    confidence: roundSeconds(confidence),
    confidenceBand: calibration.confidenceBand,
    passed,
    noMatchReason: passed ? undefined : noMatchReason ?? calibration.noMatchReason,
  };
}

export function factorSummary(result: MotionComparisonResultRecord | undefined): string {
  if (!result) return 'No comparison yet';
  if (result.noMatchReason) return result.noMatchReason;
  return `${result.selectedFactor.label}: ${Math.round(result.selectedFactor.confidence * 100)}%`;
}

export function syncSummary(result: MotionComparisonResultRecord | undefined): string {
  if (!result) return 'Choose clips';
  const summary = result.syncEvidence ?? summarizeSyncWindow(result.sync);
  const source = summary.sourceWindow;
  const reference = summary.referenceWindow;
  return `${source.startSeconds}s-${source.endSeconds}s matches ${reference.startSeconds}s-${reference.endSeconds}s`;
}

export function calibrationSummary(result: MotionComparisonResultRecord | undefined): string {
  if (!result) return 'No confidence gate yet';
  const summary = (result as Partial<MotionComparisonResultRecord>).nullCalibration;
  if (!summary) return 'No confidence gate recorded';
  const confidence = Math.round(summary.confidence * 100);
  const minimum = Math.round(summary.minimumConfidence * 100);
  const band = summary.confidenceBand ? `, ${summary.confidenceBand}` : '';
  return summary.passed
    ? `${confidence}% clears ${minimum}%${band}`
    : `${confidence}% below ${minimum}%${band}`;
}

export function motionComparisonViews(state: MotionComparisonState): MotionComparisonView[] {
  return state.requests
    .map((request) => {
      const result = latestByCreatedAt(state.results.filter((candidate) => candidate.requestId === request.requestId));
      const ids = new Set([request.requestId, result?.comparisonId].filter(Boolean));
      const sourceAttachmentIds = new Set(result?.sourceAttachmentIds ?? []);
      const sourceAttachments = state.sourceAttachments.filter((attachment) => (
        ids.has(attachment.attachedToId) || sourceAttachmentIds.has(attachment.attachmentId)
      ));
      const coachingAttachments = state.coachingAttachments.filter((attachment) => attachment.comparisonId === result?.comparisonId);
      const render = result?.comparisonId
        ? state.renders.find((candidate) => candidate.comparisonId === result.comparisonId)
        : undefined;
      return {
        request,
        result,
        sourceAttachments,
        coachingAttachments,
        status: result?.noMatchReason ? 'no-match' : result ? 'matched' : 'requested',
        factorSummary: factorSummary(result),
        syncSummary: syncSummary(result),
        calibrationSummary: calibrationSummary(result),
        render,
      };
    })
    .sort((a, b) => b.request.requestedAt.localeCompare(a.request.requestedAt));
}

export function factorKindLabels(): Record<KnownMotionComparisonFactorKind, string> {
  return {
    'hand-feature': 'Hand feature',
    'learned-view-factor': 'Learned view',
    'pose-phase': 'Pose phase',
    'motion-type': 'Motion type',
    'configured-fallback': 'Configured fallback',
  };
}

export function factorKindLabel(kind: MotionComparisonFactorKind): string {
  return factorKindLabels()[kind as KnownMotionComparisonFactorKind] ?? kind
    .split('-')
    .filter(Boolean)
    .map((part) => `${part.slice(0, 1).toUpperCase()}${part.slice(1)}`)
    .join(' ');
}
