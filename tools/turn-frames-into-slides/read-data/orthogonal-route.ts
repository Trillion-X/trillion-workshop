// tools/turn-frames-into-slides/read-data/orthogonal-route.ts
//
// The OBSTACLE-AVOIDING orthogonal router — the generative primitive behind "draw a connector that dodges
// the boxes in its way" (the draw.io / yEd / Visio canon). Given two endpoint boxes and the OTHER node
// boxes (obstacles), it returns the vertices of an axis-aligned polyline from one box edge to the other
// that (a) is fully orthogonal (every segment horizontal or vertical), (b) never crosses the interior of
// any obstacle (each inflated by a clearance margin), and (c) prefers the fewest turns + shortest length.
//
// It is the GENERAL case, not a one-box hack: it runs A* over the ORTHOGONAL VISIBILITY GRID formed by the
// obstacles' own edge coordinates (the standard reduction — an optimal rectilinear route only ever turns
// on a line flush with some obstacle edge or an endpoint), so ANY number of obstacles in ANY arrangement
// composes for free (L069 adversarial-combinatorial: N boxes, nested, staggered, or a corridor all route
// from ONE search). Fail-open: a fully boxed-in target falls back to the naive L-elbow — a connector never
// throws and never vanishes. Pure leaf (zero I/O, only the Pt/ConnectorRect geometry types).

import type { Pt, ConnectorRect } from './connector-geometry.ts';

export interface OrthoRouteOptions {
  /** Clearance kept around every obstacle (px). Obstacles are inflated by this before routing. */
  readonly margin?: number;
  /** Extra cost charged per 90° turn, in px — biases the search toward fewer bends (default 20). */
  readonly turnPenalty?: number;
}

const DEFAULT_MARGIN = 12;
const DEFAULT_TURN_PENALTY = 20;

const left = (r: ConnectorRect) => r.x;
const right = (r: ConnectorRect) => r.x + r.w;
const top = (r: ConnectorRect) => r.y;
const bottom = (r: ConnectorRect) => r.y + r.h;
const cx = (r: ConnectorRect) => r.x + r.w / 2;
const cy = (r: ConnectorRect) => r.y + r.h / 2;

const inflate = (r: ConnectorRect, m: number): ConnectorRect => ({ x: r.x - m, y: r.y - m, w: r.w + 2 * m, h: r.h + 2 * m });

const uniqSorted = (xs: readonly number[]): number[] => Array.from(new Set(xs)).sort((p, q) => p - q);

/** Does the AXIS-ALIGNED segment p→q cross the INTERIOR of `r`? Grazing an edge (collinear with a side, or
 *  touching a corner) is NOT a crossing — so a route may run flush along an obstacle's inflated boundary. */
function segCrossesRect(p: Pt, q: Pt, r: ConnectorRect): boolean {
  if (p.x === q.x) {
    const x = p.x;
    if (x <= left(r) || x >= right(r)) return false; // outside the vertical band (or grazing a side)
    const y0 = Math.min(p.y, q.y);
    const y1 = Math.max(p.y, q.y);
    return y0 < bottom(r) && y1 > top(r); // vertical extent overlaps the interior
  }
  const y = p.y;
  if (y <= top(r) || y >= bottom(r)) return false;
  const x0 = Math.min(p.x, q.x);
  const x1 = Math.max(p.x, q.x);
  return x0 < right(r) && x1 > left(r);
}

const blockedBetween = (p: Pt, q: Pt, blocks: readonly ConnectorRect[]): boolean => blocks.some((b) => segCrossesRect(p, q, b));

/** The point on `box`'s edge facing `toward` — the connector's exit/entry stub anchor (edge CENTRE of the
 *  side the other box lies toward, chosen on the dominant axis so the stub leaves square to the box). */
function edgeAnchor(box: ConnectorRect, toward: ConnectorRect): Pt {
  const dx = cx(toward) - cx(box);
  const dy = cy(toward) - cy(box);
  if (Math.abs(dx) >= Math.abs(dy)) return { x: dx >= 0 ? right(box) : left(box), y: cy(box) };
  return { x: cx(box), y: dy >= 0 ? bottom(box) : top(box) };
}

/** Collapse runs of collinear vertices (A→B→C with B on segment A–C) so the polyline is minimal. */
function simplify(points: readonly Pt[]): Pt[] {
  if (points.length <= 2) return [...points];
  const out: Pt[] = [points[0]];
  for (let i = 1; i < points.length - 1; i++) {
    const a = out[out.length - 1];
    const b = points[i];
    const c = points[i + 1];
    const collinear = (a.x === b.x && b.x === c.x) || (a.y === b.y && b.y === c.y);
    if (!collinear) out.push(b);
  }
  out.push(points[points.length - 1]);
  return out;
}

