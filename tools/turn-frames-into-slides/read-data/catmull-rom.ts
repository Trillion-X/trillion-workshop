// tools/turn-frames-into-slides/read-data/catmull-rom.ts
//
// CATMULL-ROM SPLINE — the pure primitive behind the connector `smooth` routing: a flowing curve that
// PASSES THROUGH every point of a polyline (unlike a single-control `curved` line, which only bows the
// chord, and unlike straight-segment `waypoints`, which kinks at each bend). Given the vertex chain
// [start, …bends, end], it emits one cubic bezier per segment whose control points are the Catmull-Rom
// tangents (each interior point's tangent ∝ the vector between its neighbours), so the curve is C¹-smooth
// and interpolating — the draw.io/Miro "flowing connector through bend points" look. End tangents clamp to
// the endpoints (no overshoot past the wire's ends).
//
// Pure leaf (only the `Pt` type). A 2-point chain (no bends) yields a single cubic that is visually a
// straight line (its controls sit on the chord), so `smooth` with no waypoints degrades to straight.

import type { Pt } from './connector-geometry.ts';

/**
 * The SVG path `d` (an `M` + one `C` per segment) of the uniform Catmull-Rom spline through `points`.
 * For each segment Pᵢ→Pᵢ₊₁ the cubic controls are `Pᵢ + (Pᵢ₊₁ − Pᵢ₋₁)/6` and `Pᵢ₊₁ − (Pᵢ₊₂ − Pᵢ)/6`
 * (neighbours clamped at the ends), which makes the curve interpolate every point smoothly. `< 2` points →
 * `M`-only / empty (nothing to draw).
 */
export function catmullRomPath(points: readonly Pt[]): string {
  if (points.length === 0) return '';
  if (points.length === 1) return `M ${points[0].x} ${points[0].y}`;
  const m = points.length;
  let d = `M ${points[0].x} ${points[0].y}`;
  for (let i = 0; i < m - 1; i += 1) {
    const p0 = points[Math.max(i - 1, 0)];
    const p1 = points[i];
    const p2 = points[i + 1];
    const p3 = points[Math.min(i + 2, m - 1)];
    const c1x = p1.x + (p2.x - p0.x) / 6;
    const c1y = p1.y + (p2.y - p0.y) / 6;
    const c2x = p2.x - (p3.x - p1.x) / 6;
    const c2y = p2.y - (p3.y - p1.y) / 6;
    d += ` C ${c1x} ${c1y} ${c2x} ${c2y} ${p2.x} ${p2.y}`;
  }
  return d;
}
