// packages/ask-questions-sort-answers-follow-up/do-work/answer-fact-writes.ts
//
// Pure builders for persisting captured answers. Per plan §7.3, each response is
// an addressable EEAF fact keyed (formId, respondentId, questionId) — NOT one
// opaque submission blob — so DECIDE-stage workflows (scoring/segmentation) read
// exactly the answers that changed (P6). No I/O here: the writer in
// submit-answers.ts wraps these in the engine write-batch request.

const PKG = 'ask-questions-sort-answers-follow-up';
export const PUBLISHED_RECORD_PATH = ['current-item', 'published-record'] as const;
export const ANSWER_FACT_KIND = 'answer-fact';

export interface AnswerFact {
  kind: typeof ANSWER_FACT_KIND;
  formId: string;
  respondentId: string;
  questionId: string;
  value: unknown;
  answered_at: string;
  submissionId?: string;
}

export interface WriteEntry {
  address_label: string;
  address_mode: 'identity_text';
  path_labels: string[];
  payload: AnswerFact;
}

/** Addressable per-answer fact label. Without submissionId: (formId, respondentId,
 *  questionId) — stable, resubmit overwrites. With submissionId: each submission is
 *  a distinct record so repeated forms keep full history. */
export function answerFactAddress(
  formId: string,
  respondentId: string,
  questionId: string,
  submissionId?: string,
): string {
  const base = `package::${PKG}::answer::${formId}::${respondentId}`;
  return submissionId
    ? `${base}::submission::${submissionId}::${questionId}`
    : `${base}::${questionId}`;
}

/** One write entry per answered question. Pass submissionId for repeated forms. */
export function buildAnswerFactWrites(
  formId: string,
  respondentId: string,
  answers: Readonly<Record<string, unknown>>,
  answeredAt: string,
  submissionId?: string,
): WriteEntry[] {
  return Object.keys(answers).map((questionId) => ({
    address_label: answerFactAddress(formId, respondentId, questionId, submissionId),
    address_mode: 'identity_text',
    path_labels: [...PUBLISHED_RECORD_PATH],
    payload: {
      kind: ANSWER_FACT_KIND,
      formId,
      respondentId,
      questionId,
      value: answers[questionId],
      answered_at: answeredAt,
      ...(submissionId ? { submissionId } : {}),
    },
  }));
}

export const ENGINE_OPERATION_LABEL_TARGET = 'engine.operation.label-addressed';
export const ENGINE_WRITE_BATCH_OPERATION = 'engine.operation.write-batch';

/** The full engine write-batch request that persists every answer fact. */
export function buildSubmitAnswersRequest(
  formId: string,
  respondentId: string,
  answers: Readonly<Record<string, unknown>>,
  answeredAt: string,
  submissionId?: string,
) {
  return {
    target: ENGINE_OPERATION_LABEL_TARGET,
    payload: {
      operation_label: ENGINE_WRITE_BATCH_OPERATION,
      writes: buildAnswerFactWrites(formId, respondentId, answers, answeredAt, submissionId),
    },
  };
}
