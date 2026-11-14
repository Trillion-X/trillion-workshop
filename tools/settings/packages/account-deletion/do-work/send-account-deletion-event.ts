// packages/account-deletion/do-work/send-account-deletion-event.ts
//
// Sign an account deletion lifecycle event and admit it through the
// signed event authority.

import { sendRequestToBitfieldTarget } from '@bitfield/runtime-kit';

const SIGNED_EVENT_AUTHOR_TARGET = 'signed-event-author.sign-event';
const SIGNED_EVENT_ADMISSION_TARGET = 'signed-event-authority.admit-event';

function decodeTargetReply<TResponse>(payload: Uint8Array): TResponse {
  const text = new TextDecoder().decode(payload);
  return (text.trim() ? JSON.parse(text) : {}) as TResponse;
}

export interface AccountDeletionEventInput {
  accountId: string;
  eventType: 'deletion_requested' | 'deletion_cancelled';
  eventId: string;
  occurredAt: string;
  reasonText?: string | null;
  requestId?: string;
}

export async function sendAccountDeletionEvent<TResponse>(
  input: AccountDeletionEventInput,
): Promise<TResponse> {
  const signedEvent = decodeTargetReply<Record<string, unknown>>((await sendRequestToBitfieldTarget({
    target: SIGNED_EVENT_AUTHOR_TARGET,
    payload: {
      payload: {
        event_id: input.eventId,
        occurred_at: input.occurredAt,
        idempotency_key: input.requestId ?? input.eventId,
        supersedes: [],
        facts: [{
          fact_id: `${input.eventId}:account-deletion`,
          subject: input.accountId,
          relation: 'account.deletion',
          object: input.eventType,
          attributes: {
            event_type: input.eventType,
            occurred_at: input.occurredAt,
            reason_text: input.reasonText?.trim() || null,
          },
        }],
      },
    },
  })).payload);
  const reply = await sendRequestToBitfieldTarget({
    target: SIGNED_EVENT_ADMISSION_TARGET,
    payload: input.requestId
      ? { body: { events: [signedEvent] }, request_id: input.requestId }
      : { body: { events: [signedEvent] } },
  });
  return decodeTargetReply<TResponse>(reply.payload);
}
