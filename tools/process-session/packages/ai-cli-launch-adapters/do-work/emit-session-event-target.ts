import { readTrustedRuntimeClockMs, sendRequestToBitfieldTarget } from '@bitfield/runtime-kit';
import type { BitfieldRuntimeContext } from '@bitfield/runtime-kit';
// The PURE envelope module, never the emit-session-event.mjs observer beside it. That
// observer reads a clock, an environment, a sequence file and the network, which are its
// own observations to make and a derivation's to receive.
import {
  buildSessionEventWrite,
  DEFAULT_SESSION_EVENT_PATH_LABELS,
  EVENT_KINDS,
  sessionEventAddress,
} from './session-event-envelope.mjs';

export const SESSION_EVENT_REQUEST_SCHEMA = 'ai-cli-launch-adapters.session-event-request/v1';
export const SESSION_EVENT_RECEIPT_SCHEMA = 'ai-cli-launch-adapters.session-event-receipt/v1';

type Sender = (request: { target: string; payload: unknown }) => Promise<unknown>;

type SessionEventRequest = {
  schema: typeof SESSION_EVENT_REQUEST_SCHEMA;
  event_id: string;
  event_kind: string;
  partition_label: string;
  provider_ref?: string;
  session_id: string;
  contract_ref?: string;
};

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new TypeError('session event request must be an object');
  return value as Record<string, unknown>;
}

function text(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.trim() === '') throw new TypeError(`${label} must be a non-empty string`);
  return value.trim();
}

function readRequest(input: unknown): SessionEventRequest {
  const value = record(input);
  if (value.schema !== SESSION_EVENT_REQUEST_SCHEMA) throw new TypeError(`schema must equal ${SESSION_EVENT_REQUEST_SCHEMA}`);
  const eventKind = text(value.event_kind, 'event_kind');
  if (!EVENT_KINDS.includes(eventKind)) throw new TypeError(`event_kind is not admitted: ${eventKind}`);
  const contractRef = typeof value.contract_ref === 'string' ? value.contract_ref.trim() || undefined : undefined;
  if (eventKind === 'session-stop-requested' && !contractRef) {
    throw new TypeError('contract_ref is required for session-stop-requested');
  }
  return {
    schema: SESSION_EVENT_REQUEST_SCHEMA,
    event_id: text(value.event_id, 'event_id'),
    event_kind: eventKind,
    partition_label: text(value.partition_label, 'partition_label'),
    provider_ref: typeof value.provider_ref === 'string' ? value.provider_ref.trim() || undefined : undefined,
    session_id: text(value.session_id, 'session_id'),
    contract_ref: contractRef,
  };
}

async function sequenceFromEventId(eventId: string): Promise<number> {
  const digest = await globalThis.crypto.subtle.digest('SHA-256', new TextEncoder().encode(eventId));
  const bytes = new Uint8Array(digest);
  let sequence = 0;
  for (let index = 0; index < 6; index += 1) sequence = (sequence * 256) + bytes[index];
  return sequence;
}

export async function emitSessionEventTarget(
  input: unknown,
  context?: BitfieldRuntimeContext,
  sender: Sender = sendRequestToBitfieldTarget as Sender,
) {
  const request = readRequest(input);
  const seq = await sequenceFromEventId(request.event_id);
  const write = buildSessionEventWrite({
    event_kind: request.event_kind,
    session_id: request.session_id,
    seq,
    provider_ref: request.provider_ref ?? 'operator-ui',
    contract_ref: request.contract_ref,
    partition_label: request.partition_label,
    // The instant the runtime received this request. A derivation replays, so it may not
    // ask the machine what time it is.
    ts: new Date(readTrustedRuntimeClockMs(context)).toISOString(),
    path_labels: [...DEFAULT_SESSION_EVENT_PATH_LABELS],
  });
  await sender({ target: 'engine.operation.label-addressed', payload: write });
  return {
    kind: 'session-event-receipt',
    schema: SESSION_EVENT_RECEIPT_SCHEMA,
    address: sessionEventAddress(request.session_id, seq),
    event_id: request.event_id,
    event_kind: request.event_kind,
    partition_label: request.partition_label,
    session_id: request.session_id,
    contract_ref: request.contract_ref ?? null,
  };
}
