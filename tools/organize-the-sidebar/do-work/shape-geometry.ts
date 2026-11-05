// packages/group/do-work/shape-geometry.ts
//
// The SSOT for board-shape GEOMETRY — one pure leaf that turns a self-describing
// shape descriptor (DATA) into every representation the surface needs:
//   • a CSS `clip-path`   (backward-compat with the #155 catalog render)
//   • a bbox-FILLING SVG path in a 0..100 percent viewBox  (the #213 fix: a shape
//     is a path that FILLS the item box, not a clip over top-aligned card content
//     — the root cause of the "circle renders as a dome / star as a top point")
//   • the shape's extent (for hit-testing / export bounds)
//
// WHY THIS EXISTS (L069 + L063 + SSOT): before this, a "shape" was a hand-tuned
// CSS clip-path STRING per catalog row (`board-shapes.ts`) applied to the note
// Card content — so it clipped whatever partial-height content existed (the dome),
// and SVG export emitted a plain <rect> (live != export, two sources of truth).
// This leaf makes the geometry the ONE source: the live render, the clip-path, and
// the export all derive from the same descriptor. A new shape (pentagon, octagon,
// 6-point star, any N-gon, any custom polygon) is ONE DATA row — `ngon`/`star` are
// FORMULAS, not enumerated rows, so the deletion test passes: delete ellipse/star
// and a `{kind:'ngon',sides:7}` heptagon still renders/exports with ZERO new code.
//
// =============================================================================
// NON-NEGOTIABLE INVARIANTS
// =============================================================================
// 1. Percent space: all points are in a 0..100 box. Callers scale to w×h (SVG
//    viewBox="0 0 100 100" preserveAspectRatio="none", or point*w/100). The leaf
//    is resolution-agnostic — it never sees pixels.
// 2. Blind & generic: this leaf never names a "board", a "note", or a specific
//    shape id. Meaning lives in the DATA descriptor. Adding a shape adds a row.
// 3. `ellipse`/`rect` fill the FULL box (extent 0..100 on both axes) — the dome is
//    structurally impossible because the geometry always spans the whole box.
// =============================================================================

import { finiteCoord } from '../read-data/finite-coord.ts';

// The shape descriptor is UNTRUSTED persisted DATA. `sides`/`points`/`polygon.points` are capped so
// a hostile `{kind:'ngon',sides:1e9}` (or a million-point polygon) can't `Array.from({length:huge})`
// OOM, and a capped point count keeps `Math.min(...xs)` in `shapeExtentOf` under the JS spread arg
// limit (no RangeError). No real board shape approaches these — catalog shapes have < 12 points.
const MAX_SHAPE_POINTS = 512;

/** A self-describing shape. `polygon` carries explicit percent points (the hand-
 *  tuned catalog shapes); `ngon`/`star` are FORMULAS (a regular N-gon / an
 *  N-point star) so unbounded new shapes are pure DATA, not new code. */
export type ShapeGeometry =
  | { readonly kind: 'rect' }
  | { readonly kind: 'ellipse' }
  | { readonly kind: 'polygon'; readonly points: ReadonlyArray<readonly [number, number]> }
  | { readonly kind: 'ngon'; readonly sides: number; readonly rotation?: number }
  | { readonly kind: 'star'; readonly points: number; readonly innerRatio: number; readonly rotation?: number };

/** Format a percent number for a CSS/SVG string: integer stays integer (so the
 *  catalog's clip-paths reproduce byte-for-byte), otherwise rounded to 3 dp with
 *  trailing zeros stripped (formula shapes). Avoids `0.61*100 = 61.00000000000001`. */
function fmt(n: number): string {
  // finiteCoord BEFORE rounding: an untrusted polygon point of NaN/±Infinity/MAX_VALUE must never
  // reach a CSS clip-path / SVG `d` string as "NaN"/"Infinity" — clamp to a finite percent coord.
  const r = Math.round(finiteCoord(n) * 1000) / 1000;
  return String(r);
}

/** A point on the unit circle placed in the 0..100 box, angle in degrees measured
 *  from the top (12 o'clock) going clockwise — matches how designers read shapes. */
function ringPoint(angleDeg: number, radius: number): [number, number] {
  const a = ((angleDeg - 90) * Math.PI) / 180; // -90 → start at top
  return [50 + radius * Math.cos(a), 50 + radius * Math.sin(a)];
}

/** Resolve a descriptor to its percent-space polygon points, or `null` for the two
 *  path-less kinds (`rect` = no shape, `ellipse` = a curve, not a polygon). */
