// tools/turn-frames-into-slides/read-data/connector-geometry.ts
//
// =============================================================================
// PURPOSE
// =============================================================================
//
// PURE connector geometry for the board: given two item rectangles (+ optional
// routing and fixed-port anchors as DATA), produce the SVG path `d` string, the
// two endpoints (for re-anchor handles), and the label-chip anchor. No React, no
// DOM — extracted out of ConnectorLayer.tsx so the geometry is unit-testable and
// the render layer stays a blind consumer of the path string (L090).
//
// FIXED PORTS (#2) — a connector endpoint may PIN to a fixed point on its item's
// box instead of auto-routing to the nearest border. The pin is NOT an enum of
// {top,right,bottom,left}: it is a NORMALIZED point `{ nx, ny }` in 0..1 within
// the box (top-center = {0.5,0}, right-center = {1,0.5}, top-left = {0,0}). The
// four cardinal ports are four DATA values; any fraction is equally valid. When
// an anchor is ABSENT the endpoint auto-routes exactly as before (absent → no-op,
// so the pre-anchor behavior is byte-identical). This is the L069 generative form
// of "fixed ports": one point-resolver, infinite port positions, zero new code.
//
// =============================================================================
// The extensive documentation in this codebase is a critical design feature.
// You are forbidden from simplifying or removing it.
// =============================================================================

import { finiteCoord } from './finite-coord.ts';
import { orthogonalAvoidRoute } from './orthogonal-route.ts';
import { catmullRomPath } from './catmull-rom.ts';

export interface ConnectorRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface Pt {
  x: number;
  y: number;
}

/** A fixed connector port as DATA: a normalized point in 0..1 within the item box.
 *  `{0.5,0}`=top-center, `{1,0.5}`=right-center, `{0,1}`=bottom-left, etc. */
export interface ConnectorAnchor {
  nx: number;
  ny: number;
}

/** The routing keys shipped in `ROUTING_ALGORITHMS` below. This names the built-in
 *  set for the picker's type-safety — it is NOT the closed universe: `connectorPath`
 *  dispatches by string through an OPEN capability map, so a package/composition root
 *  can register a new routing algorithm without this type or the dispatcher changing
 *  (L069/L090). Treat `routing` on the wire as `string`; this alias is convenience.
 *  `waypoints` threads the line through user-placed bend points (`extra.waypoints`) —
 *  the generalization of the other three: straight is `waypoints` with an empty list. */
export type ConnectorRouting = 'straight' | 'curved' | 'elbow' | 'waypoints' | 'avoid' | 'smooth' | 'diagonal';

export interface ConnectorGeometry {
  d: string;
  p1: Pt;
  p2: Pt;
  mid: Pt;
}

function clamp01(v: number): number {
  if (!Number.isFinite(v)) return 0;
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

export function center(r: ConnectorRect): Pt {
  return { x: r.x + r.w / 2, y: r.y + r.h / 2 };
}

/** The fixed point a normalized anchor names on `r`'s box (the #2 port resolver). */
export function anchorPoint(r: ConnectorRect, a: ConnectorAnchor): Pt {
  return { x: r.x + clamp01(a.nx) * r.w, y: r.y + clamp01(a.ny) * r.h };
}

/** Parse a connector anchor out of self-describing member DATA (`extra.fromAnchor`
 *  /`extra.toAnchor`). Returns undefined for anything that is not a `{nx,ny}` pair
 *  of finite numbers — so a malformed or absent value cleanly means "auto-route". */
export function readConnectorAnchor(value: unknown): ConnectorAnchor | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const v = value as { nx?: unknown; ny?: unknown };
  if (typeof v.nx !== 'number' || typeof v.ny !== 'number') return undefined;
  if (!Number.isFinite(v.nx) || !Number.isFinite(v.ny)) return undefined;
  return { nx: v.nx, ny: v.ny };
}

/** Parse the ordered bend-point list out of self-describing member DATA
 *  (`extra.waypoints`). Each entry is an ABSOLUTE world point `{x,y}` (not
 *  normalized like an anchor — a bend is a free point in board space, not a spot on
 *  a box). Anything that is not an array of finite `{x,y}` pairs, or an entry that
 *  is malformed, is dropped — so a missing/garbage value cleanly means "no bends"
 *  (the line is a plain straight/routed segment, byte-identical to pre-#194). */
