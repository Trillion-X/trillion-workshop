// tools/ask-questions-sort-answers-follow-up/do-work/segment-assignment-writes.ts
//
// Pure builders for recording the DECIDE outcome. The assigned segment + score becomes one record keyed
// (formId, respondentId), so the follow-up step reads exactly the decision and the results view projects
// respondents -> segment. No I/O here.
//
// Changed from the package: the record is a door record { id, type, value } (the package built an engine
// write-batch entry and a write-batch request, both gone with the old engine).

import type { RecordWrite } from '../read-data/record-rows.ts';
import type { DecideResult } from '../read-data/score-and-segment.ts';

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

export function segmentAssignmentId(formId: string, respondentId: string, submissionId?: string): string {
  const base = `${SEGMENT_ASSIGNMENT_KIND}:${formId}:${respondentId}`;
  return submissionId ? `${base}:submission:${submissionId}` : base;
}

export function buildSegmentAssignmentWrite(
  formId: string,
  respondentId: string,
  decision: DecideResult,
  decidedAt: string,
  submissionId?: string,
): RecordWrite & { value: SegmentAssignmentFact } {
  return {
    id: segmentAssignmentId(formId, respondentId, submissionId),
    type: SEGMENT_ASSIGNMENT_KIND,
    value: {
      kind: SEGMENT_ASSIGNMENT_KIND,
      formId,
      respondentId,
      segmentId: decision.segmentId,
      score: decision.score,
      breakdown: decision.breakdown,
      byLabel: decision.byLabel,
      decided_at: decidedAt,
      ...(submissionId ? { submissionId } : {}),
    },
  };
}