export function shapePolygonPoints(geo: ShapeGeometry): Array<[number, number]> | null {
  switch (geo.kind) {
    case 'rect':
    case 'ellipse':
      return null;
    case 'polygon':
      // UNTRUSTED, unbounded point list — cap before map/spread/string-build (a million-point
      // polygon would blow the extent's Math.min(...spread) and build a megabyte path string).
      return Array.isArray(geo.points) ? geo.points.slice(0, MAX_SHAPE_POINTS).map(([x, y]) => [x, y]) : [];
    case 'ngon': {
      // `sides` is UNTRUSTED — Math.floor(MAX_VALUE) → Array.from({length:huge}) OOM/RangeError.
      // Clamp to [3, MAX_SHAPE_POINTS]; a non-finite `sides` (NaN → the min) falls to the floor.
      const n = Math.min(MAX_SHAPE_POINTS, Math.max(3, Math.floor(finiteCoord(geo.sides, 3))));
      const rot = finiteCoord(geo.rotation ?? 0, 0);
      return Array.from({ length: n }, (_, i) => ringPoint(rot + (i * 360) / n, 50));
    }
    case 'star': {
      const n = Math.min(MAX_SHAPE_POINTS, Math.max(2, Math.floor(finiteCoord(geo.points, 2))));
      const rot = finiteCoord(geo.rotation ?? 0, 0);
      const inner = 50 * Math.max(0, Math.min(1, finiteCoord(geo.innerRatio, 0)));
      const verts: Array<[number, number]> = [];
      for (let i = 0; i < n * 2; i++) {
        const r = i % 2 === 0 ? 50 : inner;
        verts.push(ringPoint(rot + (i * 360) / (n * 2), r));
      }
      return verts;
    }
  }
}

/** The CSS `clip-path` for a descriptor (`''` = rectangle = no clip). Reproduces the
 *  #155 catalog strings byte-for-byte for integer polygon points. */
export function shapeClipPathOf(geo: ShapeGeometry): string {
  if (geo.kind === 'rect') return '';
  if (geo.kind === 'ellipse') return 'ellipse(50% 50% at 50% 50%)';
  const pts = shapePolygonPoints(geo)!;
  return `polygon(${pts.map(([x, y]) => `${fmt(x)}% ${fmt(y)}%`).join(', ')})`;
}

/** A bbox-FILLING SVG path `d` in the 0..100 percent viewBox. This is the #213 fix:
 *  the shape is a path that fills the whole item box (render inside
 *  `<svg viewBox="0 0 100 100" preserveAspectRatio="none">`), so it can never
 *  collapse into a dome. `rect` → the full-box rectangle path. */
export function shapeSvgPathOf(geo: ShapeGeometry): string {
  if (geo.kind === 'ellipse') {
    // Two half-arcs through the left/right extremes → a full ellipse filling the box.
    return 'M 0,50 A 50,50 0 1 0 100,50 A 50,50 0 1 0 0,50 Z';
  }
  if (geo.kind === 'rect') {
    return 'M 0,0 L 100,0 L 100,100 L 0,100 Z';
  }
  const pts = shapePolygonPoints(geo)!;
  return `M ${pts.map(([x, y]) => `${fmt(x)},${fmt(y)}`).join(' L ')} Z`;
}

/** The shape's extent in percent space `[minX, minY, maxX, maxY]`. `ellipse`/`rect`
 *  fill the whole box → `[0,0,100,100]` (the anti-dome invariant, testable). */
export function shapeExtentOf(geo: ShapeGeometry): [number, number, number, number] {
  const pts = shapePolygonPoints(geo);
  if (!pts) return [0, 0, 100, 100];
  // `pts` is capped to MAX_SHAPE_POINTS by shapePolygonPoints, so the spread stays under the JS
  // arg limit (no RangeError). finiteCoord each extent value so a NaN/MAX_VALUE point can't poison it.
  const xs = pts.map((p) => p[0]);
  const ys = pts.map((p) => p[1]);
  return [finiteCoord(Math.min(...xs)), finiteCoord(Math.min(...ys)), finiteCoord(Math.max(...xs)), finiteCoord(Math.max(...ys))];
}

/**
 * cont.26 (rough shapes) — the shape's OUTLINE as an ordered, CLOSED point ring in an absolute
 * `w`×`h` box (inset by `pad`). Polygon/ngon/star use their vertices; `ellipse` is sampled into
 * `segments` points; `rect` uses the four corners. The stroke-style leaf roughens this ring into a
 * hand-drawn shape outline (a rough diamond/star/ellipse), so a shaped note joins the sketch look
 * with ZERO shape-specific code — a new shape's rough outline falls out of its DATA geometry (L090).
 */
export function shapeOutlinePoints(
  geo: ShapeGeometry,
  w: number,
  h: number,
  pad = 2.5,
  segments = 48,
): Array<{ x: number; y: number }> {
  // w/h are UNTRUSTED item geometry; a non-finite/MAX_VALUE box would fling every outline point.
  // `segments` is capped so a hostile caller can't `Array.from({length:huge})`. Clamp the box + points.
  const fw = finiteCoord(w);
  const fh = finiteCoord(h);
  const segs = Math.min(MAX_SHAPE_POINTS, Math.max(3, Math.floor(finiteCoord(segments, 48))));
  const sx = (px: number) => finiteCoord(pad + (px / 100) * (fw - 2 * pad));
  const sy = (py: number) => finiteCoord(pad + (py / 100) * (fh - 2 * pad));
  let pct: Array<[number, number]>;
  if (geo.kind === 'ellipse') {
    pct = Array.from({ length: segs }, (_, i) => {
      const a = (i / segs) * Math.PI * 2;
      return [50 + 50 * Math.cos(a), 50 + 50 * Math.sin(a)] as [number, number];
    });
  } else {
    pct = shapePolygonPoints(geo) ?? [[0, 0], [100, 0], [100, 100], [0, 100]];
  }
  const ring = pct.map(([x, y]) => ({ x: sx(x), y: sy(y) }));
  return [...ring, ring[0]]; // close the loop
}
