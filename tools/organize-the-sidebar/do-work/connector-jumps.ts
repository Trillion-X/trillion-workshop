// packages/group/do-work/connector-jumps.ts
//
// CONNECTOR CROSSING JUMPS — the generative primitive behind "when two lines cross, one hops over the
// other with a little arc" (the draw.io / yEd / Lucidchart / Visio readability canon, so a reader can tell
// crossing wires apart from a junction). The rule is single-sided by construction: a HORIZONTAL segment
// hops over a VERTICAL crosser; a vertical segment never hops. So exactly ONE line arcs per orthogonal
// crossing (never both, which would look like a knot), with zero coordination between the two connectors.
//
// Pure leaf (only the `Pt` geometry type). Operates on the polyline POINTS of a straight-segment path, so
// it composes with every orthogonal routing mode (elbow, waypoints, and b85's obstacle-`avoid`); a curved
// path (a `Q` in its `d`) yields no points → no jumps (returned `d` is the input unchanged upstream).

import type { Pt } from './connector-geometry.ts';

/** A straight segment between two points (a crossing candidate from another connector). */
export interface Seg {
  readonly a: Pt;
  readonly b: Pt;
}

const DEFAULT_RADIUS = 6;

/** Parse an `M x y L x y L …` line path into its points. Returns [] if the path holds ANY non-line command
 *  (a `Q`/`C`/`A` — i.e. a curved or already-jumped path), so jumps only ever apply to plain polylines. */
export function pointsFromLinePath(d: string): Pt[] {
  const tokens = d.trim().split(/[\s,]+/).filter(Boolean);
  const pts: Pt[] = [];
  let i = 0;
  let expectCmd = true;
  while (i < tokens.length) {
    if (expectCmd) {
      const cmd = tokens[i];
      if (cmd !== 'M' && cmd !== 'L') return []; // any curve/arc/other command → not a plain polyline
      i += 1;
      const x = Number(tokens[i]);
      const y = Number(tokens[i + 1]);
      if (!Number.isFinite(x) || !Number.isFinite(y)) return [];
      pts.push({ x, y });
      i += 2;
      // SVG allows implicit repeated coords after one command; treat the next token as coords if numeric.
      expectCmd = false;
    } else if (/^-?\d/.test(tokens[i])) {
      const x = Number(tokens[i]);
      const y = Number(tokens[i + 1]);
      if (!Number.isFinite(x) || !Number.isFinite(y)) return [];
      pts.push({ x, y });
      i += 2;
    } else {
      expectCmd = true;
    }
  }
  return pts;
}

/** The VERTICAL segments of a point polyline — the crossers other connectors hop over. */
export function verticalSegments(points: readonly Pt[]): Seg[] {
  const segs: Seg[] = [];
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1];
    const b = points[i];
    if (a.x === b.x && a.y !== b.y) segs.push({ a, b });
  }
  return segs;
}

/**
 * The SVG path `d` for `points`, inserting a small semicircular hop on each HORIZONTAL segment wherever it
 * crosses one of the vertical `crossers`. Non-horizontal segments and crossing-free stretches stay straight.
 * The hop radius is clamped per-crossing so adjacent hops (or a hop near a corner) never overlap or overshoot.
 */
