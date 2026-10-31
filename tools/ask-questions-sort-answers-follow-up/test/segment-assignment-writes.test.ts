// Carried from bitfield-packages packages/ask-questions-sort-answers-follow-up/do-work/segment-assignment-writes.test.ts.
// Changed from the package: the assignment is a door record { id, type, value }, so the address-label
// assertions are record-id assertions; the engine write-batch envelope case is gone with the envelope.
import { describe, expect, it } from '../../../test-helpers/vitest-shim.mjs';
import {
  segmentAssignmentId,
  buildSegmentAssignmentWrite,
  SEGMENT_ASSIGNMENT_KIND,
} from '../do-work/segment-assignment-writes.ts';
import { decide } from '../read-data/score-and-segment.ts';

const AT = '2026-06-26T00:00:00.000Z';
const DECISION = decide(
  { budget: 2000, email: 'a@b.com' },
  [
    { readKey: 'budget', match: { gte: 1000 }, points: 10 },
    { readKey: 'email', match: { has_value: true }, points: 12 },
  ],
  [{ min: 0, segmentId: 'cold' }, { min: 20, segmentId: 'hot' }],
);

describe('segmentAssignmentId', () => {
  it('encodes (formId, respondentId)', () => {
    expect(segmentAssignmentId('intake', 'r1')).toBe('segment-assignment:intake:r1');
  });
});

describe('buildSegmentAssignmentWrite', () => {
  it('records the segment + score + breakdown as one addressable fact', () => {
    const w = buildSegmentAssignmentWrite('intake', 'r1', DECISION, AT);
    expect(w.id).toBe('segment-assignment:intake:r1');
    expect(w.type).toBe(SEGMENT_ASSIGNMENT_KIND);
    expect(w.value).toEqual({
      kind: SEGMENT_ASSIGNMENT_KIND,
      formId: 'intake',
      respondentId: 'r1',
      segmentId: 'hot',
      score: 22,
      breakdown: { budget: 10, email: 12 },
      byLabel: {},
      decided_at: AT,
    });
  });
});

describe('segment-assignment session history (submissionId)', () => {
  it('omitting submissionId keeps the stable per-respondent id (backward-compatible)', () => {
    expect(segmentAssignmentId('intake', 'r1')).toBe('segment-assignment:intake:r1');
    const w = buildSegmentAssignmentWrite('intake', 'r1', DECISION, AT);
    expect((w.value as any).submissionId).toBeUndefined();
  });

  it('a repeated decide-form records a DISTINCT segment per session (decision matches its answers)', () => {
    expect(segmentAssignmentId('intake', 'r1', 'wk1')).toBe('segment-assignment:intake:r1:submission:wk1');
    const wk1 = buildSegmentAssignmentWrite('intake', 'r1', DECISION, AT, 'wk1');
    const wk2 = buildSegmentAssignmentWrite('intake', 'r1', DECISION, AT, 'wk2');
    expect(wk1.id).not.toBe(wk2.id); // not overwritten — per-session history
    expect((wk1.value as any).submissionId).toBe('wk1');
    expect((wk2.value as any).submissionId).toBe('wk2');
  });
});
