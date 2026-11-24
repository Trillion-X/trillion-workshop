// tools/ask-questions-sort-answers-follow-up/do-work/answer-fact-writes.ts
//
// Pure builders for persisting captured answers. Each response is an addressable fact keyed
// (formId, respondentId, questionId), NOT one opaque submission blob, so a decide step reads exactly the
// answers that changed. No I/O here: form-tools.mjs answers the
// records these builders return.
//
// Changed from the package: a fact is a kept row { id, type, value } (the package built engine
// write-batch entries addressed by `package::<name>::answer::...` labels), so the address labels became
// record ids and the write-batch envelope is gone.

import type { RecordWrite } from '../read-data/record-rows.ts';

export const ANSWER_FACT_KIND = 'answer-fact';

export interface AnswerFact {
  kind: typeof ANSWER_FACT_KIND;
  formId: string;
  respondentId: string;
  questionId: string;
  value: unknown;
  answered_at: string;
  submissionId?: string;
  /** What the answer is about (resolveAbout), e.g. { stroke: 'Forehand' }: the same question about another thing is another series. */
  about?: Readonly<Record<string, string>>;
}

/** The record id of one answer. Without submissionId: (formId, respondentId, questionId), stable, resubmit
 *  overwrites. With submissionId: each submission is a distinct record, so repeated forms keep full history. */
export function answerFactId(
  formId: string,
  respondentId: string,
  questionId: string,
  submissionId?: string,
): string {
  const base = `${ANSWER_FACT_KIND}:${formId}:${respondentId}`;
  return submissionId
    ? `${base}:submission:${submissionId}:${questionId}`
    : `${base}:${questionId}`;
}

/** One record per answered question. Pass submissionId for repeated forms, and abouts (by questionId) for answers about a thing. */
export function buildAnswerFactWrites(
  formId: string,
  respondentId: string,
  answers: Readonly<Record<string, unknown>>,
  answeredAt: string,
  submissionId?: string,
  abouts?: Readonly<Record<string, Readonly<Record<string, string>> | null>>,
): Array<RecordWrite & { value: AnswerFact }> {
  return Object.keys(answers).map((questionId) => ({
    id: answerFactId(formId, respondentId, questionId, submissionId),
    type: ANSWER_FACT_KIND,
    value: {
      kind: ANSWER_FACT_KIND,
      formId,
      respondentId,
      questionId,
      value: answers[questionId],
      answered_at: answeredAt,
      ...(submissionId ? { submissionId } : {}),
      ...(abouts?.[questionId] ? { about: abouts[questionId] } : {}),
    },
  }));
}
