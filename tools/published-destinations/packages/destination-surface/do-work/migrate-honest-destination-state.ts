import { createHash } from 'node:crypto';
import {
  readTrustedRuntimePartition,
  sendRequestToBitfieldTarget,
  type BitfieldRuntimeContext,
} from '@bitfield/runtime-kit';
import {
  buildEngineReadCurrentRequestFromLabels,
  buildEngineWriteBatchRequestFromLabels,
  decodeEngineReadCurrentReply,
  type EngineReadCurrentReply,
} from '@bitfield/runtime-kit/protocol';

type JsonRecord = Record<string, unknown>;
type Sender = (request: unknown) => Promise<unknown>;

interface Replacement {
  address: string;
  pathLabels: string[];
  expectedPayload: JsonRecord | null;
  successor: JsonRecord;
}

interface Retraction {
  address: string;
  pathLabels: string[];
  expectedPayload: JsonRecord;
}

const encoder = new TextEncoder();
const decoder = new TextDecoder('utf-8', { fatal: true });
const MAX_REPLACEMENTS = 64;
const MAX_RETRACTIONS = 256;
const OWNED_ADDRESS_PREFIX = 'destination::';
const RECEIPT_ADDRESS_PREFIX = 'destination::migration-receipt::';

function isRecord(value: unknown): value is JsonRecord {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function text(value: unknown, field: string): string {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${field} is required`);
  return value.trim();
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (!isRecord(value)) return JSON.stringify(value) ?? 'null';
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`;
}

function replyBytes(reply: unknown): Uint8Array {
  if (ArrayBuffer.isView(reply) && (reply as { BYTES_PER_ELEMENT?: number }).BYTES_PER_ELEMENT === 1) {
    return Uint8Array.from(reply as Uint8Array);
  }
  const payload = isRecord(reply) ? reply.payload : null;
  if (ArrayBuffer.isView(payload) && (payload as { BYTES_PER_ELEMENT?: number }).BYTES_PER_ELEMENT === 1) {
    return Uint8Array.from(payload as Uint8Array);
  }
  return new Uint8Array();
}

function payloadFrom(input: unknown): JsonRecord {
  const value = isRecord(input) && isRecord(input.payload) ? input.payload : input;
  if (!isRecord(value)) throw new Error('migration payload is required');
  return value;
}

function pathLabels(value: unknown): string[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > 16) {
    throw new Error('path_labels must contain 1-16 labels');
  }
  return value.map((part, index) => text(part, `path_labels[${index}]`));
}

function ownedAddress(value: unknown): string {
  const address = text(value, 'address');
  if (!address.startsWith(OWNED_ADDRESS_PREFIX)) throw new Error('migration address is outside the destination owner namespace');
  if (address.startsWith(RECEIPT_ADDRESS_PREFIX)) throw new Error('migration receipt namespace is reserved');
  return address;
}

function containsKey(value: unknown, key: string): boolean {
  if (Array.isArray(value)) return value.some((item) => containsKey(item, key));
  if (!isRecord(value)) return false;
  return Object.entries(value).some(([entryKey, entryValue]) => entryKey === key || containsKey(entryValue, key));
}

/**
 * The migration accepts only honest empty or owner-derived destination state.
 * Labels and definitions may remain DATA. Any owner-derived collection or
 * scalar must start empty, independent of the open presentation key.
 */
export function assertHonestDestinationDescriptor(value: unknown): asserts value is JsonRecord {
  if (!isRecord(value) || value.kind !== 'destination-descriptor') throw new Error('successor must be a destination descriptor');
  text(value.ref, 'successor.ref');
  text(value.subject_ref, 'successor.subject_ref');
  text(value.statement, 'successor.statement');
  if (!Array.isArray(value.sections) || value.sections.length === 0 || value.sections.length > 64) {
    throw new Error('successor.sections must contain 1-64 sections');
  }
  if (containsKey(value, 'award')) throw new Error('successor may not contain a browser effect writer');
  if (containsKey(value, 'source') || containsKey(value, 'track') || containsKey(value, 'accepted_effect_source')) {
    throw new Error('successor may not contain browser evaluation inputs');
  }
  for (const rawSection of value.sections) {
    if (!isRecord(rawSection)) throw new Error('successor section is invalid');
    text(rawSection.presentation, 'section.presentation');
    const items = Array.isArray(rawSection.items) ? rawSection.items : [];
    const stats = Array.isArray(rawSection.stats) ? rawSection.stats : [];
    const bars = Array.isArray(rawSection.bars) ? rawSection.bars : [];
    if (bars.length > 0) throw new Error('successor bar rows must start empty and come from an owner projection');
    if ('percent' in rawSection || 'ring_label' in rawSection || 'ringLabel' in rawSection) {
      throw new Error('successor scalar values must start empty and come from an owner projection');
    }
    if (stats.length > 0) throw new Error('stat successor rows must start empty and come from an owner projection');
    for (const item of items) {
      if (!isRecord(item)) throw new Error('successor item is invalid');
      if ('actor' in item || 'rank' in item || 'percent' in item || 'fraction' in item || 'celebrate' in item) {
        throw new Error('owner-derived successor item values must start empty and come from an owner projection');
      }
    }
  }
}

