// packages/group/show/focus-view.ts
//
// =============================================================================
// PURPOSE — a NAMED SAVED FOCUS VIEW: a persisted, per-board focus filter selection.
// =============================================================================
//
// The board focus filter (`focusFacets: FacetSelection` + a free-text query) is transient VIEW
// state. A "saved view" (Miro/Mural canon) lets a user capture the current focus under a name and
// re-apply it later — "show me my #idea + Blue notes" as a one-click view. A FocusView is DISTINCT
// from the other three board catalogs (Codex-confirmed 4th kind): a COLLECTION saves ITEMS, an
// ARRANGEMENT saves a LAYOUT, an APPEARANCE-PRESET saves a LOOK — a FocusView saves a FILTER
// SELECTION (which items to spotlight).
//
// Persisted as a `focus-view-catalog` published-record, read+merged through the SAME shared
// `mergeCatalog` primitive every board catalog uses (ZERO new merge code, L063/L100). Because it
// is a real DATA store, it addresses the concerns generic filter-state cannot skip:
//   • BOARD SCOPE — each view carries the `boardId` it was saved on; `readFocusViews(records,
//     boardId)` filters to that board so views never leak between boards under one index.
//   • DELETE — `mergeCatalog` can only overlay/append, never remove; a deleted view is rewritten
//     at its OWN address with `active:false` (a tombstone) and the reader drops inactive rows.
//   • IMMUTABLE ID — the id is caller-supplied (not a name slug), so renaming a view keeps its
//     identity and two views may share a name.
//   • SCHEMA, not a TS alias — a `version` + a strict decoder (`parseFocusViewRow`) validate every
//     untrusted row (fail-safe, L083); `sanitizeFocusView` drops facet keys the board no longer
//     knows before applying (an unknown selected facet fails closed and would hide every item).
// =============================================================================

import type { FacetSelection } from '../read-data/facet-filter.ts';
import { mergeCatalog } from '../read-data/catalog-merge.ts';

/** The `payload.kind` a published-record uses to carry saved focus views. */
export const FOCUS_VIEW_CATALOG_KIND = 'focus-view-catalog';

/** The persisted schema version — bumped if the row shape ever changes (forward-compat decode). */
export const FOCUS_VIEW_SCHEMA_VERSION = 1;

/** A named, saved, per-board focus filter selection. */
export interface FocusView {
  /** Immutable identity (caller-supplied, NOT derived from the name). */
  readonly id: string;
  readonly name: string;
  /** The board this view was saved on — reads are scoped to it (no cross-board leak). */
  readonly boardId: string;
  readonly facets: FacetSelection;
  readonly query?: string;
  /** False = a tombstone (deleted). Absent/true = live. */
  readonly active?: boolean;
}

/** kebab-case a view name for a readable ADDRESS segment (empty → 'view'). Addresses key on the
 *  immutable id, not this — this is only cosmetic in the address string. */
export function focusViewSlug(name: string): string {
  const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  return slug || 'view';
}

/** Capture the current focus as a named, board-scoped view. Pure; `id` is caller-supplied (an
 *  immutable id from the panel), so renaming keeps identity. Empty facet keys + blank query drop. */
export function makeFocusView(id: string, name: string, boardId: string, facets: FacetSelection, query?: string): FocusView {
  // Object.create(null): `k` can be a `__proto__`/`constructor` facet key — on a plain object,
  // `clean['__proto__'] = [...]` invokes the prototype SETTER and corrupts the object. Null-proto
  // makes it a normal own property.
  const clean: Record<string, readonly string[]> = Object.create(null);
  for (const [k, vals] of Object.entries(facets)) if (vals.length > 0) clean[k] = [...vals];
  const trimmed = (query ?? '').trim();
  return { id, name: name.trim(), boardId, facets: clean, active: true, ...(trimmed ? { query: trimmed } : {}) };
}

/** Turn a view into its DELETE tombstone (same id/address, `active:false`) — the reader drops it. */
export function archiveFocusView(view: FocusView): FocusView {
  return { ...view, active: false };
}

/** A well-formed `Record<string, string[]>` (a FacetSelection from DATA), or null. */
function parseFacets(raw: unknown): FacetSelection | null {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return null;
  // Object.create(null): the JSON-parsed row can carry an OWN `__proto__` facet key (JSON.parse
  // creates it), and `out['__proto__'] = vals` on a plain object hits the prototype setter and
  // corrupts `out`. A null-proto accumulator stores every key as a plain own property.
  const out: Record<string, readonly string[]> = Object.create(null);
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    if (!Array.isArray(v)) return null;
    const vals = v.filter((x): x is string => typeof x === 'string');
    if (vals.length > 0) out[k] = vals;
  }
  return out;
}

/** Validate ONE untrusted DATA row → a FocusView, or null to skip it (fail-safe, L083). Reads the
 *  `is_active`/`active` tombstone flag (absent → live). `version` is read leniently (absent → v1). */
export function parseFocusViewRow(row: Record<string, unknown>): FocusView | null {
  const id = typeof row.id === 'string' ? row.id : '';
  const name = typeof row.name === 'string' ? row.name : '';
  const boardId = typeof row.boardId === 'string' ? row.boardId : '';
  if (!id || !name || !boardId) return null;
  const facets = parseFacets(row.facets);
  if (!facets) return null;
  const query = typeof row.query === 'string' && row.query.trim() ? row.query.trim() : undefined;
  const activeRaw = row.active ?? row.is_active;
  const active = activeRaw === false ? false : true;
  return { id, name, boardId, facets, active, ...(query ? { query } : {}) };
}

/**
 * The effective saved-view catalog for ONE board: the user's `focus-view-catalog` DATA rows,
 * merged through the shared `mergeCatalog` primitive (override-by-id — so a rewrite of a view
 * replaces it), then filtered to `boardId` and to LIVE rows (tombstones dropped).
 */
export function readFocusViews(records: ReadonlyArray<{ payload?: unknown }>, boardId: string): FocusView[] {
  const merged = mergeCatalog(records, {
    kind: FOCUS_VIEW_CATALOG_KIND,
    arrayKey: 'views',
    idOf: (v) => v.id,
    parseRow: parseFocusViewRow,
  });
  return merged.filter((v) => v.boardId === boardId && v.active !== false);
}

/** Drop facet keys the board no longer knows before applying a view — an unknown selected facet
 *  fails CLOSED in `matchesFacets` and would hide every item. `knownKeys` = the board's live facet
 *  keys (`BOARD_ITEM_FACETS` keys). The panel's per-value prune is a further backstop. */
export function sanitizeFocusView(view: FocusView, knownKeys: readonly string[]): FocusView {
  const known = new Set(knownKeys);
  // Object.create(null): same proto-setter guard — `view.facets` came from untrusted DATA, so a
  // surviving `__proto__` key must land as a plain own property, not corrupt the accumulator.
  const facets: Record<string, readonly string[]> = Object.create(null);
  for (const [k, vals] of Object.entries(view.facets)) if (known.has(k)) facets[k] = vals;
  return { ...view, facets };
}
