import { blake3 } from '@noble/hashes/blake3.js';
import { sendRequestToBitfieldTarget, readTrustedRuntimeClockMs, readTrustedRuntimePartition } from '@bitfield/runtime-kit';
import type { BitfieldRuntimeContext } from '@bitfield/runtime-kit';
import {
  buildEngineReadCurrentRequestFromLabels,
  buildEngineWriteBatchRequestFromLabels,
  decodeEngineReadCurrentReply,
  type EngineReadCurrentReply,
} from '@bitfield/runtime-kit/protocol';

type Sender = (request: { target: string; payload: Uint8Array }) => Promise<unknown>;

export type AppendExecutionStepRequest = {
  step: Record<string, unknown> & { id: string; run_ref: string };
};

export type ExecutionStepRecord = Record<string, unknown> & {
  kind: 'ai-execution-step';
  id: string;
  run_ref: string;
  recorded_at: string;
};

export type AppendExecutionStepResponse = {
  accepted: true;
  step_ref: string;
  idempotent: boolean;
  payload_hash_code_hex: string;
};

const encoder = new TextEncoder();
const decoder = new TextDecoder();
const STEP_PATH = ['current-item', 'published-record', 'ai-execution-step'] as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function requiredText(value: unknown, field: string): string {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${field} is required`);
  return value.trim();
}

function stepRef(stepId: string): string {
  return `package::ai-execution-history::step::${encodeURIComponent(stepId)}`;
}

function readRequest(value: unknown): AppendExecutionStepRequest {
  if (!isRecord(value)) throw new Error('append execution step input must be an object');
  const step = value.step;
  if (!isRecord(step)) throw new Error('step must be an object');
  if (step.kind !== undefined && step.kind !== 'ai-execution-step') {
    throw new Error('step.kind must be ai-execution-step when present');
  }
  const id = requiredText(step.id, 'step.id');
  const runRef = requiredText(step.run_ref, 'step.run_ref');
  return {
    step: { ...step, id, run_ref: runRef } as AppendExecutionStepRequest['step'],
  };
}

function payloadBytesFromReply(reply: unknown): Uint8Array {
  if (ArrayBuffer.isView(reply) && (reply as { BYTES_PER_ELEMENT?: number }).BYTES_PER_ELEMENT === 1) {
    return Uint8Array.from(reply as Uint8Array);
  }
  const payload = isRecord(reply) ? reply.payload : null;
  return ArrayBuffer.isView(payload) && (payload as { BYTES_PER_ELEMENT?: number }).BYTES_PER_ELEMENT === 1
    ? Uint8Array.from(payload as Uint8Array)
    : new Uint8Array();
}

async function readCurrent(partition: string, address: string, sender: Sender): Promise<EngineReadCurrentReply> {
  return decodeEngineReadCurrentReply(payloadBytesFromReply(
    await sender(buildEngineReadCurrentRequestFromLabels(partition, address)),
  ));
}

function decodeExisting(current: EngineReadCurrentReply): ExecutionStepRecord | null {
  if (!current.found || !current.payload) return null;
  const value = JSON.parse(decoder.decode(current.payload));
  if (!isRecord(value) || value.kind !== 'ai-execution-step') {
    throw new Error('execution step address contains an incompatible record');
  }
  return value as ExecutionStepRecord;
}

function same(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function hashCodeHexFromBytes(bytes: Uint8Array): string {
  return `1f:${[...blake3(bytes)].map(value => value.toString(16).padStart(2, '0')).join('')}`;
}

/**
 * Append ONE immutable execution step to the run ledger and prove it durable by
 * owner readback. This is the generic "record before effect" primitive the
 * actuation gateway (ai-action-guard.govern-computer-action) dispatches to: the
 * gateway can only mint a forward token after this owner has written and
 * confirmed the row. Step vocabulary (step_kind, tool, intent, decision, ...)
 * stays caller DATA; this owner validates only identity, immutability, conflict,
 * and readback. Identical replay is idempotent; a conflicting replay is rejected.
 * The returned payload_hash_code_hex is the `1f:` blake3 multihash of the exact
 * stored bytes, so the caller can re-verify the same durable basis before acting.
 */
export async function appendExecutionStep(
  input: unknown,
  context?: BitfieldRuntimeContext & { packageData?: unknown },
  sender: Sender = sendRequestToBitfieldTarget as Sender,
  nowUnixMs: number = readTrustedRuntimeClockMs(context),
): Promise<AppendExecutionStepResponse> {
  const request = readRequest(input);
  // The partition comes from the trusted runtime, never from the caller. These rows
  // are the audit trail for guarded computer actions, so a caller that named the
  // partition chose which app's store its own audit landed in, and could send it
  // somewhere nobody reads. The binary write frame still needs a value, which is why
  // this reads one rather than omitting it.
  const partitionLabel = readTrustedRuntimePartition(context);
  const address = stepRef(request.step.id);
  const before = decodeExisting(await readCurrent(partitionLabel, address, sender));
  const existingRecordedAt = typeof request.step.recorded_at === 'string' ? request.step.recorded_at : undefined;
  const record: ExecutionStepRecord = {
    ...request.step,
    kind: 'ai-execution-step',
    recorded_at: existingRecordedAt ?? before?.recorded_at ?? new Date(nowUnixMs).toISOString(),
  };
  const bytes = encoder.encode(JSON.stringify(record));
  const payload_hash_code_hex = hashCodeHexFromBytes(bytes);

  if (before) {
    if (!same(before, record)) {
      console.error(`[ai-execution-history.step] step=${address} run=${request.step.run_ref} result=conflict`);
      throw new Error(`execution step conflict: ${request.step.id}`);
    }
    console.info(`[ai-execution-history.step] step=${address} run=${request.step.run_ref} result=idempotent`);
    return { accepted: true, step_ref: address, idempotent: true, payload_hash_code_hex };
  }

  await sender(buildEngineWriteBatchRequestFromLabels([{
    partitionLabel,
    addressLabel: address,
    pathLabels: [...STEP_PATH],
    payloadBytes: bytes,
    expectedCurrent: { payloadHash: null },
  }]));
  const after = decodeExisting(await readCurrent(partitionLabel, address, sender));
  if (!after || !same(after, record)) {
    throw new Error('execution step write could not be confirmed by owner readback');
  }
  console.info(`[ai-execution-history.step] step=${address} run=${request.step.run_ref} result=accepted`);
  return { accepted: true, step_ref: address, idempotent: false, payload_hash_code_hex };
}
