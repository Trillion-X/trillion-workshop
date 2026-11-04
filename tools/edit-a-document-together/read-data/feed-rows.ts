// Normalizes scoped-sink feed rows to the aggregate row contract.
//
// The kind/address-scoped sink feeds (record_from_matching_records with
// `source.path: []`) emit `{record: {address, source_package}, payload}` rows;
// every reader in this package consumes the aggregate's `{address, payload}`
// shape. Normalizing at the feed boundary keeps ONE row contract for all
// readers regardless of which feed served them (L098 — the boundary
// translates, the consumers never learn the sink's internal shape).
export function normalizeFeedRows(raw: unknown): unknown[] {
  if (!Array.isArray(raw)) return [];
  return raw.map((row) => {
    if (typeof row !== 'object' || row === null) return row;
    const r = row as Record<string, unknown>;
    if (typeof r.address === 'string' || typeof r.record !== 'object' || r.record === null) return row;
    const record = r.record as Record<string, unknown>;
    return { address: record.address, payload: r.payload };
  });
}
