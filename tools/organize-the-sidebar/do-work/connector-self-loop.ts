// packages/group/do-work/connector-self-loop.ts
//
// SELF-LOOP CONNECTORS — the generative primitive behind "a connector from an item back to ITSELF"
// (the draw.io / yEd / Graphviz self-edge canon: a recursive task, an idea that reinforces itself, a
// state with a self-transition). A straight/elbow/curved route can't express this: both endpoints resolve
// to the same box toward its own centre, collapsing to a zero-length `M x y L x y` that renders as nothing.
// This leaf gives a self-edge a real shape — a rounded loop that leaves the top of the box and returns to
// an adjacent point on the same edge — and, when a node carries MORE THAN ONE self-loop, NESTS them at
// growing reach so each stays distinct (the same "one bundle, symmetric family" idea the fan leaf uses for
// parallel edges, here as concentric loops rather than side-by-side bows).
//
// Pure leaf (only the geometry types). A self-loop is a cubic (`C`), so — like every curved connector — it
// yields no polyline and simply sits out the crossing-jump pass (b87) and the parallel fan (b88).

import type { ConnectorRect, ConnectorGeometry } from './connector-geometry';
import type { FanEdge } from './connector-fan';

const BASE_REACH = 30; // how far the first loop bulges off the box edge
const REACH_STEP = 16; // extra reach per additional self-loop on the same node (nested, distinct)

/**
 * The nesting index per self-loop edge id. Edges whose two ends are the SAME node are grouped by that node
 * and numbered 0,1,2,… ordered by edge id (deterministic); a normal edge (`from !== to`) is ABSENT → the
 * caller reads 0 and only calls `selfLoopPath` when it detects a self-edge anyway. This is the self-loop
 * twin of `fanLaneMultipliers`: one bundle → a distinct-per-member family.
 */
export function selfLoopIndices(edges: readonly FanEdge[]): Map<string, number> {
  const byNode = new Map<string, FanEdge[]>();
  for (const e of edges) {
    if (e.from !== e.to) continue; // only self-edges nest
    const list = byNode.get(e.from);
    if (list) list.push(e);
    else byNode.set(e.from, [e]);
  }
  const out = new Map<string, number>();
  for (const list of byNode.values()) {
    const sorted = [...list].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    sorted.forEach((e, i) => out.set(e.id, i));
  }
  return out;
}

/**
 * The geometry of a self-loop on box `r`, nesting index `index` (0 = innermost). A rounded loop that
 * leaves the TOP edge just left of centre, bulges up and around, and returns just right of centre — a
 * cubic bezier whose control points are pushed up by `reach` and splayed outward so the loop reads as a
 * teardrop above the card. Higher `index` → larger `reach` and a wider mouth, so stacked self-loops nest
 * as concentric loops. `p1`/`p2` sit on the box edge (endpoint handles land on the card); `mid` is the top
 * of the loop (the label-chip anchor). Matches the `ConnectorGeometry` contract so the render layer stays
 * a blind consumer — it never knows this path is a loop rather than a straight line.
 */
export function selfLoopPath(r: ConnectorRect, index = 0): ConnectorGeometry {
  const reach = BASE_REACH + index * REACH_STEP;
  const cx = r.x + r.w / 2;
  const half = Math.min(r.w * 0.3, 14 + index * 4); // mouth half-width, widening per nested loop
  const p1 = { x: cx - half, y: r.y };
  const p2 = { x: cx + half, y: r.y };
  const c1 = { x: p1.x - reach * 0.6, y: r.y - reach };
  const c2 = { x: p2.x + reach * 0.6, y: r.y - reach };
  const d = `M ${p1.x} ${p1.y} C ${c1.x} ${c1.y} ${c2.x} ${c2.y} ${p2.x} ${p2.y}`;
  const mid = { x: cx, y: r.y - reach * 0.75 };
  return { d, p1, p2, mid };
}
