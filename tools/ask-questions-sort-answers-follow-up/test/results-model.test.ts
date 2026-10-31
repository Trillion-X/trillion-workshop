// packages/ask-questions-sort-answers-follow-up/read-data/results-model.test.ts
import { describe, expect, it } from '../../../test-helpers/vitest-shim.mjs';
import {
  readSegmentAssignments,
  summarize,
  buildResultsModel,
} from '../read-data/results-model.ts';

const ENTRY = [
  { payload: { kind: 'segment-assignment', formId: 'intake', respondentId: 'r1', segmentId: 'hot', score: 22, decided_at: '2026-06-26T01:00:00.000Z' } },
  { payload: { kind: 'segment-assignment', formId: 'intake', respondentId: 'r2', segmentId: 'cold', score: 3, decided_at: '2026-06-26T02:00:00.000Z' } },
  { payload: { kind: 'segment-assignment', formId: 'intake', respondentId: 'r3', segmentId: null, score: 0, decided_at: '2026-06-26T00:30:00.000Z' } },
  { payload: { kind: 'segment-assignment', formId: 'other', respondentId: 'r9', segmentId: 'hot', score: 30, decided_at: '2026-06-26T03:00:00.000Z' } },
  { payload: { kind: 'answer-fact', respondentId: 'r1' } }, // ignored
  { payload: { kind: 'segment-assignment', formId: 'intake' } }, // missing respondentId → dropped
];

describe('readSegmentAssignments', () => {
  it('decodes facts, drops malformed, and filters by formId when given', () => {
    expect(readSegmentAssignments(ENTRY, 'intake').map((r) => r.respondentId)).toEqual(['r1', 'r2', 'r3']);
    expect(readSegmentAssignments(ENTRY).map((r) => r.respondentId)).toEqual(['r1', 'r2', 'r3', 'r9']);
  });
  it('is null-safe', () => {
    expect(readSegmentAssignments(null)).toEqual([]);
  });
});

describe('summarize', () => {
  it('counts per segment, bucketing null under "unsegmented"', () => {
    const rows = readSegmentAssignments(ENTRY, 'intake');
    expect(summarize(rows)).toEqual({ total: 3, bySegment: { hot: 1, cold: 1, unsegmented: 1 } });
  });
});

describe('buildResultsModel', () => {
  it('returns rows newest-first + the summary', () => {
    const m = buildResultsModel(ENTRY, 'intake');
    expect(m.rows.map((r) => r.respondentId)).toEqual(['r2', 'r1', 'r3']); // by decidedAt desc
    expect(m.summary.total).toBe(3);
  });
  it('is honest-empty for no submissions', () => {
    expect(buildResultsModel([], 'intake')).toEqual({ rows: [], summary: { total: 0, bySegment: {} } });
  });
});
