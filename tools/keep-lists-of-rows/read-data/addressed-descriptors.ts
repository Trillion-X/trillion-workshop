//
// Open, independently addressed descriptor facts. Persistence treats family
// and value as opaque DATA; caller adapters own their Society vocabulary.

import {
  canonicalFactAddress,
  makeIdentityTextAddressFromLabel as makeAddressFromLabel,
} from './addressed-identity';
import { flattenScopedFeedRow } from './visual-database';

export interface DescriptorKey {
  family: string;
  id: string;
  parent?: readonly {
    family: string;
    id: string;
  }[];
}

export interface DescriptorFact<T = unknown> {
  kind: 'visual-database.descriptor';
  schema_version: 3;
  key: DescriptorKey;
  value: T;
}

export interface AddressedDescriptorSnapshot<T = unknown> {
  key: DescriptorKey;
  addressLabel: string;
  pathLabels: readonly string[];
  payload: DescriptorFact<T>;
  payloadHash: Uint8Array;
}

/** Owner-declared relationship extraction. `**` recursively descends through
 * objects/arrays and `*` selects every immediate child. The mutation primitive
 * interprets only this generic path algebra; descriptor-family vocabulary
 * remains owner DATA. */
export interface DescriptorReferenceRule {
  sourceFamilies?: readonly string[];
  targetFamily: string;
  valuePath: readonly string[];
}

export interface DescriptorOwnerTarget {
  addressPrefix: string;
  pathLabels: readonly string[];
  payloadDefaults?: Readonly<Record<string, unknown>>;
  referenceRules?: readonly DescriptorReferenceRule[];
}

export interface PublishedDescriptorInput {
  addressLabel: string;
  pathLabels?: readonly string[];
  payload: unknown;
  payloadHash: Uint8Array;
}

export interface InvalidAddressedDescriptor {
  addressLabel: string;
  reason:
    | 'invalid-address'
    | 'invalid-fact'
    | 'address-mismatch'
    | 'duplicate-key';
  payload: unknown;
}

export interface AddressedDescriptorFold {
  snapshots: readonly AddressedDescriptorSnapshot[];
  invalid: readonly InvalidAddressedDescriptor[];
}

function rowsFromPublishedInput(raw: unknown): readonly unknown[] {
  // Normalize every row through the ONE canonical scoped-feed decoder
  // (flattenScopedFeedRow) so a scoped `record_from_matching_records` projection
  // row ({record:{address,source_package},payload}) and the published-records
  // aggregate row ({address,payload}) become one flat shape here, exactly as the
  // main board decode does (SSOT: one scoped-feed row reader, not two).
  let rows: readonly unknown[] | undefined;
  if (Array.isArray(raw)) rows = raw;
  else if (!isRecord(raw)) return [];
  else {
    for (const key of ['records', 'items', 'rows']) {
      if (Array.isArray(raw[key])) {
        rows = raw[key] as unknown[];
        break;
      }
    }
  }
  if (!rows) return [];
  return rows.map(flattenScopedFeedRow);
}

function bytesFromBase64(value: unknown): Uint8Array | null {
  if (typeof value !== 'string' || !value) return null;
  try {
    return Uint8Array.from(atob(value), (character) => character.charCodeAt(0));
  } catch {
    return null;
  }
}

function normalizedIdentity(value: string, label: string): string {
  const normalized = value.normalize('NFC').trim();
  if (!normalized) throw new Error(`Descriptor ${label} must not be empty.`);
  return normalized;
}

export function normalizeDescriptorKey(key: DescriptorKey): DescriptorKey {
  return {
    family: normalizedIdentity(key.family, 'family'),
    id: normalizedIdentity(key.id, 'id'),
    ...(key.parent?.length
      ? {
          parent: key.parent.map((entry) => ({
            family: normalizedIdentity(entry.family, 'parent family'),
            id: normalizedIdentity(entry.id, 'parent id'),
          })),
        }
      : {}),
  };
}

function addressSegment(value: string): string {
  return encodeURIComponent(value).replace(/[!'()*]/g, (character) => (
    `%${character.charCodeAt(0).toString(16).toUpperCase()}`
  ));
}

export function descriptorKeyIdentity(key: DescriptorKey): string {
  const normalized = normalizeDescriptorKey(key);
  return JSON.stringify({
    family: normalized.family,
    id: normalized.id,
    parent: normalized.parent ?? [],
  });
}

