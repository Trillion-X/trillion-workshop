// packages/ai-cli-launch-adapters/read-data/read-harness-controls.mjs
//
// T8 (Dynamic Stop Control), pure projection. Turns the live `harness-control`
// DATA rows into ordered control view-models. The renderer is generic over the
// rows (L090 self-describing-data + generic-handler): a new control (pause,
// escalate) is a new DATA row, zero renderer code. A control exists in the UI
// IFF its row exists, which is the whole point of the data-driven control.

/** Normalize the feed input (array, {records}, or {items}) into a rows array. */
export function harnessControlRows(source) {
  if (Array.isArray(source)) return source;
  if (source && Array.isArray(source.records)) return source.records;
  if (source && Array.isArray(source.items)) return source.items;
  return [];
}

/**
 * Project `harness-control` rows into ordered control view-models. Only
 * kind:'harness-control' rows that are active are projected; they sort by
 * `order` then `id` for a stable UI.
 */
export function projectHarnessControls(source) {
  const rows = harnessControlRows(source)
    .map((row) => (row && row.payload && row.payload.kind ? row.payload : row))
    .filter((row) => row && row.kind === 'harness-control' && row.is_active !== false);
  const controls = rows.map((row) => ({
    id: String(row.id ?? row.control ?? ''),
    control: String(row.control ?? ''),
    label: String(row.label ?? row.control ?? 'Control'),
    order: Number.isFinite(row.order) ? row.order : 1000,
    dispatch: row.dispatch ?? null,
  }));
  controls.sort((a, b) => (a.order - b.order) || a.id.localeCompare(b.id));
  return controls;
}
