import { describe, expect, it } from 'vitest';
import { arrangeMatrix } from './arrange-matrix';
import type { MatrixItem } from './arrange-matrix';

// A 2×2 Eisenhower-style set: keyX = urgency (u0/u1), keyY = importance (i0/i1).
const item = (memberId: string, keyX: string, keyY: string, w = 100, h = 60): MatrixItem => ({ memberId, keyX, keyY, w, h });

describe('arrangeMatrix (cont.19 — the 2-facet cross-tab, the 2-D sibling of arrange-by-field)', () => {
  it('places each item in cell (col(keyX), row(keyY)); columns/rows are the sorted distinct keys', () => {
    const out = arrangeMatrix([
      item('a', 'u1', 'i1'), // urgent+important
      item('b', 'u0', 'i1'), // not-urgent+important
      item('c', 'u1', 'i0'), // urgent+not-important
      item('d', 'u0', 'i0'), // neither
    ], { cellGap: 20, cellPad: 10, minCellW: 120, minCellH: 80 });
    expect(out.colKeys).toEqual(['u0', 'u1']); // sorted
    expect(out.rowKeys).toEqual(['i0', 'i1']);
    // 4 items, 4 cells (2×2), no empty cell.
    expect(out.positions).toHaveLength(4);
    expect(out.cells).toHaveLength(4);
    // Column identity by x: u0 items (b,d) share the left column x; u1 items (a,c) the right.
    const px = Object.fromEntries(out.positions.map((p) => [p.memberId, p.x]));
    expect(px.b).toBe(px.d); // same column
    expect(px.a).toBe(px.c);
    expect(px.a).toBeGreaterThan(px.b); // u1 column is right of u0
    // Row identity by y: i0 items (c,d) share the top row y; i1 items (a,b) the (lower) row.
    const py = Object.fromEntries(out.positions.map((p) => [p.memberId, p.y]));
    expect(py.c).toBe(py.d);
    expect(py.a).toBe(py.b);
    expect(py.a).toBeGreaterThan(py.c); // i1 row below i0
  });

  it('columns share a uniform width and rows a uniform height (a real aligned cross-tab)', () => {
    // A wide item in one cell widens its WHOLE column; a tall item heightens its WHOLE row.
    const out = arrangeMatrix([
      item('wide', 'u0', 'i0', 300, 60),
      item('tall', 'u1', 'i1', 100, 200),
      item('n', 'u1', 'i0', 100, 60),
    ], { cellGap: 20, cellPad: 10 });
    const col = Object.fromEntries(out.cells.map((c) => [`${c.keyX}`, c.w]));
    const row = Object.fromEntries(out.cells.map((c) => [`${c.keyY}`, c.h]));
    // u0 column width reflects the 300px wide item (+2*pad); u1 the 100px items.
    expect(col.u0).toBeGreaterThan(col.u1);
    // i1 row height reflects the 200px tall item; i0 the 60px ones.
    expect(row.i1).toBeGreaterThan(row.i0);
    // Cells in the SAME column all report that column's width (uniform).
    const u0cells = out.cells.filter((c) => c.keyX === 'u0');
    expect(new Set(u0cells.map((c) => c.w)).size).toBe(1);
  });

  it('stacks multiple items in one cell as a mini row-major grid (maxPerRow)', () => {
    const out = arrangeMatrix([
      item('a', 'x', 'y', 80, 40), item('b', 'x', 'y', 80, 40),
      item('c', 'x', 'y', 80, 40), item('d', 'x', 'y', 80, 40),
    ], { maxPerRow: 2, itemGap: 10, cellPad: 5 });
    const p = Object.fromEntries(out.positions.map((x) => [x.memberId, x]));
    // Row 1: a,b side by side (same y, b right of a). Row 2: c,d wrap below.
    expect(p.a.y).toBe(p.b.y);
    expect(p.b.x).toBeGreaterThan(p.a.x);
    expect(p.c.y).toBeGreaterThan(p.a.y); // wrapped to row 2
    expect(p.c.x).toBe(p.a.x); // back to first column
  });

  it('reserves header bands and emits one axis region per column/row spanning the band', () => {
    const out = arrangeMatrix([item('a', 'u1', 'i1'), item('b', 'u0', 'i0')], {
      colHeaderBand: 40, rowHeaderBand: 60, originX: 0, originY: 0,
    });
    expect(out.colRegions).toHaveLength(2);
    expect(out.rowRegions).toHaveLength(2);
    // Column headers sit in the TOP band (y=originY, h=band) and start after the row band.
    for (const c of out.colRegions) { expect(c.y).toBe(0); expect(c.h).toBe(40); expect(c.x).toBeGreaterThanOrEqual(60); }
    // Row headers sit in the LEFT band (x=originX, w=band) and start below the column band.
    for (const r of out.rowRegions) { expect(r.x).toBe(0); expect(r.w).toBe(60); expect(r.y).toBeGreaterThanOrEqual(40); }
    // No band requested → no axis regions (zero-config default).
    expect(arrangeMatrix([item('a', 'u', 'i')]).colRegions).toEqual([]);
  });

  it('axis region counts total items in that whole column/row', () => {
    const out = arrangeMatrix([
      item('a', 'u1', 'i1'), item('b', 'u1', 'i0'), item('c', 'u1', 'i0'), // u1 column: 3 items
      item('d', 'u0', 'i1'), // u0 column: 1 item
    ], { colHeaderBand: 30 });
    const byKey = Object.fromEntries(out.colRegions.map((c) => [c.key, c.count]));
    expect(byKey.u1).toBe(3);
    expect(byKey.u0).toBe(1);
  });

  it('explicit colKeys/rowKeys give a fixed quadrant grid with VISIBLE empty cells (drop zones)', () => {
    // Only ONE item, but a full 2×2 Eisenhower asked for → all 4 quadrants exist, 3 empty.
    const out = arrangeMatrix([item('a', 'urgent', 'important')], {
      colKeys: ['not-urgent', 'urgent'], rowKeys: ['not-important', 'important'], colHeaderBand: 30, rowHeaderBand: 40,
    });
    expect(out.colKeys).toEqual(['not-urgent', 'urgent']); // explicit order preserved (NOT sorted)
    expect(out.rowKeys).toEqual(['not-important', 'important']);
    expect(out.cells).toHaveLength(4); // full 2×2 even with one item
    const occupied = out.cells.filter((c) => c.count > 0);
    expect(occupied).toHaveLength(1);
    expect(occupied[0]).toMatchObject({ keyX: 'urgent', keyY: 'important', count: 1 });
    expect(out.colRegions).toHaveLength(2); // both columns get a header even the empty one
    expect(out.rowRegions).toHaveLength(2);
  });

  it('an unlisted item key is appended after the explicit axis keys, sorted', () => {
    const out = arrangeMatrix([item('a', 'zeta', 'r'), item('b', 'urgent', 'r')], {
      colKeys: ['urgent'], rowKeys: ['r'],
    });
    expect(out.colKeys).toEqual(['urgent', 'zeta']); // explicit first, extra appended
  });

  it('degenerate shapes: 1×1 (all same cell), a missing key (→ the "" pile), and empty input', () => {
    // 1×1: everything in one cell, one column, one row.
    const one = arrangeMatrix([item('a', 'k', 'k'), item('b', 'k', 'k')], { maxPerRow: 3 });
    expect(one.colKeys).toEqual(['k']);
    expect(one.rowKeys).toEqual(['k']);
    expect(one.cells).toHaveLength(1);
    expect(one.cells[0].count).toBe(2);
    // A missing X key → the '' pile becomes its own (first, since '' sorts first) column.
    const miss = arrangeMatrix([item('a', '', 'i'), item('b', 'u', 'i')]);
    expect(miss.colKeys).toEqual(['', 'u']);
    // Empty input, no explicit axes → fully empty (no throw).
    expect(arrangeMatrix([])).toEqual({ positions: [], cells: [], colRegions: [], rowRegions: [], colKeys: [], rowKeys: [] });
  });

  it('every input item gets exactly one position (same memberId set, nothing dropped/duplicated)', () => {
    const items = [
      item('a', 'u1', 'i1'), item('b', 'u0', 'i1'), item('c', 'u1', 'i0'),
      item('d', 'u0', 'i0'), item('e', 'u1', 'i1'), item('f', '', ''),
    ];
    const out = arrangeMatrix(items);
    expect(out.positions.map((p) => p.memberId).sort()).toEqual(['a', 'b', 'c', 'd', 'e', 'f']);
  });
});

