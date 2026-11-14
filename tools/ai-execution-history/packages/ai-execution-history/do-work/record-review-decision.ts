import { sendRequestToBitfieldTarget, readTrustedRuntimeClockMs, readTrustedRuntimePartition } from '@bitfield/runtime-kit';
import type { BitfieldRuntimeContext } from '@bitfield/runtime-kit';
import {
  buildEngineReadCurrentRequestFromLabels,
  buildEngineWriteBatchRequestFromLabels,
  decodeEngineReadCurrentReply,
  type EngineReadCurrentReply,
} from '@bitfield/runtime-kit/protocol';

type Sender = (request: { target: string; payload: Uint8Array }) => Promise<unknown>;

export type RecordReviewDecisionRequest = {
  review_id: string;
  execution_ref: string;
  candidate_ref: string;
  decision: string;
  review_note: string;
  reviewer_ref: string;
  reviewed_at?: string;
  supersedes_review_ref?: string;
  evidence_refs?: readonly string[];
};

export type ExecutionReviewDecisionRecord = {
  kind: 'ai-execution-review-decision';
  id: string;
  execution_ref: string;
  candidate_ref: string;
  decision: string;
  review_note: string;
  reviewer_ref: string;
  reviewed_at: string;
  supersedes_review_ref?: string;
  evidence_refs: string[];
};

export type RecordReviewDecisionResponse = {
  accepted: true;
  review_ref: string;
  idempotent: boolean;
};

const encoder = new TextEncoder();
const decoder = new TextDecoder();
const REVIEW_PATH = ['current-item', 'published-record', 'ai-execution-review-decision'] as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function requiredText(value: unknown, field: string): string {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${field} is required`);
  return value.trim();
}

function optionalText(value: unknown, field: string): string | undefined {
  if (value == null) return undefined;
  return requiredText(value, field);
}

function stringList(value: unknown, field: string): string[] {
  if (value == null) return [];
  if (!Array.isArray(value)) throw new Error(`${field} must be an array`);
  return value.map((item) => requiredText(item, field));
}

function readRequest(value: unknown): RecordReviewDecisionRequest {
  if (!isRecord(value)) throw new Error('review decision input must be an object');
  const reviewedAt = optionalText(value.reviewed_at, 'reviewed_at');
  const supersedesReviewRef = optionalText(value.supersedes_review_ref, 'supersedes_review_ref');
  if (reviewedAt && Number.isNaN(Date.parse(reviewedAt))) throw new Error('reviewed_at must be an ISO-8601 timestamp');
  return {
    review_id: requiredText(value.review_id, 'review_id'),
    execution_ref: requiredText(value.execution_ref, 'execution_ref'),
    candidate_ref: requiredText(value.candidate_ref, 'candidate_ref'),
    decision: requiredText(value.decision, 'decision'),
    review_note: requiredText(value.review_note, 'review_note'),
    reviewer_ref: requiredText(value.reviewer_ref, 'reviewer_ref'),
    ...(reviewedAt ? { reviewed_at: reviewedAt } : {}),
    ...(supersedesReviewRef ? { supersedes_review_ref: supersedesReviewRef } : {}),
    evidence_refs: stringList(value.evidence_refs, 'evidence_refs'),
  };
}

function reviewRef(reviewId: string): string {
  return `package::ai-execution-history::review::${encodeURIComponent(reviewId)}`;
}

function payloadBytesFromReply(reply: unknown): Uint8Array {
  if (ArrayBuffer.isView(reply) && (reply as { BYTES_PER_ELEMENT?: number }).BYTES_PER_ELEMENT === 1) return Uint8Array.from(reply as Uint8Array);
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

function decodeExisting(current: EngineReadCurrentReply): ExecutionReviewDecisionRecord | null {
  if (!current.found) return null;
  const value = JSON.parse(decoder.decode(current.payload));
  if (!isRecord(value) || value.kind !== 'ai-execution-review-decision') {
    throw new Error('review address contains an incompatible record');
  }
  return value as ExecutionReviewDecisionRecord;
}

function same(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

/**
 * Append one immutable, idempotent human review receipt to the execution
 * ledger. Decision vocabulary remains caller DATA; this owner only validates
 * identity, provenance, immutability, conflict, and readback.
 */
export async function recordReviewDecision(
  input: unknown,
  context?: BitfieldRuntimeContext & { packageData?: unknown },
  sender: Sender = sendRequestToBitfieldTarget as Sender,
  nowUnixMs: number = readTrustedRuntimeClockMs(context),
): Promise<RecordReviewDecisionResponse> {
  const request = readRequest(input);
  // The partition comes from the trusted runtime, never from the caller. These rows
  // are the audit trail for guarded computer actions, so a caller that named the
  // partition chose which app's store its own audit landed in, and could send it
  // somewhere nobody reads. The binary write frame still needs a value, which is why
  // this reads one rather than omitting it.
  const partitionLabel = readTrustedRuntimePartition(context);
  const address = reviewRef(request.review_id);
  const before = decodeExisting(await readCurrent(partitionLabel, address, sender));
  const record: ExecutionReviewDecisionRecord = {
    kind: 'ai-execution-review-decision',
    id: request.review_id,
    execution_ref: request.execution_ref,
    candidate_ref: request.candidate_ref,
    decision: request.decision,
    review_note: request.review_note,
    reviewer_ref: request.reviewer_ref,
    reviewed_at: request.reviewed_at ?? before?.reviewed_at ?? new Date(nowUnixMs).toISOString(),
    ...(request.supersedes_review_ref ? { supersedes_review_ref: request.supersedes_review_ref } : {}),
    evidence_refs: [...(request.evidence_refs ?? [])],
  };
  if (before) {
    if (!same(before, record)) {
      console.error(`[ai-execution-history.review] review=${address} execution=${request.execution_ref} result=conflict`);
      throw new Error(`review decision conflict: ${request.review_id}`);
    }
    console.info(`[ai-execution-history.review] review=${address} execution=${request.execution_ref} result=idempotent`);
    return { accepted: true, review_ref: address, idempotent: true };
  }
  await sender(buildEngineWriteBatchRequestFromLabels([{
    partitionLabel,
    addressLabel: address,
    pathLabels: [...REVIEW_PATH],
    payloadBytes: encoder.encode(JSON.stringify(record)),
    expectedCurrent: { payloadHash: null },
  }]));
  const after = decodeExisting(await readCurrent(partitionLabel, address, sender));
  if (!after || !same(after, record)) throw new Error('review decision write could not be confirmed by owner readback');
  console.info(`[ai-execution-history.review] review=${address} execution=${request.execution_ref} result=accepted`);
  return { accepted: true, review_ref: address, idempotent: false };
}
