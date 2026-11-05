// packages/group/read-data/report-row-select.ts
//
// REPORT-ROW BULK SELECTORS — the analysis→action bridge, generalized from "click ONE group" to "select every
// group that matches a rule". `board-report`'s `reportSelect` already unions the cards of the rows a PREDICATE
// keeps, but that predicate was a raw function only callable from code. This is the DATA catalog of the useful
// predicates so a blind UI can offer them: a card in tags averaging under the board mean, the single strongest
// group, the groups with no measured value. Each selector is a DATA row (`id` + `label` + `select`) — the panel
// names none of them (L090/enum-dissolution); adding "median-above" or "bottom 3" is one more row, zero UI code.
//
// The thresholds are DERIVED FROM THE DATA (the mean of the measured values), never a free-typed number — so the
// control needs no numeric input and the same selector works for progress (0..1), word counts, or deadlines
// alike. Operates on the already-computed `ReportRow[]` (post-reduction, pre-sorted), so "highest" is a slice.
// Pure + deterministic.

import type { ReportRow } from './board-report.ts';

/** One bulk selector: a stable id, a human label, and a pure picker over the report's rows. `select` returns the
 *  KEPT rows (full-list context, so rank-based selectors like "highest" work); the caller unions their cardIds. */
export interface RowSelectorDef {
  readonly id: string;
  readonly label: string;
  readonly select: (rows: readonly ReportRow[]) => readonly ReportRow[];
}

/** The mean of the measured (non-null) row values, or null when no row carried a value (nothing to average). */
export function measuredMean(rows: readonly ReportRow[]): number | null {
  const vals = rows.map((r) => r.value).filter((v): v is number => v !== null);
  return vals.length === 0 ? null : vals.reduce((a, b) => a + b, 0) / vals.length;
}

/** The built-in bulk-selector capability pack — DATA the UI folds into buttons. Owner wiring may inject its own. */
export const ROW_SELECTORS: readonly RowSelectorDef[] = [
  // The single strongest group — the TRUE max by value, not the positional first row (census/pivot arrive
  // sorted desc, but a histogram arrives in BUCKET order with zero-filled buckets, so slicing [0] would pick
  // the first/empty bucket, not the biggest — Codex convergence 2026-07-09 finding 2). Skips unmeasured rows.
  { id: 'highest', label: 'Highest', select: (rows) => {
    const measured = rows.filter((r) => r.value !== null);
    if (measured.length === 0) return [];
    return [measured.reduce((a, b) => ((b.value as number) > (a.value as number) ? b : a))];
  } },
  // Every measured group at or above the board's average — "which tags are pulling their weight".
  { id: 'above-avg', label: 'Above average', select: (rows) => {
    const m = measuredMean(rows);
    return m === null ? [] : rows.filter((r) => r.value !== null && r.value >= m);
  } },
  // Every measured group below the board's average — the drag, the ones to act on.
  { id: 'below-avg', label: 'Below average', select: (rows) => {
    const m = measuredMean(rows);
    return m === null ? [] : rows.filter((r) => r.value !== null && r.value < m);
  } },
  // Groups with NO measured value — cards that carry the dimension but not the measure (honest gap, never a 0).
  { id: 'unmeasured', label: 'Unmeasured', select: (rows) => rows.filter((r) => r.value === null) },
];

/** Look up a selector by id (null when unknown). */
export function rowSelectorById(id: string): RowSelectorDef | null {
  return ROW_SELECTORS.find((s) => s.id === id) ?? null;
}

/** The card ids of every report row the named selector keeps, deduped (a card in several kept groups counts once,
 *  first-seen order). Unknown selector → []. The bulk analysis→action bridge: one report + one rule → a selection. */
export function reportRowSelection(rows: readonly ReportRow[], selectorId: string): string[] {
  const def = rowSelectorById(selectorId);
  if (!def) return [];
  const ids = new Set<string>();
  for (const row of def.select(rows)) for (const id of row.cardIds) ids.add(id);
  return [...ids];
}
