// packages/group/do-work/board-balance.ts
//
// BOARD BALANCE — the board's macro-COMPOSITION primitive (b119). Tidiness (b116) measures LOCAL geometry
// (do two cards overlap / almost-align); balance measures the GLOBAL picture: is the board evenly composed, or
// crammed into one corner? It answers the "your board is all top-left" design instinct with numbers:
//   • quadrantShares — how card area splits across the four quadrants of the board's own bounds
//   • areaCentroid   — the board's centre of mass (where the weight actually sits)
//   • a set of DATA-selected composition METRICS (even / centred / spread), each 0..1 with 1 = well-composed
//
// The metric set is an injected-capability catalog (`BALANCE_METRICS`, L069/L090) — a new composition check is
// one row, zero engine code. Pure leaf: deterministic, `finiteCoord`-guarded, zero I/O.

import { finiteCoord } from '../read-data/finite-coord.ts';

/** A rectangle in board space (a card's footprint). */
export interface BalRect {
  readonly x: number;
  readonly y: number;
  readonly w: number;
  readonly h: number;
}

/** The bounding box of a set of rects, plus its centre and span. */
export interface Bounds {
  readonly minX: number;
  readonly minY: number;
  readonly maxX: number;
  readonly maxY: number;
  readonly cx: number;
  readonly cy: number;
  readonly w: number;
  readonly h: number;
}

/** [top-left, top-right, bottom-left, bottom-right] fractions of total card area (sum ≤ 1). */
export type QuadrantShares = readonly [number, number, number, number];

/** A composition metric: a pure (rects, bounds) → value in 0..1 where 1 = well-composed. */
export interface BalanceMetricDef {
  readonly id: string;
  readonly label: string;
  readonly measure: (rects: readonly BalRect[], bounds: Bounds) => number;
}

export interface BalanceMetricResult {
  readonly id: string;
  readonly label: string;
  readonly value: number;
}

export interface BalanceResult {
  readonly metrics: readonly BalanceMetricResult[];
  /** Mean of the metric values, 0..1 (1 = balanced). */
  readonly overall: number;
  readonly bounds: Bounds;
  readonly centroid: { readonly x: number; readonly y: number };
  readonly quadrantShares: QuadrantShares;
  /** Fraction of the bounds area covered by card area, 0..1 (occupancy — informational, not scored). */
  readonly occupancy: number;
}

const fr = (r: BalRect): BalRect => ({ x: finiteCoord(r.x), y: finiteCoord(r.y), w: Math.max(0, finiteCoord(r.w)), h: Math.max(0, finiteCoord(r.h)) });
const areaOf = (r: BalRect): number => r.w * r.h;

/** The bounding box of every rect. Empty → a zero box at the origin. */
export function boundsOf(rects: readonly BalRect[]): Bounds {
  if (!rects.length) return { minX: 0, minY: 0, maxX: 0, maxY: 0, cx: 0, cy: 0, w: 0, h: 0 };
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const raw of rects) {
    const r = fr(raw);
    minX = Math.min(minX, r.x);
    minY = Math.min(minY, r.y);
    maxX = Math.max(maxX, r.x + r.w);
    maxY = Math.max(maxY, r.y + r.h);
  }
  return { minX, minY, maxX, maxY, cx: (minX + maxX) / 2, cy: (minY + maxY) / 2, w: maxX - minX, h: maxY - minY };
}

/** The area-weighted centre of mass of the cards. Empty → the bounds centre. */
export function areaCentroid(rects: readonly BalRect[], bounds: Bounds = boundsOf(rects)): { x: number; y: number } {
  let sx = 0;
  let sy = 0;
  let sa = 0;
  for (const raw of rects) {
    const r = fr(raw);
    const a = areaOf(r) || 1; // a zero-area card still contributes its position
    sx += (r.x + r.w / 2) * a;
    sy += (r.y + r.h / 2) * a;
    sa += a;
  }
  if (sa <= 0) return { x: bounds.cx, y: bounds.cy };
  return { x: finiteCoord(sx / sa), y: finiteCoord(sy / sa) };
}

/** Card-area split across the four quadrants of the bounds (by each card's centre). Sum → 1 (or 0 if empty). */
export function quadrantShares(rects: readonly BalRect[], bounds: Bounds = boundsOf(rects)): QuadrantShares {
  const q = [0, 0, 0, 0];
  let total = 0;
  for (const raw of rects) {
    const r = fr(raw);
    const a = areaOf(r) || 1;
    total += a;
    const right = r.x + r.w / 2 >= bounds.cx;
    const bottom = r.y + r.h / 2 >= bounds.cy;
    const idx = (bottom ? 2 : 0) + (right ? 1 : 0);
    q[idx] += a;
  }
  if (total <= 0) return [0, 0, 0, 0];
  return [q[0] / total, q[1] / total, q[2] / total, q[3] / total];
}

