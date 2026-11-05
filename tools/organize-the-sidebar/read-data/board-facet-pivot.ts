// packages/group/read-data/board-facet-pivot.ts
//
// FACET PIVOT — the L069 generalization of "group the cards by some dimension, then AGGREGATE a number per
// group". `board-facet-census` (b166) answers "HOW MANY cards per tag/colour/kind"; this answers "what is the
// AVERAGE progress per tag", "the TOTAL effort per person", "the LATEST deadline per kind" — the pivot-table /
// GROUP-BY-aggregate every spreadsheet has. It owns NO dimension, NO measure, and NO aggregation rule: all
// three are INJECTED capabilities selected by DATA.
//
//   groupBy : FacetExtract          — reuse any board facet extractor (tags, colour, kind, mention…)
//   measure : BoardMeasure          — the number to read off a card (progress, effort, dueDate…), or null
//   agg     : Aggregator            — how to reduce a group's measured values (a DATA row, never a switch)
//
// The AGGREGATORS list is a capability PACK (sum/mean/max/min/count) — a DATA registry the engine names none
// of; owner wiring may inject its own reducer. This is enum-dissolution: adding "median" is one row, zero
// engine change. `facetPivot` reduces to `facetCensus` when measure≡1 and agg≡sum (proof it GENERALISES the
// census, not duplicates it).
//
// The DELETION TEST: delete the avg-progress-per-tag + latest-deadline export rows that call this; the engine
// still pivots any (dimension × measure × aggregator) combination dropped in as DATA — e.g. max-votes-per-
// colour — zero engine change. That is the primitive vs an instance solution (a hand-rolled
// `avgProgressPerTag(items)` would be clay for exactly one triple). Pure, deterministic (sorted by result
// desc with unmeasured groups last, then value A→Z), connector/furniture excluded.

import type { BoardItem } from './group-board-model.ts';
import { itemIsConnector } from './group-board-model.ts';
import { itemIsBoardFurniture } from '../do-work/batch-actions.ts';
import type { FacetExtract } from './board-facet-census.ts';

/** A numeric measure read off a card, or null when the card doesn't carry it (excluded from the aggregate —
 *  a card with no due date does not drag a MAX-deadline pivot, it simply isn't measured). */
export type BoardMeasure = (item: BoardItem) => number | null;

/** How to reduce a group's measured values to one number. Injected as a DATA row — the engine never switches
 *  on an aggregation name (enum-dissolution). `reduce` is only ever called with a NON-EMPTY array. */
export interface Aggregator {
  readonly id: string;
  readonly label: string;
  readonly reduce: (values: readonly number[]) => number;
}

/** The built-in aggregator capability pack — a DATA registry selectable by id. Owner wiring may inject its
 *  own (median, p95, …); the pivot engine names none of these. */
export const AGGREGATORS: readonly Aggregator[] = [
  { id: 'sum', label: 'Total', reduce: (v) => v.reduce((a, b) => a + b, 0) },
  { id: 'mean', label: 'Average', reduce: (v) => v.reduce((a, b) => a + b, 0) / v.length },
  { id: 'max', label: 'Max', reduce: (v) => v.reduce((a, b) => (b > a ? b : a), v[0]) },
  { id: 'min', label: 'Min', reduce: (v) => v.reduce((a, b) => (b < a ? b : a), v[0]) },
  { id: 'count', label: 'Count', reduce: (v) => v.length },
];

/** Look up an aggregator by id (null when unknown). */
export function aggregatorById(id: string): Aggregator | null {
  return AGGREGATORS.find((a) => a.id === id) ?? null;
}

/** One pivot group: a facet value, the cards in it, how many carried the measure, and the aggregate. */
export interface PivotRow {
  readonly value: string;
  /** distinct content cards in this group (whether or not they carried the measure). */
  readonly cardCount: number;
  /** how many of those cards carried a non-null measure (the aggregate's sample size). */
  readonly measured: number;
  /** the aggregator over the measured values, or null when NO card in the group carried the measure. */
  readonly result: number | null;
  readonly cardIds: readonly string[];
}

/** Content card = not a connector and not generated furniture (only these carry a facet + a measure). */
function contentCards(items: readonly BoardItem[]): BoardItem[] {
  return items.filter((i) => !itemIsConnector(i) && !itemIsBoardFurniture(i));
}

/**
 * Pivot a board: group the content cards by the injected `groupBy` dimension (a card in N values joins N
 * groups, like the census), aggregate each group's non-null `measure` values with `agg`. A group whose cards
 * carried no measure reports `result: null` (honest — never a fake 0). Sorted result-desc (nulls last), then
 * value A→Z. Pure, deterministic. Empty when no card imposes a group value.
 */
export function facetPivot(
  items: readonly BoardItem[],
  groupBy: FacetExtract,
  measure: BoardMeasure,
  agg: Aggregator,
): PivotRow[] {
  const ids = new Map<string, string[]>();
  const vals = new Map<string, number[]>();
  for (const card of contentCards(items)) {
    const m = measure(card);
    const seen = new Set<string>(); // a card counts once per distinct group value it carries
    for (const value of groupBy(card)) {
      if (seen.has(value)) continue;
      seen.add(value);
      (ids.get(value) ?? ids.set(value, []).get(value)!).push(card.memberId);
      if (m !== null && Number.isFinite(m)) (vals.get(value) ?? vals.set(value, []).get(value)!).push(m);
    }
  }
  return [...ids.entries()]
    .map(([value, cardIds]) => {
      const measured = vals.get(value) ?? [];
      return {
        value,
        cardCount: cardIds.length,
        measured: measured.length,
        result: measured.length > 0 ? agg.reduce(measured) : null,
        cardIds,
      };
    })
    .sort((a, b) => {
      if (a.result === null && b.result === null) return a.value.localeCompare(b.value);
      if (a.result === null) return 1; // unmeasured groups sink to the bottom
      if (b.result === null) return -1;
      return b.result - a.result || a.value.localeCompare(b.value);
    });
}

/** Format a pivot as a markdown readout. `formatValue` (DATA) renders the aggregate in its own units — a
 *  percent, a duration, a date — so the engine stays blind to what the number MEANS (L090); default is a
 *  trimmed number. A group with no measured card shows "—". */
export function facetPivotText(
  items: readonly BoardItem[],
  groupBy: FacetExtract,
  measure: BoardMeasure,
  agg: Aggregator,
  heading: string,
  formatValue: (n: number) => string = (n) => String(Math.round(n * 100) / 100),
): string {
  const rows = facetPivot(items, groupBy, measure, agg);
  if (rows.length === 0) return `## ${heading}\n\n_none_`;
  const lines = rows.map((r) => {
    const val = r.result === null ? '—' : formatValue(r.result);
    return `- ${r.value} — ${val} (${r.measured}/${r.cardCount} ${r.cardCount === 1 ? 'card' : 'cards'})`;
  });
  return `## ${heading}\n\n${lines.join('\n')}`;
}
