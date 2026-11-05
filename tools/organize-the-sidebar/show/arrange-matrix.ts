// packages/group/show/arrange-matrix.ts
//
// The arrange-MATRIX leaf — pure, zero I/O, framework-agnostic. The 2-D sibling of
// `arrange-by-field` (which clusters items 1-D by ONE precomputed `groupKey` and stacks the
// clusters vertically). Here each item carries TWO precomputed keys — `keyX` (its column facet)
// and `keyY` (its row facet) — and lands in cell (columnOf(keyX), rowOf(keyY)) of a cross-tab
// grid, with a column-header band across the top and a row-header band down the left.
//
// The caller decides WHAT the two facets are (tag × colour, marker × kind, urgent × important,
// effort × impact, …) and precomputes keyX/keyY; this leaf is blind to that meaning and MUST
// NEVER enumerate any facet kind (L090 — self-describing data, generic handler). ONE geometry
// engine → every 2-facet board (Eisenhower / effort×impact / status×assignee / …) emerges from
// DATA, zero new code per matrix (L069). Pure so the geometry is unit-tested; the panel holds the
// React state and applies the returned positions + drops the header labels.

import type { ArrangedPosition } from './arrange-by-field.ts';
import { finiteCoord } from '../read-data/finite-coord.ts';

// A cross-tab over UNTRUSTED explicit axis lists (`opts.colKeys`/`rowKeys` from a saved matrix lens)
// would otherwise run Pass-1/Pass-3 at O(cols x rows) — a hostile 100k x 100k lens hangs the render
// and allocates 1e10 cell regions. No real matrix exceeds this; the axes are capped so the grid is
// always bounded. (Item-derived keys are already board-bounded; this only fences the explicit lists.)
const MAX_AXIS = 512;

export interface MatrixItem {
  readonly memberId: string;
  readonly w: number;
  readonly h: number;
  readonly keyX: string; // column facet key ('' = the no-value pile)
  readonly keyY: string; // row facet key ('' = the no-value pile)
}

/** One matrix cell's bounding box + the raw axis keys it sits at + its item count. Geometry only —
 *  carries RAW keys, never a human label or facet vocabulary (L090). */
export interface MatrixCellRegion {
  readonly keyX: string;
  readonly keyY: string;
  readonly x: number;
  readonly y: number;
  readonly w: number;
  readonly h: number;
  readonly count: number;
}

/** One axis header region — a column header (across the top band) or a row header (down the left
 *  band). `key` = the raw axis key; `count` = total items in that whole column/row. */
export interface MatrixAxisRegion {
  readonly key: string;
  readonly x: number;
  readonly y: number;
  readonly w: number;
  readonly h: number;
  readonly count: number;
}

export interface MatrixLayout {
  readonly positions: ArrangedPosition[]; // exactly one per input item (same memberId set)
  readonly cells: MatrixCellRegion[]; // one per (column × row) intersection, row-major
  readonly colRegions: MatrixAxisRegion[]; // one per distinct column key (top header band)
  readonly rowRegions: MatrixAxisRegion[]; // one per distinct row key (left header band)
  readonly colKeys: string[]; // resolved column order
  readonly rowKeys: string[]; // resolved row order
}

export interface ArrangeMatrixOptions {
  readonly cellPad?: number; // inner padding inside every cell (default 16)
  readonly itemGap?: number; // gap between items packed within a cell (default 16)
  readonly cellGap?: number; // gap between adjacent cells (default 24)
  readonly originX?: number; // top-left of the whole matrix (default 0)
  readonly originY?: number; // (default 0)
  readonly colHeaderBand?: number; // px reserved at the TOP for column headers (default 0 → none)
  readonly rowHeaderBand?: number; // px reserved at the LEFT for row headers (default 0 → none)
  readonly maxPerRow?: number; // items per row within a single cell (default 3)
  readonly minCellW?: number; // floor width for a (possibly empty) column so it stays visible (default 120)
  readonly minCellH?: number; // floor height for a (possibly empty) row (default 80)
  // EXPLICIT AXES (like `arrange-by-field`'s laneKeys): when given, columns/rows appear in THIS
  // order, EVERY listed key gets an axis region + cells even with zero items (a visible empty
  // cell / drop zone — the Eisenhower quadrant that happens to be empty still shows), and any item
  // key not listed is appended after, sorted. Omit → sorted-by-present-keys (zero-config default).
  readonly colKeys?: readonly string[];
  readonly rowKeys?: readonly string[];
}