function replacement(value: unknown): Replacement {
  if (!isRecord(value)) throw new Error('replacement is invalid');
  const successor = clone(value.successor);
  assertHonestDestinationDescriptor(successor);
  const expectedPayload = value.expected_payload === null ? null : clone(value.expected_payload);
  if (expectedPayload !== null && !isRecord(expectedPayload)) throw new Error('replacement.expected_payload must be an object or null');
  return {
    address: ownedAddress(value.address),
    pathLabels: pathLabels(value.path_labels),
    expectedPayload,
    successor,
  };
}

function retraction(value: unknown, bases: readonly string[]): Retraction {
  if (!isRecord(value) || !isRecord(value.expected_payload)) throw new Error('retraction expected_payload is required');
  const address = ownedAddress(value.address);
  if (!bases.some((base) => address === base || address.startsWith(`${base}::`))) {
    throw new Error('retraction address is outside the declared migration bases');
  }
  return { address, pathLabels: pathLabels(value.path_labels), expectedPayload: clone(value.expected_payload) };
}

function decodeStored(reply: EngineReadCurrentReply): JsonRecord | null {
  if (!reply.found || !reply.payload) return null;
  let parsed: unknown;
  try { parsed = JSON.parse(decoder.decode(reply.payload)); } catch { throw new Error('stored destination row is invalid JSON'); }
  if (!isRecord(parsed)) throw new Error('stored destination row is not an object');
  return parsed;
}

async function current(partition: string, address: string, sender: Sender): Promise<EngineReadCurrentReply> {
  return decodeEngineReadCurrentReply(replyBytes(await sender(buildEngineReadCurrentRequestFromLabels(partition, address))));
}

function basis(value: EngineReadCurrentReply): Uint8Array | null {
  if (!value.found) return null;
  if (!value.payloadHash) throw new Error('current destination row has no atomic revision basis');
  return value.payloadHash;
}

function same(left: unknown, right: unknown): boolean {
  return canonical(left) === canonical(right);
}

function migrationBasis(value: unknown): string {
  return `sha256:${createHash('sha256').update(canonical(value)).digest('hex')}`;
}

async function assertFinalState(
  partition: string,
  replacements: readonly Replacement[],
  retractions: readonly Retraction[],
  sender: Sender,
): Promise<void> {
  for (const row of replacements) {
    const after = decodeStored(await current(partition, row.address, sender));
    if (!same(after, row.successor)) throw new Error(`successor readback failed for ${row.address}`);
  }
  for (const row of retractions) {
    if (decodeStored(await current(partition, row.address, sender)) !== null) {
      throw new Error(`legacy row retraction readback failed for ${row.address}`);
    }
  }
}

/**
 * Owner-to-owner repair target. Successors are written and independently read
 * before any exact legacy row is retracted. Every mutation is guarded by the
 * current engine basis; retries converge on the same final state.
 */
