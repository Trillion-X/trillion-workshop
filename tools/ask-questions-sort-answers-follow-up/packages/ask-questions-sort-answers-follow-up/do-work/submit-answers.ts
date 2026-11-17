// packages/ask-questions-sort-answers-follow-up/do-work/submit-answers.ts
//
// The I/O wrapper: persists captured answers as EEAF facts via the engine
// write-batch target. All request shaping lives in the pure builders
// (answer-fact-writes.ts); this file only performs the side effect.

import { sendRequestToBitfieldTarget } from '@bitfield/runtime-kit';
import { buildSubmitAnswersRequest } from './answer-fact-writes';

/** Persist every answer for one respondent's submission of one form. */
export async function submitAnswers(
  formId: string,
  respondentId: string,
  answers: Readonly<Record<string, unknown>>,
  answeredAt: string = new Date().toISOString(),
  submissionId?: string,
): Promise<unknown> {
  return sendRequestToBitfieldTarget(
    buildSubmitAnswersRequest(formId, respondentId, answers, answeredAt, submissionId),
  );
}
