// packages/group/do-work/density-field.ts
//
// DENSITY FIELD — the generative primitive behind "show me where the board is CROWDED" (the heatmap /
// hot-spot canon: a Miro/FigJam density overlay, a coverage map, a "where did everyone pile their notes"
// view). The requests "colour the busy areas / weight it by votes / weight it by progress / find the hottest
// region" are all ONE computation configured by HOW each item is WEIGHTED: accumulate every item's weight
// into a uniform grid (spread across the cells its footprint covers, so weight is CONSERVED — a big note
// spreads, a small note concentrates), then read the field back normalized or as its argmax. WHICH weight an
// item carries is the caller's injected `weightOf` (default 1 = plain count); this leaf never names "votes".
//
// Pure leaf — only local rect types + the `finiteCoord` clamp SSOT. Deterministic, zero I/O, framework-
// agnostic. The show/ overlay renders the field as coloured cells + injects `weightOf`; the DATA weight/ramp
// catalogs live there. The grid is BOUNDED (cellSize auto-grows so `cols·rows ≤ MAX_CELLS`), so a malformed
// huge-span board can never allocate an unbounded grid (OOM) — it fails closed to a coarser field.

import { finiteCoord } from '../read-data/finite-coord.ts';

/** A weighted footprint (an item's world box). */
export interface DensityRect {
  readonly x: number;
  readonly y: number;
  readonly w: number;
  readonly h: number;
}

export interface DensityBounds {
  readonly minX: number;
  readonly minY: number;
  readonly maxX: number;
  readonly maxY: number;
}

/** The computed field: a row-major grid of accumulated weights + the geometry to place it. */
export interface DensityField {
  readonly cols: number;
  readonly rows: number;
  readonly cellSize: number;
  readonly origin: { x: number; y: number };
  /** Row-major (row * cols + col) accumulated weight per cell. */
  readonly cells: readonly number[];
  /** Max cell weight (0 for an empty field) — the normalisation divisor. */
  readonly max: number;
  /** Sum of all cell weights (≈ Σ weightOf, conserved). */
  readonly total: number;
}

export interface DensityFieldOptions {
  /** Target cell edge (world units). Default 60. Auto-GROWS if the grid would exceed MAX_CELLS. */
  readonly cellSize?: number;
  /** Weight per rect (default 1 = count). Clamped to a finite ≥ 0. */
  readonly weightOf?: (rect: DensityRect, index: number) => number;
  /** Explicit bounds (else computed from the rects, padded by one cell). */
  readonly bounds?: DensityBounds;
}

/** Grid cap — a board spanning millions of px at cellSize 1 would allocate an unbounded grid (OOM). Beyond
 *  this the cell size auto-grows so the field stays bounded (coarser, never a crash). ~250k cells is a fine,
 *  large heatmap; a real board is far under it. */
const MAX_CELLS = 250_000;

const clampNum = (v: number): number => finiteCoord(v);

/** Bounding box of the rects (finite-clamped), or a unit box when empty. */
export function computeBounds(rects: readonly DensityRect[]): DensityBounds {
  if (rects.length === 0) return { minX: 0, minY: 0, maxX: 1, maxY: 1 };
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const r of rects) {
    const x = clampNum(r.x);
    const y = clampNum(r.y);
    const w = Math.max(0, clampNum(r.w));
    const h = Math.max(0, clampNum(r.h));
    if (x < minX) minX = x;
    if (y < minY) minY = y;
    if (x + w > maxX) maxX = x + w;
    if (y + h > maxY) maxY = y + h;
  }
  return { minX, minY, maxX, maxY };
}

const overlap = (a0: number, a1: number, b0: number, b1: number): number =>
  Math.max(0, Math.min(a1, b1) - Math.max(a0, b0));

/**
 * Accumulate each rect's weight into a uniform grid, spreading a rect across the cells its footprint covers
 * IN PROPORTION to the overlap area — so the total deposited weight equals the rect's weight (conservation),
 * a big note washes a region while a small note spikes one cell. A zero-area rect drops its full weight into
 * the single cell containing its top-left. Deterministic; grid auto-coarsens past MAX_CELLS.
 */
