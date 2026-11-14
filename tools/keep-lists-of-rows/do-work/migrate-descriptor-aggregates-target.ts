//
// Admitted migration target. It stages independently addressed facts,
// independently reads them back, proves semantic parity, then writes exactly
// one activation marker guarded by every legacy source hash.

import {
  readAddressedCurrent,
  writeAddressedRecords,
  writeAddressedRecordsGuarded,
  type AddressedCurrentSnapshot,
  type AddressedWrite,
  type AddressedWritePrecondition,
} from './record-writes';
import {
  planDescriptorAggregateMigration,
  verifyDescriptorMigrationParity,
  type LegacyDescriptorAggregate,
} from './migrate-descriptor-aggregates';
import {
  foldAddressedDescriptorFacts,
  type DescriptorKey,
  type DescriptorOwnerTarget,
} from '../read-data/addressed-descriptors';

type JsonObject = Record<string, unknown>;
type BatchWriter = (
  partitionLabel: string,
  writes: readonly AddressedWrite[],
) => Promise<void>;
type GuardedBatchWriter = (
  partitionLabel: string,
  writes: readonly AddressedWrite[],
  preconditions: readonly AddressedWritePrecondition[],
) => Promise<void>;
type CurrentReader = (
  partitionLabel: string,
  addressLabel: string,
) => Promise<AddressedCurrentSnapshot | null>;

interface MigrationRequest {
  partitionLabel: string;
  migrationId: string;
  descriptorTarget: DescriptorOwnerTarget;
  activationAddressLabel: string;
  activationPathLabels: readonly string[];
  chunkSize?: number;
  aggregates: readonly LegacyDescriptorAggregate[];
}

export type MigrateDescriptorAggregatesTargetReply =
  | {
      ok: true;
      state: 'activated' | 'already-active';
      descriptor_count: number;
      semantic_digest: string;
    }
  | { ok: false; error: string };

