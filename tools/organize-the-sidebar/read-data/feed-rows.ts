// packages/group/read-data/feed-rows.ts
//
// Normalizes scoped-sink feed rows to the aggregate row contract.
//
// The board's action-affordance / preset / placeable-surface reads used to
// subscribe to the shared `published-records` aggregate — a cell_table projection
// that re-delivers + re-parses the ENTIRE studio's ~28k published records (tens of
// MB) on the main thread every time the board opens, starving the engine queue so
// the board's own targeted note reads (store.load) hang on "Loading your board…".
//
// The fix (proven pattern, mirrors screen-arrangement + documents): a
// scoped `record_from_matching_records` sink (`package::group::group-owned-feed`)
// delivers ONLY the board's own records. Those `record_from_matching_records` rows
// arrive as `{record: {address, source_package}, payload}`, whereas every reader
// consumes the aggregate's `{address, payload}` shape. Normalizing at the feed
// boundary keeps ONE row contract for all readers regardless of which feed served
// them (L098 — the boundary translates; consumers never learn the sink's shape).
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
