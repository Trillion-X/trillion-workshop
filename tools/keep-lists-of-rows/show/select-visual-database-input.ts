//
// Per-surface board input selection — the multi-board-by-DATA primitive.
//
// visual-database's mount reads four global inputs (`records` / `fields` / `views`
// / `actions`). That is ONE board per app. A product that wants a SECOND
// independent board (its own fields/views — a mental check-in, an NPS survey, a
// custom pipeline) needs each mount to be able to supply its OWN board DATA
// without clobbering the shared global surface. This is the generic per-mount
// input-selection primitive for the four visual-database inputs, each
// independently overridable.
//
// A mount may pass a `surfaceInput` carrier object holding any of `records` /
// `fields` / `views` / `actions`. Each key it CARRIES is this instance's SSOT
// (the global input is not read for that key); each key it OMITS falls back to
// the global read. `null` / `{}` / a non-carrier / a non-object → all global —
// the host threads `null`/`{}` for ordinary mounts and those must NEVER blank a
// board. Zero visual-database code per new board: adding a board is DATA.

export function selectVisualDatabaseInput(surfaceInput: unknown, key: string, globalRaw: unknown): unknown {
  if (surfaceInput && typeof surfaceInput === 'object' && !Array.isArray(surfaceInput)) {
    const carrier = surfaceInput as Record<string, unknown>;
    if (Object.prototype.hasOwnProperty.call(carrier, key)) return carrier[key];
  }
  return globalRaw;
}