/** Row-major pack of a cell's items into ≤`maxPerRow` columns; returns each item's offset RELATIVE
 *  to the cell's content origin plus the content bounding box (w×h). Deterministic — item order =
 *  input order. Empty → { offsets: [], w: 0, h: 0 }. The same packing `arrange-by-field` uses,
 *  extracted so a cell is just a mini grid. */
function packCell(
  items: readonly MatrixItem[],
  maxPerRow: number,
  itemGap: number,
): { offsets: Array<{ memberId: string; dx: number; dy: number }>; w: number; h: number } {
  const offsets: Array<{ memberId: string; dx: number; dy: number }> = [];
  let rowTop = 0;
  let colX = 0;
  let rowHeight = 0;
  let colInRow = 0;
  let maxRight = 0;
  for (const item of items) {
    // `item.w`/`item.h` are UNTRUSTED persisted geometry — a NaN poisons the cursor (`colX += NaN`
    // sticks NaN across the whole cell -> NaN offsets), a MAX_VALUE flings the pack to ~1e308. Clamp
    // both to finite board coords before they enter the cumulative pack math.
    const iw = finiteCoord(item.w);
    const ih = finiteCoord(item.h);
    if (colInRow === maxPerRow) {
      rowTop += rowHeight + itemGap;
      colX = 0;
      rowHeight = 0;
      colInRow = 0;
    }
    offsets.push({ memberId: item.memberId, dx: colX, dy: rowTop });
    if (colX + iw > maxRight) maxRight = colX + iw;
    colX += iw + itemGap;
    if (ih > rowHeight) rowHeight = ih;
    colInRow += 1;
  }
  return { offsets, w: maxRight, h: rowTop + rowHeight };
}

/** Resolve an axis order: explicit keys first (deduped, in order — even zero-item ones), then any
 *  extra present keys appended sorted ascending. No explicit list → present keys sorted ascending.
 *  Mirrors `arrange-by-field`'s lane-vs-sorted contract on BOTH axes. */
function resolveAxis(present: Set<string>, explicit?: readonly string[]): string[] {
  const sortAsc = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
  if (!explicit) return [...present].sort(sortAsc);
  const seen = new Set<string>();
  const ordered: string[] = [];
  for (const k of explicit) if (!seen.has(k)) (seen.add(k), ordered.push(k));
  const extra = [...present].filter((k) => !seen.has(k)).sort(sortAsc);
  return [...ordered, ...extra];
}