/** Max bend points kept from one connector's `extra.waypoints` — a guardrail against a
 *  paste-bombed/corrupted persisted value (millions of points → a walk + allocate of every
 *  point, then a giant SVG path string), NOT a feature cap. A hand-routed line has a handful
 *  of bends; 256 is generous headroom while bounding the work. Fail closed at the leaf. */
const MAX_WAYPOINTS = 256;
/** Max RAW entries scanned from one `extra.waypoints` — distinct from `MAX_WAYPOINTS` (kept points).
 *  The kept-cap alone still walks the WHOLE array when every entry is garbage (a million `null`s that
 *  never fill the keep-budget = a million-iteration CPU DoS). This bounds the SCAN itself. No real
 *  waypoint list is a fraction of this; a hostile/corrupted one is refused past it. */
const MAX_WAYPOINT_INPUT = 100_000;

export function readWaypoints(value: unknown): Pt[] {
  if (!Array.isArray(value)) return [];
  const out: Pt[] = [];
  const scanLimit = Math.min(value.length, MAX_WAYPOINT_INPUT); // bound the scan, not just the kept count
  for (let idx = 0; idx < scanLimit; idx++) {
    const entry = value[idx];
    if (!entry || typeof entry !== 'object') continue;
    const p = entry as { x?: unknown; y?: unknown };
    if (typeof p.x !== 'number' || typeof p.y !== 'number') continue;
    if (!Number.isFinite(p.x) || !Number.isFinite(p.y)) continue; // drop non-finite (never a 0,0 bend)
    out.push({ x: finiteCoord(p.x), y: finiteCoord(p.y) }); // clamp a finite-huge MAX_VALUE bend
    if (out.length >= MAX_WAYPOINTS) break;
  }
  return out;
}

/** Perpendicular distance from point `p` to the segment `a→b` (clamped to the
 *  segment, so it's the true nearest-point distance, not the infinite-line one).
 *  Pure — used to decide which segment of a routed polyline a click lands on. */
function distToSegment(p: Pt, a: Pt, b: Pt): number {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const len2 = dx * dx + dy * dy;
  if (len2 === 0) return Math.hypot(p.x - a.x, p.y - a.y);
  let t = ((p.x - a.x) * dx + (p.y - a.y) * dy) / len2;
  t = t < 0 ? 0 : t > 1 ? 1 : t;
  return Math.hypot(p.x - (a.x + t * dx), p.y - (a.y + t * dy));
}

/**
 * Insert a new bend at `click`, ordered into `waypoints` at the position matching
 * the segment of the current polyline the click is nearest to. The full vertex
 * chain is `[p1, ...waypoints, p2]`; the nearest segment index equals the insert
 * index into `waypoints` (segment i runs chain[i]→chain[i+1]; inserting at i drops
 * the bend between that pair). Pure — returns a NEW array, never mutates. This is
 * the "double-click the line to add a bend" op (Lucidchart/draw.io canon).
 */
export function insertBendAt(p1: Pt, waypoints: readonly Pt[], p2: Pt, click: Pt): Pt[] {
  const chain: Pt[] = [p1, ...waypoints, p2];
  let bestIndex = 0;
  let bestDist = Infinity;
  for (let i = 0; i < chain.length - 1; i++) {
    const dist = distToSegment(click, chain[i], chain[i + 1]);
    if (dist < bestDist) {
      bestDist = dist;
      bestIndex = i;
    }
  }
  const next = waypoints.slice();
  next.splice(bestIndex, 0, { x: click.x, y: click.y });
  return next;
}

/** Reposition the bend at `index` to `pt` (dragging a waypoint handle). Out-of-range
 *  index → unchanged copy. Pure — returns a NEW array. */
export function moveWaypoint(waypoints: readonly Pt[], index: number, pt: Pt): Pt[] {
  const next = waypoints.slice();
  if (index < 0 || index >= next.length) return next;
  next[index] = { x: pt.x, y: pt.y };
  return next;
}

/** Remove the bend at `index` (double-click a waypoint handle to delete it). Out-of-
 *  range index → unchanged copy. Pure — returns a NEW array. */
export function removeWaypoint(waypoints: readonly Pt[], index: number): Pt[] {
  const next = waypoints.slice();
  if (index < 0 || index >= next.length) return next;
  next.splice(index, 1);
  return next;
}

