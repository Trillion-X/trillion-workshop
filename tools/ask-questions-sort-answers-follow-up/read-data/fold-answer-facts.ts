// packages/ask-questions-sort-answers-follow-up/read-data/fold-answer-facts.ts
//
// Purpose: the READ counterpart to do-work/answer-fact-writes.ts. Given a set of
// `answer-fact` records (the shape the forms engine writes), fold them back into a
// respondent's session answers — the view a coach / RAG / results surface needs to
// read "this learner's last session goals / reflections / lesson" WITHOUT knowing
// the storage addresses (L098: the data owner does the assembly).
//
// Generic + framework-agnostic + zero I/O. NEVER enumerates question types or the
// caller's semantic categories (goal/focus/reflection/…) — it reads `questionId`,
// `value`, `answered_at` off each self-describing fact (L090). Latest-wins per
// question by `answered_at` so a re-submitted session supersedes the old one.

/** One `answer-fact` record as written by buildAnswerFactWrites (payload-wrapped). */
export interface AnswerFactRow {
  payload: {
    kind: string;
    formId: string;
    respondentId: string;
    questionId: string;
    value: unknown;
    answered_at?: string;
    submissionId?: string;
  };
}

/** A respondent's folded session — a finished view the consumer can read directly. */
export interface FoldedSession {
  formId: string;
  respondentId: string;
  /** The submission coordinate, when the facts carried one (repeated forms). Empty string for one-shot forms. */
  submissionId: string;
  /** questionId -> latest answered value. */
  answers: Record<string, unknown>;
  /** The most recent `answered_at` across the session's answers (null if none carried one). */
  answeredAt: string | null;
  /** Number of distinct questions answered. */
  count: number;
}

const ANSWER_FACT_KIND = 'answer-fact';

/** Later ISO timestamp wins; a present timestamp beats an absent one. */
function isNewer(candidate: string | undefined, current: string | undefined): boolean {
  if (candidate === undefined) return false;
  if (current === undefined) return true;
  return candidate > current;
}

/**
 * Fold `answer-fact` rows into one FoldedSession per (formId, respondentId, submissionId).
 * Facts carrying a `submissionId` (repeated forms) produce one session per submission —
 * full journal history; facts without one collapse to a single session per respondent (the
 * one-shot/update default). Optionally narrow by form / respondent / submissionId.
 * Latest-wins per question within a session.
 */
export function foldAnswerFacts(
  rows: readonly AnswerFactRow[],
  filter: { formId?: string; respondentId?: string; submissionId?: string } = {},
): FoldedSession[] {
  const sessions = new Map<
    string,
    {
      formId: string;
      respondentId: string;
      submissionId: string;
      answers: Record<string, unknown>;
      perQuestionTs: Record<string, string | undefined>;
      answeredAt: string | null;
      count: number;
    }
  >();

  for (const row of rows) {
    const f = row?.payload;
    if (!f || f.kind !== ANSWER_FACT_KIND) continue;
    if (filter.formId !== undefined && f.formId !== filter.formId) continue;
    if (filter.respondentId !== undefined && f.respondentId !== filter.respondentId) continue;
    if (typeof f.formId !== 'string' || typeof f.respondentId !== 'string' || typeof f.questionId !== 'string') continue;
    const submissionId = typeof f.submissionId === 'string' ? f.submissionId : '';
    if (filter.submissionId !== undefined && submissionId !== filter.submissionId) continue;

    const key = `${f.formId}::${f.respondentId}::${submissionId}`;
    let s = sessions.get(key);
    if (!s) {
      s = { formId: f.formId, respondentId: f.respondentId, submissionId, answers: {}, perQuestionTs: {}, answeredAt: null, count: 0 };
      sessions.set(key, s);
    }

    const seen = Object.prototype.hasOwnProperty.call(s.answers, f.questionId);
    // First fact for this question, or a strictly-newer one, wins.
    if (!seen || isNewer(f.answered_at, s.perQuestionTs[f.questionId])) {
      if (!seen) s.count += 1;
      s.answers[f.questionId] = f.value;
      s.perQuestionTs[f.questionId] = f.answered_at;
      if (isNewer(f.answered_at, s.answeredAt ?? undefined)) s.answeredAt = f.answered_at ?? s.answeredAt;
    }
  }

  return [...sessions.values()].map(({ formId, respondentId, submissionId, answers, answeredAt, count }) => ({
    formId,
    respondentId,
    submissionId,
    answers,
    answeredAt,
    count,
  }));
}
