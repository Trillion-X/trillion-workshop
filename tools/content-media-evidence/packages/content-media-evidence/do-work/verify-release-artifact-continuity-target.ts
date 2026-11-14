import {
  readTrustedRuntimePartition,
  sendRequestToBitfieldTarget,
  type BitfieldRuntimeContext,
} from '@bitfield/runtime-kit';
import {
  buildEngineReadCurrentRequestFromLabels,
  buildEngineWriteBatchRequestFromLabels,
  decodeEngineReadCurrentReply,
} from '@bitfield/runtime-kit/protocol';

type JsonRecord = Record<string, unknown>;
type Sender = (request: unknown) => Promise<unknown>;

const REQUEST_SCHEMA = 'content-media-evidence.release-artifact-continuity-request';
const RECEIPT_SCHEMA = 'content-media-evidence.release-artifact-continuity-receipt';
const NATIVE_READ_SCHEMA = 'bitfield.sealed_app_package_set_read';
const NATIVE_READ_TARGET = 'package-loader.read-sealed-app-package-set';
const RECEIPT_PREFIX = 'package::content-media-evidence::release-artifact-continuity::';
const encoder = new TextEncoder();
const decoder = new TextDecoder();

type ArtifactIdentity = {
  path: string;
  filename: string;
  byte_count: number;
  sha256: string;
};

type ReleaseContinuityRequest = {
  schema: string;
  release_id: string;
  artifact: ArtifactIdentity;
  package_set_ref: string;
  requested_target_refs: string[];
  requested_entry_refs: string[];
};

type TargetReadback = {
  target_ref?: string;
  package_ref: string;
  entry_ref: string;
  stored_bytes_ref: string;
  stored_bytes_byte_count: number;
  stored_bytes_sha256: string;
  package_contract_sha256: string;
};

export type ReleaseArtifactContinuityResult = {
  accepted: true;
  idempotent: boolean;
  receipt_ref: string;
  payload_sha256: string;
};

function record(value: unknown): JsonRecord | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as JsonRecord
    : null;
}