/**
 * Where the ray from `r`'s center toward `(tx,ty)` crosses `r`'s border — so the
 * line touches the box edge nearest the other item instead of piercing to the
 * center. Pure geometry: scale the center→target vector until it hits the nearer
 * of the two half-extents. This is the AUTO-routing fallback used when an endpoint
 * has no fixed-port anchor.
 */
export function edgePoint(r: ConnectorRect, tx: number, ty: number): Pt {
  const c = center(r);
  const dx = tx - c.x;
  const dy = ty - c.y;
  if (dx === 0 && dy === 0) return c;
  // Half-extents. A ZERO-or-negative (degenerate) extent must NOT enter the ratio as a
  // divisor: on a collapsed axis `Math.abs(0) / 0` is 0/0 = NaN, and `Math.max(NaN, …)` is
  // NaN, so the endpoint became {NaN, NaN} — a broken `M NaN NaN` path that vanishes on the
  // live board and in the SVG export (Codex batch-5 + independent pass both reproduced with a
  // zero-WIDTH item whose partner sits on its vertical axis). On a collapsed axis the box has
  // no reach there, so that axis simply does not constrain the exit ray: ratio 0 when the
  // target is aligned on it, Infinity when it is off it.
  const hw = r.w > 0 ? r.w / 2 : 0;
  const hh = r.h > 0 ? r.h / 2 : 0;
  const ratioX = hw > 0 ? Math.abs(dx) / hw : dx === 0 ? 0 : Infinity;
  const ratioY = hh > 0 ? Math.abs(dy) / hh : dy === 0 ? 0 : Infinity;
  const denom = Math.max(ratioX, ratioY);
  // Fully degenerate box (or a non-finite ratio) → the center is the only sane crossing.
  if (!Number.isFinite(denom) || denom <= 0) return c;
  const scale = 1 / denom;
  const x = c.x + dx * scale;
  const y = c.y + dy * scale;
  return Number.isFinite(x) && Number.isFinite(y) ? { x, y } : c;
}

/** Resolve one endpoint: the fixed port if anchored, else the auto border crossing
 *  toward `toward`'s center. The single seam where ports and auto-routing meet. */
function endpoint(r: ConnectorRect, toward: ConnectorRect, anchor?: ConnectorAnchor): Pt {
  if (anchor) return anchorPoint(r, anchor);
  const t = center(toward);
  return edgePoint(r, t.x, t.y);
}

/**
 * A routing algorithm: given the two item boxes (+ optional fixed-port anchors),
 * produce the connector geometry (path `d` + endpoints + label anchor). This is the
 * behavior boundary the routing name selects. A new routing mode is ONE function of
 * this shape registered in `ROUTING_ALGORITHMS` — the dispatcher never learns its
 * name (L069 injected capability, L090 self-describing key → generic handler).
 */
export type RoutingAlgorithm = (
  a: ConnectorRect,
  b: ConnectorRect,
  fromAnchor?: ConnectorAnchor,
  toAnchor?: ConnectorAnchor,
  waypoints?: readonly Pt[],
  /** The OTHER node boxes on the board (obstacles), for routing modes that dodge them (`avoid`). Every
   *  built-in except `avoid` ignores this, so passing it is byte-identical for straight/curved/elbow. */
  obstacles?: readonly ConnectorRect[],
) => ConnectorGeometry;

/** straight: endpoint→endpoint, a single segment. Endpoints honor fixed-port anchors
 *  when present, else auto-route to the nearest border (byte-identical to pre-#2). */
const straightRouting: RoutingAlgorithm = (a, b, fromAnchor, toAnchor) => {
  const p1 = endpoint(a, b, fromAnchor);
  const p2 = endpoint(b, a, toAnchor);
  return {
    d: `M ${p1.x} ${p1.y} L ${p2.x} ${p2.y}`,
    p1,
    p2,
    mid: { x: (p1.x + p2.x) / 2, y: (p1.y + p2.y) / 2 },
  };
};

/** curved: same endpoints as straight, a quadratic bezier whose control point is the
 *  chord midpoint pushed along the perpendicular (a gentle, consistent arc). */
