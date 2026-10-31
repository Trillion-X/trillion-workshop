// Carried from bitfield-packages packages/ask-questions-sort-answers-follow-up/do-work/process-submission.test.ts.
// Changed from the package: the plan holds door records (`writes`) where it held an engine write-batch.
import { describe, expect, it } from '../../../test-helpers/vitest-shim.mjs';
import { buildProcessSubmission, type DecideConfig } from '../do-work/process-submission.ts';

const AT = '2026-06-26T00:00:00.000Z';

const CONFIG: DecideConfig = {
  scoreRules: [
    { readKey: 'budget', match: { gte: 1000 }, points: 10 },
    { readKey: 'email', match: { has_value: true }, points: 12 },
  ],
  segmentRules: [
    { min: 0, segmentId: 'cold' },
    { min: 20, segmentId: 'hot' },
  ],
  followUpSequences: [
    { kind: 'follow-up-sequence', segmentId: 'hot', steps: [{ stepId: 's1', venueConfigAddress: 'venue::crm' }] },
  ],
};

describe('buildProcessSubmission — atomic CAPTURE + DECIDE + ACT', () => {
  it('persists every answer fact AND the segment-assignment in ONE write', () => {
    const plan = buildProcessSubmission('intake', 'r1', { budget: 2000, email: 'a@b.com' }, CONFIG, AT);
    const writes = plan.writes;
    // 2 answer facts + 1 segment-assignment
    expect(writes).toHaveLength(3);
    const kinds = writes.map((w) => (w.value as { kind: string }).kind);
    expect(kinds.filter((k) => k === 'answer-fact')).toHaveLength(2);
    expect(kinds.filter((k) => k === 'segment-assignment')).toHaveLength(1);
  });

  it('computes the decision and selects the matching follow-up sequence', () => {
    const plan = buildProcessSubmission('intake', 'r1', { budget: 2000, email: 'a@b.com' }, CONFIG, AT);
    expect(plan.decision.score).toBe(22);
    expect(plan.decision.segmentId).toBe('hot');
    expect(plan.followUp?.steps[0].venueConfigAddress).toBe('venue::crm');
  });

  it('returns no follow-up when the segment has no sequence', () => {
    const plan = buildProcessSubmission('intake', 'r2', { budget: 500 }, CONFIG, AT);
    expect(plan.decision.segmentId).toBe('cold'); // below 20
    expect(plan.followUp).toBeNull();
  });

  it('records a single segment-assignment even for an empty submission', () => {
    const plan = buildProcessSubmission('intake', 'r3', {}, CONFIG, AT);
    const kinds = plan.writes.map((w) => (w.value as { kind: string }).kind);
    expect(kinds).toEqual(['segment-assignment']);
    expect(plan.decision.segmentId).toBe('cold');
  });
});
