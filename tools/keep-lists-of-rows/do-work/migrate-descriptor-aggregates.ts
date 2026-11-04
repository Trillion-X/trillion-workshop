//
// Pure migration planner for replacing legacy aggregate descriptor truth with
// independently addressed facts. Facts are staged first. One guarded marker
// activates them only after exact semantic parity and source-hash checks.

import type { AddressedWrite, AddressedWritePrecondition } from './record-writes';
import {
  descriptorAddressFor,
  descriptorKeyIdentity,
  normalizeDescriptorKey,
  type AddressedDescriptorSnapshot,
  type DescriptorFact,
  type DescriptorKey,
  type DescriptorOwnerTarget,
} from '../read-data/addressed-descriptors';

export interface LegacyDescriptorAggregate {
  addressLabel: string;
  payloadHash: Uint8Array;
  descriptors: readonly {
    key: DescriptorKey;
    value: unknown;
  }[];
}

export interface DescriptorMigrationReceipt {
  kind: 'visual-database.descriptor-migration-receipt';
  schema_version: 1;
  migration_id: string;
  semantic_digest: string;
  descriptor_count: number;
  source_bases: readonly {
    address_label: string;
    payload_hash_base64: string;
  }[];
}

export interface DescriptorAuthorityActivation {
  kind: 'visual-database.descriptor-authority-activation';
  schema_version: 2;
  authority_id: string;
  active_address_prefix: string;
  active_path_labels: readonly string[];
  migration_receipt: DescriptorMigrationReceipt;
}

export interface DescriptorAggregateMigrationPlan {
  migrationId: string;
  semanticDigest: string;
  descriptorCount: number;
  stagingTarget: DescriptorOwnerTarget;
  stagedWrites: readonly AddressedWrite[];
  stagedBatches: readonly (readonly AddressedWrite[])[];
  activeWrites: readonly AddressedWrite[];
  activationWrite: AddressedWrite;
  sourcePreconditions: readonly AddressedWritePrecondition[];
  activation: DescriptorAuthorityActivation;
}

export interface DescriptorMigrationParity {
  ok: boolean;
  sourceCount: number;
  stagedCount: number;
  sourceDigest: string;
  stagedDigest: string;
  missingKeys: readonly string[];
  changedKeys: readonly string[];
  unexpectedKeys: readonly string[];
}

export type DescriptorAuthoritySelection =
  | { state: 'legacy'; activation: null }
  | {
      state: 'addressed';
      activation: DescriptorAuthorityActivation;
      snapshots: readonly AddressedDescriptorSnapshot[];
    }
  | {
      state: 'invalid';
      activation: DescriptorAuthorityActivation | null;
      reason:
        | 'malformed-activation'
        | 'namespace-mismatch'
        | 'path-mismatch'
        | 'mixed-authority-without-activation'
        | 'invalid-active-facts';
    };

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

export function descriptorAuthorityActivationFromUnknown(
  value: unknown,
): DescriptorAuthorityActivation | null {
  if (
    !isRecord(value)
    || value.kind !== 'visual-database.descriptor-authority-activation'
    || value.schema_version !== 2
    || typeof value.authority_id !== 'string'
    || !value.authority_id.trim()
    || typeof value.active_address_prefix !== 'string'
    || !value.active_address_prefix.trim()
    || !Array.isArray(value.active_path_labels)
    || value.active_path_labels.length === 0
    || value.active_path_labels.some(
      (entry) => typeof entry !== 'string' || !entry.trim(),
    )
    || !isRecord(value.migration_receipt)
  ) return null;
  const receipt = value.migration_receipt;
  if (
    receipt.kind !== 'visual-database.descriptor-migration-receipt'
    || receipt.schema_version !== 1
    || typeof receipt.migration_id !== 'string'
    || !receipt.migration_id.trim()
    || typeof receipt.semantic_digest !== 'string'
    || !receipt.semantic_digest.trim()
    || !Number.isSafeInteger(receipt.descriptor_count)
    || (receipt.descriptor_count as number) < 0
    || !Array.isArray(receipt.source_bases)
  ) return null;
  const sourceBases: DescriptorMigrationReceipt['source_bases'][number][] = [];
  for (const source of receipt.source_bases) {
    if (
      !isRecord(source)
      || typeof source.address_label !== 'string'
      || !source.address_label.trim()
      || typeof source.payload_hash_base64 !== 'string'
      || !source.payload_hash_base64
    ) return null;
    sourceBases.push({
      address_label: source.address_label,
      payload_hash_base64: source.payload_hash_base64,
    });
  }
  return {
    kind: 'visual-database.descriptor-authority-activation',
    schema_version: 2,
    authority_id: value.authority_id,
    active_address_prefix: value.active_address_prefix,
    active_path_labels: value.active_path_labels.map((entry) => (entry as string).trim()),
    migration_receipt: {
      kind: 'visual-database.descriptor-migration-receipt',
      schema_version: 1,
      migration_id: receipt.migration_id,
      semantic_digest: receipt.semantic_digest,
      descriptor_count: receipt.descriptor_count as number,
      source_bases: sourceBases,
    },
  };
}