const curvedRouting: RoutingAlgorithm = (a, b, fromAnchor, toAnchor) => {
  const p1 = endpoint(a, b, fromAnchor);
  const p2 = endpoint(b, a, toAnchor);
  const cmx = (p1.x + p2.x) / 2;
  const cmy = (p1.y + p2.y) / 2;
  const dx = p2.x - p1.x;
  const dy = p2.y - p1.y;
  const len = Math.hypot(dx, dy) || 1;
  const off = Math.min(60, len * 0.22);
  const ctrl = { x: cmx + (-dy / len) * off, y: cmy + (dx / len) * off };
  return {
    d: `M ${p1.x} ${p1.y} Q ${ctrl.x} ${ctrl.y} ${p2.x} ${p2.y}`,
    p1,
    p2,
    mid: { x: (cmx + ctrl.x) / 2, y: (cmy + ctrl.y) / 2 },
  };
};

/** elbow: axis-aligned route between the endpoints (horizontal-first when the boxes
 *  are mostly side-by-side, else vertical-first). Anchored endpoints use the fixed
 *  port; otherwise the box edge at center height/width (matching the original). */
const elbowRouting: RoutingAlgorithm = (a, b, fromAnchor, toAnchor) => {
  const ca = center(a);
  const cb = center(b);
  const horizontalFirst = Math.abs(cb.x - ca.x) >= Math.abs(cb.y - ca.y);
  const autoFrom: Pt = horizontalFirst
    ? { x: ca.x + Math.sign(cb.x - ca.x || 1) * (a.w / 2), y: ca.y }
    : { x: ca.x, y: ca.y + Math.sign(cb.y - ca.y || 1) * (a.h / 2) };
  const autoTo: Pt = horizontalFirst
    ? { x: cb.x - Math.sign(cb.x - ca.x || 1) * (b.w / 2), y: cb.y }
    : { x: cb.x, y: cb.y - Math.sign(cb.y - ca.y || 1) * (b.h / 2) };
  const p1 = fromAnchor ? anchorPoint(a, fromAnchor) : autoFrom;
  const p2 = toAnchor ? anchorPoint(b, toAnchor) : autoTo;
  if (horizontalFirst) {
    const midX = (p1.x + p2.x) / 2;
    const d = `M ${p1.x} ${p1.y} L ${midX} ${p1.y} L ${midX} ${p2.y} L ${p2.x} ${p2.y}`;
    return { d, p1, p2, mid: { x: midX, y: (p1.y + p2.y) / 2 } };
  }
  const midY = (p1.y + p2.y) / 2;
  const d = `M ${p1.x} ${p1.y} L ${p1.x} ${midY} L ${p2.x} ${midY} L ${p2.x} ${p2.y}`;
  return { d, p1, p2, mid: { x: (p1.x + p2.x) / 2, y: midY } };
};

/** waypoints: thread the line through the member's ordered bend points. The vertex
 *  chain is `[p1, ...waypoints, p2]`; endpoints honor fixed ports when present, else
 *  auto-route toward the FIRST/LAST bend (so the stub leaves the box aimed at its
 *  next turn) — or, with no bends at all, toward the other box center, making this
 *  BYTE-IDENTICAL to `straight`. This is the L069 generalization: straight/curved/
 *  elbow are the zero-or-computed-waypoint cases of one "polyline through points". */
/** avoid: an orthogonal route that dodges the OTHER node boxes (the `orthogonalAvoidRoute` leaf runs A* over
 *  the obstacles' visibility grid). Auto-routes edge-to-edge (fixed ports are overridden by the search —
 *  the whole point is automatic clearance). With no obstacles it degrades to a plain orthogonal line. */
const avoidRouting: RoutingAlgorithm = (a, b, _fromAnchor, _toAnchor, _waypoints, obstacles) => {
  const chain = orthogonalAvoidRoute(a, b, obstacles ?? []);
  const p1 = chain[0];
  const p2 = chain[chain.length - 1];
  const d = 'M ' + chain.map((p) => `${p.x} ${p.y}`).join(' L ');
  const m = Math.floor((chain.length - 1) / 2);
  const mid = { x: (chain[m].x + chain[m + 1].x) / 2, y: (chain[m].y + chain[m + 1].y) / 2 };
  return { d, p1, p2, mid };
};

