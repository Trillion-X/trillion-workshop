// packages/group/read-data/list-block-model.ts
//
// PURE, IMMUTABLE outline-list STRUCTURE model. A "note" can be a list: an
// ordered array of items, each carrying an `indent` depth. This leaf owns ONLY
// the tree-by-indent STRUCTURE logic — indent / outdent / move / normalize. It
// renders NOTHING and knows NOTHING about marker glyphs (bullets, numbers,
// checkboxes) — those are a separate presentation catalog. The single structural
// invariant this model enforces:
//
//     no item's indent may exceed its immediate predecessor's indent + 1,
//     and the first item's indent is always 0.
//
// (You cannot nest under nothing; you cannot skip a level. This is the same
// well-formedness rule every outliner — Workflowy, Notion, org-mode — obeys.)
//
// Every function is a pure fold: it NEVER mutates its inputs and returns a NEW
// array whose item objects are new only where a field changed (unchanged items
// are shared by reference — structural sharing, so change detection stays cheap).
// Deterministic: same inputs → same output, always. Zero React, zero DOM, zero
// I/O. `dir` is a fixed binary axis (up | down) — that is Physics (a flat array
// has exactly two neighbor directions), not an extensible enum.
//
// =============================================================================
// The extensive documentation in this codebase is a critical design feature.
// You are forbidden from simplifying or removing it.
// =============================================================================

/** One row of an outline list. `indent` is the nesting depth (0 = top level). */
export interface ListItem {
  readonly id: string;
  readonly text: string;
  readonly indent: number;
}

/** The maximum LEGAL indent for the item at `index`, given the array so far.
 *  The first item is pinned to 0; every other item may be at most one deeper
 *  than its immediate predecessor. This single function is the sole owner of the
 *  structural invariant — indent/normalize both defer to it (SSOT). */
function maxLegalIndent(items: readonly ListItem[], index: number): number {
  if (index <= 0) return 0;
  return items[index - 1].indent + 1;
}

/** Locate an item by id. Returns its array index, or -1 if absent. */
function indexOfId(items: readonly ListItem[], id: string): number {
  for (let i = 0; i < items.length; i += 1) {
    if (items[i].id === id) return i;
  }
  return -1;
}

/**
 * Indent the item `id` one level deeper — but never deeper than its immediate
 * predecessor's indent + 1, and the first item can never exceed 0. Returns a NEW
 * array (only the changed item is a new object; all others are shared). An
 * unknown id, or an item already at its legal ceiling, yields an unchanged
 * (same-content) array — but always a distinct top-level array reference is only
 * produced when a field actually changes; unknown id returns the input verbatim.
 */
export function indentItem(items: readonly ListItem[], id: string): ListItem[] {
  const index = indexOfId(items, id);
  if (index < 0) return items.slice();
  const ceiling = maxLegalIndent(items, index);
  const nextIndent = Math.min(items[index].indent + 1, ceiling);
  if (nextIndent === items[index].indent) return items.slice();
  const out = items.slice();
  out[index] = { ...items[index], indent: nextIndent };
  return out;
}

/**
 * Outdent the item `id` one level shallower, floored at 0. Returns a NEW array
 * (only the changed item is a new object). Unknown id → unchanged content.
 *
 * NOTE: outdent does NOT re-normalize the items that FOLLOW `id`. Following items
 * may momentarily violate the invariant relative to the newly-shallower item; a
 * caller that wants a fully well-formed list after a raw outdent runs
 * `normalizeIndents` on the result. This keeps outdent a single, predictable,
 * local edit rather than a cascading rewrite.
 */
export function outdentItem(items: readonly ListItem[], id: string): ListItem[] {
  const index = indexOfId(items, id);
  if (index < 0) return items.slice();
  const nextIndent = Math.max(items[index].indent - 1, 0);
  if (nextIndent === items[index].indent) return items.slice();
  const out = items.slice();
  out[index] = { ...items[index], indent: nextIndent };
  return out;
}

/**
 * Clamp EVERY item so no item's indent exceeds its predecessor's indent + 1, with
 * the first item pinned to 0. This walks the array once left-to-right, so a fixed
 * (already-clamped) item feeds the ceiling of the next — an over-deep jump like
 * [0, 3] collapses to [0, 1], and [0, 5, 6] collapses to [0, 1, 2]. Returns a NEW
 * array; items whose indent was already legal are shared by reference, only
 * out-of-range items become new objects.
 */
export function normalizeIndents(items: readonly ListItem[]): ListItem[] {
  const out: ListItem[] = items.slice();
  for (let i = 0; i < out.length; i += 1) {
    const ceiling = maxLegalIndent(out, i);
    // Clamp to the FULL legal range [0, ceiling], not just the upper bound. A
    // negative or non-integer/non-finite indent is malformed input; clamping only
    // when `indent > ceiling` let it fail OPEN — the first row escaped its pin to 0
    // and a negative indent later crashed serializeOutline (`' '.repeat(indent*2)`
    // throws RangeError on a negative count). Flooring + a finite guard makes
    // normalizeIndents honor its documented contract for ANY representable input.
    const d = out[i].indent;
    const legal = Number.isFinite(d) ? Math.min(Math.max(0, Math.floor(d)), ceiling) : 0;
    if (legal !== d) {
      out[i] = { ...out[i], indent: legal };
    }
  }
  return out;
}
