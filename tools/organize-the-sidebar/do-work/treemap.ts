// packages/group/do-work/treemap.ts
//
// SQUARIFIED TREEMAP — the generative primitive behind "size each item PROPORTIONAL to a value" (the
// treemap / proportion-map canon: the biggest tile is the highest-value item — most votes, most progress,
// most words). It is genuinely distinct from every board ARRANGE strategy (grid/masonry/pack/spiral/… all
// PRESERVE each item's own size and only move it); a treemap RESIZES every tile so AREA encodes a value, then
// packs them to fill a rectangle with near-square tiles. The requests "treemap by votes / by progress / by
// count / what's biggest" are all ONE computation configured by the injected `valueOf`.
//
// Algorithm: Bruls–Huizing–van Wijk SQUARIFIED treemap — greedily grow a row along the shorter side while the
// worst tile aspect ratio keeps improving; when the next tile would worsen it, close the row and recurse into
// the remaining rectangle. This yields compact, readable tiles (vs a naive slice-and-dice's slivers).
//
// Pure leaf — only the `finiteCoord` clamp SSOT. Deterministic (value DESC, stable index tie-break), zero I/O.
// The show/ overlay injects `valueOf` + renders the tiles; the value-source catalog lives there as DATA.

import { finiteCoord } from '../read-data/finite-coord.ts';

export interface TreemapBounds {
  readonly x: number;
  readonly y: number;
  readonly w: number;
  readonly h: number;
}

export interface TreemapTile {
  /** Index into the INPUT `values` array (so the caller maps a tile back to its item). */
  readonly index: number;
  readonly x: number;
  readonly y: number;
  readonly w: number;
  readonly h: number;
  /** The original (non-negative) value this tile encodes. */
  readonly value: number;
}

interface Cell {
  readonly index: number;
  readonly value: number;
  area: number;
}

/** worst() from the paper: the worst (largest) aspect ratio in a row of tile AREAS laid along `side`. */
function worstRatio(areas: readonly number[], side: number): number {
  if (areas.length === 0) return Infinity;
  let sum = 0;
  let max = 0;
  let min = Infinity;
  for (const a of areas) {
    sum += a;
    if (a > max) max = a;
    if (a < min) min = a;
  }
  const s2 = sum * sum;
  const side2 = side * side;
  if (s2 === 0) return Infinity;
  return Math.max((side2 * max) / s2, s2 / (side2 * min));
}

/**
 * Squarified treemap: `values` (index-aligned) → one {@link TreemapTile} per positive value, filling `bounds`
 * with AREA ∝ value. Non-positive / non-finite values are dropped (a tile with no value has no area). Empty /
 * all-zero → []. Deterministic (values sorted DESC, stable by index).
 */
export function squarifiedTreemap(values: readonly number[], bounds: TreemapBounds): TreemapTile[] {
  const bx = finiteCoord(bounds.x);
  const by = finiteCoord(bounds.y);
  const bw = Math.max(0, finiteCoord(bounds.w));
  const bh = Math.max(0, finiteCoord(bounds.h));
  const totalArea = bw * bh;
  if (totalArea <= 0) return [];

  const cells: Cell[] = [];
  let totalValue = 0;
  values.forEach((v, index) => {
    const value = finiteCoord(v);
    if (value > 0) {
      cells.push({ index, value, area: 0 });
      totalValue += value;
    }
  });
  if (cells.length === 0 || totalValue <= 0) return [];
  // value → area (conserve: Σ area == bounds area)
  const scale = totalArea / totalValue;
  for (const c of cells) c.area = c.value * scale;
  // sort by value DESC, stable by index
  cells.sort((a, b) => b.value - a.value || a.index - b.index);

  const out: TreemapTile[] = [];
  let x = bx;
  let y = by;
  let w = bw;
  let h = bh;

  const layoutRow = (row: readonly Cell[]) => {
    const rowArea = row.reduce((s, c) => s + c.area, 0);
    if (rowArea <= 0) return;
    if (w >= h) {
      // vertical strip on the left, width = rowArea / h, tiles stacked down its height
      const stripW = rowArea / h;
      let cy = y;
      for (const c of row) {
        const ih = c.area / stripW; // == c.area * h / rowArea
        out.push({ index: c.index, x, y: cy, w: stripW, h: ih, value: c.value });
        cy += ih;
      }
      x += stripW;
      w -= stripW;
    } else {
      // horizontal strip on top, height = rowArea / w, tiles across its width
      const stripH = rowArea / w;
      let cx = x;
      for (const c of row) {
        const iw = c.area / stripH;
        out.push({ index: c.index, x: cx, y, w: iw, h: stripH, value: c.value });
        cx += iw;
      }
      y += stripH;
      h -= stripH;
    }
  };

  let row: Cell[] = [];
  let i = 0;
  while (i < cells.length) {
    const side = Math.min(w, h);
    if (side <= 0) break; // remaining space exhausted (numerical) — stop cleanly
    const cur = row.map((c) => c.area);
    const next = [...cur, cells[i].area];
    if (row.length === 0 || worstRatio(next, side) <= worstRatio(cur, side)) {
      row.push(cells[i]);
      i++;
    } else {
      layoutRow(row);
      row = [];
    }
  }
  if (row.length > 0) layoutRow(row);
  return out;
}
