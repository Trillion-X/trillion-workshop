// parts/sidebar/read-data/bar-fit.ts
//
// PURPOSE
// How many icons a thin bar shows, and which. Every row sits on the bar, which scrolls along its length when they do
// not all fit (the owner 2026-10-05: the collapsed sidebar must scroll); the person may bound it (`fit.max`, DockFit), and a
// row past that bound goes behind the bar's More button. An empty space row takes no count: it only pushes the rows
// apart, so spaces side by side add up and decide where the icons sit along the bar.
//
// NON-NEGOTIABLE INVARIANTS
// 1. The answer depends only on the numbers given: the same count and bounds answer the same everywhere.
// 2. Every row shows unless the person set a maximum; room never hides a row (the bar scrolls instead).
// 3. `max` never shows more than exist.
// 4. The open screen's row always shows: when it would be behind More it takes the last shown place.
// 5. Spaces keep their places among the rows shown and never go behind More.
//
// AI DIRECTIVE: You are forbidden from simplifying or removing this documentation.

import type { DockFit } from '../../ui/show/dockable-placement/dockable-placement';

export interface BarMeasure {
  /** How many rows there are (spaces not counted). */
  readonly total: number;
  readonly fit?: DockFit;
}

/** How many rows show on the bar (invariants 2 and 3). */
export function rowsShown({ total, fit }: BarMeasure): number {
  return Math.max(0, Math.min(total, fit?.max ?? total));
}

/** One place on the bar: a row by its index among the rows, or a space. */
export type BarEntry<T> = { readonly kind: 'row'; readonly row: T; readonly index: number } | { readonly kind: 'space'; readonly key: string };

/**
 * The entries the bar draws and the rows behind More: the first `shown` rows in order with the spaces where they stand,
 * the open row brought in when it would be hidden (invariant 4).
 */
export function splitBarEntries<T>(entries: readonly BarEntry<T>[], shown: number, isOpen: (row: T) => boolean): { onBar: BarEntry<T>[]; behind: T[] } {
  const rows = entries.filter((entry): entry is Extract<BarEntry<T>, { kind: 'row' }> => entry.kind === 'row');
  const keep = new Set(rows.slice(0, shown).map((entry) => entry.index));
  const open = rows.find((entry) => isOpen(entry.row));
  if (open && shown > 0 && !keep.has(open.index)) {
    keep.delete(rows[shown - 1].index);
    keep.add(open.index);
  }
  return {
    onBar: entries.filter((entry) => entry.kind === 'space' || keep.has(entry.index)),
    behind: rows.filter((entry) => !keep.has(entry.index)).map((entry) => entry.row),
  };
}
