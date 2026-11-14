import {
  readTrustedRuntimeClockMs,
  readTrustedRuntimePartition,
  sendRequestToBitfieldTarget,
  type BitfieldRuntimeContext,
} from '@bitfield/runtime-kit';
import { makeMultihashEncodedBytesFromCodeHex } from '@bitfield/slot-protocol';

const ADDRESS = 'package::permission-lease::authorization-time';
const KIND = 'permission-lease.authorization-time-observation';
type Sender = (request: { target: string; payload: Record<string, unknown> }) => Promise<unknown>;

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown> : null;
}

function replyValue(reply: unknown): Record<string, unknown> {
  const outer = record(reply);
  let value: unknown = outer && Object.prototype.hasOwnProperty.call(outer, 'payload') ? outer.payload : reply;
  // Direct engine read replies themselves contain the stored payload.
  if (outer && Object.prototype.hasOwnProperty.call(outer, 'found')) value = outer;
  if (value instanceof ArrayBuffer) value = new Uint8Array(value);
  if (ArrayBuffer.isView(value)) {
    const bytes = new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
    if (bytes.byteLength > 64 * 1024) throw new Error('Authorization time reply is too large.');
    value = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  }
  if (typeof value === 'string') {
    if (value.length > 64 * 1024) throw new Error('Authorization time reply is too large.');
    value = JSON.parse(value);
  }
  const result = record(value);
  if (!result) throw new Error('Authorization time could not be read.');
  return result;
}

function validTime(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

function expectedHash(hash: string): string {
  let binary = '';
  for (const byte of makeMultihashEncodedBytesFromCodeHex(hash)) binary += String.fromCharCode(byte);
  return btoa(binary);
}

/** Remember observed runtime time before using it to decide an expiring permission.
 * A rolled-back clock fails closed. Deadlines and caller timestamps never advance it.
 * The returned content hash identifies the exact retained observation; no separately
 * sampled log cursor is presented as proof of that record.
 */
export async function readAuthorizationTimeTarget(
  input: unknown,
  context?: BitfieldRuntimeContext,
  sender: Sender = sendRequestToBitfieldTarget as Sender,
): Promise<{ now_ms: number; observation_ref: string; observation_hash: string }> {
  const request = record(input);
  if (!request || Object.keys(request).some((key) => key !== 'request_ref')
    || typeof request.request_ref !== 'string' || !request.request_ref.trim()
    || request.request_ref.length > 512) throw new Error('Authorization time request is invalid.');
  const now = readTrustedRuntimeClockMs(context);
  if (!validTime(now)) throw new Error('Runtime time is invalid.');
  const partition = readTrustedRuntimePartition(context);
  const invoke = async (payload: Record<string, unknown>) => replyValue(await sender({
    target: 'engine.operation.label-addressed',
    payload: { ...payload, partition_label: partition },
  }));
  const read = async () => {
    const reply = await invoke({ operation_label: 'engine.operation.read-current', address_label: ADDRESS, address_mode: 'identity_text' });
    if (reply.found === false) return null;
    const value = record(reply.payload);
    if (reply.found !== true || typeof reply.content_hash !== 'string'
      || !reply.content_hash || !value || value.kind !== KIND || !validTime(value.now_ms)) {
      throw new Error('Stored authorization time is invalid.');
    }
    expectedHash(reply.content_hash);
    return { now_ms: value.now_ms, hash: reply.content_hash };
  };
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const prior = await read();
    if (prior && prior.now_ms > now) throw new Error('Runtime clock moved backwards.');
    if (prior?.now_ms === now) return { now_ms: now, observation_ref: ADDRESS, observation_hash: prior.hash };
    try {
      const result = await invoke({
        operation_label: 'engine.operation.write-batch',
        writes: [{
          address_label: ADDRESS, address_mode: 'identity_text',
          path_labels: ['current-item', 'published-record'],
          payload: { kind: KIND, now_ms: now, request_ref: request.request_ref },
          expected_current: { payload_hash_base64: prior ? expectedHash(prior.hash) : null },
        }],
      });
      if (result.write_count !== 1) throw new Error('Authorization time was not recorded.');
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (attempt < 2 && /FE_EXPECTED_CURRENT_MISMATCH|ExpectedCurrentMismatch/.test(message)) continue;
      throw error;
    }
    const current = await read();
    if (!current || current.now_ms !== now) throw new Error('Authorization time changed during the request.');
    return { now_ms: now, observation_ref: ADDRESS, observation_hash: current.hash };
  }
  throw new Error('Authorization time could not be recorded.');
}
