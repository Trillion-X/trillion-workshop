// packages/business-event/read-data/field-path.ts
//
// =============================================================================
// PURPOSE — the ONE machine-readable field-path primitive for the spine
// =============================================================================
//
// A `FieldPath` is an ARRAY of keys, never a dotted string: a dumb reader walks
// it with zero parsing (CLAUDE.md machine-readable rule — no `"a.b.c"` string
// surgery, no escaping of keys that contain dots). `readPath` is the single,
// canonical walk used by EVERY consumer that resolves a value out of a record
// (the mapper, the ledger rollup, the funnel projection, any future read-model).
//
// SSOT (L030/L069): this used to be copy-pasted in `map-to-business-event.ts`
// and `read-business-event-ledger.ts`. Two identical bodies = two sources of
// truth that can silently diverge. The moment a third consumer (the funnel
// projection) needed the same walk, the duplication was extracted to here so
// there is exactly ONE definition. A bug fixed here is fixed everywhere.
// =============================================================================

/** A machine-readable path into a record — an array of keys, never a dotted
 *  string. A dumb reader walks it with zero parsing. */
export type FieldPath = readonly string[];

/**
 * Walk a `FieldPath` into an arbitrary record. Returns `undefined` the instant
 * any step is missing or steps into a non-object — never throws, so callers
 * decide (fail-closed or fall back) without try/catch. Pure, no I/O.
 */
export function readPath(record: unknown, path: FieldPath): unknown {
  let cursor: unknown = record;
  for (const key of path) {
    if (cursor == null || typeof cursor !== 'object') return undefined;
    cursor = (cursor as Record<string, unknown>)[key];
  }
  return cursor;
}
