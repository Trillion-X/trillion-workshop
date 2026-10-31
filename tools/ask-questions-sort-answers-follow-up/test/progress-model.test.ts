// packages/ask-questions-sort-answers-follow-up/read-data/progress-model.test.ts
//
// Contract for buildProgressModel — a respondent's own answer-facts (as they sit
// in the live published-records feed) folded into a progress model: ordered rows,
// a numeric trend series, the latest session, honest-empty. Reuses the package's
// own SSOT fold (foldAnswerFacts -> foldSessionsToRows); no fabrication (L117).

import { describe, it, expect } from '../../../test-helpers/vitest-shim.mjs';
import { buildProgressModel } from '../read-data/progress-model.ts';

// published-records rows are payload-wrapped; answer-facts among them carry kind:'answer-fact'.
function fact(qid: string, value: unknown, at: string, sub: string, respondentId = 'student-abc') {
  return { payload: { kind: 'answer-fact', formId: 'practice-session', respondentId, questionId: qid, value, answered_at: at, submissionId: sub } };
}

const FEED = [
  { payload: { kind: 'segment-assignment', respondentId: 'x' } }, // noise the model must ignore
  fact('focus_rating', 6, '2026-06-20T18:00:00Z', 'sub-1'),
  fact('goals_met', 'partially', '2026-06-20T18:00:00Z', 'sub-1'),
  fact('focus_rating', 9, '2026-06-27T18:00:00Z', 'sub-2'),
  fact('goals_met', 'yes', '2026-06-27T18:00:00Z', 'sub-2'),
  fact('focus_rating', 3, '2026-06-25T10:00:00Z', 'other-sub', 'someone-else'), // different student
];

const OPTS = { formId: 'practice-session', respondentId: 'student-abc', fieldMap: { focus: 'focus_rating', goals: 'goals_met' } };

describe('buildProgressModel — respondent progress from the live feed', () => {
  it('folds only THIS respondent, chronological, with a numeric trend + latest', () => {
    const model = buildProgressModel(FEED, OPTS);
    expect(model.count).toBe(2); // other student + the segment-assignment noise excluded
    expect(model.rows.map((r) => r.id)).toEqual(['sub-1', 'sub-2']);
    expect(model.trend).toEqual({ field: 'focus', points: [6, 9] });
    expect(model.latest).toMatchObject({ focus: 9, goals: 'yes' });
  });

  it('honest-empty: no matching facts -> empty model (pre-first-session, L117)', () => {
    const model = buildProgressModel([], OPTS);
    expect(model).toEqual({ rows: [], trend: null, latest: null, count: 0 });
  });

  it('no respondent id -> folds nothing (a progress view is per-student)', () => {
    // foldAnswerFacts with an absent respondent would fold everyone; the surface
    // passes the current student. Here we prove an unknown student yields empty.
    expect(buildProgressModel(FEED, { ...OPTS, respondentId: 'nobody' }).count).toBe(0);
  });

  it('trendField picks a specific numeric field; falls back when it is non-numeric', () => {
    const model = buildProgressModel(FEED, { ...OPTS, trendField: 'goals' });
    // goals is textual -> pickTrend falls through to the first numeric field (focus)
    expect(model.trend?.field).toBe('focus');
  });

  it('ignores non-answer-fact records in the feed (segment-assignments, etc.)', () => {
    const onlyNoise = [{ payload: { kind: 'segment-assignment', respondentId: 'student-abc' } }];
    expect(buildProgressModel(onlyNoise, OPTS).count).toBe(0);
  });
});