/**
 * The vertices of an orthogonal polyline from `from`'s edge to `to`'s edge that avoids every obstacle.
 * Always returns ≥2 points; the first sits on `from`, the last on `to`. `obstacles` should exclude the two
 * endpoint boxes (they are the anchors, not walls). Deterministic.
 */
export function orthogonalAvoidRoute(
  from: ConnectorRect,
  to: ConnectorRect,
  obstacles: readonly ConnectorRect[],
  opts?: OrthoRouteOptions,
): Pt[] {
  const margin = opts?.margin ?? DEFAULT_MARGIN;
  const turnPenalty = opts?.turnPenalty ?? DEFAULT_TURN_PENALTY;
  const start = edgeAnchor(from, to);
  const goal = edgeAnchor(to, from);
  const blocks = obstacles.map((o) => inflate(o, margin));

  // The orthogonal visibility grid: candidate turn lines are the endpoints' coords + each obstacle's
  // inflated edges (an optimal rectilinear path only bends on such a line). Small grid → fast A*.
  const xs = uniqSorted([start.x, goal.x, ...blocks.flatMap((b) => [left(b), right(b)])]);
  const ys = uniqSorted([start.y, goal.y, ...blocks.flatMap((b) => [top(b), bottom(b)])]);
  const xi = new Map(xs.map((v, i) => [v, i]));
  const yi = new Map(ys.map((v, i) => [v, i]));
  const key = (ix: number, iy: number) => iy * xs.length + ix;
  const startK = key(xi.get(start.x)!, yi.get(start.y)!);
  const goalK = key(xi.get(goal.x)!, yi.get(goal.y)!);

  // A* with a turn penalty. State = grid node; we track the incoming direction to charge bends.
  const gScore = new Map<number, number>();
  const cameFrom = new Map<number, number>();
  const dirOf = new Map<number, number>(); // 2 = none (start); 0 = last move horizontal, 1 = vertical
  const nodeAt = (k: number): Pt => ({ x: xs[k % xs.length], y: ys[Math.floor(k / xs.length)] });
  const heur = (k: number): number => {
    const p = nodeAt(k);
    return Math.abs(p.x - goal.x) + Math.abs(p.y - goal.y);
  };
  // Simple binary-heap-free open set (grids here are tiny — a few hundred nodes at most).
  const open = new Set<number>([startK]);
  gScore.set(startK, 0);
  dirOf.set(startK, 2);

  const popLowest = (): number => {
    let best = -1;
    let bestF = Infinity;
    for (const k of open) {
      const f = (gScore.get(k) ?? Infinity) + heur(k);
      if (f < bestF) {
        bestF = f;
        best = k;
      }
    }
    return best;
  };

  while (open.size > 0) {
    const current = popLowest();
    if (current === goalK) break;
    open.delete(current);
    const ix = xi.get(nodeAt(current).x)!;
    const iy = yi.get(nodeAt(current).y)!;
    const p = nodeAt(current);
    // 4 orthogonal neighbours (adjacent grid lines).
    const neighbours: Array<[number, 0 | 1]> = [];
    if (ix > 0) neighbours.push([key(ix - 1, iy), 0]);
    if (ix < xs.length - 1) neighbours.push([key(ix + 1, iy), 0]);
    if (iy > 0) neighbours.push([key(ix, iy - 1), 1]);
    if (iy < ys.length - 1) neighbours.push([key(ix, iy + 1), 1]);
    for (const [nk, axis] of neighbours) {
      const q = nodeAt(nk);
      if (blockedBetween(p, q, blocks)) continue;
      const step = Math.abs(q.x - p.x) + Math.abs(q.y - p.y);
      const prevDir = dirOf.get(current)!;
      const turned = prevDir !== 2 && prevDir !== axis ? turnPenalty : 0;
      const tentative = (gScore.get(current) ?? Infinity) + step + turned;
      if (tentative < (gScore.get(nk) ?? Infinity)) {
        cameFrom.set(nk, current);
        gScore.set(nk, tentative);
        dirOf.set(nk, axis);
        open.add(nk);
      }
    }
  }

  if (!cameFrom.has(goalK) && startK !== goalK) {
    // Boxed in — fall back to a naive L-elbow (never fail, never vanish).
    const corner: Pt = { x: goal.x, y: start.y };
    return simplify([start, corner, goal]);
  }

  const path: Pt[] = [];
  let cur = goalK;
  while (true) {
    path.unshift(nodeAt(cur));
    if (cur === startK) break;
    const prev = cameFrom.get(cur);
    if (prev === undefined) break; // defensive — reconstruction always reaches the start
    cur = prev;
  }
  return simplify(path.length >= 2 ? path : [start, goal]);
}