export function selectDescriptorAuthority(input: {
  activation: unknown;
  target: DescriptorOwnerTarget;
  fold: {
    snapshots: readonly AddressedDescriptorSnapshot[];
    invalid: readonly unknown[];
  };
}): DescriptorAuthoritySelection {
  if (input.activation === undefined || input.activation === null) {
    if (input.fold.snapshots.length > 0 || input.fold.invalid.length > 0) {
      return {
        state: 'invalid',
        activation: null,
        reason: 'mixed-authority-without-activation',
      };
    }
    return { state: 'legacy', activation: null };
  }
  const activation = descriptorAuthorityActivationFromUnknown(input.activation);
  if (!activation) {
    return { state: 'invalid', activation: null, reason: 'malformed-activation' };
  }
  if (activation.active_address_prefix !== input.target.addressPrefix) {
    return { state: 'invalid', activation, reason: 'namespace-mismatch' };
  }
  if (
    activation.active_path_labels.length !== input.target.pathLabels.length
    || activation.active_path_labels.some(
      (label, index) => label !== input.target.pathLabels[index],
    )
  ) {
    return { state: 'invalid', activation, reason: 'path-mismatch' };
  }
  if (input.fold.invalid.length > 0) {
    return { state: 'invalid', activation, reason: 'invalid-active-facts' };
  }
  return {
    state: 'addressed',
    activation,
    snapshots: input.fold.snapshots,
  };
}

function canonicalValue(value: unknown): unknown {
  if (value instanceof Uint8Array) return [...value];
  if (Array.isArray(value)) return value.map(canonicalValue);
  if (isRecord(value)) {
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .filter((key) => value[key] !== undefined)
        .map((key) => [key, canonicalValue(value[key])]),
    );
  }
  return value;
}

function canonicalJson(value: unknown): string {
  return JSON.stringify(canonicalValue(value));
}

function fnv1a64(value: string): string {
  let hash = 0xcbf29ce484222325n;
  for (const byte of new TextEncoder().encode(value)) {
    hash ^= BigInt(byte);
    hash = BigInt.asUintN(64, hash * 0x100000001b3n);
  }
  return `fnv1a64:${hash.toString(16).padStart(16, '0')}`;
}

