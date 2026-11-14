import { sendRequestToBitfieldTarget } from '@bitfield/runtime-kit';
import type { PracticeProtocolEventRequestRecord } from '../read-data/practice-protocol-types.ts';

export const REQUEST_PROTOCOL_EVENT_ACTION = 'action:practice-protocol.request-protocol-event';

export type RequestProtocolEventDraft = {
  requestId?: string;
  learnerId: string;
  protocolId: string;
  stepId?: string;
  target: string;
  event: unknown;
  now?: Date;
};

export type RequestProtocolEventInput = {
  request_id: string;
  request_record: PracticeProtocolEventRequestRecord;
};

function generatedId(prefix: string): string {
  return `${prefix}:${crypto.randomUUID()}`;
}

function clean(value: string, label: string): string {
  const trimmed = value.trim();
  if (!trimmed) throw new Error(`${label} needs a value`);
  return trimmed;
}

export function buildRequestProtocolEventInput(draft: RequestProtocolEventDraft): RequestProtocolEventInput {
  const requestId = draft.requestId ?? generatedId('practice-protocol-event-request');
  return {
    request_id: requestId,
    request_record: {
      kind: 'practice-protocol-event-request',
      requestId,
      learnerId: clean(draft.learnerId, 'Learner'),
      protocolId: clean(draft.protocolId, 'Practice plan'),
      stepId: draft.stepId?.trim() || undefined,
      target: clean(draft.target, 'Target'),
      event: draft.event,
      createdAt: (draft.now ?? new Date()).toISOString(),
    },
  };
}

export function requestProtocolEvent(input: RequestProtocolEventInput): Promise<unknown> {
  return sendRequestToBitfieldTarget({
    target: 'slot::workflow',
    payload: {
      operation: 'execute_definition',
      definition_id: REQUEST_PROTOCOL_EVENT_ACTION,
      include_steps: false,
      include_output: false,
      input,
    },
  });
}