// Lay `items` into a cross-tab: distinct keyX → columns, distinct keyY → rows, each item in cell
// (col(keyX), row(keyY)) as a mini row-major grid. Columns share a UNIFORM width (the widest cell
// content in that column, floored by minCellW) and rows a uniform height, so the grid aligns like a
// real matrix. Returns { positions, cells, colRegions, rowRegions, colKeys, rowKeys }. Empty input
// with no explicit axes → all empty. Pure + deterministic (input order within a cell).
export function arrangeMatrix(items: readonly MatrixItem[], opts?: ArrangeMatrixOptions): MatrixLayout {
  // Every numeric opt is UNTRUSTED — `?? default` catches only null/undefined, so a hand-crafted NaN
  // (or MAX_VALUE) would flow into cumulative cell/position math and poison EVERY coordinate. Read
  // each through finiteCoord with the default as the non-finite fallback (NaN/±Infinity -> default).
  const cellPad = finiteCoord(opts?.cellPad ?? 16, 16);
  const itemGap = finiteCoord(opts?.itemGap ?? 16, 16);
  const cellGap = finiteCoord(opts?.cellGap ?? 24, 24);
  const originX = finiteCoord(opts?.originX ?? 0, 0);
  const originY = finiteCoord(opts?.originY ?? 0, 0);
  const colBand = opts?.colHeaderBand && opts.colHeaderBand > 0 ? finiteCoord(opts.colHeaderBand, 0) : 0;
  const rowBand = opts?.rowHeaderBand && opts.rowHeaderBand > 0 ? finiteCoord(opts.rowHeaderBand, 0) : 0;
  const maxPerRow = Math.max(1, Math.floor(finiteCoord(opts?.maxPerRow ?? 3, 3)));
  const minCellW = finiteCoord(opts?.minCellW ?? 120, 120);
  const minCellH = finiteCoord(opts?.minCellH ?? 80, 80);

  const empty: MatrixLayout = { positions: [], cells: [], colRegions: [], rowRegions: [], colKeys: [], rowKeys: [] };
  if (items.length === 0 && !opts?.colKeys && !opts?.rowKeys) return empty;

  // Bucket by cell, and collect present axis keys.
  const presentX = new Set<string>();
  const presentY = new Set<string>();
  const byCell = new Map<string, MatrixItem[]>();
  const cellKey = (x: string, y: string) => `${x}\u0000${y}`;
  for (const it of items) {
    presentX.add(it.keyX);
    presentY.add(it.keyY);
    const k = cellKey(it.keyX, it.keyY);
    const b = byCell.get(k);
    if (b) b.push(it);
    else byCell.set(k, [it]);
  }

  // Cap axis cardinality: an untrusted explicit `colKeys`/`rowKeys` (a saved matrix lens) could be
  // huge, and Pass-1/Pass-3 are O(cols x rows). MAX_AXIS bounds the grid so the render can't hang/OOM.
  const colKeys = resolveAxis(presentX, opts?.colKeys).slice(0, MAX_AXIS);
  const rowKeys = resolveAxis(presentY, opts?.rowKeys).slice(0, MAX_AXIS);
  if (colKeys.length === 0 || rowKeys.length === 0) return empty;

  // Pass 1: pack every occupied cell → its content box; track uniform column widths + row heights.
  const packed = new Map<string, ReturnType<typeof packCell>>();
  const colW = colKeys.map(() => minCellW);
  const rowH = rowKeys.map(() => minCellH);
  colKeys.forEach((cx, ci) => {
    rowKeys.forEach((ry, ri) => {
      const bucket = byCell.get(cellKey(cx, ry)) ?? [];
      if (bucket.length === 0) return;
      const p = packCell(bucket, maxPerRow, itemGap);
      packed.set(cellKey(cx, ry), p);
      const needW = p.w + cellPad * 2;
      const needH = p.h + cellPad * 2;
      if (needW > colW[ci]) colW[ci] = needW;
      if (needH > rowH[ri]) rowH[ri] = needH;
    });
  });

  // Pass 2: cumulative left/top of each column/row (after the header bands).
  const gridX0 = originX + rowBand;
  const gridY0 = originY + colBand;
  const colLeft: number[] = [];
  let cx = gridX0;
  colKeys.forEach((_, ci) => { colLeft.push(cx); cx += colW[ci] + cellGap; });
  const rowTop: number[] = [];
  let cy = gridY0;
  rowKeys.forEach((_, ri) => { rowTop.push(cy); cy += rowH[ri] + cellGap; });

  // Pass 3: emit positions + cell/axis regions.
  const positions: ArrangedPosition[] = [];
  const cells: MatrixCellRegion[] = [];
  const colCounts = colKeys.map(() => 0);
  const rowCounts = rowKeys.map(() => 0);
  colKeys.forEach((cxk, ci) => {
    rowKeys.forEach((ryk, ri) => {
      const bucket = byCell.get(cellKey(cxk, ryk)) ?? [];
      const p = packed.get(cellKey(cxk, ryk));
      if (p) {
        for (const off of p.offsets) {
          positions.push({ memberId: off.memberId, x: colLeft[ci] + cellPad + off.dx, y: rowTop[ri] + cellPad + off.dy });
        }
      }
      colCounts[ci] += bucket.length;
      rowCounts[ri] += bucket.length;
      cells.push({ keyX: cxk, keyY: ryk, x: colLeft[ci], y: rowTop[ri], w: colW[ci], h: rowH[ri], count: bucket.length });
    });
  });

  // Column headers span the top band across each column; row headers span the left band down each row.
  const colRegions: MatrixAxisRegion[] = colBand > 0
    ? colKeys.map((k, ci) => ({ key: k, x: colLeft[ci], y: originY, w: colW[ci], h: colBand, count: colCounts[ci] }))
    : [];
  const rowRegions: MatrixAxisRegion[] = rowBand > 0
    ? rowKeys.map((k, ri) => ({ key: k, x: originX, y: rowTop[ri], w: rowBand, h: rowH[ri], count: rowCounts[ri] }))
    : [];

  return { positions, cells, colRegions, rowRegions, colKeys, rowKeys };
}
