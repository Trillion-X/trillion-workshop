// packages/group/do-work/connector-fan.ts
//
// PARALLEL MULTI-EDGE FAN-OUT — the generative primitive behind "when two cards have MORE THAN ONE
// connector between them, the wires bow apart instead of stacking invisibly on top of each other" (the
// yEd / Graphviz / draw.io multi-edge canon). Two straight connectors between the same pair resolve to
// the IDENTICAL path, so one hides the other entirely; a reader can't tell there are two relations. This
// leaf assigns every connector in a coincident-endpoint BUNDLE a signed lane multiplier symmetric about
// zero, and bows each edge perpendicular to its chord by that lane — so a bundle of n fans into n visibly
// separate, symmetric arcs. A SINGLETON (the overwhelmingly-common case) gets multiplier 0 → its exact
// routing is byte-identical (zero regression), which is why this is safe to run always-on: it only ever
// changes boards that actually have overlapping edges, where separation is unconditionally wanted (L083).
//
// Pure leaf (only the `Pt` geometry type). The bow is a quadratic (matching the `curved` routing), so a
// fanned edge — like any curved path — yields no polyline and simply sits out the crossing-jump pass.

import type { Pt } from './connector-geometry';

/** One connector reduced to its identity + endpoints (all the fan needs; the layer maps its models to these). */
export interface FanEdge {
  readonly id: string;
  readonly from: string;
  readonly to: string;
}

/** The distance (px) between adjacent lanes in a bundle — the fan's total spread is `(n-1) * FAN_SPACING`. */
export const FAN_SPACING = 26;

/** Unordered endpoint-pair key so A→B and B→A land in the SAME bundle (a relation's direction doesn't
 *  change that two cards are wired twice). NUL-joined so ids can't collide across the boundary. */
export function pairKey(from: string, to: string): string {
  return from < to ? `${from}\u0000${to}` : `${to}\u0000${from}`;
}

/**
 * Signed lane multiplier per edge id. Within each bundle of coincident-endpoint edges of size n ≥ 2, the
 * edges fan SYMMETRICALLY about 0: ordered by id (deterministic), edge i of n gets `i - (n-1)/2` — so a
 * pair fans to `[-0.5, +0.5]`, a triple to `[-1, 0, +1]`, a quad to `[-1.5, -0.5, +0.5, +1.5]`, etc.
 * Singletons (a lone edge on its pair) and self-pairs (`from === to`, a self-loop is not a parallel bundle)
 * are ABSENT from the map → the caller reads 0 → their routing is untouched.
 */
export function fanLaneMultipliers(edges: readonly FanEdge[]): Map<string, number> {
  const bundles = new Map<string, FanEdge[]>();
  for (const e of edges) {
    if (e.from === e.to) continue; // self-loop — not a parallel bundle
    const k = pairKey(e.from, e.to);
    const list = bundles.get(k);
    if (list) list.push(e);
    else bundles.set(k, [e]);
  }
  const out = new Map<string, number>();
  for (const list of bundles.values()) {
    if (list.length < 2) continue; // singleton keeps its exact routing (multiplier 0)
    const sorted = [...list].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    const mid = (sorted.length - 1) / 2;
    sorted.forEach((e, i) => out.set(e.id, i - mid));
  }
  return out;
}

/**
 * A gentle perpendicular bow of the chord `p1`→`p2` by `offset` px (signed — the sign picks the side).
 * The path is a quadratic whose control point is the chord midpoint pushed along the perpendicular by
 * `2 * offset`, so the on-curve peak sits ≈ `offset` off the straight line. Returns the `d` and the
 * on-curve midpoint (a quadratic at t=0.5 is `(p1 + 2·ctrl + p2)/4`) for the label chip. `offset === 0`
 * → the plain straight segment (byte-identical to `straightRouting`).
 */
export function bowedChord(p1: Pt, p2: Pt, offset: number): { d: string; mid: Pt } {
  if (!offset) {
    return { d: `M ${p1.x} ${p1.y} L ${p2.x} ${p2.y}`, mid: { x: (p1.x + p2.x) / 2, y: (p1.y + p2.y) / 2 } };
  }
  const dx = p2.x - p1.x;
  const dy = p2.y - p1.y;
  const len = Math.hypot(dx, dy) || 1;
  const nx = -dy / len; // unit perpendicular
  const ny = dx / len;
  const cmx = (p1.x + p2.x) / 2;
  const cmy = (p1.y + p2.y) / 2;
  const ctrl = { x: cmx + nx * offset * 2, y: cmy + ny * offset * 2 };
  const mid = { x: (p1.x + 2 * ctrl.x + p2.x) / 4, y: (p1.y + 2 * ctrl.y + p2.y) / 4 };
  return { d: `M ${p1.x} ${p1.y} Q ${ctrl.x} ${ctrl.y} ${p2.x} ${p2.y}`, mid };
}