/**
 * The DATA catalog of composition metrics (L069/L090). Each returns 0..1, 1 = well-composed:
 * - `even`: card area spread evenly across the four quadrants (1 = a perfect quarter each; 0 = all in one).
 * - `centered`: the area-centroid sits near the bounds centre (1 = dead centre; 0 = a far corner).
 * - `spread`: cards cover the canvas rather than clumping — the fraction of a 4×4 grid whose cells hold a card
 *   centre, normalised by how many cells the card count could fill (1 = as spread as the count allows).
 * A new composition check is one row; nothing else changes.
 */
export const BALANCE_METRICS: readonly BalanceMetricDef[] = [
  {
    id: 'even',
    label: 'Evenly spread',
    measure: (rects, bounds) => {
      const q = quadrantShares(rects, bounds);
      // Sum of absolute deviation from an even 0.25 each; max deviation (all in one quadrant) = 1.5.
      const dev = q.reduce((s, v) => s + Math.abs(v - 0.25), 0);
      return Math.max(0, 1 - dev / 1.5);
    },
  },
  {
    id: 'centered',
    label: 'Centred',
    measure: (rects, bounds) => {
      if (!rects.length) return 1;
      const c = areaCentroid(rects, bounds);
      const halfDiag = Math.hypot(bounds.w, bounds.h) / 2 || 1;
      const dist = Math.hypot(c.x - bounds.cx, c.y - bounds.cy);
      return Math.max(0, 1 - dist / halfDiag);
    },
  },
  {
    id: 'spread',
    label: 'Uses the space',
    measure: (rects, bounds) => {
      if (rects.length < 2) return 1;
      const GRID = 4;
      const cells = new Set<number>();
      for (const raw of rects) {
        const r = fr(raw);
        const gx = bounds.w > 0 ? Math.min(GRID - 1, Math.floor(((r.x + r.w / 2 - bounds.minX) / bounds.w) * GRID)) : 0;
        const gy = bounds.h > 0 ? Math.min(GRID - 1, Math.floor(((r.y + r.h / 2 - bounds.minY) / bounds.h) * GRID)) : 0;
        cells.add(gy * GRID + Math.max(0, gx));
      }
      const reachable = Math.min(GRID * GRID, rects.length);
      return Math.min(1, cells.size / reachable);
    },
  },
];

/** Occupancy: the fraction of the bounds area covered by card area (informational, clamped 0..1). */
export function occupancyOf(rects: readonly BalRect[], bounds: Bounds = boundsOf(rects)): number {
  const boxArea = bounds.w * bounds.h;
  if (boxArea <= 0) return 0;
  const cardArea = rects.reduce((s, r) => s + areaOf(fr(r)), 0);
  return Math.min(1, cardArea / boxArea);
}

/**
 * The full composition analysis: each metric scored, their mean as `overall`, plus the raw shares / centroid /
 * occupancy for display. A board of 0 or 1 card is trivially balanced (overall 1) — you cannot be lopsided with
 * nothing to weigh. Deterministic, bounded [0,1].
 */
export function analyzeBalance(rects: readonly BalRect[], metrics: readonly BalanceMetricDef[] = BALANCE_METRICS): BalanceResult {
  const bounds = boundsOf(rects);
  const centroid = areaCentroid(rects, bounds);
  const shares = quadrantShares(rects, bounds);
  const occupancy = occupancyOf(rects, bounds);
  if (rects.length < 2) {
    return {
      metrics: metrics.map((m) => ({ id: m.id, label: m.label, value: 1 })),
      overall: 1,
      bounds,
      centroid,
      quadrantShares: shares,
      occupancy,
    };
  }
  const results = metrics.map((m) => ({ id: m.id, label: m.label, value: Math.max(0, Math.min(1, m.measure(rects, bounds))) }));
  const overall = results.length ? results.reduce((s, r) => s + r.value, 0) / results.length : 1;
  return { metrics: results, overall, bounds, centroid, quadrantShares: shares, occupancy };
}

/** Score band → colour + word (green ≥ 0.8, amber ≥ 0.55, else red). */
export function balanceBand(overall: number): { color: string; ink: string; label: string } {
  if (overall >= 0.8) return { color: '#dcfce7', ink: '#166534', label: 'Well balanced' };
  if (overall >= 0.55) return { color: '#fef9c3', ink: '#854d0e', label: 'A little lopsided' };
  return { color: '#fee2e2', ink: '#991b1b', label: 'Lopsided' };
}
