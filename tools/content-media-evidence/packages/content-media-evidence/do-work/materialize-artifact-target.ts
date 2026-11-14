import {
  readTrustedRuntimeClockMs,
  readTrustedRuntimePartition,
  sendRequestToBitfieldTarget,
  type BitfieldRuntimeContext,
} from '@bitfield/runtime-kit';
import {
  buildEngineReadCurrentRequestFromLabels,
  buildEngineWriteBatchRequestFromLabels,
  decodeEngineReadCurrentReply,
  makeHashCodeHexFromBytes,
} from '@bitfield/runtime-kit/protocol';
import {
  decodeCanonicalArtifactRef,
  relationAddress,
  type CanonicalArtifactRef,
  type EvidenceRelationRecord,
} from '../../../../record-voice-and-meetings/read-data/content-media-evidence';
import { verifyContentMediaOwnerAdmission } from './verify-hosted-session-admission';

type Sender = (request: unknown) => Promise<unknown>;
type JsonRecord = Record<string, unknown>;

const MATERIALIZE_ACTION = 'content-media-evidence.materialize-artifact';
const MAX_BROWSER_BYTES = 16 * 1024 * 1024;

function record(value: unknown): JsonRecord | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as JsonRecord
    : null;
}

function text(value: unknown, label: string): string {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${label} is required`);
  return value.trim();
}

function replyBytes(reply: unknown): Uint8Array {
  if (ArrayBuffer.isView(reply) && (reply as { BYTES_PER_ELEMENT?: number }).BYTES_PER_ELEMENT === 1) {
    return Uint8Array.from(reply as Uint8Array);
  }
  const payload = record(reply)?.payload;
  return ArrayBuffer.isView(payload) && (payload as { BYTES_PER_ELEMENT?: number }).BYTES_PER_ELEMENT === 1
    ? Uint8Array.from(payload as Uint8Array)
    : new Uint8Array();
}

function resultRecord(reply: unknown): JsonRecord {
  const value = record(reply);
  const payload = value?.payload;
  if (payload instanceof Uint8Array || payload instanceof ArrayBuffer || ArrayBuffer.isView(payload)) {
    const decoded = record(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(replyBytes(reply))));
    if (!decoded) throw new Error('owner target returned an invalid result');
    return decoded;
  }
  const result = record(payload) ?? value;
  if (!result) throw new Error('owner target returned an invalid result');
  return result;
}

function jsonSafeBytes(value: unknown): Uint8Array {
  let values: unknown[] | null = null;
  if (Array.isArray(value)) {
    if (value.length > MAX_BROWSER_BYTES) throw new Error('selected bytes exceed the materialization bound');
    values = value;
  } else if (ArrayBuffer.isView(value) && (value as { BYTES_PER_ELEMENT?: number }).BYTES_PER_ELEMENT === 1) {
    if (value.byteLength > MAX_BROWSER_BYTES) throw new Error('selected bytes exceed the materialization bound');
    values = Array.from(value as Uint8Array);
  }
  if (!values) throw new Error('selected bytes exceed the materialization bound');
  const bytes = new Uint8Array(values.length);
  for (let index = 0; index < values.length; index += 1) {
    const item = values[index];
    if (!Number.isSafeInteger(item) || item < 0 || item > 255) throw new Error('selected bytes are invalid');
    bytes[index] = item;
  }
  return bytes;
}

function sourceFrom(payload: JsonRecord): {
  bytes: Uint8Array;
  mediaType: string;
  displayName: string;
  provenance: JsonRecord;
  addressed?: { payloadAddress: string; integrityHash: string };
} {
  const source = record(payload.source);
  if (!source || 'payload_address' in source || 'storage_ref' in source || 'artifact_ref' in source) {
    throw new Error('selected source must contain bytes, not a storage identity');
  }
  const bytes = jsonSafeBytes(source.bytes);
  const declaredLength = source.byte_length;
  if (declaredLength !== bytes.byteLength) throw new Error('selected source byte length does not match its bytes');
  const provenance = record(source.provenance) ?? {};
  const addressed = source.source_mode === 'verified-addressed-bytes'
    ? {
      payloadAddress: text(source.artifact_address, 'source.artifact_address'),
      integrityHash: text(source.integrity_hash, 'source.integrity_hash'),
    }
    : undefined;
  if (source.source_mode !== undefined && !addressed) throw new Error('selected source mode is invalid');
  return {
    bytes,
    mediaType: text(source.media_type, 'source.media_type').toLowerCase(),
    displayName: text(source.display_name, 'source.display_name'),
    provenance,
    addressed,
  };
}

function relationInput(payload: JsonRecord): {
  targetRef: unknown;
  roleRef: unknown;
  identity: { target_ref: unknown; context_ref: unknown; role_ref: unknown };
} {
  const relation = record(payload.relation) ?? {};
  if (relation.context_ref !== undefined) throw new Error('relation.context_ref is owner-derived and cannot be supplied');
  if (relation.idempotency_ref !== undefined) throw new Error('relation.idempotency_ref is not an admitted input');
  const targetRef = relation.target_ref ?? null;
  const roleRef = relation.role_ref ?? null;
  return {
    targetRef,
    roleRef,
    identity: {
      target_ref: targetRef,
      context_ref: null,
      role_ref: roleRef,
    },
  };
}

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  const object = record(value);
  if (!object) return value === undefined ? null : value;
  return Object.fromEntries(Object.keys(object).sort().map((key) => [key, canonical(object[key])]));
}

function sameCanonical(left: unknown, right: unknown): boolean {
  return JSON.stringify(canonical(left)) === JSON.stringify(canonical(right));
}

function ownerIdempotencyRef(
  integrityHash: string,
  byteLength: number,
  sourceIdentity: { media_type: string; display_name: string; provenance: JsonRecord },
  relationIdentity: { target_ref: unknown; context_ref: unknown; role_ref: unknown },
): string {
  const identity = canonical({
    kind: 'content-media.relation-idempotency/v1',
    materializer_target: MATERIALIZE_ACTION,
    bytes: { integrity_hash: integrityHash, byte_length: byteLength },
    source: sourceIdentity,
    relation: relationIdentity,
  });
  return `relation:${makeHashCodeHexFromBytes(new TextEncoder().encode(JSON.stringify(identity)))}`;
}

function relationArtifact(relation: EvidenceRelationRecord): CanonicalArtifactRef | null {
  const source = record(relation.source_ref);
  return decodeCanonicalArtifactRef(source?.artifact_ref);
}

async function readRelation(partition: string, address: string, sender: Sender): Promise<EvidenceRelationRecord | null> {
  const current = decodeEngineReadCurrentReply(replyBytes(
    await sender(buildEngineReadCurrentRequestFromLabels(partition, address)),
  ));
  if (!current.found) return null;
  try {
    const value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(current.payload));
    return record(value)?.kind === 'content-media.relation.record'
      ? value as EvidenceRelationRecord
      : null;
  } catch {
    throw new Error('materialized relation is invalid');
  }
}

function callerReadyRelation(relationRef: string, artifact: CanonicalArtifactRef) {
  return {
    kind: 'content-media.materialized-relation/v1',
    relation_ref: relationRef,
    media_type: artifact.media_type,
    display_name: artifact.display_name,
    byte_length: artifact.byte_length,
    integrity_hash: artifact.integrity_hash,
  };
}

function matchingExistingArtifact(
  existing: EvidenceRelationRecord,
  authorityScopeRef: string,
  idempotencyRef: string,
  source: {
    bytes: Uint8Array;
    mediaType: string;
    displayName: string;
    provenance: JsonRecord;
  },
  sourceIntegrityHash: string,
  relation: { targetRef: unknown; roleRef: unknown },
): CanonicalArtifactRef {
  const artifact = relationArtifact(existing);
  const provenance = artifact && record(artifact.provenance);
  if (!artifact || record(existing.context_ref)?.subject_ref !== authorityScopeRef
    || existing.idempotency_ref !== idempotencyRef
    || artifact.integrity_hash !== sourceIntegrityHash
    || artifact.byte_length !== source.bytes.byteLength
    || artifact.media_type !== source.mediaType
    || artifact.display_name !== source.displayName
    || !provenance
    || !sameCanonical(provenance, source.provenance)
    || !sameCanonical(existing.target_ref, relation.targetRef)
    || !sameCanonical(existing.role_ref, relation.roleRef)) {
    throw new Error('idempotency_ref already materialized a different relation');
  }
  return artifact;
}

/**
 * The admitted content-media owner is the only browser-facing materializer.
 * It derives its namespace from trusted target runtime context, delegates bytes
 * to CAS through an owner Envelope, persists one normalized relation, and
 * reads that relation back before returning its opaque identity.
 */
export async function materializeArtifactTarget(
  input: unknown,
  context?: BitfieldRuntimeContext,
  sender: Sender = sendRequestToBitfieldTarget as Sender,
) {
  const partition = readTrustedRuntimePartition(context);
  const admission = await verifyContentMediaOwnerAdmission(input, MATERIALIZE_ACTION, sender);
  const source = sourceFrom(admission.payload);
  const relation = relationInput(admission.payload);
  const declaredIdempotency = text(admission.payload.idempotency_ref, 'idempotency_ref');
  if (!/^[A-Za-z0-9._:-]{1,256}$/.test(declaredIdempotency)) throw new Error('idempotency_ref is invalid');
  const sourceIntegrityHash = makeHashCodeHexFromBytes(source.bytes);
  const ownerIdempotency = ownerIdempotencyRef(sourceIntegrityHash, source.bytes.byteLength, {
    media_type: source.mediaType,
    display_name: source.displayName,
    provenance: source.provenance,
  }, relation.identity);
  const admissionIdentity = source.addressed?.integrityHash ?? ownerIdempotency;
  if (source.addressed && (source.addressed.integrityHash !== sourceIntegrityHash
    || source.addressed.payloadAddress !== sourceIntegrityHash)) {
    throw new Error('addressed source identity does not match its selected bytes');
  }
  if (declaredIdempotency !== admissionIdentity
    || admission.subjectRef !== admissionIdentity
    || admission.resourceRevision !== admissionIdentity) {
    throw new Error('materialization admission is not bound to the owner-computed request identity');
  }
  const idempotencyRef = ownerIdempotency;
  const address = relationAddress(admission.authorityScopeRef, idempotencyRef);
  const existing = await readRelation(partition, address, sender);
  if (existing) {
    return callerReadyRelation(address, matchingExistingArtifact(
      existing,
      admission.authorityScopeRef,
      idempotencyRef,
      source,
      sourceIntegrityHash,
      relation,
    ));
  }
  const materialized = source.addressed
    ? {
      payload_address: source.addressed.payloadAddress,
      payload_address_mode: 'address_bytes',
      integrity_hash: source.addressed.integrityHash,
      byte_length: source.bytes.byteLength,
    }
    : resultRecord(await sender({
      target: 'cas-store.materialize-bytes',
      payload: {
        bytes: Array.from(source.bytes),
        metadata: { media_type: source.mediaType, display_name: source.displayName },
        namespace: {
          partitionLabel: partition,
          addressPrefix: `package::content-media-evidence::artifact::${encodeURIComponent(admission.authorityScopeRef)}`,
          pathLabels: ['content-media-evidence', 'artifact'],
        },
      },
    }));
  const artifact = decodeCanonicalArtifactRef({
    kind: 'canonical-artifact-ref/v1',
    ...materialized,
    media_type: source.mediaType,
    display_name: source.displayName,
    provenance: source.provenance,
  });
  if (!artifact) throw new Error('CAS materializer did not return a canonical artifact');
  if (artifact.integrity_hash !== sourceIntegrityHash || artifact.byte_length !== source.bytes.byteLength) {
    throw new Error('CAS materializer returned bytes outside the admitted request identity');
  }
  if (source.addressed) {
    const delivered = resultRecord(await sender({
      target: 'cas-store.read-addressed-bytes',
      payload: {
        partition_label: partition,
        max_bytes: MAX_BROWSER_BYTES,
        storage_ref: {
          payload_address: artifact.payload_address,
          payload_address_mode: artifact.payload_address_mode,
          integrity_hash: artifact.integrity_hash,
          byte_length: artifact.byte_length,
        },
      },
    }));
    if (delivered.integrity_hash !== sourceIntegrityHash || delivered.byte_length !== source.bytes.byteLength) {
      throw new Error('addressed source readback does not match its selected bytes');
    }
  }
  const recordToWrite: EvidenceRelationRecord = {
    kind: 'content-media.relation.record',
    relation_id: address,
    source_ref: { artifact_ref: artifact },
    target_ref: relation.targetRef,
    role_ref: relation.roleRef,
    context_ref: {
      subject_ref: admission.authorityScopeRef,
      materialized_at: new Date(readTrustedRuntimeClockMs(context)).toISOString(),
    },
    idempotency_ref: idempotencyRef,
  };
  try {
    await sender(buildEngineWriteBatchRequestFromLabels([{
      partitionLabel: partition,
      addressLabel: address,
      pathLabels: ['current-item', 'published-record'],
      payloadBytes: new TextEncoder().encode(JSON.stringify(recordToWrite)),
      expectedCurrent: { payloadHash: null },
    }]));
  } catch {
    const raced = await readRelation(partition, address, sender);
    if (!raced) throw new Error('materialized relation create-only write failed');
    return callerReadyRelation(address, matchingExistingArtifact(
      raced,
      admission.authorityScopeRef,
      idempotencyRef,
      source,
      sourceIntegrityHash,
      relation,
    ));
  }
  const readback = await readRelation(partition, address, sender);
  const readbackArtifact = readback && relationArtifact(readback);
  if (!readbackArtifact || !sameCanonical(readbackArtifact, artifact)
    || record(readback.context_ref)?.subject_ref !== admission.authorityScopeRef
    || readback.idempotency_ref !== idempotencyRef || !sameCanonical(readback.target_ref, relation.targetRef)
    || !sameCanonical(readback.role_ref, relation.roleRef)) {
    throw new Error('materialized relation readback failed');
  }
  console.info(`[artifact.materialize] mode=${artifact.payload_address_mode} bytes=${artifact.byte_length} payload=opaque result=stored`);
  return callerReadyRelation(address, readbackArtifact);
}