export function densityField(rects: readonly DensityRect[], opts: DensityFieldOptions = {}): DensityField {
  const weightOf = opts.weightOf ?? (() => 1);
  const bounds = opts.bounds ?? computeBounds(rects);
  const spanX = Math.max(1, bounds.maxX - bounds.minX);
  const spanY = Math.max(1, bounds.maxY - bounds.minY);

  let cellSize = Math.max(1, clampNum(opts.cellSize ?? 60));
  // Auto-grow the cell so the grid never exceeds MAX_CELLS (bounded allocation, fail-closed on a huge span).
  let cols = Math.max(1, Math.ceil(spanX / cellSize));
  let rows = Math.max(1, Math.ceil(spanY / cellSize));
  if (cols * rows > MAX_CELLS) {
    const scale = Math.sqrt((cols * rows) / MAX_CELLS);
    cellSize = cellSize * scale;
    cols = Math.max(1, Math.ceil(spanX / cellSize));
    rows = Math.max(1, Math.ceil(spanY / cellSize));
  }

  const cells = new Array<number>(cols * rows).fill(0);
  const origin = { x: bounds.minX, y: bounds.minY };

  rects.forEach((r, i) => {
    const w = Math.max(0, clampNum(weightOf(r, i)));
    if (w === 0) return;
    const rx = clampNum(r.x);
    const ry = clampNum(r.y);
    const rw = Math.max(0, clampNum(r.w));
    const rh = Math.max(0, clampNum(r.h));
    const area = rw * rh;

    if (area <= 0) {
      // zero-area footprint → the single cell containing its point
      const c = Math.min(cols - 1, Math.max(0, Math.floor((rx - origin.x) / cellSize)));
      const rr = Math.min(rows - 1, Math.max(0, Math.floor((ry - origin.y) / cellSize)));
      cells[rr * cols + c] += w;
      return;
    }
    const c0 = Math.max(0, Math.floor((rx - origin.x) / cellSize));
    const c1 = Math.min(cols - 1, Math.floor((rx + rw - origin.x) / cellSize));
    const r0 = Math.max(0, Math.floor((ry - origin.y) / cellSize));
    const r1 = Math.min(rows - 1, Math.floor((ry + rh - origin.y) / cellSize));
    for (let rr = r0; rr <= r1; rr++) {
      const cy0 = origin.y + rr * cellSize;
      const oy = overlap(ry, ry + rh, cy0, cy0 + cellSize);
      if (oy <= 0) continue;
      for (let cc = c0; cc <= c1; cc++) {
        const cx0 = origin.x + cc * cellSize;
        const ox = overlap(rx, rx + rw, cx0, cx0 + cellSize);
        if (ox <= 0) continue;
        cells[rr * cols + cc] += (w * (ox * oy)) / area;
      }
    }
  });

  let max = 0;
  let total = 0;
  for (const v of cells) {
    if (v > max) max = v;
    total += v;
  }
  return { cols, rows, cellSize, origin, cells, max, total };
}

/** Per-cell normalised weight in 0..1 (cell / max; all 0 for an empty field). */
export function normalizedCells(field: DensityField): number[] {
  if (field.max <= 0) return field.cells.map(() => 0);
  return field.cells.map((v) => v / field.max);
}

/** The hottest cell — its row-major index, grid col/row, world-space centre, and normalised value. Null for
 *  an empty field. Emergent "jump to the busiest region" affordance. Deterministic (first cell on a tie). */
export function hotspot(field: DensityField): {
  index: number;
  col: number;
  row: number;
  center: { x: number; y: number };
  value: number;
} | null {
  if (field.max <= 0) return null;
  let best = 0;
  for (let i = 1; i < field.cells.length; i++) if (field.cells[i] > field.cells[best]) best = i;
  const col = best % field.cols;
  const row = Math.floor(best / field.cols);
  return {
    index: best,
    col,
    row,
    center: {
      x: field.origin.x + (col + 0.5) * field.cellSize,
      y: field.origin.y + (row + 0.5) * field.cellSize,
    },
    value: field.cells[best] / field.max,
  };
}

// ── Colour ramps as DATA (a ramp is a list of {at, color} stops; a new ramp is one row, L090) ──

export interface RampStop {
  readonly at: number; // 0..1
  readonly color: readonly [number, number, number]; // rgb 0..255
}
export type DensityRamp = readonly RampStop[];

/** Linear-interpolate a ramp at t (0..1) → `rgb(r,g,b)`. Blind to the ramp's stops (DATA). */
export function rampColor(t: number, ramp: DensityRamp): string {
  const x = Math.min(1, Math.max(0, Number.isFinite(t) ? t : 0));
  if (ramp.length === 0) return 'rgb(0,0,0)';
  if (x <= ramp[0].at) return `rgb(${ramp[0].color.join(',')})`;
  const last = ramp[ramp.length - 1];
  if (x >= last.at) return `rgb(${last.color.join(',')})`;
  for (let i = 1; i < ramp.length; i++) {
    if (x <= ramp[i].at) {
      const a = ramp[i - 1];
      const b = ramp[i];
      const f = (x - a.at) / (b.at - a.at || 1);
      const c = a.color.map((av, k) => Math.round(av + (b.color[k] - av) * f));
      return `rgb(${c.join(',')})`;
    }
  }
  return `rgb(${last.color.join(',')})`;
}
