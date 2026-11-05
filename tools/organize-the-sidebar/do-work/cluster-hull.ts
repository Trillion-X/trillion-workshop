// packages/group/do-work/cluster-hull.ts
//
// CLUSTER HULL — the generative primitive behind "draw a soft territory outline AROUND a set of items"
// (the Kumu / InfraNodus / FigJam-section canon: a blob that hugs a cluster so a group reads as one region
// WITHOUT a hard rectangular frame). The request "outline the tag cluster / outline the kind cluster /
// lasso the selection / ring the connected component" is ONE shape configured by WHICH points you feed it
// and HOW you group them — so this leaf owns only the geometry: the smallest convex enclosure of a point
// set, then a padded, rounded path around it. WHICH items form a cluster is the CALLER's injected `keyOf`
// (the SAME facet contract arrange-by-facet / select-similar already use), so a new cluster axis is DATA,
// zero geometry code (L069/L090).
//
// Two pure functions compose:
//   • `convexHull(points)` — Andrew's monotone-chain hull (deterministic O(n log n), no random): the ordered
//     outer vertices. Degenerate inputs collapse HONESTLY — 0 pts → [], 1 unique → [p], 2 unique or a fully
//     COLLINEAR set → the two extreme points (never a bogus triangle).
//   • `hullPath(hull, padding, radius)` — the SVG `d` for the blob. The degenerate cases get AREA from the
//     padding, uniformly, with NO per-caller branch: 1 vertex → a circle of radius `padding`; 2 vertices →
//     a stadium (parallel sides + semicircle caps); ≥3 → the hull grown outward by `padding` with each
//     corner rounded by `radius`. One path builder covers a dot, a pair, and a 400-node cluster.
//
// Pure leaf — only the `Pt` type (type-only import, no runtime coupling with connector-geometry) and the
// `finiteCoord` clamp SSOT (so a NaN/Infinity/huge coordinate from malformed DATA can never poison the path).
// Framework-agnostic, deterministic, zero I/O — the show/ overlay groups items + injects `keyOf`; this file
// never knows what a "tag" or a "board" is.

import type { Pt } from './connector-geometry.ts';
import { finiteCoord } from '../read-data/finite-coord.ts';

/** A rectangle (an item's world-space box). */
export interface HullRect {
  readonly x: number;
  readonly y: number;
  readonly w: number;
  readonly h: number;
}

/** Clamp a point through the finiteCoord SSOT — the ONE place raw coordinates enter the leaf, so every
 *  downstream sum/offset is overflow-safe (finiteCoord bounds NaN/Infinity AND finite-huge to ±1e7). */
function clamp(p: Pt): Pt {
  return { x: finiteCoord(p.x), y: finiteCoord(p.y) };
}

/** The four corners of a rect — the caller feeds an item's box in as its four corners so the hull hugs the
 *  actual footprint (not just centres). */
export function rectCorners(r: HullRect): Pt[] {
  const x = finiteCoord(r.x);
  const y = finiteCoord(r.y);
  const w = Math.max(0, finiteCoord(r.w));
  const h = Math.max(0, finiteCoord(r.h));
  return [
    { x, y },
    { x: x + w, y },
    { x: x + w, y: y + h },
    { x, y: y + h },
  ];
}