function isRecord(value: unknown): value is JsonObject {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function nonEmpty(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function stringList(value: unknown): readonly string[] | null {
  return Array.isArray(value)
    && value.length > 0
    && value.every((entry) => typeof entry === 'string' && entry.trim())
    ? value.map((entry) => entry.trim())
    : null;
}

function sameStrings(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length
    && left.every((entry, index) => entry === right[index]);
}

function coherentOwnerContract(input: {
  addressPrefix: string;
  descriptorPaths: readonly string[];
  activationAddressLabel: string;
  activationPathLabels: readonly string[];
}): boolean {
  const namespace = 'visual-database.descriptors::';
  if (!input.addressPrefix.startsWith(namespace)) return false;
  const ownerId = input.addressPrefix.slice(namespace.length);
  if (!ownerId || ownerId.includes('::')) return false;
  const expectedPath = [
    'current-item',
    'visual-database-descriptor',
    'owner',
    ownerId,
  ];
  return sameStrings(input.descriptorPaths, expectedPath)
    && input.activationAddressLabel === `${input.addressPrefix}::authority`
    && sameStrings(input.activationPathLabels, input.descriptorPaths);
}

function decodeBase64(value: unknown): Uint8Array | null {
  if (typeof value !== 'string' || !value) return null;
  try {
    return Uint8Array.from(atob(value), (character) => character.charCodeAt(0));
  } catch {
    return null;
  }
}

function descriptorKey(value: unknown): DescriptorKey | null {
  if (!isRecord(value)) return null;
  const family = nonEmpty(value.family);
  const id = nonEmpty(value.id);
  if (!family || !id) return null;
  if (value.parent !== undefined && !Array.isArray(value.parent)) return null;
  const parent = (value.parent ?? []).map(descriptorKey);
  if (parent.some((entry) => entry === null)) return null;
  return {
    family,
    id,
    ...(parent.length
      ? {
          parent: parent.map((entry) => ({
            family: entry!.family,
            id: entry!.id,
          })),
        }
      : {}),
  };
}

function readRequest(input: unknown): MigrationRequest | null {
  if (!isRecord(input)) return null;
  const partitionLabel = nonEmpty(input.partition_label);
  const migrationId = nonEmpty(input.migration_id);
  const descriptor = isRecord(input.descriptor_target) ? input.descriptor_target : null;
  const addressPrefix = nonEmpty(descriptor?.address_prefix);
  const descriptorPaths = stringList(descriptor?.path_labels);
  const activation = isRecord(input.activation) ? input.activation : null;
  const activationAddressLabel = nonEmpty(activation?.address_label);
  const activationPathLabels = stringList(activation?.path_labels);
  if (
    !partitionLabel
    || !migrationId
    || !addressPrefix
    || !descriptorPaths
    || !activationAddressLabel
    || !activationPathLabels
    || !Array.isArray(input.aggregates)
  ) return null;
  if (!coherentOwnerContract({
    addressPrefix,
    descriptorPaths,
    activationAddressLabel,
    activationPathLabels,
  })) return null;
  const aggregates: LegacyDescriptorAggregate[] = [];
  for (const rawAggregate of input.aggregates) {
    if (!isRecord(rawAggregate) || !Array.isArray(rawAggregate.descriptors)) return null;
    const addressLabel = nonEmpty(rawAggregate.address_label);
    const payloadHash = decodeBase64(rawAggregate.payload_hash_base64);
    if (!addressLabel || !payloadHash) return null;
    const descriptors: LegacyDescriptorAggregate['descriptors'][number][] = [];
    for (const rawDescriptor of rawAggregate.descriptors) {
      if (!isRecord(rawDescriptor) || !Object.prototype.hasOwnProperty.call(rawDescriptor, 'value')) {
        return null;
      }
      const key = descriptorKey(rawDescriptor.key);
      if (!key) return null;
      descriptors.push({ key, value: rawDescriptor.value });
    }
    aggregates.push({ addressLabel, payloadHash, descriptors });
  }
  const chunkSize = input.chunk_size;
  if (
    chunkSize !== undefined
    && (!Number.isSafeInteger(chunkSize) || (chunkSize as number) <= 0)
  ) return null;
  return {
    partitionLabel,
    migrationId,
    descriptorTarget: {
      addressPrefix,
      pathLabels: descriptorPaths,
    },
    activationAddressLabel,
    activationPathLabels,
    ...(chunkSize === undefined ? {} : { chunkSize: chunkSize as number }),
    aggregates,
  };
}

function sameValue(left: unknown, right: unknown): boolean {
  if (Object.is(left, right)) return true;
  if (Array.isArray(left) && Array.isArray(right)) {
    return left.length === right.length
      && left.every((value, index) => sameValue(value, right[index]));
  }
  if (isRecord(left) && isRecord(right)) {
    const keys = Object.keys(left);
    return keys.length === Object.keys(right).length
      && keys.every(
        (key) => Object.prototype.hasOwnProperty.call(right, key)
          && sameValue(left[key], right[key]),
      );
  }
  return false;
}

async function stageBatch(
  request: MigrationRequest,
  writes: readonly AddressedWrite[],
  reader: CurrentReader,
  writer: BatchWriter,
): Promise<void> {
  const missing: AddressedWrite[] = [];
  for (const write of writes) {
    const current = await reader(request.partitionLabel, write.addressLabel);
    if (!current) {
      missing.push(write);
      continue;
    }
    if (!sameValue(current.payload, write.payload)) {
      throw new Error('Staged descriptor address contains different current truth.');
    }
  }
  if (missing.length === 0) return;
  try {
    await writer(request.partitionLabel, missing);
  } catch (error) {
    const accepted = await Promise.all(missing.map(async (write) => {
      const current = await reader(request.partitionLabel, write.addressLabel);
      return current !== null && sameValue(current.payload, write.payload);
    }));
    if (!accepted.every(Boolean)) throw error;
  }
}

async function allWritesMatchCurrent(
  request: MigrationRequest,
  writes: readonly AddressedWrite[],
  reader: CurrentReader,
): Promise<boolean> {
  const accepted = await Promise.all(writes.map(async (write) => {
    const current = await reader(request.partitionLabel, write.addressLabel);
    return current !== null && sameValue(current.payload, write.payload);
  }));
  return accepted.every(Boolean);
}

async function activateBatch(
  request: MigrationRequest,
  writes: readonly AddressedWrite[],
  preconditions: readonly AddressedWritePrecondition[],
  reader: CurrentReader,
  writer: GuardedBatchWriter,
): Promise<void> {
  try {
    await writer(request.partitionLabel, writes, preconditions);
  } catch (error) {
    if (!await allWritesMatchCurrent(request, writes, reader)) throw error;
  }
}

export async function migrateDescriptorAggregatesTarget(
  input: unknown,
  _context?: { packageData?: unknown },
  ports: {
    readCurrent?: CurrentReader;
    writeBatch?: BatchWriter;
    writeGuardedBatch?: GuardedBatchWriter;
  } = {},
): Promise<MigrateDescriptorAggregatesTargetReply> {
  const request = readRequest(input);
  if (!request) return { ok: false, error: 'invalid descriptor migration request' };
  const reader = ports.readCurrent ?? readAddressedCurrent;
  const writer = ports.writeBatch ?? writeAddressedRecords;
  const guardedWriter = ports.writeGuardedBatch ?? writeAddressedRecordsGuarded;
  try {
    const plan = planDescriptorAggregateMigration({
      migrationId: request.migrationId,
      aggregates: request.aggregates,
      descriptorTarget: request.descriptorTarget,
      activationAddressLabel: request.activationAddressLabel,
      activationPathLabels: request.activationPathLabels,
      ...(request.chunkSize === undefined ? {} : { chunkSize: request.chunkSize }),
    });
    const existingActivation = await reader(
      request.partitionLabel,
      request.activationAddressLabel,
    );
    if (existingActivation) {
      if (!sameValue(existingActivation.payload, plan.activation)) {
        throw new Error('A different descriptor authority is already active.');
      }
      return {
        ok: true,
        state: 'already-active',
        descriptor_count: plan.descriptorCount,
        semantic_digest: plan.semanticDigest,
      };
    }
    for (const batch of plan.stagedBatches) {
      await stageBatch(request, batch, reader, writer);
    }
    const staged = await Promise.all(plan.stagedWrites.map(async (write) => {
      const current = await reader(request.partitionLabel, write.addressLabel);
      return current && {
        addressLabel: write.addressLabel,
        payload: current.payload,
        payloadHash: current.payloadHash,
      };
    }));
    if (staged.some((entry) => entry === null)) {
      throw new Error('Descriptor staging readback is incomplete.');
    }
    const folded = foldAddressedDescriptorFacts(
      plan.stagingTarget,
      staged as {
        addressLabel: string;
        payload: unknown;
        payloadHash: Uint8Array;
      }[],
    );
    if (folded.invalid.length > 0) {
      throw new Error('Descriptor staging readback contains invalid facts.');
    }
    const parity = verifyDescriptorMigrationParity({
      aggregates: request.aggregates,
      staged: folded.snapshots,
    });
    if (!parity.ok) throw new Error('Descriptor migration semantic parity failed.');
    await activateBatch(
      request,
      [...plan.activeWrites, plan.activationWrite],
      plan.sourcePreconditions,
      reader,
      guardedWriter,
    );
    const activationReadback = await reader(
      request.partitionLabel,
      request.activationAddressLabel,
    );
    if (
      !activationReadback
      || !sameValue(activationReadback.payload, plan.activation)
    ) {
      throw new Error('Descriptor authority activation readback failed.');
    }
    if (!await allWritesMatchCurrent(request, plan.activeWrites, reader)) {
      throw new Error('Active descriptor readback is incomplete.');
    }
    return {
      ok: true,
      state: 'activated',
      descriptor_count: plan.descriptorCount,
      semantic_digest: plan.semanticDigest,
    };
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : 'descriptor migration failed',
    };
  }
}
