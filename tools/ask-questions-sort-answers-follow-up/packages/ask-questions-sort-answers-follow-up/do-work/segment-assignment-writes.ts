// packages/ask-questions-sort-answers-follow-up/do-work/segment-assignment-writes.ts
//
// Pure builders for recording the DECIDE outcome. The assigned segment + score
// becomes one addressable EEAF fact keyed (formId, respondentId), so the ACT
// stage's follow-up workflow reads exactly the decision (P6) and the operator
// results surface projects respondents -> segment. No I/O here.

import {
  ENGINE_OPERATION_LABEL_TARGET,
  ENGINE_WRITE_BATCH_OPERATION,
  PUBLISHED_RECORD_PATH,
  type WriteEntry,
} from '@/packages/ask-questions-sort-answers-follow-up/do-work/answer-fact-writes';
import type { DecideResult } from '@/packages/ask-questions-sort-answers-follow-up/read-data/score-and-segment';

const PKG = 'ask-questions-sort-answers-follow-up';
export const SEGMENT_ASSIGNMENT_KIND = 'segment-assignment';

export interface SegmentAssignmentFact {
  kind: typeof SEGMENT_ASSIGNMENT_KIND;
  formId: string;
  respondentId: string;
  segmentId: string | null;
  score: number;
  breakdown: Record<string, number>;
  byLabel: Record<string, number>;
  decided_at: string;
  submissionId?: string;
}

export function segmentAssignmentAddress(formId: string, respondentId: string, submissionId?: string): string {
  const base = `package::${PKG}::segment-assignment::${formId}::${respondentId}`;
  return submissionId ? `${base}::submission::${submissionId}` : base;
}

export function buildSegmentAssignmentWrite(
  formId: string,
  respondentId: string,
  decision: DecideResult,
  decidedAt: string,
  submissionId?: string,
): WriteEntry & { payload: SegmentAssignmentFact } {
  return {
    address_label: segmentAssignmentAddress(formId, respondentId, submissionId),
    address_mode: 'identity_text',
    path_labels: [...PUBLISHED_RECORD_PATH],
    payload: {
      kind: SEGMENT_ASSIGNMENT_KIND,
      formId,
      respondentId,
      segmentId: decision.segmentId,
      score: decision.score,
      breakdown: decision.breakdown,
      byLabel: decision.byLabel,
      decided_at: decidedAt,
      ...(submissionId ? { submissionId } : {}),
    } as SegmentAssignmentFact,
  };
}

export function buildRecordDecisionRequest(
  formId: string,
  respondentId: string,
  decision: DecideResult,
  decidedAt: string,
  submissionId?: string,
) {
  return {
    target: ENGINE_OPERATION_LABEL_TARGET,
    payload: {
      operation_label: ENGINE_WRITE_BATCH_OPERATION,
      writes: [buildSegmentAssignmentWrite(formId, respondentId, decision, decidedAt, submissionId)],
    },
  };
}