function base64(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function descriptorFact(key: DescriptorKey, value: unknown): DescriptorFact {
  return {
    kind: 'visual-database.descriptor',
    schema_version: 3,
    key: normalizeDescriptorKey(key),
    value,
  };
}

function sourceFacts(
  aggregates: readonly LegacyDescriptorAggregate[],
): readonly DescriptorFact[] {
  const facts = aggregates.flatMap((aggregate) => aggregate.descriptors.map(
    (descriptor) => descriptorFact(descriptor.key, descriptor.value),
  ));
  const identities = facts.map((fact) => descriptorKeyIdentity(fact.key));
  if (new Set(identities).size !== identities.length) {
    throw new Error('Descriptor aggregate migration found duplicate descriptor identities.');
  }
  return facts.sort(
    (left, right) => descriptorKeyIdentity(left.key).localeCompare(descriptorKeyIdentity(right.key)),
  );
}

export function descriptorMigrationSemanticDigest(
  descriptors: readonly DescriptorFact[],
): string {
  const canonical = [...descriptors]
    .sort(
      (left, right) => descriptorKeyIdentity(left.key).localeCompare(descriptorKeyIdentity(right.key)),
    )
    .map((descriptor) => ({
      key: normalizeDescriptorKey(descriptor.key),
      value: descriptor.value,
    }));
  return fnv1a64(canonicalJson(canonical));
}

function chunks<T>(values: readonly T[], size: number): readonly (readonly T[])[] {
  const result: T[][] = [];
  for (let index = 0; index < values.length; index += size) {
    result.push(values.slice(index, index + size));
  }
  return result;
}

function migrationIdentitySegment(value: string): string {
  return encodeURIComponent(value).replace(/[!'()*]/g, (character) => (
    `%${character.charCodeAt(0).toString(16).toUpperCase()}`
  ));
}

export function descriptorMigrationStagingTarget(
  activeTarget: DescriptorOwnerTarget,
  migrationId: string,
): DescriptorOwnerTarget {
  const identity = migrationIdentitySegment(migrationId.normalize('NFC').trim());
  if (!identity) throw new Error('Descriptor aggregate migration requires an identity.');
  return {
    addressPrefix: `${activeTarget.addressPrefix}::staging::${identity}`,
    pathLabels: ['descriptor-migration-staging', identity],
  };
}

export function planDescriptorAggregateMigration(input: {
  migrationId: string;
  aggregates: readonly LegacyDescriptorAggregate[];
  descriptorTarget: DescriptorOwnerTarget;
  activationAddressLabel: string;
  activationPathLabels: readonly string[];
  chunkSize?: number;
}): DescriptorAggregateMigrationPlan {
  const migrationId = input.migrationId.normalize('NFC').trim();
  if (!migrationId) throw new Error('Descriptor aggregate migration requires an identity.');
  const chunkSize = input.chunkSize ?? 128;
  if (!Number.isSafeInteger(chunkSize) || chunkSize <= 0) {
    throw new Error('Descriptor aggregate migration chunk size must be a positive integer.');
  }
  const facts = sourceFacts(input.aggregates);
  const semanticDigest = descriptorMigrationSemanticDigest(facts);
  const stagingTarget = descriptorMigrationStagingTarget(
    input.descriptorTarget,
    migrationId,
  );
  const stagedWrites = facts.map((payload): AddressedWrite => ({
    addressLabel: descriptorAddressFor(stagingTarget, payload.key),
    pathLabels: stagingTarget.pathLabels,
    payload,
    expectedCurrent: null,
  }));
  const activeWrites = facts.map((payload): AddressedWrite => ({
    addressLabel: descriptorAddressFor(input.descriptorTarget, payload.key),
    pathLabels: input.descriptorTarget.pathLabels,
    payload,
    expectedCurrent: null,
  }));
  const sourceBases = [...input.aggregates]
    .sort((left, right) => left.addressLabel.localeCompare(right.addressLabel))
    .map((aggregate) => ({
      address_label: aggregate.addressLabel,
      payload_hash_base64: base64(aggregate.payloadHash),
    }));
  const migrationReceipt: DescriptorMigrationReceipt = {
    kind: 'visual-database.descriptor-migration-receipt',
    schema_version: 1,
    migration_id: migrationId,
    semantic_digest: semanticDigest,
    descriptor_count: facts.length,
    source_bases: sourceBases,
  };
  const activation: DescriptorAuthorityActivation = {
    kind: 'visual-database.descriptor-authority-activation',
    schema_version: 2,
    authority_id: migrationId,
    active_address_prefix: input.descriptorTarget.addressPrefix,
    active_path_labels: [...input.descriptorTarget.pathLabels],
    migration_receipt: migrationReceipt,
  };
  return {
    migrationId,
    semanticDigest,
    descriptorCount: facts.length,
    stagingTarget,
    stagedWrites,
    stagedBatches: chunks(stagedWrites, chunkSize),
    activeWrites,
    activationWrite: {
      addressLabel: input.activationAddressLabel,
      pathLabels: input.activationPathLabels,
      payload: activation,
      expectedCurrent: null,
    },
    sourcePreconditions: input.aggregates.map((aggregate) => ({
      addressLabel: aggregate.addressLabel,
      expectedCurrent: { payloadHash: new Uint8Array(aggregate.payloadHash) },
    })),
    activation,
  };
}

export function verifyDescriptorMigrationParity(input: {
  aggregates: readonly LegacyDescriptorAggregate[];
  staged: readonly AddressedDescriptorSnapshot[];
}): DescriptorMigrationParity {
  const source = sourceFacts(input.aggregates);
  const sourceByKey = new Map(
    source.map((descriptor) => [descriptorKeyIdentity(descriptor.key), descriptor]),
  );
  const stagedByKey = new Map(
    input.staged.map((snapshot) => [descriptorKeyIdentity(snapshot.key), snapshot.payload]),
  );
  const missingKeys = [...sourceByKey.keys()].filter((key) => !stagedByKey.has(key));
  const unexpectedKeys = [...stagedByKey.keys()].filter((key) => !sourceByKey.has(key));
  const changedKeys = [...sourceByKey].flatMap(([key, descriptor]) => (
    stagedByKey.has(key)
    && canonicalJson(stagedByKey.get(key)) !== canonicalJson(descriptor)
      ? [key]
      : []
  ));
  const sourceDigest = descriptorMigrationSemanticDigest(source);
  const stagedDigest = descriptorMigrationSemanticDigest([...stagedByKey.values()]);
  return {
    ok: missingKeys.length === 0
      && unexpectedKeys.length === 0
      && changedKeys.length === 0
      && sourceDigest === stagedDigest,
    sourceCount: source.length,
    stagedCount: input.staged.length,
    sourceDigest,
    stagedDigest,
    missingKeys,
    changedKeys,
    unexpectedKeys,
  };
}
