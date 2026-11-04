// packages/group/read-data/catalog-merge.ts
//
// THE generative primitive for "a board catalog is user-extensible DATA" (L069/L063). Every
// board catalog — markers, backgrounds, stamps, appearance presets, shortcuts — is a list of
// self-describing rows that should be EXTENSIBLE from `published-record` DATA, not frozen in a
// source const (Physics-vs-Society). Rather than write one bespoke `readXCatalog(records)` per
// catalog (marker/lens/inspection all did — duplication), this leaf owns the ONE merge:
//
//   built-in rows + DATA rows → effective catalog, where a DATA row whose id matches a built-in
//   OVERRIDES it in place and a new id APPENDS (Map insertion order = built-ins, then new).
//
// Adding a NEW catalog is a one-line `mergeCatalog(records, spec)` + a tiny row validator —
// ZERO new merge code (L100: the shared logic is written once). Pure, deterministic, no I/O.

/**
 * Safely parse an array of UNTRUSTED DATA rows: return `[]` for a non-array, skip any non-object
 * row (a stray null/primitive), and swallow a throwing `parseRow` so ONE malformed row never
 * crashes the whole read (fail-safe, L083). This is the shared core of every catalog / field-set
 * reader over user-authored published-records — write the guard ONCE (L063), so a hostile or
 * fat-fingered DATA row degrades to "that row is ignored", never "the board blanks".
 */
export function parseRows<T>(
  rows: unknown,
  parseRow: (row: Record<string, unknown>) => T | null,
): T[] {
  if (!Array.isArray(rows)) return [];
  const out: T[] = [];
  for (const row of rows) {
    if (typeof row !== 'object' || row === null) continue;
    try {
      const parsed = parseRow(row as Record<string, unknown>);
      if (parsed) out.push(parsed);
    } catch {
      // malformed row → skip it, keep the read alive
    }
  }
  return out;
}

export interface CatalogMergeSpec<T> {
  /** The `payload.kind` a published-record uses to carry THIS catalog's DATA rows. */
  readonly kind: string;
  /** The `payload[arrayKey]` array of raw rows. */
  readonly arrayKey: string;
  /** The stable identity of a row (built-in or parsed) — the override/append key. */
  readonly idOf: (item: T) => string;
  /** Validate + shape one untrusted DATA row → a typed row, or `null` to skip it. The catalog
   *  owns what a valid row is; this leaf never inspects row fields. */
  readonly parseRow: (row: Record<string, unknown>) => T | null;
  /** The built-in rows (the source const). Absent → a purely-DATA catalog. */
  readonly builtins?: readonly T[];
}

/**
 * The effective catalog = built-ins overlaid with well-formed DATA rows (override-by-id, else
 * append). Ignores records that aren't this catalog's kind and rows that fail `parseRow`.
 * Order-stable: built-ins first (in their order), overrides stay in place, new rows append.
 */
export function mergeCatalog<T>(
  records: ReadonlyArray<{ payload?: unknown }>,
  spec: CatalogMergeSpec<T>,
): T[] {
  const byId = new Map<string, T>();
  for (const b of spec.builtins ?? []) byId.set(spec.idOf(b), b);
  for (const record of records) {
    if (!record || typeof record !== 'object') continue; // a null/malformed envelope entry → skip, never crash
    const payload = record.payload as Record<string, unknown> | undefined;
    if (!payload || payload.kind !== spec.kind) continue;
    // Untrusted rows are parsed through the shared fail-safe `parseRows` (skips non-objects,
    // swallows a throwing parseRow), so one bad DATA row never wipes the catalog (L083).
    for (const parsed of parseRows(payload[spec.arrayKey], spec.parseRow)) {
      byId.set(spec.idOf(parsed), parsed);
    }
  }
  return [...byId.values()];
}
