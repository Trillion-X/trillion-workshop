import { sendRequestToBitfieldTarget } from '@bitfield/runtime-kit';
import type { ReviewResponseRequestRecord } from '@/packages/spaced-repetition/read-data/spaced-repetition-types';

export const REQUEST_REVIEW_RESPONSE_ACTION = 'action:spaced-repetition.request-review-response';

export type RequestReviewResponseDraft = {
  requestId?: string;
  learnerId: string;
  promptId: string;
  scheduleId?: string;
  target: string;
  /** Open recall-grade token — resolved via `policy.gradeQuality` DATA, never a
   *  closed union (a new grade is a policy row, not a code edit). */
  response: string;
  now?: Date;
};

export type RequestReviewResponseInput = {
  request_id: string;
  request_record: ReviewResponseRequestRecord;
};

function generatedId(prefix: string): string {
  return `${prefix}:${crypto.randomUUID()}`;
}

function clean(value: string, label: string): string {
  const trimmed = value.trim();
  if (!trimmed) throw new Error(`${label} needs a value`);
  return trimmed;
}

export function buildRequestReviewResponseInput(draft: RequestReviewResponseDraft): RequestReviewResponseInput {
  const requestId = draft.requestId ?? generatedId('review-response-request');
  return {
    request_id: requestId,
    request_record: {
      kind: 'review-response-request',
      requestId,
      learnerId: clean(draft.learnerId, 'Learner'),
      promptId: clean(draft.promptId, 'Review prompt'),
      scheduleId: draft.scheduleId?.trim() || undefined,
      target: clean(draft.target, 'Target'),
      response: draft.response,
      createdAt: (draft.now ?? new Date()).toISOString(),
    },
  };
}

export function requestReviewResponse(input: RequestReviewResponseInput): Promise<unknown> {
  return sendRequestToBitfieldTarget({
    target: 'slot::workflow',
    payload: {
      operation: 'execute_definition',
      definition_id: REQUEST_REVIEW_RESPONSE_ACTION,
      include_steps: false,
      include_output: false,
      input,
    },
  });
}
