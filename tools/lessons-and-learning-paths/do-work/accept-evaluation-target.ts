import { sendRequestToBitfieldTarget } from '@bitfield/runtime-kit';
import {
  buildEngineReadCurrentRequestFromLabels,
  buildEngineWriteBatchRequestFromLabels,
  decodeEngineReadCurrentReply,
  makeHashCodeHexFromBytes,
  type EngineReadCurrentReply,
} from '@bitfield/runtime-kit/protocol';
import { makeMultihashEncodedBytesFromCodeHex } from '@bitfield/slot-protocol';
import {
  buildEvaluationWritePlan,
  evaluationReceiptRef,
  progressStateRef,
  structurallyEqual,
  validateEvaluationReceipt,
  type AcceptEvaluationRequest,
} from './build-evaluation-writes.ts';
import type {
  ProgressEvaluationReceiptRecord,
  ProgressStateRecord,
} from '../read-data/learning-progress-types.ts';

type Sender = (request: { target: string; payload: Uint8Array }) => Promise<unknown>;

export type AcceptEvaluationResponse = {
  accepted: boolean;
  receipt_ref: string;
  state_ref: string;
  revision: number;
  decision_key: string;
  idempotent?: boolean;
};

const encoder = new TextEncoder();
const decoder = new TextDecoder();
const RECEIPT_PATH = ['current-item', 'learning-progress-evaluation-receipt'] as const;
const STATE_PATH = ['current-item', 'published-record'] as const;

export async function acceptEvaluationTarget(
  request: AcceptEvaluationRequest,
  _context?: { packageData?: unknown },
  sender: Sender = sendRequestToBitfieldTarget as Sender,
): Promise<AcceptEvaluationResponse> {
  const receipt = validateEvaluationReceipt(request.receipt);
  const partition = nonEmpty(request.partition_label, 'partition_label');
  const receiptRef = evaluationReceiptRef(receipt.evaluationId);
  const stateRef = progressStateRef(receipt.learnerId, receipt.trackId);
  const [receiptCurrent, stateCurrent] = await Promise.all([
    readCurrent(partition, receiptRef, sender),
    readCurrent(partition, stateRef, sender),
  ]);
  const existingReceipt = decodeRecord<ProgressEvaluationReceiptRecord>(receiptCurrent);
  const existingState = decodeRecord<ProgressStateRecord>(stateCurrent);

  if (existingReceipt) {
    if (!structurallyEqual(existingReceipt, receipt)) {
      console.error(`[learning-progress] evaluation conflict id=${receipt.evaluationId}`);
      throw new Error(`evaluation receipt conflict: ${receipt.evaluationId}`);
    }
    if (!existingState || !existingState.evaluationReceiptRefs.includes(receiptRef)) {
      throw new Error('idempotent receipt exists without its derived progress state');
    }
    return {
      accepted: true,
      receipt_ref: receiptRef,
      state_ref: stateRef,
      revision: existingState.revision,
      decision_key: receipt.decisionKey,
      idempotent: true,
    };
  }

  const plan = buildEvaluationWritePlan(request, existingState);
  const receiptBytes = encoder.encode(JSON.stringify(plan.receipt));
  const stateBytes = encoder.encode(JSON.stringify(plan.state));
  await sender(buildEngineWriteBatchRequestFromLabels([
    {
      partitionLabel: partition,
      addressLabel: plan.receiptRef,
      pathLabels: [...RECEIPT_PATH],
      payloadBytes: receiptBytes,
      expectedCurrent: { payloadHash: null },
    },
    {
      partitionLabel: partition,
      addressLabel: plan.stateRef,
      pathLabels: [...STATE_PATH],
      payloadBytes: stateBytes,
      expectedCurrent: { payloadHash: currentPayloadHash(stateCurrent) },
    },
  ]));

  const [receiptAfter, stateAfter] = await Promise.all([
    readCurrent(partition, plan.receiptRef, sender),
    readCurrent(partition, plan.stateRef, sender),
  ]);
  if (!structurallyEqual(decodeRecord(receiptAfter), plan.receipt)
      || !structurallyEqual(decodeRecord(stateAfter), plan.state)) {
    throw new Error('evaluation write could not be confirmed by owner readback');
  }

  console.info(`[learning-progress] evaluation accepted id=${receipt.evaluationId} decision=${receipt.decisionKey}`);
  console.info(`[learning-progress] state derived track=${receipt.trackId} completed=${plan.state.completedStepIds.length} receipts=${plan.state.evaluationReceiptRefs.length}`);
  console.info(`[learning-progress] readback confirmed receipt=${plan.receiptRef} state=${plan.stateRef}`);
  return {
    accepted: true,
    receipt_ref: plan.receiptRef,
    state_ref: plan.stateRef,
    revision: plan.state.revision,
    decision_key: receipt.decisionKey,
  };
}

async function readCurrent(partitionLabel: string, addressLabel: string, sender: Sender): Promise<EngineReadCurrentReply> {
  const reply = await sender(buildEngineReadCurrentRequestFromLabels(partitionLabel, addressLabel));
  return decodeEngineReadCurrentReply(payloadBytesFromReply(reply));
}

function decodeRecord<T>(current: EngineReadCurrentReply): T | null {
  if (!current.found) return null;
  const parsed = JSON.parse(decoder.decode(current.payload));
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('owner record payload must be an object');
  return parsed as T;
}

function currentPayloadHash(current: EngineReadCurrentReply): Uint8Array | null {
  if (!current.found) return null;
  return makeMultihashEncodedBytesFromCodeHex(makeHashCodeHexFromBytes(Uint8Array.from(current.payload)));
}

function payloadBytesFromReply(reply: unknown): Uint8Array {
  if (reply instanceof Uint8Array) return reply;
  if (reply instanceof ArrayBuffer) return new Uint8Array(reply);
  if (ArrayBuffer.isView(reply)) return new Uint8Array(reply.buffer, reply.byteOffset, reply.byteLength);
  if (typeof reply === 'string') return encoder.encode(reply);
  if (reply && typeof reply === 'object' && 'payload' in reply) {
    return payloadBytesFromReply((reply as { payload: unknown }).payload);
  }
  throw new Error('engine.operation reply did not include decodable payload bytes');
}

function nonEmpty(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) throw new TypeError(`${label} must be non-empty`);
  return value.trim();
}
