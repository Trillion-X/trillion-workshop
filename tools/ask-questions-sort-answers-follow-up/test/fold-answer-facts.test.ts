// Carried from bitfield-packages packages/ask-questions-sort-answers-follow-up/read-data/fold-answer-facts.test.ts.
// foldAnswerFacts is the READ counterpart to buildAnswerFactWrites: it folds answer-fact records back into a
// respondent's session answers (round-trip), latest-wins per question, filterable by form/respondent. F3 proves
// a full 15-answer session folds back into every category. Changed from the package: the synthetic form fixture
// replaces the owner's template, written facts go through payloadRows (the door record shape), and the case that
// fed the facts to another package's measure (progression-evaluator, not in the Workshop) is not carried.
import { describe, expect, it } from '../../../test-helpers/vitest-shim.mjs';
import practiceSession from './fixtures/practice-session.json' with { type: 'json' };
import { foldAnswerFacts, type AnswerFactRow } from '../read-data/fold-answer-facts.ts';
import { buildAnswerFactWrites } from '../do-work/answer-fact-writes.ts';
import { payloadRows } from '../read-data/record-rows.ts';

describe('foldAnswerFacts (F2 — the read side)', () => {
  it('round-trips buildAnswerFactWrites: written answers fold back to the same answers', () => {
    const answers = { 'pre-goals': 'a cleaner first bar', 'pre-focus-skills': 'skill-a', 'focus-rating': 8 };
    const writes = buildAnswerFactWrites('f1', 'ob_a', answers, '2026-07-01T00:00:00Z');
    const [session] = foldAnswerFacts(payloadRows(writes) as AnswerFactRow[], { formId: 'f1', respondentId: 'ob_a' });
    expect(session.answers).toEqual(answers);
    expect(session.count).toBe(3);
    expect(session.answeredAt).toBe('2026-07-01T00:00:00Z');
  });

  it('latest-wins per question when a session is re-answered', () => {
    const rows: AnswerFactRow[] = [
      { payload: { kind: 'answer-fact', formId: 'f1', respondentId: 'ob_a', questionId: 'focus-rating', value: 3, answered_at: '2026-07-01T00:00:00Z' } },
      { payload: { kind: 'answer-fact', formId: 'f1', respondentId: 'ob_a', questionId: 'focus-rating', value: 9, answered_at: '2026-07-02T00:00:00Z' } },
    ];
    const [session] = foldAnswerFacts(rows, {});
    expect(session.answers['focus-rating']).toBe(9);
    expect(session.count).toBe(1);
    expect(session.answeredAt).toBe('2026-07-02T00:00:00Z');
  });

  it('splits by respondent and filters', () => {
    const rows: AnswerFactRow[] = [
      { payload: { kind: 'answer-fact', formId: 'f1', respondentId: 'a', questionId: 'q', value: 1 } },
      { payload: { kind: 'answer-fact', formId: 'f1', respondentId: 'b', questionId: 'q', value: 2 } },
    ];
    expect(foldAnswerFacts(rows, {}).length).toBe(2);
    const onlyB = foldAnswerFacts(rows, { respondentId: 'b' });
    expect(onlyB.length).toBe(1);
    expect(onlyB[0].answers.q).toBe(2);
  });

  it('ignores non-answer-fact rows and returns [] for empty input', () => {
    const rows: AnswerFactRow[] = [
      { payload: { kind: 'traffic-visit', formId: 'f1', respondentId: 'a', questionId: 'x', value: 1 } as any },
    ];
    expect(foldAnswerFacts(rows, {})).toEqual([]);
    expect(foldAnswerFacts([], {})).toEqual([]);
  });
});