const waypointRouting: RoutingAlgorithm = (a, b, fromAnchor, toAnchor, waypoints) => {
  const wps = waypoints ?? [];
  const firstTarget = wps.length ? wps[0] : center(b);
  const lastTarget = wps.length ? wps[wps.length - 1] : center(a);
  const p1 = fromAnchor ? anchorPoint(a, fromAnchor) : edgePoint(a, firstTarget.x, firstTarget.y);
  const p2 = toAnchor ? anchorPoint(b, toAnchor) : edgePoint(b, lastTarget.x, lastTarget.y);
  const chain: Pt[] = [p1, ...wps, p2];
  const d = 'M ' + chain.map((p) => `${p.x} ${p.y}`).join(' L ');
  // Label anchor: midpoint of the central segment of the whole chain, so the chip
  // sits ON the bent line (for 0 bends this is the p1↔p2 midpoint == straight).
  const m = Math.floor((chain.length - 1) / 2);
  const mid = { x: (chain[m].x + chain[m + 1].x) / 2, y: (chain[m].y + chain[m + 1].y) / 2 };
  return { d, p1, p2, mid };
};

/**
 * The routing capability map: routing key (self-describing member DATA) → algorithm.
 * `connectorPath` dispatches through this with a `straight` fallback and NEVER
 * branches on the routing name — the old `if (routing === 'elbow') … if (routing ===
 * 'curved') …` ladder is dissolved (L069/L090/enum-dissolution). Adding a routing
 * mode (orthogonal-rounded, stepped, waypointed, …) is ONE entry here plus one pure
 * `RoutingAlgorithm`; zero edits to the dispatcher, the render layer, or any consumer.
 * The map is `string`-keyed and open: a composition root can spread its own entries
 * over these built-ins to inject a routing the core never knew about.
 */
/** smooth: a Catmull-Rom spline that FLOWS through the member's bend points (the interpolating cousin of
 *  `waypoints`, which kinks at each bend, and of `curved`, which only bows the chord). Endpoints aim the
 *  stub at the first/last bend exactly like `waypoints`; with no bends the chain is just [p1,p2] and the
 *  spline degrades to a straight line (byte-visual to straight). One `catmullRomPath` over the chain. */
const smoothRouting: RoutingAlgorithm = (a, b, fromAnchor, toAnchor, waypoints) => {
  const wps = waypoints ?? [];
  const firstTarget = wps.length ? wps[0] : center(b);
  const lastTarget = wps.length ? wps[wps.length - 1] : center(a);
  const p1 = fromAnchor ? anchorPoint(a, fromAnchor) : edgePoint(a, firstTarget.x, firstTarget.y);
  const p2 = toAnchor ? anchorPoint(b, toAnchor) : edgePoint(b, lastTarget.x, lastTarget.y);
  const chain: Pt[] = [p1, ...wps, p2];
  const d = catmullRomPath(chain);
  const m = Math.floor((chain.length - 1) / 2);
  const mid = { x: (chain[m].x + chain[m + 1].x) / 2, y: (chain[m].y + chain[m + 1].y) / 2 };
  return { d, p1, p2, mid };
};

/** diagonal (b106): an OCTILINEAR route — a 45° diagonal segment then an axis-aligned segment (the metro-map
 *  / circuit "chamfered" wire). The diagonal covers the SHORTER axis's full delta in BOTH x and y (a true 45°
 *  leg); the remaining longer-axis delta is a straight horizontal/vertical run to the endpoint. Distinct from
 *  `elbow` (a 90° corner), `curved` (a bezier bow), and `smooth` (a spline): here every segment is either 45°
 *  or axis-aligned. Endpoints honour fixed-port anchors when present (via the shared `endpoint`). */
const diagonalRouting: RoutingAlgorithm = (a, b, fromAnchor, toAnchor) => {
  const p1 = endpoint(a, b, fromAnchor);
  const p2 = endpoint(b, a, toAnchor);
  const dx = p2.x - p1.x;
  const dy = p2.y - p1.y;
  const diag = Math.min(Math.abs(dx), Math.abs(dy)); // the 45° leg covers this in BOTH axes
  const corner: Pt =
    Math.abs(dx) >= Math.abs(dy)
      ? { x: p1.x + Math.sign(dx || 1) * diag, y: p2.y } // diagonal, then horizontal
      : { x: p2.x, y: p1.y + Math.sign(dy || 1) * diag }; // diagonal, then vertical
  return {
    d: `M ${p1.x} ${p1.y} L ${corner.x} ${corner.y} L ${p2.x} ${p2.y}`,
    p1,
    p2,
    mid: { x: (p1.x + p2.x) / 2, y: (p1.y + p2.y) / 2 },
  };
};

