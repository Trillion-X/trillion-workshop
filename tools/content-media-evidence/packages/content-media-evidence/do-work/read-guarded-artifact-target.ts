import {
  readTrustedRuntimePartition,
  sendRequestToBitfieldTarget,
  type BitfieldRuntimeContext,
} from '@bitfield/runtime-kit';
import {
  buildEngineReadCurrentRequestFromLabels,
  decodeEngineReadCurrentReply,
} from '@bitfield/runtime-kit/protocol';
import {
  decodeCanonicalArtifactRef,
  isRelationAddress,
  relationAddress,
} from '../../../../record-voice-and-meetings/read-data/content-media-evidence';
import { verifyContentMediaOwnerAdmission } from './verify-hosted-session-admission';

type Sender = (request: unknown) => Promise<unknown>;
type JsonRecord = Record<string, unknown>;

const SELECTED_PAYLOAD_READER = 'cas-store.read-addressed-bytes';
const READ_ACTION = 'content-media-evidence.read-guarded-artifact';

function isRecord(value: unknown): value is JsonRecord {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function requiredText(value: unknown, field: string): string {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${field} is required`);
  return value.trim();
}

function replyBytes(reply: unknown): Uint8Array {
  if (ArrayBuffer.isView(reply) && (reply as { BYTES_PER_ELEMENT?: number }).BYTES_PER_ELEMENT === 1) return Uint8Array.from(reply as Uint8Array);
  const payload = isRecord(reply) ? reply.payload : null;
  return ArrayBuffer.isView(payload) && (payload as { BYTES_PER_ELEMENT?: number }).BYTES_PER_ELEMENT === 1
    ? Uint8Array.from(payload as Uint8Array)
    : new Uint8Array();
}

function relationSubject(relation: JsonRecord): string {
  const context = isRecord(relation.context_ref) ? relation.context_ref : null;
  return requiredText(context?.subject_ref, 'relation context subject_ref');
}

function relationArtifact(relation: JsonRecord): unknown {
  const source = relation.source_ref;
  return isRecord(source) && source.artifact_ref !== undefined ? source.artifact_ref : source;
}

async function readRelation(partition: string, address: string, sender: Sender): Promise<JsonRecord> {
  const current = decodeEngineReadCurrentReply(replyBytes(
    await sender(buildEngineReadCurrentRequestFromLabels(partition, address)),
  ));
  if (!current.found) throw new Error('artifact relation is missing');
  let value: unknown;
  try { value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(current.payload)); } catch { throw new Error('artifact relation is invalid'); }
  if (!isRecord(value) || value.kind !== 'content-media.relation.record') throw new Error('artifact relation is invalid');
  return value;
}

function ownerResult(value: unknown): JsonRecord {
  let result = isRecord(value) && 'payload' in value ? value.payload : value;
  if (Object.prototype.toString.call(result) === '[object ArrayBuffer]' || ArrayBuffer.isView(result)) {
    const bytes = ArrayBuffer.isView(result)
      ? new Uint8Array(result.buffer, result.byteOffset, result.byteLength)
      : new Uint8Array(result as ArrayBuffer);
    // The selected owner delivers at most 16 MiB, encoded as Base64 JSON.
    if (bytes.byteLength > Math.ceil(16 * 1024 * 1024 / 3) * 4 + 64 * 1024) {
      throw new Error('selected payload reply exceeds the delivery bound');
    }
    result = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
  }
  if (!isRecord(result)) throw new Error('selected payload owner returned an invalid result');
  requiredText(result.bytes_base64, 'bytes_base64');
  if (!Number.isSafeInteger(result.byte_length) || (result.byte_length as number) < 0) throw new Error('byte_length is invalid');
  return result;
}

/** Executable owner adapter for relation-scoped delivery. The browser supplies
 * only the relation identity; server admission and storage resolution remain
 * behind owner boundaries. */
export async function readGuardedArtifactTarget(
  input: unknown,
  context?: BitfieldRuntimeContext,
  sender: Sender = sendRequestToBitfieldTarget as Sender,
): Promise<JsonRecord> {
  const partition = readTrustedRuntimePartition(context);
  const admission = await verifyContentMediaOwnerAdmission(input, READ_ACTION, sender);
  // The address is DERIVED from the server-verified admission and never taken from the caller.
  // This read `payload.relation_ref` and then proved it equal to the admission, which is the same
  // guarantee only for as long as every comparison stays present and correctly ordered, and those
  // comparisons had no test. The sibling `materialize-artifact-target.ts` already derived its
  // address, so two targets in one package disagreed about whether a caller may name where a read
  // lands. `payload.relation_ref` is now ignored rather than trusted.
  const address = admission.subjectRef;
  if (!isRelationAddress(address)) throw new Error('admission subject must be an owner-issued relation identity');
  if (admission.resourceRevision !== address) {
    throw new Error('artifact relation admission is not bound to the requested identity');
  }
  const relation = await readRelation(partition, address, sender);
  if (requiredText(relation.relation_id, 'relation_id') !== address) throw new Error('artifact relation identity is invalid');
  const subjectRef = relationSubject(relation);
  if (subjectRef !== admission.authorityScopeRef) {
    throw new Error('artifact relation belongs to a different hosted authority scope');
  }
  const idempotencyRef = requiredText(relation.idempotency_ref, 'relation idempotency_ref');
  // Recomposed through the SAME owner the writer composes with, so a grammar
  // change moves both sides at once. Spelled inline here until 2026-09-05, which
  // made this check silently disagree with `materialize-artifact-target.ts` the
  // moment either copy was edited, and it would have surfaced as a stored-row
  // integrity failure rather than as the code split it actually is.
  if (relationAddress(subjectRef, idempotencyRef) !== address) {
    throw new Error('artifact relation identity is invalid');
  }
  const artifact = decodeCanonicalArtifactRef(relationArtifact(relation));
  if (!artifact) throw new Error('artifact relation has no canonical artifact');
  const delivered = ownerResult(await sender({
    target: SELECTED_PAYLOAD_READER,
    payload: {
      partition_label: partition,
      max_bytes: 16 * 1024 * 1024,
      storage_ref: {
        payload_address: artifact.payload_address,
        payload_address_mode: artifact.payload_address_mode,
        integrity_hash: artifact.integrity_hash,
        byte_length: artifact.byte_length,
      },
    },
  }));
  if (delivered.integrity_hash !== artifact.integrity_hash || delivered.byte_length !== artifact.byte_length) {
    throw new Error('selected payload result does not match the artifact relation');
  }
  console.info(`[artifact.guard] relation=${address} decision=${admission.decisionRef} result=allowed reason=allowed`);
  return {
    bytes_base64: delivered.bytes_base64,
    byte_length: artifact.byte_length,
    integrity_hash: artifact.integrity_hash,
    media_type: artifact.media_type,
    display_name: artifact.display_name,
    decision_ref: admission.decisionRef,
  };
}