describe('foldAnswerFacts — journal session history (submissionId, plan 2026-07-01-answer-fact-session-history)', () => {
  it('a repeated form keeps EACH submission as its own session (history preserved, not overwritten)', () => {
    // The same respondent journals the same form on two different days.
    const s1 = buildAnswerFactWrites('practice-session', 'resp-a', { 'focus-rating': 4, 'todays-lesson': 'tempo drifted' }, '2026-07-01T00:00:00Z', 'sess-mon');
    const s2 = buildAnswerFactWrites('practice-session', 'resp-a', { 'focus-rating': 9, 'todays-lesson': 'relax the wrist' }, '2026-07-02T00:00:00Z', 'sess-tue');
    const sessions = foldAnswerFacts(payloadRows([...s1, ...s2]) as AnswerFactRow[], { respondentId: 'resp-a' });
    expect(sessions.length).toBe(2); // NOT collapsed to one — the whole point
    const mon = sessions.find((x) => x.submissionId === 'sess-mon');
    const tue = sessions.find((x) => x.submissionId === 'sess-tue');
    expect(mon?.answers['focus-rating']).toBe(4);
    expect(mon?.answers['todays-lesson']).toBe('tempo drifted');
    expect(tue?.answers['focus-rating']).toBe(9);
    expect(tue?.answers['todays-lesson']).toBe('relax the wrist');
  });

  it('the submission record id includes the submission coordinate (distinct records)', () => {
    const [w] = buildAnswerFactWrites('f', 'r', { q: 1 }, '2026-07-01T00:00:00Z', 'sub9');
    expect(w.id).toBe('answer-fact:f:r:submission:sub9:q');
    expect((w.value as any).submissionId).toBe('sub9');
    // omitting the submissionId keeps the stable one-shot address (backward-compatible)
    const [w0] = buildAnswerFactWrites('f', 'r', { q: 1 }, '2026-07-01T00:00:00Z');
    expect(w0.id).toBe('answer-fact:f:r:q');
    expect((w0.value as any).submissionId).toBeUndefined();
  });

  it('filters to one submission; one-shot facts (no submissionId) still fold to a single session', () => {
    const s1 = buildAnswerFactWrites('f', 'r', { q: 1 }, '2026-07-01T00:00:00Z', 'a');
    const s2 = buildAnswerFactWrites('f', 'r', { q: 2 }, '2026-07-02T00:00:00Z', 'b');
    const only = foldAnswerFacts(payloadRows([...s1, ...s2]) as AnswerFactRow[], { submissionId: 'b' });
    expect(only.length).toBe(1);
    expect(only[0].answers.q).toBe(2);
    // one-shot (no id): re-answer overwrites into a single session
    const one = foldAnswerFacts(payloadRows(buildAnswerFactWrites('f', 'r', { q: 5 }, '2026-07-01T00:00:00Z')) as AnswerFactRow[], {});
    expect(one.length).toBe(1);
    expect(one[0].submissionId).toBe('');
  });
});

describe('F3 — end-to-end: a full session folds into every category the form asked about', () => {
  const SEQ = practiceSession.sequence;

  // A realistic completed session: one answer per question in the form.
  const answerFor = (q: any): unknown => {
    if (q.questionTypeId === 'rating') return 8;
    if (q.questionTypeId === 'choice') return q.options[0].value;
    return `answer for ${q.questionId}`;
  };
  const answers: Record<string, unknown> = Object.fromEntries(SEQ.questions.map((q: any) => [q.questionId, answerFor(q)]));

  it('a full 15-answer session writes then folds back into every category', () => {
    const writes = buildAnswerFactWrites(SEQ.formId, 'resp-a', answers, '2026-07-01T10:00:00Z');
    const [session] = foldAnswerFacts(payloadRows(writes) as AnswerFactRow[], { formId: SEQ.formId, respondentId: 'resp-a' });
    expect(session.count).toBe(SEQ.questions.length); // all 15 questions
    // the form's semantic categories are all present as recovered facts
    const categories: Record<string, string> = {
      goal: 'pre-goals', focus: 'pre-focus-skills', action: 'pre-actions', metric: 'pre-success-metric',
      reflection: 'post-learnings', rating: 'focus-rating', lesson: 'todays-lesson',
    };
    for (const [cat, qid] of Object.entries(categories)) {
      expect(session.answers, `${cat} (${qid}) must be captured`).toHaveProperty(qid);
    }
  });
});
