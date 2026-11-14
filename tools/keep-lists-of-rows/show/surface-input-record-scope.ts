import {
  recordAddress,
  type VisualDatabaseModel,
} from '@/packages/visual-database/read-data/visual-database';

export interface VisualDatabaseRecordScope {
  readonly addresses: readonly string[];
  readonly kinds: readonly string[];
}

/** An instance may narrow the owner's editing permission, never widen it. */
export function visualDatabaseInstanceIsWritable(datasetWritable: unknown, input: unknown): boolean {
  return datasetWritable !== false && record(input)?.writable !== false;
}

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function strings(value: unknown): readonly string[] {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.filter((item): item is string => (
    typeof item === 'string' && item.trim().length > 0
  )).map((item) => item.trim()))];
}

function text(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined;
}

/**
 * Opaque surface DATA can narrow the already-owned record feed without
 * replacing it. Both filters compose when supplied: a visible row must match
 * an exact address AND a kind. The aliases retain compatibility with ordinary
 * camelCase React callers while `record_scope` remains the durable DATA form.
 */
export function visualDatabaseRecordScopeFromSurfaceInput(value: unknown): VisualDatabaseRecordScope | null {
  const input = record(value);
  if (!input) return null;
  const nested = record(input.record_scope ?? input.recordScope);
  const addresses = strings(
    nested?.addresses
      ?? input.record_addresses
      ?? input.recordAddresses,
  );
  const kinds = strings(
    nested?.kinds
      ?? input.record_kinds
      ?? input.recordKinds,
  );
  return addresses.length > 0 || kinds.length > 0 ? { addresses, kinds } : null;
}

export function scopedVisualDatabaseModel(
  model: VisualDatabaseModel,
  scope: VisualDatabaseRecordScope | null,
): VisualDatabaseModel {
  if (!scope) return model;
  const addresses = new Set(scope.addresses);
  const kinds = new Set(scope.kinds);
  return {
    ...model,
    records: model.records.filter((item) => (
      (addresses.size === 0 || addresses.has(recordAddress(item) ?? ''))
      && (kinds.size === 0 || kinds.has(item.kind))
    )),
  };
}

/** Latest-run evidence is a presentation cue, never a record mutation. */
export function latestRecordRefsFromSurfaceInput(value: unknown): readonly string[] {
  const input = record(value);
  return strings(
    input?.latest_record_refs
      ?? input?.latestRecordRefs
      ?? input?.highlighted_record_refs
      ?? input?.highlightedRecordRefs,
  );
}

export function initialViewIdFromSurfaceInput(value: unknown): string | undefined {
  const input = record(value);
  return text(input?.initial_view_id ?? input?.initialViewId);
}
