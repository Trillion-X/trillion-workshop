// packages/group/read-data/board-crosstab.ts
//
// CROSS-TAB — the 2-D completion of the reducer family: census (b166) counts cards per ONE bucket; pivot
// (b175) aggregates a measure per ONE bucket; this counts/aggregates per PAIR of buckets → a contingency
// matrix / heatmap (tags × colours, kind × progress-band, marker × status). It is NOT the spatial
// `arrangeByMatrixLabeled` (that MOVES cards into a grid); this COUNTS them into a table you read + export.
//
// Everything is injected, DATA-selected: two `FacetExtract` axes (any board facet, and — via `bucketFacet`,
// b176 — any continuous measure bucketed into bands), and an OPTIONAL (`measure` × `agg`) so a cell holds a
// COUNT (contingency table) or an AGGREGATE (mean progress per tag×colour). Reuses the `AGGREGATORS` registry
// (b175) — the engine names no aggregation. A card with multi-value axes contributes to each distinct (row,
// col) pair it forms (like the census's per-value counting), once. Row/col MARGINALS count a card once per
// distinct axis value (a 2-column card is one card in its row total, not two). Pure, deterministic; rows/cols
// ordered by marginal total desc then name; the cell grid is DENSE (every row×col, zeros included, so a
// heatmap has no holes). Owns no dimension/measure/aggregation (L069/L090/L093).

import type { BoardItem } from './group-board-model';
import { itemIsConnector } from './group-board-model';
import { itemIsBoardFurniture } from '../do-work/batch-actions';
import type { FacetExtract } from './board-facet-census';
import type { BoardMeasure, Aggregator } from './board-facet-pivot';

/** One cell of the matrix: the (row, col) pair, its cards, how many carried the measure, and the cell value. */
export interface CrossCell {
  readonly row: string;
  readonly col: string;
  /** distinct cards in this cell. */
  readonly count: number;
  /** how many of those carried a non-null measure (0 + all in count mode). */
  readonly measured: number;
  /** the cell's number: its `count` in COUNT mode; the aggregate over measured values in MEASURE mode, or
   *  null when no card in the cell carried the measure. */
  readonly value: number | null;
  readonly cardIds: readonly string[];
}

/** A full cross-tabulation: ordered row + col headers, a dense cell grid, and the marginal totals. */
export interface CrossTab {
  readonly rows: readonly string[];
  readonly cols: readonly string[];
  /** dense: exactly `rows.length × cols.length` cells, row-major. `cell(t, r, c)` is the ergonomic lookup. */
  readonly cells: readonly CrossCell[];
  /** distinct cards per row value (a card counts once per row value, regardless of how many cols it spans). */
  readonly rowTotals: ReadonlyMap<string, number>;
  readonly colTotals: ReadonlyMap<string, number>;
  /** distinct content cards that landed in at least one cell. */
  readonly total: number;
}

/** Content card = not a connector and not generated furniture (only these carry facets + a measure). */
function contentCards(items: readonly BoardItem[]): BoardItem[] {
  return items.filter((i) => !itemIsConnector(i) && !itemIsBoardFurniture(i));
}

// The cell key joins row+col with a NUL (\u0000, invisible above) — NOT a space — so a value containing
// a space cannot collide (row "a b"×col "c" vs row "a"×col "b c"), the same fix as the b168 pair key.
const key = (r: string, c: string): string => `${r}\u0000${c}`;

/**
 * Cross-tabulate a board over two facet axes. Without `measure`, each cell holds the card COUNT (a contingency
 * table); with `measure` + `agg`, each cell holds that aggregate over the cards' non-null measures (null when
 * none carried it — never a fake 0). Rows/cols are ordered by marginal total desc then name A→Z; the grid is
 * dense (every row×col). Pure, deterministic. Empty when no card produces any (row,col) pair.
 */
