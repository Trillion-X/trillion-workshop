import { blake3 } from '@noble/hashes/blake3.js';
import { readTrustedRuntimeClockMs, sendRequestToBitfieldTarget } from '@bitfield/runtime-kit';
import type { BitfieldRuntimeContext } from '@bitfield/runtime-kit';

export const GUARD_POLICY_REQUEST_SCHEMA = 'ai-action-guard-policy-evaluation-request/v2';
export const GUARD_POLICY_RECEIPT_SCHEMA = 'ai-action-guard-policy-evaluation-receipt/v2';

const ENGINE_OPERATION_TARGET = 'engine.operation.label-addressed';
const ENGINE_READ_CURRENT = 'engine.operation.read-current';
const LIMIT_PREFIX = 'package::ai-action-guard::limit::';
const STATE_PREFIX = 'package::ai-action-guard::state::';
const TEXT_DECODER = new TextDecoder();
const TEXT_ENCODER = new TextEncoder();

type GuardLimitRecord = {
  action_ref: string;
  id: string;
  limit: number;
  subject_ref: string;
};

type GuardStateRecord = {
  action_ref: string;
  allowed: boolean;
  failure_count: number;
  id: string;
  subject_ref: string;
};

export type GuardPolicyEvaluationRequest = {
  action_ref: string;
  guard_limit_ref: string;
  guard_state_ref: string;
  request_ref: string;
  schema: typeof GUARD_POLICY_REQUEST_SCHEMA;
  subject_ref: string;
};

export type GuardPolicyEvaluationReceipt = {
  action_ref: string;
  allowed: boolean;
  basis_ref: string;
  evaluated_at: string;
  evidence_refs: string[];
  guard_limit_ref: string;
  guard_state_ref: string;
  kind: 'ai-action-guard-policy-evaluation-receipt';
  limit: number;
  observed_count: number;
  reason_code: string;
  request_ref: string;
  schema: typeof GUARD_POLICY_RECEIPT_SCHEMA;
  subject_ref: string;
};

export type GuardPolicyReadback = {
  address_ref: string;
  payload: unknown;
  payload_hash_code_hex: string;
};

export type GuardPolicyReader = (addressRef: string) => Promise<GuardPolicyReadback>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function requiredText(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.trim() === '') throw new TypeError(`${label} must be a non-empty string`);
  return value;
}

function requiredCount(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || Number(value) < 0) throw new TypeError(`${label} must be a non-negative safe integer`);
  return Number(value);
}

function requiredBoolean(value: unknown, label: string): boolean {
  if (typeof value !== 'boolean') throw new TypeError(`${label} must be a boolean`);
  return value;
}

function requiredOwnerRef(value: unknown, prefix: string, label: string): string {
  const ref = requiredText(value, label);
  if (!ref.startsWith(prefix) || ref.length === prefix.length) {
    throw new TypeError(`${label} must name an ${prefix} owner record`);
  }
  return ref;
}

function readRequest(value: unknown): GuardPolicyEvaluationRequest {
  if (!isRecord(value)) throw new TypeError('guard policy evaluation request must be an object');
  if (value.schema !== GUARD_POLICY_REQUEST_SCHEMA) throw new TypeError(`schema must equal ${GUARD_POLICY_REQUEST_SCHEMA}`);
  return {
    schema: GUARD_POLICY_REQUEST_SCHEMA,
    request_ref: requiredText(value.request_ref, 'request_ref'),
    action_ref: requiredText(value.action_ref, 'action_ref'),
    subject_ref: requiredText(value.subject_ref, 'subject_ref'),
    guard_limit_ref: requiredOwnerRef(value.guard_limit_ref, LIMIT_PREFIX, 'guard_limit_ref'),
    guard_state_ref: requiredOwnerRef(value.guard_state_ref, STATE_PREFIX, 'guard_state_ref'),
  };
}

function readLimit(value: unknown): GuardLimitRecord {
  if (!isRecord(value) || value.kind !== 'ai-guard-limit') throw new TypeError('guard limit owner record is invalid');
  return {
    id: requiredText(value.id, 'guard_limit.id'),
    action_ref: requiredText(value.action_ref, 'guard_limit.action_ref'),
    subject_ref: requiredText(value.subject_ref, 'guard_limit.subject_ref'),
    limit: requiredCount(value.limit, 'guard_limit.limit'),
  };
}

function readState(value: unknown): GuardStateRecord {
  if (!isRecord(value) || value.kind !== 'ai-guard-state') throw new TypeError('guard state owner record is invalid');
  return {
    id: requiredText(value.id, 'guard_state.id'),
    action_ref: requiredText(value.action_ref, 'guard_state.action_ref'),
    subject_ref: requiredText(value.subject_ref, 'guard_state.subject_ref'),
    allowed: requiredBoolean(value.allowed, 'guard_state.allowed'),
    failure_count: requiredCount(value.failure_count, 'guard_state.failure_count'),
  };
}

function decodeReply(reply: unknown): Record<string, unknown> {
  if (reply instanceof Uint8Array) return JSON.parse(TEXT_DECODER.decode(reply)) as Record<string, unknown>;
  if (isRecord(reply) && reply.payload instanceof Uint8Array) {
    return JSON.parse(TEXT_DECODER.decode(reply.payload)) as Record<string, unknown>;
  }
  if (!isRecord(reply)) throw new Error('guard policy owner read returned no object');
  return reply;
}

