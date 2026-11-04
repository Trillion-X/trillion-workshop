// Pure request and mutation builders shared by Visual Database surfaces.
// Transport and readback live in record-writes.ts; this module stays safe for
// public/read-only surfaces to import without pulling workspace transport.

import { recordAddress, recordPayload } from '../read-data/visual-database';
import type {
  VisualDatabaseCellRef,
  VisualDatabaseFieldDescriptor,
  VisualDatabaseRecord,
  VisualDatabaseValueExpression,
} from '../read-data/visual-database';
import type { AddressedCellValues } from './cell-expression';
import { canonicalFactAddress } from '../read-data/addressed-identity';
export { canonicalFactAddress, canonicalRecordIdentity } from '../read-data/addressed-identity';

type EngineExpectedCurrentValue = { payloadHash: Uint8Array | null };

export const PUBLISHED_RECORD_PATH: readonly string[] = ['current-item', 'published-record'];

export interface AddressedWrite {
  addressLabel: string;
  payload: unknown;
  pathLabels?: readonly string[];
  /** CAS basis (Codex #5 / task #11): when set, the engine writes this entry ONLY
   *  if the address's current payload still hashes to `payloadHash` — a concurrent
   *  edit that moved the record makes this write fail-closed instead of silently
   *  clobbering. The caller supplies the hash it READ (load-time basis); omit for
   *  an unconditional write (creates, appends, single-writer surfaces). This is the
   *  generic seam: any descriptor-addressed field write can be guarded by passing
   *  the loaded basis — no per-field or per-package code. */
  expectedCurrent?: EngineExpectedCurrentValue | null;
  /** Visual Database projection metadata. The writer resolves this revision to
   * the exact current source payload hash, then sends that source address as a
   * precondition-only assertion on the same atomic cache/provenance batch.
   * It is never serialized as a write and never rewrites source truth. */
  sourceRevisionGuard?: {
    addressLabel: string;
    revision: string;
  };
}

export interface AddressedWritePrecondition {
  addressLabel: string;
  expectedCurrent: EngineExpectedCurrentValue;
}

export interface WriteAddressedRecordOptions extends AddressedWrite {
  partitionLabel: string;
}

export interface LabelAddressedWriteEntry {
  address_label: string;
  address_mode?: 'multihash_hex';
  path_labels: string[];
  payload: unknown;
  expected_current?: { payload_hash_base64: string | null };
}

export interface LabelAddressedWritePrecondition {
  address_label: string;
  address_mode?: 'multihash_hex';
  expected_current: { payload_hash_base64: string | null };
}

export interface LabelAddressedWriteBatchRequest {
  target: 'engine.operation.label-addressed';
  payload: {
    operation_label: 'engine.operation.write-batch';
    partition_label: string;
    writes: LabelAddressedWriteEntry[];
    preconditions?: LabelAddressedWritePrecondition[];
  };
}

export interface RecordCreateAttempt {
  fingerprint: string;
  addressLabel: string;
}

function slugifyRecordTitle(value: string): string {
  return value.toLowerCase().trim().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'item';
}

export function createRecordAddressLabel(
  addressPrefix: string,
  kind: string | null,
  title: string,
  stamp: string,
): string {
  const prefix = addressPrefix.trim().replace(/:+$/g, '');
  if (!prefix) throw new Error('Record owner supplied an empty record address prefix');
  return [prefix, kind, slugifyRecordTitle(title).slice(0, 40), stamp].filter(Boolean).join('::');
}

/** Deterministic retry allocation: one unchanged draft retains one address;
 * changing owner/kind/title/payload allocates the supplied next stamp. */
export function nextRecordCreateAttempt(
  current: RecordCreateAttempt | null,
  input: {
    addressPrefix: string;
    pathLabels?: readonly string[];
    kind: string | null;
    title: string;
    payload: unknown;
    stamp: string;
  },
): RecordCreateAttempt {
  const fingerprint = JSON.stringify([
    input.addressPrefix,
    input.pathLabels ?? [],
    input.kind,
    input.title,
    input.payload,
  ]);
  if (current?.fingerprint === fingerprint) return current;
  return {
    fingerprint,
    addressLabel: createRecordAddressLabel(
      input.addressPrefix,
      input.kind,
      input.title,
      input.stamp,
    ),
  };
}

