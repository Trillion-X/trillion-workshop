// packages/ask-questions-sort-answers-follow-up/read-data/session-progress-rows.test.ts
//
// Contract for foldSessionsToRows — the read view that turns a respondent's folded
// journal history into ordered per-session progress rows for a "progress over time"
// surface. Proves: chronological order, DATA-driven field mapping (no hardcoded
// domain fields), honest omission of unanswered fields (never fabricated), the
// answeredAt time axis, stable handling of timestamp-less/one-shot sessions, and
// L069 cross-domain reuse. Runs the FULL real path: foldAnswerFacts -> foldSessionsToRows.

import { describe, it, expect } from '../../../test-helpers/vitest-shim.mjs';
import { foldAnswerFacts, type AnswerFactRow } from '../read-data/fold-answer-facts.ts';
import { foldSessionsToRows } from '../read-data/session-progress-rows.ts';

// Build an answer-fact row exactly as buildAnswerFactWrites emits (payload-wrapped).
function fact(
  formId: string,
  respondentId: string,
  questionId: string,
  value: unknown,
  answered_at: string,
  submissionId?: string,
): AnswerFactRow {
  return { payload: { kind: 'answer-fact', formId, respondentId, questionId, value, answered_at, submissionId } };
}

// Two real practice-journal submissions by one student (the CJ-C.1/C.2 seam),
// each with a focus rating + goals-met + a reflection. submissionId keeps them
// distinct (the journal-history primitive).
const STUDENT = 'student-abc';
const FORM = 'practice-session';
const FACTS: AnswerFactRow[] = [
  // session 1 (earlier)
  fact(FORM, STUDENT, 'focus_rating', 6, '2026-06-20T18:00:00Z', 'sub-1'),
  fact(FORM, STUDENT, 'goals_met', 'partially', '2026-06-20T18:00:00Z', 'sub-1'),
  fact(FORM, STUDENT, 'reflection', 'Held the tempo better in the second half.', '2026-06-20T18:00:00Z', 'sub-1'),
  // session 2 (later)
  fact(FORM, STUDENT, 'focus_rating', 9, '2026-06-27T18:00:00Z', 'sub-2'),
  fact(FORM, STUDENT, 'goals_met', 'yes', '2026-06-27T18:00:00Z', 'sub-2'),
  fact(FORM, STUDENT, 'reflection', 'Stayed calm on big points.', '2026-06-27T18:00:00Z', 'sub-2'),
];

// The field map is DATA: output field -> questionId. The module never names
// these — the caller names its own questions.
const FIELD_MAP = { focus: 'focus_rating', goals: 'goals_met', reflection: 'reflection' };

describe('foldSessionsToRows — journal history -> ordered progress rows (L069/L090)', () => {
  it('produces one row per session, oldest->newest, fields mapped from DATA', () => {
    const sessions = foldAnswerFacts(FACTS, { respondentId: STUDENT });
    const rows = foldSessionsToRows(sessions, FIELD_MAP);
    expect(rows.map((r) => r.id)).toEqual(['sub-1', 'sub-2']); // chronological
    expect(rows[0].fields).toMatchObject({ focus: 6, goals: 'partially', reflection: 'Held the tempo better in the second half.', answeredAt: '2026-06-20T18:00:00Z' });
    expect(rows[1].fields).toMatchObject({ focus: 9, goals: 'yes', answeredAt: '2026-06-27T18:00:00Z' });
    // label defaults to the session date (the time axis a trend reads)
    expect(rows[0].label).toBe('2026-06-20T18:00:00Z');
  });

  it('omits an unanswered mapped field (honest-degrade, never fabricated)', () => {
    const partial = foldAnswerFacts(
      [fact(FORM, STUDENT, 'focus_rating', 7, '2026-06-28T18:00:00Z', 'sub-3')],
      { respondentId: STUDENT },
    );
    const rows = foldSessionsToRows(partial, FIELD_MAP);
    expect(rows[0].fields.focus).toBe(7);
    expect('goals' in rows[0].fields).toBe(false); // not answered -> absent, not null/0
    expect('reflection' in rows[0].fields).toBe(false);
  });

  it('honest-empty: no sessions -> no rows (the pre-first-submission state)', () => {
    expect(foldSessionsToRows(foldAnswerFacts([], { respondentId: STUDENT }), FIELD_MAP)).toEqual([]);
  });

  it('labelFrom ordinal, and a one-shot (no submissionId) session gets an ordinal id', () => {
    const oneShot = foldAnswerFacts([fact(FORM, STUDENT, 'focus_rating', 5, '2026-06-19T18:00:00Z')], { respondentId: STUDENT });
    const rows = foldSessionsToRows(oneShot, FIELD_MAP, { labelFrom: 'ordinal' });
    expect(rows[0].id).toBe('session-1');
    expect(rows[0].label).toBe('Session 1');
  });

  it('emergent reuse (L069): a DIFFERENT domain (a weekly mood check-in) folds through the SAME function', () => {
    const moodFacts: AnswerFactRow[] = [
      fact('mood-weekly', 'u1', 'mood', 4, '2026-06-01T09:00:00Z', 'w1'),
      fact('mood-weekly', 'u1', 'sleep_hours', 7, '2026-06-01T09:00:00Z', 'w1'),
      fact('mood-weekly', 'u1', 'mood', 8, '2026-06-08T09:00:00Z', 'w2'),
    ];
    const rows = foldSessionsToRows(foldAnswerFacts(moodFacts, { respondentId: 'u1' }), { mood: 'mood', sleep: 'sleep_hours' });
    expect(rows.map((r) => r.id)).toEqual(['w1', 'w2']);
    expect(rows[0].fields).toMatchObject({ mood: 4, sleep: 7 });
    expect(rows[1].fields.mood).toBe(8);
  });
});