export function descriptorAddressFor(
  target: DescriptorOwnerTarget,
  key: DescriptorKey,
): string {
  const prefix = target.addressPrefix.normalize('NFC').trim().replace(/:+$/g, '');
  if (!prefix) throw new Error('Descriptor owner address prefix must not be empty.');
  const normalized = normalizeDescriptorKey(key);
  const parentSegments = (normalized.parent ?? []).flatMap((entry) => [
    'parent',
    addressSegment(entry.family),
    addressSegment(entry.id),
  ]);
  return [
    prefix,
    ...parentSegments,
    'member',
    addressSegment(normalized.family),
    addressSegment(normalized.id),
  ].join('::');
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function descriptorKeyFromUnknown(value: unknown): DescriptorKey | null {
  if (!isRecord(value) || typeof value.family !== 'string' || typeof value.id !== 'string') {
    return null;
  }
  if (value.parent !== undefined && !Array.isArray(value.parent)) return null;
  const parent: { family: string; id: string }[] = [];
  for (const entry of value.parent ?? []) {
    if (!isRecord(entry) || typeof entry.family !== 'string' || typeof entry.id !== 'string') {
      return null;
    }
    parent.push({ family: entry.family, id: entry.id });
  }
  try {
    return normalizeDescriptorKey({
      family: value.family,
      id: value.id,
      ...(parent.length ? { parent } : {}),
    });
  } catch {
    return null;
  }
}

export function descriptorFactFromUnknown(value: unknown): DescriptorFact | null {
  if (
    !isRecord(value)
    || value.kind !== 'visual-database.descriptor'
    || value.schema_version !== 3
  ) {
    return null;
  }
  const key = descriptorKeyFromUnknown(value.key);
  if (!key || !Object.prototype.hasOwnProperty.call(value, 'value')) return null;
  return {
    kind: 'visual-database.descriptor',
    schema_version: 3,
    key,
    value: value.value,
  };
}

export function addressedDescriptorInputsFromPublishedRecords(
  target: DescriptorOwnerTarget,
  records: readonly PublishedDescriptorInput[],
): readonly AddressedDescriptorSnapshot[] {
  return records.flatMap((record) => {
    const payload = descriptorFactFromUnknown(record.payload);
    if (!payload) return [];
    if (descriptorAddressFor(target, payload.key) !== record.addressLabel) return [];
    return [{
      key: payload.key,
      addressLabel: record.addressLabel,
      pathLabels: [...(record.pathLabels ?? target.pathLabels)],
      payload,
      payloadHash: new Uint8Array(record.payloadHash),
    }];
  });
}

export function foldAddressedDescriptorFacts(
  target: DescriptorOwnerTarget,
  records: readonly PublishedDescriptorInput[],
): AddressedDescriptorFold {
  const snapshots: AddressedDescriptorSnapshot[] = [];
  const invalid: InvalidAddressedDescriptor[] = [];
  const seen = new Map<string, number>();

  for (const record of records) {
    const payload = descriptorFactFromUnknown(record.payload);
    if (!payload) {
      invalid.push({
        addressLabel: record.addressLabel,
        reason: 'invalid-fact',
        payload: record.payload,
      });
      continue;
    }
    let expectedAddress: string;
    try {
      expectedAddress = descriptorAddressFor(target, payload.key);
    } catch {
      invalid.push({
        addressLabel: record.addressLabel,
        reason: 'invalid-address',
        payload: record.payload,
      });
      continue;
    }
    if (expectedAddress !== record.addressLabel) {
      invalid.push({
        addressLabel: record.addressLabel,
        reason: 'address-mismatch',
        payload: record.payload,
      });
      continue;
    }
    const identity = descriptorKeyIdentity(payload.key);
    const existingIndex = seen.get(identity);
    if (existingIndex !== undefined) {
      invalid.push({
        addressLabel: record.addressLabel,
        reason: 'duplicate-key',
        payload: record.payload,
      });
      snapshots.splice(existingIndex, 1);
      for (const [key, index] of seen) {
        if (index > existingIndex) seen.set(key, index - 1);
      }
      seen.delete(identity);
      continue;
    }
    seen.set(identity, snapshots.length);
    snapshots.push({
      key: payload.key,
      addressLabel: record.addressLabel,
      pathLabels: [...(record.pathLabels ?? target.pathLabels)],
      payload,
      payloadHash: new Uint8Array(record.payloadHash),
    });
  }

  return { snapshots, invalid };
}

/** Reads descriptor members from the existing published-record feed. The feed
 * exposes fact identities as multihashes, while the writer needs the original
 * deterministic label; this boundary proves those are the same identity and
 * retains the human label only for the next guarded write. */
export function foldAddressedDescriptorFactsFromPublishedFeed(
  target: DescriptorOwnerTarget,
  raw: unknown,
): AddressedDescriptorFold {
  const records: PublishedDescriptorInput[] = [];
  const invalid: InvalidAddressedDescriptor[] = [];
  for (const row of rowsFromPublishedInput(raw)) {
    if (!isRecord(row)) {
      invalid.push({
        addressLabel: '<published-descriptor-row>',
        reason: 'invalid-fact',
        payload: row,
      });
      continue;
    }
    // Rows are already flattened to {address,payload} by rowsFromPublishedInput
    // (flattenScopedFeedRow), so the address is always a flat field here.
    const observedAddress = row.address_label ?? row.addressLabel ?? row.address;
    const payload = descriptorFactFromUnknown(row.payload);
    if (!payload) {
      invalid.push({
        addressLabel: typeof observedAddress === 'string'
          ? observedAddress
          : '<published-descriptor-row>',
        reason: 'invalid-fact',
        payload: row.payload,
      });
      continue;
    }
    const addressLabel = descriptorAddressFor(target, payload.key);
    const observedCanonical = typeof observedAddress === 'string'
      ? canonicalFactAddress(observedAddress) ?? makeAddressFromLabel(observedAddress.trim())
      : null;
    const expectedCanonical = makeAddressFromLabel(addressLabel);
    // A scoped-feed projection row ({record:{address},payload}) carries no
    // per-row payload hash. The hash is only a basis for the migration write
    // path, never needed to read render snapshots, so a missing hash is an
    // empty basis here and is never a reason to reject a valid descriptor.
    // The address-match check below stays, so the authority fence is intact.
    const payloadHash = row.payloadHash instanceof Uint8Array
      ? new Uint8Array(row.payloadHash)
      : bytesFromBase64(row.payload_hash_base64 ?? row.payloadHashBase64)
        ?? new Uint8Array();
    if (observedCanonical !== expectedCanonical) {
      invalid.push({
        addressLabel: typeof observedAddress === 'string' ? observedAddress : addressLabel,
        reason: observedCanonical === null ? 'invalid-address' : 'address-mismatch',
        payload: row.payload,
      });
      continue;
    }
    records.push({
      addressLabel,
      pathLabels: target.pathLabels,
      payload,
      payloadHash,
    });
  }
  const folded = foldAddressedDescriptorFacts(target, records);
  return {
    snapshots: folded.snapshots,
    invalid: [...invalid, ...folded.invalid],
  };
}
