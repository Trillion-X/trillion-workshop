// PORTED FROM: bitfield-packages/packages/chat/do-work/submit-message-egress-from-chat.ts @ e99ac5976
import { sendRequestToBitfieldTarget } from '#workspace-records';
import type { ConversationSendCapability } from '../read-data/read-chat-sessions';

/**
 * Chat-side dispatch for outbound messages. The composer forwards a thread's
 * self-describing send capability to the egress front door WITHOUT interpreting
 * any of it: the front-door action id, channel, and destination all ride the
 * source-declared `sendCapability`, and the recipient handle rides the
 * decoder-resolved `sendRef`. Chat never names a channel, never parses a phone
 * number, never picks a transport — it is a blind courier (L090). Routing,
 * consent, exactly-once claiming, and transport all live behind the front door
 * in content-distribution (SSOT); adding a new sendable channel is one DATA
 * config there, zero edits here.
 */

export interface SubmitMessageEgressFromChatInput {
  /** Source-declared routing object: {frontDoorAction, channel, destinationId}. */
  capability: ConversationSendCapability;
  /** Decoder-resolved recipient buddy handle (e.g. iMessage phone/email). Opaque. */
  recipient: string;
  /** The message body the user typed. */
  body: string;
  /** The thread this send replies into (activeSessionId), for transcript reconciliation. */
  replyToThreadRef: string;
  now?: Date;
  intentId?: string;
}

export function buildSubmitMessageEgressInput(
  input: SubmitMessageEgressFromChatInput,
): Record<string, unknown> {
  const now = input.now ?? new Date();
  return {
    // Distinct per send: the front door claims exactly-once on the payload hash,
    // so a fresh intent id per user action is the correct unique key.
    intent_id: input.intentId ?? `egress:${crypto.randomUUID()}`,
    destination_id: input.capability.destinationId,
    channel: input.capability.channel,
    recipient: input.recipient,
    body: input.body,
    requested_at: now.toISOString(),
    reply_to_thread_ref: input.replyToThreadRef,
  };
}

export async function submitMessageEgressFromChat(
  input: SubmitMessageEgressFromChatInput,
): Promise<unknown> {
  return sendRequestToBitfieldTarget({
    target: 'slot::workflow',
    payload: {
      operation: 'execute_definition',
      // Blind forward: the source told us which front door to knock on.
      definition_id: input.capability.frontDoorAction,
      include_steps: false,
      include_output: false,
      input: buildSubmitMessageEgressInput(input),
    },
  });
}