/** Dedupe + sort points by (x, then y) — the monotone-chain precondition. */
function sortedUnique(points: readonly Pt[]): Pt[] {
  const seen = new Set<string>();
  const out: Pt[] = [];
  for (const raw of points) {
    const p = clamp(raw);
    const key = `${p.x},${p.y}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(p);
  }
  out.sort((a, b) => a.x - b.x || a.y - b.y);
  return out;
}

/** > 0 ccw, < 0 cw, 0 collinear (screen coords: y grows down, so "ccw" is visually clockwise — irrelevant,
 *  we only need a consistent simple polygon). */
function cross(o: Pt, a: Pt, b: Pt): number {
  return (a.x - o.x) * (b.y - o.y) - (a.y - o.y) * (b.x - o.x);
}

/**
 * Andrew's monotone-chain convex hull. Returns the hull vertices in order (a simple polygon), with all
 * strictly-interior AND collinear-edge points dropped (`<= 0` keeps only true corners). 0/1/2 unique points
 * (or a fully collinear set) return as-is — the caller's `hullPath` gives them area. Deterministic.
 */
export function convexHull(points: readonly Pt[]): Pt[] {
  const pts = sortedUnique(points);
  const n = pts.length;
  if (n <= 2) return pts; // dot / pair / (dedup already collapsed exact duplicates)

  const lower: Pt[] = [];
  for (const p of pts) {
    while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], p) <= 0) lower.pop();
    lower.push(p);
  }
  const upper: Pt[] = [];
  for (let i = n - 1; i >= 0; i--) {
    const p = pts[i];
    while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], p) <= 0) upper.pop();
    upper.push(p);
  }
  lower.pop();
  upper.pop();
  const hull = lower.concat(upper);
  // A fully collinear set collapses to its two extremes (both chains reduce to endpoints) — return the pair.
  return hull.length >= 3 ? hull : [pts[0], pts[n - 1]];
}

/** Centroid of the hull vertices (the push-origin for outward padding). */
function centroid(hull: readonly Pt[]): Pt {
  let sx = 0;
  let sy = 0;
  for (const p of hull) {
    sx += p.x;
    sy += p.y;
  }
  return { x: sx / hull.length, y: sy / hull.length };
}

function len(dx: number, dy: number): number {
  return Math.hypot(dx, dy) || 1;
}

/** A point `r` along the segment from `v` toward `t` (used to cut a corner back for rounding). */
function toward(v: Pt, t: Pt, r: number): Pt {
  const dx = t.x - v.x;
  const dy = t.y - v.y;
  const l = len(dx, dy);
  return { x: v.x + (dx / l) * r, y: v.y + (dy / l) * r };
}

function num(v: number): string {
  // compact, locale-free, finite (clamped inputs guarantee finiteness; guard anyway)
  return (Number.isFinite(v) ? Math.round(v * 100) / 100 : 0).toString();
}

/** A circle path centred at `c` with radius `r` (the 1-point / single-item blob). */
function circlePath(c: Pt, r: number): string {
  const R = Math.max(1, r);
  return `M ${num(c.x - R)} ${num(c.y)} A ${num(R)} ${num(R)} 0 1 0 ${num(c.x + R)} ${num(c.y)} A ${num(R)} ${num(R)} 0 1 0 ${num(c.x - R)} ${num(c.y)} Z`;
}

/** A stadium (discorectangle) hugging the segment a→b with cap radius `r` (the 2-point / collinear blob). */
function stadiumPath(a: Pt, b: Pt, r: number): string {
  const R = Math.max(1, r);
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const l = len(dx, dy);
  // unit perpendicular
  const nx = -dy / l;
  const ny = dx / l;
  const a1 = { x: a.x + nx * R, y: a.y + ny * R };
  const a2 = { x: a.x - nx * R, y: a.y - ny * R };
  const b1 = { x: b.x + nx * R, y: b.y + ny * R };
  const b2 = { x: b.x - nx * R, y: b.y - ny * R };
  // a1 → b1 (side), cap around b (b1 → b2), b2 → a2 (side), cap around a (a2 → a1)
  return `M ${num(a1.x)} ${num(a1.y)} L ${num(b1.x)} ${num(b1.y)} A ${num(R)} ${num(R)} 0 0 1 ${num(b2.x)} ${num(b2.y)} L ${num(a2.x)} ${num(a2.y)} A ${num(R)} ${num(R)} 0 0 1 ${num(a1.x)} ${num(a1.y)} Z`;
}

/**
 * The blob path for a hull. `padding` grows the outline off the items; `radius` rounds each corner (≥3 case).
 * Degenerate hulls (0/1/2 vertices) are handled by the dedicated circle/stadium builders so a lone item or a
 * collinear pair still renders as a real, area-having region (never a zero-width line or empty path).
 */
export function hullPath(hull: readonly Pt[], padding = 24, radius = 18): string {
  const pad = Math.max(0, finiteCoord(padding));
  if (hull.length === 0) return '';
  if (hull.length === 1) return circlePath(hull[0], pad);
  if (hull.length === 2) return stadiumPath(hull[0], hull[1], pad);

  // ≥3: push each vertex outward from the centroid by `pad`, then round each corner by `radius`.
  const c = centroid(hull);
  const off = hull.map((v) => {
    const dx = v.x - c.x;
    const dy = v.y - c.y;
    const l = len(dx, dy);
    return { x: v.x + (dx / l) * pad, y: v.y + (dy / l) * pad };
  });
  const n = off.length;
  const rad = Math.max(0, finiteCoord(radius));
  let d = '';
  for (let i = 0; i < n; i++) {
    const v = off[i];
    const prev = off[(i - 1 + n) % n];
    const next = off[(i + 1) % n];
    const rIn = Math.min(rad, len(v.x - prev.x, v.y - prev.y) / 2);
    const rOut = Math.min(rad, len(next.x - v.x, next.y - v.y) / 2);
    const a = toward(v, prev, rIn); // approach (before the corner)
    const b = toward(v, next, rOut); // depart (after the corner)
    d += i === 0 ? `M ${num(a.x)} ${num(a.y)}` : ` L ${num(a.x)} ${num(a.y)}`;
    d += ` Q ${num(v.x)} ${num(v.y)} ${num(b.x)} ${num(b.y)}`;
  }
  return `${d} Z`;
}

/** Ray-cast point-in-polygon (a point strictly inside or on the hull). Used by the overlay to label-anchor
 *  and by tests to prove every clustered item corner is enclosed. A <3-vertex hull has no area → false. */
export function pointInHull(hull: readonly Pt[], p: Pt): boolean {
  const n = hull.length;
  if (n < 3) return false;
  let inside = false;
  for (let i = 0, j = n - 1; i < n; j = i++) {
    const a = hull[i];
    const b = hull[j];
    const straddles = a.y > p.y !== b.y > p.y;
    if (straddles && p.x < ((b.x - a.x) * (p.y - a.y)) / (b.y - a.y || 1e-9) + a.x) inside = !inside;
  }
  return inside;
}