export const ROUTING_ALGORITHMS: Readonly<Record<string, RoutingAlgorithm>> = {
  straight: straightRouting,
  curved: curvedRouting,
  elbow: elbowRouting,
  waypoints: waypointRouting,
  avoid: avoidRouting,
  smooth: smoothRouting,
  diagonal: diagonalRouting,
};

/**
 * The connector's geometry as DATA → one SVG path. Generic dispatch: the routing key
 * selects a `RoutingAlgorithm` from `ROUTING_ALGORITHMS` (unknown/absent → `straight`),
 * which returns the `d` string and the endpoint/midpoint anchors. The element type
 * never branches on routing; with no anchors the output is identical to pre-#2.
 */
export function connectorPath(
  routing: string,
  a: ConnectorRect,
  b: ConnectorRect,
  fromAnchor?: ConnectorAnchor,
  toAnchor?: ConnectorAnchor,
  waypoints?: readonly Pt[],
  // The routing capability map is INJECTED, not core-owned — a package/composition root passes its
  // own map (extending or replacing the built-ins) so a new routing algorithm is DATA, never an
  // edit to this dispatcher (L090/enum-dissolution — a core-owned const would be an enum in disguise).
  // Defaults to the shipped built-ins, so every existing caller is byte-identical.
  algorithms: Readonly<Record<string, RoutingAlgorithm>> = ROUTING_ALGORITHMS,
  // The OTHER node boxes, for the `avoid` routing mode (dodges them); ignored by every other mode.
  // Last param so the injected-`algorithms` positional API stays backward-compatible.
  obstacles?: readonly ConnectorRect[],
): ConnectorGeometry {
  // Sanitize the untrusted geometry inputs at the ONE dispatch seam so every routing algorithm stays
  // self-sufficient (batch-24 precedent — clamp at the entry, never scatter clamps through the math):
  // a persisted `Number.MAX_VALUE` rect coord would otherwise overflow `center`/midpoint math to
  // ±Infinity in the emitted SVG `d`. Anchors are already `clamp01`-bounded to 0..1 inside `anchorPoint`,
  // so only the rects + any raw waypoints need clamping. The waypoint list is also bounded here in case a
  // caller passed one that bypassed `readWaypoints`. No-op for real geometry.
  const ra = finiteRect(a);
  const rb = finiteRect(b);
  const wps = waypoints ? clampWaypoints(waypoints) : undefined;
  // Own-key lookup only: `routing` is untrusted (`extra.routing` on a connector). A plain `algorithms[routing]`
  // with routing '__proto__' resolves to Object.prototype (truthy → skips the `??`) → not callable → CRASH;
  // 'constructor' → Object (callable) → returns `a` (a rect, not a ConnectorGeometry) → a broken `.d` path
  // downstream. hasOwn + a function check route any prototype-chain routing to the straight fallback.
  const picked = Object.prototype.hasOwnProperty.call(algorithms, routing) ? algorithms[routing] : undefined;
  const algorithm = typeof picked === 'function' ? picked : algorithms.straight ?? ROUTING_ALGORITHMS.straight;
  return algorithm(ra, rb, fromAnchor, toAnchor, wps, obstacles);
}

/** Clamp a rect's coords through the `finiteCoord` SSOT (a finite-huge MAX_VALUE coord would overflow
 *  center/midpoint math to ±Infinity); dimensions are floored at 0 (a negative w/h is never a real box). */
function finiteRect(r: ConnectorRect): ConnectorRect {
  return { x: finiteCoord(r.x), y: finiteCoord(r.y), w: Math.max(0, finiteCoord(r.w)), h: Math.max(0, finiteCoord(r.h)) };
}

/** Bound + finite-clamp an already-parsed waypoint list (defense-in-depth for a caller that bypassed
 *  `readWaypoints` — F6). Caps the count at `MAX_WAYPOINTS` and clamps each coord magnitude. */
function clampWaypoints(wps: readonly Pt[]): Pt[] {
  const n = Math.min(wps.length, MAX_WAYPOINTS);
  const out: Pt[] = [];
  for (let i = 0; i < n; i++) out.push({ x: finiteCoord(wps[i].x), y: finiteCoord(wps[i].y) });
  return out;
}
