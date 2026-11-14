import { sendRequestToBitfieldTarget } from '@bitfield/runtime-kit';
import type {
  DecisionResponse,
  ResponseReason,
} from '../read-data/practice-decision-loop-types.ts';

export const SUBMIT_DECISION_RESPONSE_ACTION = 'action:practice-decision-loop.submit-response';

export type SubmitDecisionResponseDraft = {
  responseId?: string;
  reasonId?: string;
  promptId: string;
  userId: string;
  choiceId: string;
  reasonText: string;
  now?: Date;
};

export type SubmitDecisionResponseInput = {
  response_id: string;
  response_record: DecisionResponse;
  reason_id: string;
  reason_record: ResponseReason;
};

function generatedId(prefix: string): string {
  return `${prefix}:${crypto.randomUUID()}`;
}

export function buildSubmitDecisionResponseInput(
  draft: SubmitDecisionResponseDraft,
): SubmitDecisionResponseInput {
  const createdAt = (draft.now ?? new Date()).toISOString();
  const responseId = draft.responseId ?? generatedId('decision-response');
  const reasonId = draft.reasonId ?? generatedId('response-reason');
  return {
    response_id: responseId,
    response_record: {
      kind: 'decision-response',
      responseId,
      promptId: draft.promptId,
      userId: draft.userId,
      choiceId: draft.choiceId,
      createdAt,
    },
    reason_id: reasonId,
    reason_record: {
      kind: 'response-reason',
      reasonId,
      responseId,
      promptId: draft.promptId,
      userId: draft.userId,
      text: draft.reasonText,
      createdAt,
    },
  };
}

export function submitDecisionResponse(input: SubmitDecisionResponseInput): Promise<unknown> {
  return sendRequestToBitfieldTarget({
    target: 'slot::workflow',
    payload: {
      operation: 'execute_definition',
      definition_id: SUBMIT_DECISION_RESPONSE_ACTION,
      include_steps: false,
      include_output: false,
      input,
    },
  });
}
