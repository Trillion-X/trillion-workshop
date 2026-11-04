// packages/documents/read-data/normalize-feed-rows.ts
//
// L126 read-path shim. The `published-records` input now feeds the scoped
// `ca-content-pool-feed` (record_from_matching_records json_array), whose rows
// are shaped {record:{address,source_package},payload} — NOT the flat
// {address,payload} the raw aggregate cell_table projected. Normalize back to
// the flat shape at the single read site so EVERY downstream consumer (the
// readPublishedRecords folds AND optionSourceRecords) decodes identically,
// INDEPENDENT of the live `ui` package version (the currently-deployed ui's
// readPublishedRecords does not yet read the nested record.address, so relying
// on it would mis-extract the address as a fallback id). Non-scoped/flat rows
// pass through unchanged, so this is safe before and after the feed migration.

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

export function normalizeFeedRows(rows: unknown): unknown {
  if (!Array.isArray(rows)) return rows;
  return rows.map((row) => {
    if (
      isRecord(row) &&
      isRecord(row.record) &&
      typeof row.record.address === 'string' &&
      row.payload !== undefined
    ) {
      return {
        address: row.record.address,
        source_package: row.record.source_package,
        path: row.path,
        payload: row.payload,
      };
    }
    return row;
  });
}