describe('arrangeMatrix red-team — untrusted geometry/opts/axes never poison or hang (cont.98 batch-35)', () => {
  const allFinite = (out: ReturnType<typeof arrangeMatrix>) => {
    for (const p of out.positions) if (!Number.isFinite(p.x) || !Number.isFinite(p.y)) return false;
    for (const c of out.cells) if (![c.x, c.y, c.w, c.h].every(Number.isFinite)) return false;
    return true;
  };

  it('a NaN/MAX_VALUE item dimension yields finite positions + cell geometry', () => {
    const items = [
      item('a', 'u1', 'i1', Number.NaN, 60),
      item('b', 'u0', 'i0', Number.MAX_VALUE, Number.NaN),
      item('c', 'u1', 'i0', 100, Number.POSITIVE_INFINITY),
    ];
    expect(allFinite(arrangeMatrix(items))).toBe(true);
  });

  it('a NaN opts numeric (cellPad/originX/itemGap) falls back to the default — positions stay finite', () => {
    const items = [item('a', 'u1', 'i1'), item('b', 'u0', 'i0')];
    const out = arrangeMatrix(items, { cellPad: Number.NaN, originX: Number.NaN, itemGap: Number.NaN, cellGap: Number.NaN });
    expect(allFinite(out)).toBe(true);
  });

  it('a hostile 5000-key explicit axis is capped (no O(cols x rows) hang / OOM)', () => {
    const big = Array.from({ length: 5000 }, (_, i) => `k${i}`);
    const out = arrangeMatrix([item('a', 'u1', 'i1')], { colKeys: big, rowKeys: big });
    expect(out.colKeys.length).toBeLessThanOrEqual(512);
    expect(out.rowKeys.length).toBeLessThanOrEqual(512);
    // one cell per capped (col x row) intersection — bounded, not 25,000,000
    expect(out.cells.length).toBeLessThanOrEqual(512 * 512);
  });
});
