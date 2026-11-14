import { sendRequestToBitfieldTarget } from '@bitfield/runtime-kit';
import {
  selectedFactorForWeights,
  summarizeNullCalibration,
  summarizeSyncWindow,
  weightedFactorScore,
} from '../read-data/read-motion-comparison.ts';
import type {
  MotionComparisonResultRecord,
  MotionComparisonRequestRecord,
  MotionFactorMeasurement,
  MotionSyncWindow,
} from '../read-data/motion-comparison-factor-types.ts';

export const PUBLISH_MOTION_COMPARISON_RESULT_ACTION = 'action:motion-comparison.publish-result';

export type PublishMotionComparisonResultDraft = {
  comparisonId?: string;
  request: MotionComparisonRequestRecord;
  factorMeasurements: MotionFactorMeasurement[];
  sync: MotionSyncWindow;
  tradeoffNote: string;
  renderArtifactRef?: string;
  now?: Date;
};

export type PublishMotionComparisonResultInput = {
  comparison_id: string;
  result_record: MotionComparisonResultRecord;
};

function generatedId(prefix: string): string {
  return `${prefix}:${crypto.randomUUID()}`;
}

function assertUnitNumber(value: number, label: string): number {
  if (!Number.isFinite(value) || value < 0 || value > 1) {
    throw new Error(`${label} must be between 0 and 1`);
  }
  return value;
}

function cleanFactorMeasurement(measurement: MotionFactorMeasurement): MotionFactorMeasurement {
  const label = measurement.label.trim();
  const reason = measurement.reason.trim();
  if (!measurement.factorKind.trim()) throw new Error('Factor measurement needs a kind');
  if (!label) throw new Error('Factor measurement needs a label');
  if (!reason) throw new Error('Factor measurement needs a reason');
  return {
    ...measurement,
    factorKind: measurement.factorKind.trim(),
    label,
    confidence: assertUnitNumber(measurement.confidence, `${label} confidence`),
    distance: typeof measurement.distance === 'number' ? measurement.distance : undefined,
    reason,
    sourceAttachmentIds: measurement.sourceAttachmentIds?.map((id) => id.trim()).filter(Boolean),
  };
}

function cleanWindow(window: MotionSyncWindow['sourceWindow'], label: string): MotionSyncWindow['sourceWindow'] {
  if (!Number.isFinite(window.startSeconds) || window.startSeconds < 0) {
    throw new Error(`${label} window needs a non-negative start`);
  }
  if (!Number.isFinite(window.endSeconds) || window.endSeconds <= window.startSeconds) {
    throw new Error(`${label} window end must be after start`);
  }
  return {
    startSeconds: window.startSeconds,
    endSeconds: window.endSeconds,
  };
}

function cleanSync(sync: MotionSyncWindow): MotionSyncWindow {
  return {
    sourceWindow: cleanWindow(sync.sourceWindow, 'Source'),
    referenceWindow: cleanWindow(sync.referenceWindow, 'Reference'),
    phaseAlignment: sync.phaseAlignment,
    frameOffsets: sync.frameOffsets.map((offset) => {
      if (!Number.isFinite(offset.sourceTime) || !Number.isFinite(offset.referenceTime) || !Number.isFinite(offset.offsetSeconds)) {
        throw new Error('Frame offsets need numeric times');
      }
      return offset;
    }),
  };
}

export function buildPublishMotionComparisonResultInput(
  draft: PublishMotionComparisonResultDraft,
): PublishMotionComparisonResultInput {
  const comparisonId = draft.comparisonId ?? generatedId('motion-comparison-result');
  const factorMeasurements = draft.factorMeasurements.map(cleanFactorMeasurement);
  const sync = cleanSync(draft.sync);
  const tradeoffNote = draft.tradeoffNote.trim();
  if (!tradeoffNote) throw new Error('Comparison result needs a tradeoff note');
  const selectedFactor = selectedFactorForWeights(factorMeasurements, draft.request.intentWeights);
  if (!selectedFactor) throw new Error('Comparison result needs at least one measured factor');
  const confidence = weightedFactorScore(factorMeasurements, draft.request.intentWeights);
  const noMatchReason = confidence < draft.request.nullCalibration.minimumConfidence
    ? draft.request.nullCalibration.noMatchReason ?? 'No reliable movement match found.'
    : undefined;
  const sourceAttachmentIds = [...new Set(factorMeasurements.flatMap((measurement) => measurement.sourceAttachmentIds ?? []))];
  return {
    comparison_id: comparisonId,
    result_record: {
      kind: 'motion-comparison-result',
      comparisonId,
      requestId: draft.request.requestId,
      sourceClipId: draft.request.sourceClip.clipId,
      referenceClipId: draft.request.referenceClip.clipId,
      selectedFactor,
      factorMeasurements,
      confidence,
      nullCalibration: summarizeNullCalibration(draft.request.nullCalibration, confidence, noMatchReason),
      sync,
      syncEvidence: summarizeSyncWindow(sync),
      tradeoffNote,
      noMatchReason,
      renderArtifactRef: draft.renderArtifactRef,
      sourceAttachmentIds,
      createdAt: (draft.now ?? new Date()).toISOString(),
    },
  };
}

export function publishMotionComparisonResult(input: PublishMotionComparisonResultInput): Promise<unknown> {
  return sendRequestToBitfieldTarget({
    target: 'slot::workflow',
    payload: {
      operation: 'execute_definition',
      definition_id: PUBLISH_MOTION_COMPARISON_RESULT_ACTION,
      include_steps: false,
      include_output: false,
      input,
    },
  });
}