function text(value: unknown, label: string): string {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${label} is required`);
  return value.trim();
}

function exactFields(value: JsonRecord, fields: readonly string[], label: string): void {
  const allowed = new Set(fields);
  const unknown = Object.keys(value).find((field) => !allowed.has(field));
  if (unknown) throw new Error(`${label} contains unknown input field ${unknown}`);
}

function sha256(value: unknown, label: string): string {
  const digest = text(value, label);
  if (!/^[a-f0-9]{64}$/.test(digest)) throw new Error(`${label} must be lowercase SHA-256`);
  return digest;
}

function safePositiveInteger(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || Number(value) <= 0) throw new Error(`${label} must be a positive safe integer`);
  return Number(value);
}

function artifactIdentity(value: unknown): ArtifactIdentity {
  const artifact = record(value);
  if (!artifact) throw new Error('artifact is required');
  exactFields(artifact, ['path', 'filename', 'byte_count', 'sha256'], 'artifact');
  const path = text(artifact.path, 'artifact.path');
  const filename = text(artifact.filename, 'artifact.filename');
  if (!filename.endsWith('.dmg') || filename.includes('/') || filename.includes('\\')) {
    throw new Error('artifact.filename must be a DMG basename');
  }
  if (!path.endsWith(`/${filename}`)) throw new Error('artifact.path must end with artifact.filename');
  return {
    path,
    filename,
    byte_count: safePositiveInteger(artifact.byte_count, 'artifact.byte_count'),
    sha256: sha256(artifact.sha256, 'artifact.sha256'),
  };
}

function requestFrom(input: unknown): ReleaseContinuityRequest {
  const value = record(input);
  if (!value) throw new Error('release artifact continuity input must be an object');
  exactFields(
    value,
    ['schema', 'release_id', 'artifact', 'package_set_ref', 'requested_target_refs', 'requested_entry_refs'],
    'release artifact continuity input',
  );
  if (value.schema !== REQUEST_SCHEMA) throw new Error('release artifact continuity request schema mismatch');
  const requestedTargetRefs = Array.isArray(value.requested_target_refs)
    ? value.requested_target_refs.map((target, index) => text(target, `requested_target_refs[${index}]`))
    : [];
  const requestedEntryRefs = Array.isArray(value.requested_entry_refs)
    ? value.requested_entry_refs.map((entry, index) => text(entry, `requested_entry_refs[${index}]`))
    : [];
  if (!requestedTargetRefs.length && !requestedEntryRefs.length) {
    throw new Error('requested target or entry refs are required');
  }
  if (new Set(requestedTargetRefs).size !== requestedTargetRefs.length) {
    throw new Error('requested_target_refs must be unique');
  }
  if (new Set(requestedEntryRefs).size !== requestedEntryRefs.length) {
    throw new Error('requested_entry_refs must be unique');
  }
  return {
    schema: REQUEST_SCHEMA,
    release_id: text(value.release_id, 'release_id'),
    artifact: artifactIdentity(value.artifact),
    package_set_ref: text(value.package_set_ref, 'package_set_ref'),
    requested_target_refs: requestedTargetRefs,
    requested_entry_refs: requestedEntryRefs,
  };
}

function payloadBytes(reply: unknown): Uint8Array {
  if (ArrayBuffer.isView(reply) && (reply as { BYTES_PER_ELEMENT?: number }).BYTES_PER_ELEMENT === 1) {
    return Uint8Array.from(reply as Uint8Array);
  }
  const payload = record(reply)?.payload;
  return ArrayBuffer.isView(payload) && (payload as { BYTES_PER_ELEMENT?: number }).BYTES_PER_ELEMENT === 1
    ? Uint8Array.from(payload as Uint8Array)
    : new Uint8Array();
}

function targetResult(reply: unknown): JsonRecord {
  const bytes = payloadBytes(reply);
  if (bytes.byteLength) {
    const decoded = record(JSON.parse(decoder.decode(bytes)));
    if (!decoded) throw new Error('sealed package-set owner returned an invalid result');
    return decoded;
  }
  const result = record(record(reply)?.payload) ?? record(reply);
  if (!result) throw new Error('sealed package-set owner returned an invalid result');
  return result;
}

function same(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function materialReadback(value: unknown, expectedRef: string, indexLabel: string, includesTarget: boolean): TargetReadback {
  const target = record(value);
  const observedRef = includesTarget ? target?.target_ref : target?.entry_ref;
  if (!target || observedRef !== expectedRef) {
    throw new Error('sealed package-set material order or identity mismatch');
  }
  return {
    ...(includesTarget ? { target_ref: text(target.target_ref, `${indexLabel}.target_ref`) } : {}),
    package_ref: text(target.package_ref, `${indexLabel}.package_ref`),
    entry_ref: text(target.entry_ref, `${indexLabel}.entry_ref`),
    stored_bytes_ref: text(target.stored_bytes_ref, `${indexLabel}.stored_bytes_ref`),
    stored_bytes_byte_count: safePositiveInteger(
      target.stored_bytes_byte_count,
      `${indexLabel}.stored_bytes_byte_count`,
    ),
    stored_bytes_sha256: sha256(target.stored_bytes_sha256, `${indexLabel}.stored_bytes_sha256`),
    package_contract_sha256: sha256(
      target.package_contract_sha256,
      `${indexLabel}.package_contract_sha256`,
    ),
  };
}

function targetReadbacks(result: JsonRecord, request: ReleaseContinuityRequest): {
  targets: TargetReadback[];
  entries: TargetReadback[];
} {
  if (result.schema !== NATIVE_READ_SCHEMA) throw new Error('sealed package-set readback schema mismatch');
  if (!same(result.artifact, request.artifact)) throw new Error('sealed package-set artifact identity mismatch');
  if (result.package_set_ref !== request.package_set_ref) throw new Error('sealed package-set reference mismatch');
  if (!Array.isArray(result.targets) || result.targets.length !== request.requested_target_refs.length) {
    throw new Error('sealed package-set target readback is incomplete');
  }
  if (!Array.isArray(result.entries) || result.entries.length !== request.requested_entry_refs.length) {
    throw new Error('sealed package-set entry readback is incomplete');
  }
  return {
    targets: result.targets.map((value, index) => materialReadback(
      value,
      request.requested_target_refs[index],
      `targets[${index}]`,
      true,
    )),
    entries: result.entries.map((value, index) => materialReadback(
      value,
      request.requested_entry_refs[index],
      `entries[${index}]`,
      false,
    )),
  };
}

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = await globalThis.crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(digest)].map(value => value.toString(16).padStart(2, '0')).join('');
}

async function readReceipt(partition: string, address: string, sender: Sender): Promise<Uint8Array | null> {
  const current = decodeEngineReadCurrentReply(payloadBytes(
    await sender(buildEngineReadCurrentRequestFromLabels(partition, address)),
  ));
  return current.found && current.payload ? Uint8Array.from(current.payload) : null;
}

function receiptAddress(request: ReleaseContinuityRequest, payloadSha256: string): string {
  return `${RECEIPT_PREFIX}${encodeURIComponent(request.release_id)}::${request.artifact.sha256}::${payloadSha256}`;
}

export async function verifyReleaseArtifactContinuityTarget(
  input: unknown,
  context?: BitfieldRuntimeContext,
  sender: Sender = sendRequestToBitfieldTarget as Sender,
): Promise<ReleaseArtifactContinuityResult> {
  const partition = readTrustedRuntimePartition(context);
  const request = requestFrom(input);
  const nativeResult = targetResult(await sender({
    target: NATIVE_READ_TARGET,
    payload: {
      schema: NATIVE_READ_SCHEMA,
      artifact: request.artifact,
      package_set_ref: request.package_set_ref,
      requested_target_refs: request.requested_target_refs,
      requested_entry_refs: request.requested_entry_refs,
    },
  }));
  const materials = targetReadbacks(nativeResult, request);
  const receipt = {
    schema: RECEIPT_SCHEMA,
    kind: 'media',
    terminal_status: 'VERIFIED',
    release_id: request.release_id,
    artifact: request.artifact,
    package_set_ref: request.package_set_ref,
    requested_target_refs: request.requested_target_refs,
    requested_entry_refs: request.requested_entry_refs,
    targets: materials.targets,
    entries: materials.entries,
  };
  const bytes = encoder.encode(JSON.stringify(receipt));
  const payloadSha256 = await sha256Hex(bytes);
  const address = receiptAddress(request, payloadSha256);
  const before = await readReceipt(partition, address, sender);
  if (before) {
    if (!same(Array.from(before), Array.from(bytes))) throw new Error('media continuity receipt address contains different bytes');
    return { accepted: true, idempotent: true, receipt_ref: address, payload_sha256: payloadSha256 };
  }
  try {
    await sender(buildEngineWriteBatchRequestFromLabels([{
      partitionLabel: partition,
      addressLabel: address,
      pathLabels: ['current-item', 'published-record', 'release-artifact-continuity-receipt'],
      payloadBytes: bytes,
      expectedCurrent: { payloadHash: null },
    }]));
  } catch {
    // Exact readback below classifies a committed/lost reply from a real conflict.
  }
  const after = await readReceipt(partition, address, sender);
  if (!after || !same(Array.from(after), Array.from(bytes))) {
    throw new Error('media continuity receipt write could not be confirmed by owner readback');
  }
  return { accepted: true, idempotent: false, receipt_ref: address, payload_sha256: payloadSha256 };
}
