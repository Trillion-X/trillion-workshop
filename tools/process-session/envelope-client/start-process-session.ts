// packages/process-session/envelope-client/start-process-session.ts
//
// Public, generic "launch a process-session and get its live feed address" client.
// The caller supplies both the configured target and the request sender, so this
// module owns no transport, process, or runtime side effect. compute.process_session
// remains the sole execution owner.

import type { ProcessSessionLaunchDescriptor } from '../read-data/read-process-session-launch';

export interface RawProcessSessionReply {
  readonly result?: unknown;
  readonly session_id?: unknown;
  readonly snapshot?: unknown;
  readonly reason?: unknown;
}

export type ProcessSessionSender = (
  request: { target: string; payload: Record<string, unknown> },
) => Promise<unknown>;

export interface ProcessSessionStartResult {
  readonly sessionId: string;
  readonly eventFeedAddress: string | null;
  readonly eventStreamAddress: string | null;
  readonly terminalOutputAddress: string | null;
}

export interface ProcessSessionStartRequestOptions {
  readonly target: string;
  readonly idempotencyKey?: string;
}

export interface ProcessSessionStartRequest {
  readonly target: string;
  readonly payload: {
    readonly operation: 'start_session';
    readonly descriptor: ProcessSessionLaunchDescriptor;
    readonly idempotency_key?: string;
  };
}

function asString(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' ? (value as Record<string, unknown>) : {};
}

export function decodeProcessSessionReply(reply: unknown): RawProcessSessionReply {
  const payload = asRecord(reply).payload;
  if (!ArrayBuffer.isView(payload)) {
    throw new Error('process-session returned no byte payload');
  }
  try {
    const decoded = JSON.parse(new TextDecoder().decode(payload as ArrayBufferView)) as unknown;
    if (!decoded || typeof decoded !== 'object' || Array.isArray(decoded)) {
      throw new Error('reply is not an object');
    }
    return decoded as RawProcessSessionReply;
  } catch (error) {
    throw new Error(`process-session returned invalid JSON: ${(error as Error).message}`);
  }
}

function validateIdempotencyKey(key: string): void {
  const byteLength = new TextEncoder().encode(key).byteLength;
  if (key.trim().length === 0) throw new Error('process-session idempotency key must not be empty');
  if (byteLength > 512) throw new Error('process-session idempotency key must be at most 512 UTF-8 bytes');
  if (/\p{Cc}/u.test(key)) throw new Error('process-session idempotency key must not contain control characters');
}

export function buildProcessSessionStartRequest(
  descriptor: ProcessSessionLaunchDescriptor,
  options: ProcessSessionStartRequestOptions,
): ProcessSessionStartRequest {
  if (options.idempotencyKey !== undefined) validateIdempotencyKey(options.idempotencyKey);
  return {
    target: options.target,
    payload: {
      operation: 'start_session',
      descriptor,
      ...(options.idempotencyKey !== undefined
        ? { idempotency_key: options.idempotencyKey }
        : {}),
    },
  };
}

export async function startProcessSession(
  descriptor: ProcessSessionLaunchDescriptor,
  options: ProcessSessionStartRequestOptions & { sender: ProcessSessionSender },
): Promise<ProcessSessionStartResult> {
  const reply = await options.sender(buildProcessSessionStartRequest(descriptor, options));
  const result = decodeProcessSessionReply(reply);
  if (result.result !== 'session_started') {
    throw new Error(asString(result.reason) ?? 'Failed to start process session');
  }
  const snapshot = asRecord(result.snapshot);
  const sessionId = asString(result.session_id) ?? asString(snapshot.session_id);
  if (!sessionId) throw new Error('process-session returned no session_id');
  return {
    sessionId,
    eventFeedAddress: asString(snapshot.event_feed_address),
    eventStreamAddress: asString(snapshot.event_stream_address),
    terminalOutputAddress: asString(snapshot.terminal_output_address),
  };
}