function decodeBase64(value: string): Uint8Array {
  const binary = globalThis.atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

function hashCodeHexFromBytes(bytes: Uint8Array): string {
  return `1f:${[...blake3(bytes)].map(value => value.toString(16).padStart(2, '0')).join('')}`;
}

function extractPayloadBytes(result: Record<string, unknown>): Uint8Array {
  if (typeof result.payload_base64 === 'string' && result.payload_base64.length > 0) {
    return decodeBase64(result.payload_base64);
  }
  if (typeof result.value_json === 'string' && result.value_json.length > 0) {
    return TEXT_ENCODER.encode(result.value_json);
  }
  if (isRecord(result.payload)) return TEXT_ENCODER.encode(JSON.stringify(result.payload));
  throw new Error('guard policy owner read returned no payload bytes');
}

export const readGuardPolicyOwnerRecord: GuardPolicyReader = async (addressRef) => {
  const result = decodeReply(await sendRequestToBitfieldTarget({
    target: ENGINE_OPERATION_TARGET,
    payload: {
      operation_label: ENGINE_READ_CURRENT,
      // No partition. The engine defaults to the partition the request arrived on,
      // which is the app this guard is protecting. Letting a caller name one let it
      // point the policy read at a store it controls.
      address_label: addressRef,
      address_mode: 'identity_text',
    },
  }));
  if (result.found !== true) throw new Error(`guard policy owner record not found: ${addressRef}`);
  const bytes = extractPayloadBytes(result);
  const decoded = JSON.parse(TEXT_DECODER.decode(bytes)) as unknown;
  return { address_ref: addressRef, payload: decoded, payload_hash_code_hex: hashCodeHexFromBytes(bytes) };
};

/**
 * Fail-closed guard evaluation over owner-read policy bytes. The caller may select
 * an action, subject, and exact owner-record refs, but cannot supply or alter policy
 * state, limits, counters, timestamps, the evidence basis, or which app's store the
 * policy is read from.
 */
export async function evaluateGuardPolicyWithReader(
  input: unknown,
  readOwnerRecord: GuardPolicyReader,
  nowUnixMs: number,
): Promise<GuardPolicyEvaluationReceipt> {
  const request = readRequest(input);
  const [limitReadback, stateReadback] = await Promise.all([
    readOwnerRecord(request.guard_limit_ref),
    readOwnerRecord(request.guard_state_ref),
  ]);
  if (limitReadback.address_ref !== request.guard_limit_ref) throw new Error('guard limit readback address mismatch');
  if (stateReadback.address_ref !== request.guard_state_ref) throw new Error('guard state readback address mismatch');
  if (!/^1f:[a-f0-9]{64}$/.test(limitReadback.payload_hash_code_hex)) throw new Error('guard limit readback lacks a 1f: blake3 basis');
  if (!/^1f:[a-f0-9]{64}$/.test(stateReadback.payload_hash_code_hex)) throw new Error('guard state readback lacks a 1f: blake3 basis');

  const limitRecord = readLimit(limitReadback.payload);
  const stateRecord = readState(stateReadback.payload);
  let allowed = false;
  let reasonCode = 'guard_scope_mismatch';
  if (limitRecord.action_ref !== request.action_ref || limitRecord.subject_ref !== request.subject_ref) {
    reasonCode = 'guard_limit_scope_mismatch';
  } else if (stateRecord.action_ref !== request.action_ref || stateRecord.subject_ref !== request.subject_ref) {
    reasonCode = 'guard_state_scope_mismatch';
  } else if (stateRecord.allowed !== true) {
    reasonCode = 'guard_state_denied';
  } else if (limitRecord.limit <= 0) {
    reasonCode = 'guard_limit_not_positive';
  } else if (stateRecord.failure_count >= limitRecord.limit) {
    reasonCode = 'guard_limit_exhausted';
  } else {
    allowed = true;
    reasonCode = 'allowed';
  }

  const evaluatedAt = new Date(nowUnixMs).toISOString();
  const evidenceRefs = [
    `${request.guard_limit_ref}#${limitReadback.payload_hash_code_hex}`,
    `${request.guard_state_ref}#${stateReadback.payload_hash_code_hex}`,
  ];
  return {
    schema: GUARD_POLICY_RECEIPT_SCHEMA,
    kind: 'ai-action-guard-policy-evaluation-receipt',
    request_ref: request.request_ref,
    action_ref: request.action_ref,
    subject_ref: request.subject_ref,
    basis_ref: `ai-action-guard-owner-snapshot:${limitReadback.payload_hash_code_hex}:${stateReadback.payload_hash_code_hex}`,
    evaluated_at: evaluatedAt,
    allowed,
    reason_code: reasonCode,
    guard_limit_ref: limitRecord.id,
    guard_state_ref: stateRecord.id,
    observed_count: stateRecord.failure_count,
    limit: limitRecord.limit,
    evidence_refs: evidenceRefs,
  };
}

export function evaluateGuardPolicy(
  input: unknown,
  context?: BitfieldRuntimeContext,
): Promise<GuardPolicyEvaluationReceipt> {
  // The instant this request reached the runtime, not the instant this code happens to run.
  // A receipt whose sibling field is a SHA-256 basis has to replay to the same bytes.
  return evaluateGuardPolicyWithReader(
    input,
    readGuardPolicyOwnerRecord,
    readTrustedRuntimeClockMs(context),
  );
}
