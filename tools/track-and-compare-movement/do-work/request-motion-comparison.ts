import { sendRequestToBitfieldTarget } from '@bitfield/runtime-kit';
import type {
  KnownMotionComparisonIntent,
  MotionComparisonClipRef,
  MotionComparisonIntent,
  MotionComparisonRequestRecord,
  MotionIntentWeights,
  MotionNullCalibration,
} from '../read-data/motion-comparison-factor-types.ts';

export const REQUEST_MOTION_COMPARISON_ACTION = 'action:motion-comparison.request-comparison';

export type RequestMotionComparisonDraft = {
  requestId?: string;
  sourceClip: MotionComparisonClipRef;
  referenceClip: MotionComparisonClipRef;
  intent: MotionComparisonIntent;
  intentWeights?: MotionIntentWeights;
  nullCalibration?: Partial<MotionNullCalibration>;
  requestedBy?: string;
  now?: Date;
};

export type RequestMotionComparisonInput = {
  request_id: string;
  request_record: MotionComparisonRequestRecord;
};

const DEFAULT_WEIGHTS: Record<KnownMotionComparisonIntent, MotionIntentWeights> = {
  'same-view': {
    'hand-feature': 0.6,
    'learned-view-factor': 0.4,
    'pose-phase': 0.2,
  },
  'same-phase': {
    'pose-phase': 0.7,
    'motion-type': 0.3,
  },
  'same-motion': {
    'motion-type': 0.7,
    'pose-phase': 0.3,
  },
  'coaching-review': {
    'hand-feature': 0.35,
    'learned-view-factor': 0.25,
    'pose-phase': 0.25,
    'motion-type': 0.15,
  },
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

function cleanWeights(weights: MotionIntentWeights): MotionIntentWeights {
  return Object.fromEntries(
    Object.entries(weights)
      .filter((entry): entry is [string, number] => typeof entry[1] === 'number')
      .map(([factorKind, value]) => [factorKind, assertUnitNumber(value, `${factorKind} weight`)])
      .filter(([, value]) => value > 0),
  );
}

function defaultWeightsForIntent(intent: MotionComparisonIntent): MotionIntentWeights {
  return DEFAULT_WEIGHTS[intent as KnownMotionComparisonIntent] ?? {
    'configured-fallback': 1,
  };
}

function cleanClip(clip: MotionComparisonClipRef, role: string): MotionComparisonClipRef {
  if (!clip.clipId.trim()) throw new Error(`${role} clip needs an id`);
  if (!clip.label.trim()) throw new Error(`${role} clip needs a label`);
  return {
    ...clip,
    clipId: clip.clipId.trim(),
    label: clip.label.trim(),
  };
}

function cleanNullCalibration(calibration: Partial<MotionNullCalibration> | undefined): MotionNullCalibration {
  const minimumConfidence = assertUnitNumber(calibration?.minimumConfidence ?? 0.6, 'Minimum confidence');
  const noMatchReason = calibration?.noMatchReason?.trim();
  return {
    minimumConfidence,
    noMatchReason: noMatchReason || undefined,
    confidenceBand: calibration?.confidenceBand,
  };
}

export function buildRequestMotionComparisonInput(draft: RequestMotionComparisonDraft): RequestMotionComparisonInput {
  const requestId = draft.requestId ?? generatedId('motion-comparison-request');
  const weights = cleanWeights({
    ...defaultWeightsForIntent(draft.intent),
    ...draft.intentWeights,
  });
  return {
    request_id: requestId,
    request_record: {
      kind: 'motion-comparison-request',
      requestId,
      sourceClip: cleanClip(draft.sourceClip, 'Source'),
      referenceClip: cleanClip(draft.referenceClip, 'Reference'),
      intent: draft.intent,
      intentWeights: weights,
      nullCalibration: cleanNullCalibration(draft.nullCalibration),
      requestedBy: draft.requestedBy,
      requestedAt: (draft.now ?? new Date()).toISOString(),
    },
  };
}

export function requestMotionComparison(input: RequestMotionComparisonInput): Promise<unknown> {
  return sendRequestToBitfieldTarget({
    target: 'slot::workflow',
    payload: {
      operation: 'execute_definition',
      definition_id: REQUEST_MOTION_COMPARISON_ACTION,
      include_steps: false,
      include_output: false,
      input,
    },
  });
}