export function crossTab(
  items: readonly BoardItem[],
  rowFacet: FacetExtract,
  colFacet: FacetExtract,
  measure?: BoardMeasure,
  agg?: Aggregator,
): CrossTab {
  const cellIds = new Map<string, string[]>();
  const cellVals = new Map<string, number[]>();
  const rowIds = new Map<string, Set<string>>();
  const colIds = new Map<string, Set<string>>();
  const allCards = new Set<string>();

  for (const card of contentCards(items)) {
    const rowVals = [...new Set(rowFacet(card))];
    const colVals = [...new Set(colFacet(card))];
    if (rowVals.length === 0 || colVals.length === 0) continue;
    const m = measure ? measure(card) : null;
    for (const r of rowVals) (rowIds.get(r) ?? rowIds.set(r, new Set()).get(r)!).add(card.memberId);
    for (const c of colVals) (colIds.get(c) ?? colIds.set(c, new Set()).get(c)!).add(card.memberId);
    for (const r of rowVals) {
      for (const c of colVals) {
        const k = key(r, c);
        (cellIds.get(k) ?? cellIds.set(k, []).get(k)!).push(card.memberId);
        if (measure && m !== null && Number.isFinite(m)) (cellVals.get(k) ?? cellVals.set(k, []).get(k)!).push(m);
      }
    }
    allCards.add(card.memberId);
  }

  const order = (m: Map<string, Set<string>>): string[] =>
    [...m.entries()].sort((a, b) => b[1].size - a[1].size || a[0].localeCompare(b[0])).map(([v]) => v);
  const rows = order(rowIds);
  const cols = order(colIds);
  const rowTotals = new Map([...rowIds].map(([v, s]) => [v, s.size]));
  const colTotals = new Map([...colIds].map(([v, s]) => [v, s.size]));

  const cells: CrossCell[] = [];
  for (const r of rows) {
    for (const c of cols) {
      const k = key(r, c);
      const ids = cellIds.get(k) ?? [];
      const vals = cellVals.get(k) ?? [];
      const value = measure ? (vals.length > 0 ? agg!.reduce(vals) : null) : ids.length;
      cells.push({ row: r, col: c, count: ids.length, measured: vals.length, value, cardIds: ids });
    }
  }
  return { rows, cols, cells, rowTotals, colTotals, total: allCards.size };
}

/** The cell at (row, col), or null if either header is absent. O(cols) index into the dense grid. */
export function cell(tab: CrossTab, row: string, col: string): CrossCell | null {
  const r = tab.rows.indexOf(row);
  const c = tab.cols.indexOf(col);
  if (r < 0 || c < 0) return null;
  return tab.cells[r * tab.cols.length + c] ?? null;
}

/**
 * Render a cross-tab as a markdown table — a header row of col values, one row per row value with its cells,
 * and a trailing totals column/row (marginals). `formatValue` (DATA) renders each cell in its own units
 * (default: a trimmed number; a null cell → "·"), so the engine stays blind to what the number means (L090).
 */
export function crossTabText(
  items: readonly BoardItem[],
  rowFacet: FacetExtract,
  colFacet: FacetExtract,
  heading: string,
  opts: { measure?: BoardMeasure; agg?: Aggregator; formatValue?: (n: number) => string } = {},
): string {
  const tab = crossTab(items, rowFacet, colFacet, opts.measure, opts.agg);
  if (tab.rows.length === 0 || tab.cols.length === 0) return `## ${heading}\n\n_none_`;
  const fmt = opts.formatValue ?? ((n: number) => String(Math.round(n * 100) / 100));
  const cellStr = (v: number | null): string => (v === null ? '·' : fmt(v));
  const header = `| | ${tab.cols.join(' | ')} | **Total** |`;
  const divider = `| --- |${tab.cols.map(() => ' --- |').join('')} --- |`;
  const bodyRows = tab.rows.map((r) => {
    const cellsStr = tab.cols.map((c) => cellStr(cell(tab, r, c)!.value)).join(' | ');
    return `| **${r}** | ${cellsStr} | ${tab.rowTotals.get(r) ?? 0} |`;
  });
  const totalRow = `| **Total** | ${tab.cols.map((c) => tab.colTotals.get(c) ?? 0).join(' | ')} | ${tab.total} |`;
  return `## ${heading}\n\n${[header, divider, ...bodyRows, totalRow].join('\n')}`;
}