export function pathWithJumps(points: readonly Pt[], crossers: readonly Seg[], radius = DEFAULT_RADIUS): string {
  if (points.length < 2) return points.length === 1 ? `M ${points[0].x} ${points[0].y}` : '';
  let d = `M ${points[0].x} ${points[0].y}`;
  for (let i = 1; i < points.length; i++) {
    const p = points[i - 1];
    const q = points[i];
    if (p.y !== q.y || p.x === q.x) {
      d += ` L ${q.x} ${q.y}`;
      continue;
    }
    // Horizontal segment: collect the x of every vertical crosser that passes strictly through its interior.
    const y = p.y;
    const lo = Math.min(p.x, q.x);
    const hi = Math.max(p.x, q.x);
    const dir = q.x > p.x ? 1 : -1;
    const xsSet = new Set<number>();
    for (const s of crossers) {
      const vx = s.a.x;
      if (s.a.x !== s.b.x) continue; // not vertical
      const y0 = Math.min(s.a.y, s.b.y);
      const y1 = Math.max(s.a.y, s.b.y);
      if (vx > lo && vx < hi && y > y0 && y < y1) xsSet.add(vx);
    }
    if (xsSet.size === 0) {
      d += ` L ${q.x} ${q.y}`;
      continue;
    }
    // Sort along travel direction, then hop over each — clamping the radius so hops never overlap/overshoot.
    const xs = [...xsSet].sort((m, n) => (dir > 0 ? m - n : n - m));
    let cursor = p.x;
    for (let k = 0; k < xs.length; k++) {
      const cx = xs[k];
      const prevBound = k === 0 ? p.x : xs[k - 1];
      const nextBound = k === xs.length - 1 ? q.x : xs[k + 1];
      const r = Math.min(radius, Math.abs(cx - prevBound) / 2, Math.abs(nextBound - cx) / 2);
      if (r <= 0) continue; // too tight to hop cleanly → pass straight through
      const before = cx - dir * r;
      const after = cx + dir * r;
      d += ` L ${before} ${y}`;
      // Semicircle bulging UP (toward smaller y). The sweep flag flips with travel direction so the arc
      // always peaks above the line: rightward → sweep 0, leftward → sweep 1.
      const sweep = dir > 0 ? 0 : 1;
      d += ` A ${r} ${r} 0 0 ${sweep} ${after} ${y}`;
      cursor = after;
    }
    d += ` L ${q.x} ${q.y}`;
    void cursor;
  }
  return d;
}

/** The vertices a connector's routed path passes through, in order: line commands as they are, and each `Q`/`C` curve
 *  flattened into `segments` straight pieces. This is what a hand-drawn (rough) stroke traces, so the line a person
 *  sees follows the same route as the hit band they click (straight, elbow, avoid, custom bends or curved). Returns []
 *  for a command it does not know, so the caller keeps its own fallback. */
export function pointsAlongPath(d: string, segments = 12): Pt[] {
  const tokens = d.trim().split(/[\s,]+/).filter(Boolean);
  const pts: Pt[] = [];
  let i = 0;
  let cmd = '';
  const num = () => Number(tokens[i++]);
  while (i < tokens.length) {
    if (/^[A-Za-z]$/.test(tokens[i])) cmd = tokens[i++];
    const at = pts[pts.length - 1];
    if (cmd === 'M' || cmd === 'L') {
      const x = num();
      const y = num();
      if (!Number.isFinite(x) || !Number.isFinite(y)) return [];
      pts.push({ x, y });
    } else if ((cmd === 'Q' || cmd === 'C') && at) {
      const controls: Pt[] = [];
      for (let n = cmd === 'Q' ? 2 : 3; n > 0; n -= 1) {
        const x = num();
        const y = num();
        if (!Number.isFinite(x) || !Number.isFinite(y)) return [];
        controls.push({ x, y });
      }
      const [c1, c2, end] = cmd === 'Q' ? [controls[0], controls[0], controls[1]] : controls;
      for (let step = 1; step <= segments; step += 1) {
        const t = step / segments;
        const u = 1 - t;
        pts.push(cmd === 'Q'
          ? { x: u * u * at.x + 2 * u * t * c1.x + t * t * end.x, y: u * u * at.y + 2 * u * t * c1.y + t * t * end.y }
          : { x: u * u * u * at.x + 3 * u * u * t * c1.x + 3 * u * t * t * c2.x + t * t * t * end.x,
              y: u * u * u * at.y + 3 * u * u * t * c1.y + 3 * u * t * t * c2.y + t * t * t * end.y });
      }
    } else {
      return [];
    }
  }
  return pts;
}