function base64FromBytes(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

/** Public for boundary tests: production and tests inspect the same
 *  label-addressed entry. Human labels are hashed by the runtime; projected
 *  fact identities use multihash_hex and are never re-hashed. Path labels
 *  cross the same runtime-owned translation boundary for both creates and
 *  updates. */
export function engineWriteEntry(
  _partitionLabel: string,
  write: AddressedWrite,
): LabelAddressedWriteEntry {
  const canonicalAddress = canonicalFactAddress(write.addressLabel);
  return {
    address_label: canonicalAddress ?? write.addressLabel,
    ...(canonicalAddress ? { address_mode: 'multihash_hex' as const } : {}),
    path_labels: [...(write.pathLabels ?? PUBLISHED_RECORD_PATH)],
    payload: write.payload,
    ...(write.expectedCurrent === undefined
      ? {}
      : {
          expected_current: {
            payload_hash_base64: write.expectedCurrent?.payloadHash
              ? base64FromBytes(write.expectedCurrent.payloadHash)
              : null,
          },
        }),
  };
}

export function buildLabelAddressedWriteBatchRequest(
  partitionLabel: string,
  writes: readonly AddressedWrite[],
  preconditions: readonly AddressedWritePrecondition[] = [],
): LabelAddressedWriteBatchRequest {
  return {
    target: 'engine.operation.label-addressed',
    payload: {
      operation_label: 'engine.operation.write-batch',
      partition_label: partitionLabel,
      writes: writes.map((write) => engineWriteEntry(partitionLabel, write)),
      ...(preconditions.length > 0
        ? {
            preconditions: preconditions.map((precondition) => {
              const canonicalAddress = canonicalFactAddress(precondition.addressLabel);
              return {
                address_label: canonicalAddress ?? precondition.addressLabel,
                ...(canonicalAddress ? { address_mode: 'multihash_hex' as const } : {}),
                expected_current: {
                  payload_hash_base64: precondition.expectedCurrent.payloadHash
                    ? base64FromBytes(precondition.expectedCurrent.payloadHash)
                    : null,
                },
              };
            }),
          }
        : {}),
    },
  };
}

/** Stable, independently-addressable cell value labels. The source, cached
 * projection, and provenance never share an address, so a cache refresh can
 * not overwrite expression truth. */
export function addressedCellValueLabels(ref: VisualDatabaseCellRef): {
  expression: string;
  cache: string;
  provenance: string;
} {
  const identity = `${encodeURIComponent(ref.recordRef)}::${encodeURIComponent(ref.fieldRef)}`;
  return {
    expression: `visual-database.cell-expression::${identity}`,
    cache: `visual-database.cell-cache::${identity}`,
    provenance: `visual-database.cell-provenance::${identity}`,
  };
}

/** Canonical wire projection for addressed source truth. TypeScript member
 * names never leak into the closed v2 JSON schema, and absent optional members
 * are omitted rather than serialized as unstable `undefined` values. */
export function visualDatabaseValueExpressionPayload(
  expression: VisualDatabaseValueExpression,
): Record<string, unknown> {
  if (Object.prototype.hasOwnProperty.call(expression, 'literal')) {
    return { literal: expression.literal };
  }
  const derive = expression.derive;
  if (!derive) return {};
  return {
    derive: {
      target: derive.target,
      ...(derive.evaluatorRef ? { evaluator_ref: derive.evaluatorRef } : {}),
      ...(derive.request ? { request: derive.request } : {}),
      ...(derive.resultPath ? { result_path: derive.resultPath } : {}),
      ...(derive.dependencyRefs ? {
        dependency_refs: derive.dependencyRefs.map((dependency) => ({
          record_ref: dependency.recordRef,
          field_ref: dependency.fieldRef,
          ...(dependency.contextKey ? { context_key: dependency.contextKey } : {}),
        })),
      } : {}),
      ...(derive.dependencySelector ? { dependency_selector: derive.dependencySelector } : {}),
      ...(derive.cachePath ? { cache_path: derive.cachePath } : {}),
      ...(derive.persist !== undefined ? { persist: derive.persist } : {}),
    },
  };
}

/** Assemble independent addressed writes for a caller-ready cell. Absent
 * projection values are deliberately not fabricated; callers may update only
 * source, only cache, or only provenance in one atomic batch. */
export function buildAddressedCellValueWrites(values: AddressedCellValues): readonly AddressedWrite[] {
  const labels = addressedCellValueLabels(values.cellRef);
  const cell_ref = { record_ref: values.cellRef.recordRef, field_ref: values.cellRef.fieldRef };
  const writes: AddressedWrite[] = [];
  if (values.expression !== undefined) {
    writes.push({ addressLabel: labels.expression, payload: { cell_ref, expression: visualDatabaseValueExpressionPayload(values.expression), revision: values.revision }, ...(values.sourceExpectedCurrent !== undefined ? { expectedCurrent: values.sourceExpectedCurrent } : {}) });
  }
  if (values.cachedValue !== undefined) {
    const sourceRevisionGuard = values.cachedValue.sourceRevision
      ? { addressLabel: labels.expression, revision: values.cachedValue.sourceRevision }
      : undefined;
    writes.push({
      addressLabel: labels.cache,
      payload: {
        cell_ref,
        cached_value: {
          value: values.cachedValue.value,
          ...(values.cachedValue.revision ? { revision: values.cachedValue.revision } : {}),
          ...(values.cachedValue.sourceRevision ? { source_revision: values.cachedValue.sourceRevision } : {}),
          ...(values.cachedValue.observedAt ? { observed_at: values.cachedValue.observedAt } : {}),
        },
      },
      ...(values.cacheExpectedCurrent !== undefined ? { expectedCurrent: values.cacheExpectedCurrent } : {}),
      ...(sourceRevisionGuard ? { sourceRevisionGuard } : {}),
    });
  }
  if (values.provenance !== undefined) {
    const sourceRevisionGuard = values.provenance.sourceRevision
      ? { addressLabel: labels.expression, revision: values.provenance.sourceRevision }
      : undefined;
    writes.push({
      addressLabel: labels.provenance,
      payload: {
        cell_ref,
        provenance_ref: values.provenance.ref,
        ...(values.provenance.revision ? { revision: values.provenance.revision } : {}),
        ...(values.provenance.sourceRevision ? { source_revision: values.provenance.sourceRevision } : {}),
        ...(values.provenance.evaluatorRef ? { evaluator_ref: values.provenance.evaluatorRef } : {}),
        ...(values.provenance.evaluatorTarget ? { evaluator_target: values.provenance.evaluatorTarget } : {}),
        ...(values.provenance.evaluatorRevision ? { evaluator_revision: values.provenance.evaluatorRevision } : {}),
        ...(values.provenance.policyRevision ? { policy_revision: values.provenance.policyRevision } : {}),
        ...(values.provenance.reads ? {
          reads: {
            variables: values.provenance.reads.variables.map((read) => ({
              binding_key: read.bindingKey,
              root_name: read.rootName,
              catalog_id: read.catalogId,
              record_ref: read.recordRef,
              field_ref: read.fieldRef,
              value_revision: read.valueRevision,
              ...(read.contextKey ? { context_key: read.contextKey } : {}),
              span: read.span
                ? {
                  start_utf16: read.span.startUtf16,
                  end_utf16: read.span.endUtf16,
                }
                : null,
            })),
            entities: values.provenance.reads.entities,
            specials: values.provenance.reads.specials,
            functions: values.provenance.reads.functions,
          },
        } : {}),
        ...(values.provenance.displayLabel ? { provenance_display_label: values.provenance.displayLabel } : {}),
      },
      ...(values.provenanceExpectedCurrent !== undefined ? { expectedCurrent: values.provenanceExpectedCurrent } : {}),
      ...(sourceRevisionGuard ? { sourceRevisionGuard } : {}),
    });
  }
  return writes;
}

// -----------------------------------------------------------------------------
// Descriptor-driven write assembly (RB-BE-002)
//
// Turning a field descriptor + value into the next payload is WRITE SEMANTICS,
// the inverse of read-data's decode. It lives here (do-work, the write owner),
// NOT in the UI: a surface that knew descriptor write-paths would become a
// second owner of record meaning. The UI supplies {descriptor, value}; this
// module produces the AddressedWrite. Generic — zero field vocabulary.
// -----------------------------------------------------------------------------

export function isPlainObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

export interface FieldWrite {
  descriptor: VisualDatabaseFieldDescriptor;
  value: unknown;
}

/** The descriptor's write path expressed relative to the payload object:
 *  explicit `writePath`, else the first read path rooted at 'payload', else the
 *  first read path re-rooted under 'payload'. Exported as the ONE SSOT for
 *  "where does this field live in the payload" — reused by the inspector bridge
 *  (record-inspection) so the read side (source.fieldPath) and the write side
 *  (buildRecordWrite) can never diverge. */
export function payloadFieldPath(descriptor: VisualDatabaseFieldDescriptor): readonly string[] | null {
  const raw = descriptor.writePath
    ?? descriptor.paths.find((path) => path[0] === 'payload')
    ?? (descriptor.paths[0] ? ['payload', ...descriptor.paths[0]] : null);
  if (!raw || raw.length === 0) return null;
  const path = raw[0] === 'payload' ? raw.slice(1) : [...raw];
  return path.length > 0 ? path : null;
}

/** Deep-set creating intermediate objects (path-copied). null/undefined deletes. */
function setPathValue(target: Record<string, unknown>, path: readonly string[], value: unknown): void {
  let current = target;
  for (let index = 0; index < path.length - 1; index += 1) {
    const part = path[index];
    const next = current[part];
    const child = isPlainObject(next) ? { ...next } : {};
    current[part] = child;
    current = child;
  }
  const last = path[path.length - 1];
  if (value === null || value === undefined) delete current[last];
  else current[last] = value;
}

/** Compose any number of field writes into one payload object (descriptor
 *  write-paths interpreted here). */
export function applyFieldWrites(payload: Record<string, unknown>, writes: readonly FieldWrite[]): void {
  for (const { descriptor, value } of writes) {
    const path = payloadFieldPath(descriptor);
    if (path) setPathValue(payload, path, value);
  }
}

export function clonePayloadValue<T>(value: T): T {
  if (typeof structuredClone === 'function') return structuredClone(value);
  if (Array.isArray(value)) return value.map(clonePayloadValue) as T;
  if (isPlainObject(value)) {
    return Object.fromEntries(
      Object.entries(value).map(([key, entry]) => [key, clonePayloadValue(entry)]),
    ) as T;
  }
  return value;
}

const inverses = new WeakMap<AddressedWrite, unknown>();

export function hasRecordWriteInverse(write: AddressedWrite): boolean {
  return inverses.has(write);
}

export function recordWriteInverse(write: AddressedWrite): unknown {
  return inverses.get(write);
}

/** Delete = null payload at the record's address (the log keeps history; the projection
 *  drops the row), with the record as it was kept as the undo inverse. */
export function buildRecordDeletion(record: VisualDatabaseRecord): AddressedWrite | null {
  const address = recordAddress(record);
  if (!address) return null;
  const write: AddressedWrite = { addressLabel: address, payload: null, pathLabels: PUBLISHED_RECORD_PATH };
  inverses.set(write, clonePayloadValue(recordPayload(record)));
  return write;
}

/** One record + N field writes → one batch entry (or null when read-only).
 *  Keeps the pre-write payload as the undo inverse (recorded once saved). */
export function buildRecordWrite(
  record: VisualDatabaseRecord,
  writes: readonly FieldWrite[],
  // CAS basis: the payload hash the caller read, so a stale write is rejected.
  expectedCurrent?: EngineExpectedCurrentValue | null,
): AddressedWrite | null {
  const address = recordAddress(record);
  const observedPayload = recordPayload(record);
  if (!address || !observedPayload) return null;
  // Never mutate the published feed object. Besides corrupting the UI's
  // canonical input, that would let an optimistic edit satisfy independent
  // feed settlement before the owner had actually published anything.
  const payload = clonePayloadValue(observedPayload);
  applyFieldWrites(payload, writes);
  const write: AddressedWrite = {
    addressLabel: address,
    payload,
    pathLabels: PUBLISHED_RECORD_PATH,
    ...(expectedCurrent === undefined ? {} : { expectedCurrent }),
  };
  // The undo inverse; it enters the history only once the writer has saved this write.
  inverses.set(write, clonePayloadValue(observedPayload));
  return write;
}