export async function migrateHonestDestinationStateTarget(
  input: unknown,
  context?: BitfieldRuntimeContext,
  sender: Sender = sendRequestToBitfieldTarget as Sender,
) {
  const partition = readTrustedRuntimePartition(context);
  const payload = payloadFrom(input);
  const migrationRef = text(payload.migration_ref, 'migration_ref');
  const idempotencyRef = text(payload.idempotency_ref, 'idempotency_ref');
  const rawReplacements = Array.isArray(payload.replacements) ? payload.replacements : [];
  const rawRetractions = Array.isArray(payload.retractions) ? payload.retractions : [];
  const bases = Array.isArray(payload.retraction_bases)
    ? payload.retraction_bases.map((value, index) => ownedAddress(text(value, `retraction_bases[${index}]`)))
    : [];
  if (rawReplacements.length === 0 || rawReplacements.length > MAX_REPLACEMENTS) throw new Error('migration replacements are required and bounded');
  if (rawRetractions.length > MAX_RETRACTIONS) throw new Error('migration retractions exceed the bounded owner limit');
  const replacements = rawReplacements.map(replacement);
  const retractions = rawRetractions.map((value) => retraction(value, bases));
  const addresses = [...replacements.map((row) => row.address), ...retractions.map((row) => row.address)];
  if (new Set(addresses).size !== addresses.length) throw new Error('migration addresses must be unique');
  const receiptAddress = `${RECEIPT_ADDRESS_PREFIX}${encodeURIComponent(idempotencyRef)}`;
  const payloadBasis = migrationBasis({
    migration_ref: migrationRef,
    replacements,
    retraction_bases: bases,
    retractions,
  });
  const existingReceipt = decodeStored(await current(partition, receiptAddress, sender));
  if (existingReceipt !== null) {
    if (existingReceipt.kind !== 'destination-surface.honest-state-migration-receipt/v1'
      || existingReceipt.idempotency_ref !== idempotencyRef
      || existingReceipt.migration_ref !== migrationRef
      || existingReceipt.migration_basis !== payloadBasis
      || !isRecord(existingReceipt.result)) {
      throw new Error('migration idempotency receipt conflicts with this request');
    }
    await assertFinalState(partition, replacements, retractions, sender);
    return {
      ...clone(existingReceipt.result),
      successor_writes: 0,
      invented_rows_retracted: 0,
      replay: true,
    };
  }

  const successorWrites = [];
  for (const row of replacements) {
    const before = await current(partition, row.address, sender);
    const stored = decodeStored(before);
    if (same(stored, row.successor)) continue;
    if (!same(stored, row.expectedPayload)) throw new Error(`replacement basis changed for ${row.address}`);
    successorWrites.push({
      partitionLabel: partition,
      addressLabel: row.address,
      pathLabels: row.pathLabels,
      payloadBytes: encoder.encode(JSON.stringify(row.successor)),
      expectedCurrent: { payloadHash: basis(before) },
    });
  }
  if (successorWrites.length > 0) {
    try { await sender(buildEngineWriteBatchRequestFromLabels(successorWrites)); } catch { /* exact readback classifies commit/lost reply */ }
  }
  for (const row of replacements) {
    const after = decodeStored(await current(partition, row.address, sender));
    if (!same(after, row.successor)) throw new Error(`successor readback failed for ${row.address}`);
  }

  const retractionWrites = [];
  for (const row of retractions) {
    const before = await current(partition, row.address, sender);
    const stored = decodeStored(before);
    if (stored === null) continue;
    if (!same(stored, row.expectedPayload)) throw new Error(`retraction basis changed for ${row.address}`);
    retractionWrites.push({
      partitionLabel: partition,
      addressLabel: row.address,
      pathLabels: row.pathLabels,
      expectedCurrent: { payloadHash: basis(before) },
    });
  }
  if (retractionWrites.length > 0) {
    try { await sender(buildEngineWriteBatchRequestFromLabels(retractionWrites)); } catch { /* exact absence proof classifies commit/lost reply */ }
  }
  await assertFinalState(partition, replacements, retractions, sender);

  console.info(`[destination.migrate] descriptor=${migrationRef} invented_rows_retracted=${retractionWrites.length} derived_sources=${replacements.length} readback=pass`);
  const result = {
    status: 'accepted',
    migration_ref: migrationRef,
    idempotency_ref: idempotencyRef,
    successors: replacements.map((row) => row.address),
    successor_writes: successorWrites.length,
    invented_rows_retracted: retractionWrites.length,
    readback: 'pass',
  };
  const receipt = {
    kind: 'destination-surface.honest-state-migration-receipt/v1',
    migration_ref: migrationRef,
    idempotency_ref: idempotencyRef,
    migration_basis: payloadBasis,
    result,
  };
  try {
    await sender(buildEngineWriteBatchRequestFromLabels([{
      partitionLabel: partition,
      addressLabel: receiptAddress,
      pathLabels: ['current-item', 'migration-receipt'],
      payloadBytes: encoder.encode(JSON.stringify(receipt)),
      expectedCurrent: { payloadHash: null },
    }]));
  } catch { /* exact receipt readback classifies commit/lost reply */ }
  const receiptReadback = decodeStored(await current(partition, receiptAddress, sender));
  if (!same(receiptReadback, receipt)) throw new Error('migration receipt readback failed');
  return { ...result, replay: false };
}
