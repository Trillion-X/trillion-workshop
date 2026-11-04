// packages/group/do-work/connector-corners.ts
//
// ROUNDED CONNECTOR CORNERS — the generative primitive behind "an elbow/orthogonal wire turns with a
// smooth curve instead of a hard 90° corner" (the draw.io/Lucidchart "rounded" edge style, the single
// most-used connector look in diagramming). Orthogonal routings (`elbow`, and b85's obstacle-`avoid`)
// emit sharp-cornered polylines; this leaf takes ANY polyline's points and replaces each interior corner
// with a quadratic fillet — cut back by `radius` along both incident segments and curve through the vertex.
// It is a pure POST-transform on the resolved points, so it composes with every polyline routing for free
// and needs zero per-routing code; a straight 2-point line (no interior vertex) comes back unchanged.
//
// Pure leaf (only the `Pt` type + the shared `pointsFromLinePath` parser). Distinct axis from the other
// connector-readability primitives: jumps (b87) / fan (b88) / self-loop (b89) are about how MULTIPLE edges
// relate; this is one edge's own corner STYLE.

import type { Pt } from './connector-geometry';

const DEFAULT_RADIUS = 10;

function dist(a: Pt, b: Pt): number {
  return Math.hypot(b.x - a.x, b.y - a.y);
}

/** The point `r` px from `v` toward `t` (a corner cutback). `r` is assumed already clamped ≤ dist(v,t). */
function towards(v: Pt, t: Pt, r: number): Pt {
  const len = dist(v, t) || 1;
  return { x: v.x + ((t.x - v.x) / len) * r, y: v.y + ((t.y - v.y) / len) * r };
}

/**
 * The SVG path `d` for `points` with every INTERIOR corner rounded to `radius`. Each interior vertex `v`
 * (with neighbours `prev`/`next`) is replaced by: a line to the approach point `r` before `v` on the
 * `prev→v` segment, then a quadratic `Q v` to the departure point `r` after `v` on the `v→next` segment.
 * `r` is clamped per-corner to half of each incident segment so adjacent fillets never overlap or overshoot
 * (a corner between two short segments rounds less). Endpoints are untouched; a polyline of < 3 points (a
 * straight line) is returned as its plain `M…L…` (byte-identical). A zero-length incident segment → that
 * corner is passed straight through (no degenerate arc).
 */
export function roundedPolyline(points: readonly Pt[], radius = DEFAULT_RADIUS): string {
  if (points.length < 2) return points.length === 1 ? `M ${points[0].x} ${points[0].y}` : '';
  if (points.length < 3) return `M ${points[0].x} ${points[0].y} L ${points[1].x} ${points[1].y}`;
  let d = `M ${points[0].x} ${points[0].y}`;
  for (let i = 1; i < points.length - 1; i++) {
    const prev = points[i - 1];
    const v = points[i];
    const next = points[i + 1];
    const dPrev = dist(prev, v);
    const dNext = dist(v, next);
    const r = Math.min(radius, dPrev / 2, dNext / 2);
    if (r <= 0) {
      d += ` L ${v.x} ${v.y}`; // degenerate incident segment — no room to fillet
      continue;
    }
    const a = towards(v, prev, r); // approach point (r before the corner)
    const b = towards(v, next, r); // departure point (r after the corner)
    d += ` L ${a.x} ${a.y} Q ${v.x} ${v.y} ${b.x} ${b.y}`;
  }
  const last = points[points.length - 1];
  d += ` L ${last.x} ${last.y}`;
  return d;
}
