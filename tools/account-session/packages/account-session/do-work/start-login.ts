import { sendRequestToBitfieldTarget } from '@bitfield/runtime-kit';

export interface StartLoginInput {
  accountId: string;
  eventId: string;
  occurredAt: string;
  contractId?: string;
  metadata?: Record<string, unknown>;
  requestId?: string;
}

export function buildStartLoginPayload(input: StartLoginInput) {
  return {
    account_id: input.accountId,
    event_id: input.eventId,
    event_type: 'signup_started',
    occurred_at: input.occurredAt,
    contract_id: input.contractId ?? null,
    metadata: input.metadata ?? {},
  };
}

const SIGNED_EVENT_AUTHOR_TARGET = 'signed-event-author.sign-event';
const SIGNED_EVENT_ADMISSION_TARGET = 'signed-event-authority.admit-event';

function decodeTargetReply<TResponse>(payload: Uint8Array): TResponse {
  const text = new TextDecoder().decode(payload);
  return (text.trim() ? JSON.parse(text) : {}) as TResponse;
}

async function signStartLoginEvent(input: StartLoginInput) {
  const payload = buildStartLoginPayload(input);
  const reply = await sendRequestToBitfieldTarget({
    target: SIGNED_EVENT_AUTHOR_TARGET,
    payload: {
      payload: {
        event_id: input.eventId,
        occurred_at: input.occurredAt,
        idempotency_key: input.requestId ?? input.eventId,
        supersedes: [],
        facts: [{
          fact_id: `${input.eventId}:account-lifecycle`,
          subject: input.accountId,
          relation: 'account.lifecycle',
          object: input.contractId ?? 'signup_started',
          attributes: payload,
        }],
      },
    },
  });
  return decodeTargetReply<Record<string, unknown>>(reply.payload);
}

async function admitStartLoginEvent<TResponse>(
  signedEvent: Record<string, unknown>,
  requestId?: string,
): Promise<TResponse> {
  const reply = await sendRequestToBitfieldTarget({
    target: SIGNED_EVENT_ADMISSION_TARGET,
    payload: requestId
      ? { body: { events: [signedEvent] }, request_id: requestId }
      : { body: { events: [signedEvent] } },
  });
  return decodeTargetReply<TResponse>(reply.payload);
}

export async function startLogin<TResponse>(
  input: StartLoginInput,
): Promise<TResponse> {
  return admitStartLoginEvent<TResponse>(
    await signStartLoginEvent(input),
    input.requestId,
  );
}
