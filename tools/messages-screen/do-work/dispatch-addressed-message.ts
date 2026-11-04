// PORTED FROM: bitfield-packages/packages/chat/do-work/dispatch-addressed-message.ts @ e99ac5976
// Dispatch one message through the selected participant's DATA-defined route.
// The route owns the target and complete payload template. Chat supplies only
// the generic addressed-message context and never branches on who/what the
// participant is or which owner receives it.

import { sendRequestToBitfieldTarget } from '#workspace-records';
import { resolveBindingTemplate } from '../../ui/show/action-affordance/read-action-affordances';
import type { AddressedWayToReachAdapterDescriptor } from '../read-data/read-addressed-exchange-participants';

export interface AddressedMessageRequest {
  messageRef: string;
  participantRef: string;
  senderRef: string;
  body: string;
  sentAt: string;
  conversationRef: string | null;
  // Where this message sits in its conversation. A route that writes a reply
  // back needs it to place the reply after the message rather than beside it.
  sequence?: number;
}

export interface AddressedMessageDispatch {
  target: string;
  payloadTemplate: Record<string, unknown>;
}

type RequestSender = (request: unknown) => Promise<unknown>;

function record(value: unknown): Record<string, unknown> | null {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function nonEmptyText(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null;
}

function jsonRecord(value: unknown): Record<string, unknown> | null {
  const text = nonEmptyText(value);
  if (!text) return null;
  try {
    return record(JSON.parse(text));
  } catch {
    return null;
  }
}

/** Decode the open dispatch contract carried by any way-to-reach adapter. */
export function readAddressedMessageDispatch(
  adapter: AddressedWayToReachAdapterDescriptor | null | undefined,
): AddressedMessageDispatch | null {
  const dispatch = record(adapter?.payload.dispatch ?? adapter?.metadata.dispatch);
  const target = nonEmptyText(dispatch?.target);
  const payloadTemplate = record(dispatch?.payload_template ?? dispatch?.payloadTemplate)
    ?? jsonRecord(dispatch?.payload_template_json ?? dispatch?.payloadTemplateJson);
  return target && payloadTemplate ? { target, payloadTemplate } : null;
}

/** Some routes answer in the same breath rather than only accepting the
 * message. Reading that answer is what lets a reply appear as it arrives; a
 * route that only accepts returns nothing here and the conversation still
 * carries the reply whenever it comes. */
export function readAnswerFromRoute(reply: unknown): string | null {
  const outer = record(reply);
  if (!outer) return null;
  const payload = outer.payload;
  // Bytes arrive as a typed view or as a plain list of numbers depending on how
  // far the reply travelled. Testing the shape rather than the class also
  // survives a value built in another realm, where `instanceof` quietly says no
  // to bytes that are plainly bytes.
  const bytes = ArrayBuffer.isView(payload)
    ? new Uint8Array((payload as ArrayBufferView).buffer, (payload as ArrayBufferView).byteOffset, (payload as ArrayBufferView).byteLength)
    : Array.isArray(payload) && payload.every((item) => Number.isInteger(item))
      ? Uint8Array.from(payload as number[])
      : null;
  if (bytes) {
    try {
      return nonEmptyText(record(JSON.parse(new TextDecoder().decode(bytes)))?.content);
    } catch {
      return null;
    }
  }
  return nonEmptyText(record(payload)?.content) ?? nonEmptyText(outer.content);
}

/** Resolve the route's generic binding template and hand the resulting
 * envelope to its declared target. Missing route data fails closed. */
export async function dispatchAddressedMessage(
  adapter: AddressedWayToReachAdapterDescriptor | null | undefined,
  message: AddressedMessageRequest,
  send: RequestSender = sendRequestToBitfieldTarget as RequestSender,
): Promise<unknown> {
  const dispatch = readAddressedMessageDispatch(adapter);
  if (!dispatch) throw new Error('Selected participant has no message route.');

  const payload = resolveBindingTemplate(dispatch.payloadTemplate, {
    run: { id: message.messageRef },
    surface: { participant_ref: message.participantRef },
    message,
  } as never);

  return send({ target: dispatch.target, payload });
}
