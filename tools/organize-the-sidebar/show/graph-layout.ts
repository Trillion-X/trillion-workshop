// packages/group/show/graph-layout.ts
//
// The graph-layout leaf — pure, zero I/O, framework-agnostic. Positions connector-LINKED
// nodes BY their graph structure (the edge-AWARE sibling of `arrange-by-field`/`arrange-matrix`,
// which are edge-BLIND). ONE blind engine shape — a `GraphLayoutStrategy (nodes, edges, opts)
// → Map<id, localTopLeft>` — with the strategy INJECTED as DATA. Three ship (tidy tree /
// layered DAG / radial mind-map); a 4th (force-directed, Sugiyama-with-crossing-min, …) is one
// more strategy function + one catalog row, ZERO engine change (L069). The leaf is blind to
// which strategy runs and never enumerates them (L090). Coordinates are LOCAL (a virtual
// top-left origin); the do-work wrapper anchors the result at the selection's current position
// and commits — so this stays a pure, deterministic, unit-tested geometry surface (L098).
//
// Honesty (per Codex convergence 2026-07-05): "tidy tree" is a Reingold–Tilford-SHAPED solver
// (stack leaves, centre parents), not full RT contour/apportion; "layered DAG" is BFS/longest-
// path ranks + stable within-rank order, NOT Sugiyama (no crossing-reduction); "radial mind-map"
// is root-centred, depth→ring, subtree-leaf-count → angular wedge (a real mind-map, not a plain
// circle). All three are cycle-safe (feedback edges on the current path are skipped, never a
// silent no-op when a root exists) and forest-safe (disconnected components lay out side by side).

import { finiteCoord } from '../read-data/finite-coord';

/** A positionable node. `x`/`y` are its CURRENT position — used only as a stable visual
 *  tie-break for sibling/within-rank ordering (never as an output). Connectors are excluded
 *  by the caller before this leaf sees the nodes. */
export interface GraphNode {
  readonly memberId: string;
  readonly w: number;
  readonly h: number;
  readonly x?: number;
  readonly y?: number;
}

/** A directed parent→child relationship (a connector's from→to). */
export interface GraphEdge {
  readonly from: string;
  readonly to: string;
}

/** Spacing + root controls shared by every strategy (each reads the ones it needs). */
export interface GraphLayoutOptions {
  /** Horizontal gap after each depth/rank's widest node (tree + layered). Default 90. */
  readonly colGap?: number;
  /** Vertical gap between stacked siblings/subtrees/rank-peers. Default 40. */
  readonly rowGap?: number;
  /** Radial ring pitch (distance between depth rings). Default 160. */
  readonly ringGap?: number;
  /** Horizontal gap between disconnected components / separate roots. Default 80. */
  readonly componentGap?: number;
  /** Force this node as the single root; else every indegree-0 node with children roots. */
  readonly rootId?: string;
}

/** The injected seam: whole-graph in, LOCAL top-lefts out. An empty map = "no layout"
 *  (the caller leaves the board untouched). This is the ONE contract every layout satisfies. */
export type GraphLayoutStrategy = (
  nodes: readonly GraphNode[],
  edges: readonly GraphEdge[],
  opts?: GraphLayoutOptions,
) => Map<string, { x: number; y: number }>;

/** A FINITE, non-negative gap or the default. The strategies accumulate column/rank/ring offsets
 *  from these options, so a NaN/Infinity gap (a malformed DATA config) would poison every position
 *  into NaN. `?? default` only catches null/undefined — guard finiteness and fail closed. */
function finiteGap(v: number | undefined, def: number): number {
  return Number.isFinite(v) && (v as number) >= 0 ? (v as number) : def;
}

/** `Math.max` over an array WITHOUT spreading it into the call (`Math.max(...arr)` throws
 *  `RangeError: Maximum call stack size exceeded` once the array exceeds the JS argument limit —
 *  a wide imported graph of 150k nodes hit exactly that). A plain reduce is O(n) and unbounded-safe. */
function maxOf(values: Iterable<number>, seed = 0): number {
  let m = seed;
  for (const v of values) if (v > m) m = v;
  return m;
}

/** Recursion/most-nesting bound for the layout strategies. Their tree/graph walks recurse per level,
 *  so a pathological deep chain (a 20k-node n0→n1→…→n19999 line, reachable from an imported connector
 *  graph) would overflow the JS call stack — a RangeError DoS on "arrange as mind map/flow/radial". A
 *  20k-deep tree is unlayoutable anyway (≈20k columns / 1.8M px wide); the contract is DON'T CRASH, so
 *  beyond this depth a node is treated as a leaf (its deeper subtree keeps its current position). Real
 *  mind-maps are a few dozen levels deep, so this never affects a legitimate graph (same fail-closed
 *  bound as MAX_TEMPLATE_DEPTH / the other MAX_* caps across this audit). */
const MAX_GRAPH_DEPTH = 1000; // >10x any real mind-map depth, yet comfortably under the JS call-stack
// limit for these closure-heavy frames (4000 still overflowed) — fails closed WELL before a RangeError.

// ── Shared graph primitives (built once per layout, reused by every strategy) ──

interface Adjacency {
  readonly byId: Map<string, GraphNode>;
  /** from → [to, …] in insertion order (self-loops + edges to unknown nodes dropped). */
  readonly children: Map<string, string[]>;
  /** child → indegree (number of incoming edges from known nodes). */
  readonly indeg: Map<string, number>;
}

function buildAdjacency(nodes: readonly GraphNode[], edges: readonly GraphEdge[]): Adjacency {
  // Clamp node dimensions through the finiteCoord SSOT so every strategy's cumulative width/height math
  // is overflow-safe regardless of caller — the ONE place raw GraphNode sizes enter the leaf. finiteCoord
  // bounds BOTH non-finite (NaN/Infinity) AND finite-huge (Number.MAX_VALUE, valid JSON) to ±1e7, so a
  // cumulative column/ring sum can never reach Infinity. A no-op for real sizes.
  const byId = new Map(nodes.map((n) => [n.memberId, { ...n, w: finiteCoord(n.w), h: finiteCoord(n.h) }]));
  const children = new Map<string, string[]>();
  const indeg = new Map<string, number>();
  for (const n of nodes) {
    children.set(n.memberId, []);
    indeg.set(n.memberId, 0);
  }
  // DEDUPE edges: two connectors A→B are the SAME parent→child relationship for layout. A duplicate
  // child in `children` corrupts tidy-tree centering (`cys = [cy(a), cy(b), cy(a)]` centres on the wrong
  // span) and radial wedge allocation (an empty wedge for the phantom duplicate), and double-counts
  // indegree. Keeping each (from,to) once fixes both at the root (L063).
  const seenEdge = new Set<string>();
  for (const e of edges) {
    if (!byId.has(e.from) || !byId.has(e.to) || e.from === e.to) continue; // drop unknown + self-loop
    const key = JSON.stringify([e.from, e.to]); // collision-free (a string separator would merge "a b"+"c" with "a"+"b c")
    if (seenEdge.has(key)) continue; // drop a duplicate parent→child edge
    seenEdge.add(key);
    children.get(e.from)!.push(e.to);
    indeg.set(e.to, (indeg.get(e.to) ?? 0) + 1);
  }
  return { byId, children, indeg };
}

/** Stable visual order (top-to-bottom, then left-to-right) — the deterministic tie-break for
 *  siblings, within-rank peers, and root ordering. Falls back to memberId when positions tie. */
function byVisual(byId: Map<string, GraphNode>): (a: string, b: string) => number {
  return (a, b) => {
    const A = byId.get(a)!;
    const B = byId.get(b)!;
    return (A.y ?? 0) - (B.y ?? 0) || (A.x ?? 0) - (B.x ?? 0) || (a < b ? -1 : a > b ? 1 : 0);
  };
}

/** Pick roots: explicit `rootId` wins; else every indegree-0 node (with children when
 *  `requireChildren`). When no indegree-0 node exists (a pure cycle) and `breakCycles` is set,
 *  fall back to the first node by visual order that has an outgoing edge — so a cycle-tolerant
 *  layout is never a silent no-op. With `breakCycles` false (the strict tidy-tree contract) a
 *  pure cycle returns no root and the caller leaves the board untouched. */
function pickRoots(
  adj: Adjacency,
  opts: GraphLayoutOptions,
  requireChildren: boolean,
  breakCycles: boolean,
): string[] {
  const { byId, children, indeg } = adj;
  if (opts.rootId && byId.has(opts.rootId)) return [opts.rootId];
  const cmp = byVisual(byId);
  const tops = [...byId.keys()]
    .filter((id) => (indeg.get(id) ?? 0) === 0 && (!requireChildren || children.get(id)!.length > 0))
    .sort(cmp);
  if (tops.length > 0 || !breakCycles) return tops;
  // No indegree-0 node (every node has a parent → a cycle exists). Break it: root at the
  // first node (by visual order) that has an outgoing edge, so a real relationship lays out.
  const withKids = [...byId.keys()].filter((id) => children.get(id)!.length > 0).sort(cmp);
  return withKids.length > 0 ? [withKids[0]] : [];
}

/** Has ANY real (known, non-self) edge? Used to distinguish "no tree" from "an edgeless pile". */
function hasAnyEdge(adj: Adjacency): boolean {
  for (const kids of adj.children.values()) if (kids.length > 0) return true;
  return false;
}

// ── Strategy 1: tidy tree (relocated verbatim from batch-actions#computeTreeLayout) ──

/**
 * Pure tidy-tree solver: depth → column x (cumulative per-depth max width so mixed sizes
 * never overlap); a leaf takes the next free row, an internal node centres on its child span
 * (Reingold–Tilford SHAPE, not a full RT apportion). DAG/cycle-safe (placed once; back-edges
 * on the current path skipped). EMPTY map when no rooted tree exists.
 */
export const tidyTreeLayout: GraphLayoutStrategy = (nodes, edges, opts = {}) => {
  const colGap = finiteGap(opts.colGap, 90);
  const rowGap = finiteGap(opts.rowGap, 40);
  const adj = buildAdjacency(nodes, edges);
  const { byId, children } = adj;
  const roots = pickRoots(adj, opts, true, false);
  if (roots.length === 0) return new Map();

  const info = new Map<string, { depth: number; top: number; h: number; cy: number }>();
  const onPath = new Set<string>();
  let cursorY = 0;
  const layout = (id: string, depth: number): number => {
    const placed = info.get(id);
    if (placed) return placed.cy; // shared node (DAG) — keep its first placement
    const node = byId.get(id)!;
    // Beyond MAX_GRAPH_DEPTH, treat the node as a leaf (don't recurse) — bounds the JS call stack on a
    // pathological deep chain; a real tree never reaches this depth, so no legitimate layout changes.
    const kids = depth >= MAX_GRAPH_DEPTH ? [] : children.get(id)!.filter((k) => byId.has(k) && !onPath.has(k) && !info.has(k));
    let cy: number;
    if (kids.length === 0) {
      cy = cursorY + node.h / 2;
      info.set(id, { depth, top: cursorY, h: node.h, cy });
      cursorY += node.h + rowGap;
    } else {
      onPath.add(id);
      const cys = kids.map((k) => layout(k, depth + 1));
      onPath.delete(id);
      cy = (cys[0] + cys[cys.length - 1]) / 2;
      info.set(id, { depth, top: cy - node.h / 2, h: node.h, cy });
    }
    return cy;
  };
  for (const r of roots) {
    layout(r, 0);
    cursorY += rowGap; // breathing room between separate trees
  }

  const maxW = new Map<number, number>();
  for (const [id, f] of info) maxW.set(f.depth, Math.max(maxW.get(f.depth) ?? 0, byId.get(id)!.w));
  const maxDepth = maxOf([...info.values()].map((f) => f.depth));
  const colX = new Map<number, number>();
  let x = 0;
  for (let d = 0; d <= maxDepth; d++) {
    colX.set(d, x);
    x += (maxW.get(d) ?? 0) + colGap;
  }
  const out = new Map<string, { x: number; y: number }>();
  for (const [id, f] of info) out.set(id, { x: colX.get(f.depth)!, y: Math.round(f.top) });
  return out;
};

// ── Strategy 2: layered DAG (BFS / longest-path ranks) ──

/**
 * Layered layout: each node's DEPTH = the longest path (in edges) from any source, so a node
 * with two parents at different depths sits to the RIGHT of both (the merge a tree can't show —
 * the true DAG distinction from `tidyTreeLayout`). Depths become columns (x = cumulative per-
 * depth max width + colGap); within a depth, nodes keep stable visual order and stack vertically
 * by height + rowGap. Cycle-safe: back-edges (a parent already on the current DFS path) don't
 * deepen the node. EMPTY map when there is no edge at all.
 */
export const layeredDagLayout: GraphLayoutStrategy = (nodes, edges, opts = {}) => {
  const colGap = finiteGap(opts.colGap, 90);
  const rowGap = finiteGap(opts.rowGap, 40);
  const adj = buildAdjacency(nodes, edges);
  if (!hasAnyEdge(adj)) return new Map();
  const { byId, children, indeg } = adj;

  // parents map (child → [parent, …]) for longest-path-from-source depth.
  const parents = new Map<string, string[]>();
  for (const id of byId.keys()) parents.set(id, []);
  for (const [from, kids] of children) for (const k of kids) parents.get(k)!.push(from);

  // depth(node) = longest path INTO the node from a source (indegree-0). Sources = depth 0.
  const depth = new Map<string, number>();
  const onPath = new Set<string>();
  const depthOf = (id: string, rec = 0): number => {
    const cached = depth.get(id);
    if (cached !== undefined) return cached;
    if ((indeg.get(id) ?? 0) === 0) {
      depth.set(id, 0);
      return 0;
    }
    onPath.add(id);
    let d = 0;
    for (const p of parents.get(id)!) {
      if (onPath.has(p)) continue; // back-edge → does not extend depth
      // Depth guard: beyond MAX_GRAPH_DEPTH parent-hops, stop descending — bounds the JS call stack on
      // a pathological deep chain (a 20k parent chain overflowed here); a real DAG is never this deep.
      if (rec >= MAX_GRAPH_DEPTH) continue;
      d = Math.max(d, depthOf(p, rec + 1) + 1);
    }
    onPath.delete(id);
    depth.set(id, d);
    return d;
  };
  for (const id of byId.keys()) depthOf(id);

  const cmp = byVisual(byId);
  const layers = new Map<number, string[]>();
  for (const id of byId.keys()) {
    const d = depth.get(id)!;
    if (!layers.has(d)) layers.set(d, []);
    layers.get(d)!.push(id);
  }
  const maxDepth = maxOf(layers.keys());
  const colX = new Map<number, number>();
  let x = 0;
  for (let d = 0; d <= maxDepth; d++) {
    colX.set(d, x);
    const ids = layers.get(d) ?? [];
    const widest = ids.length ? maxOf(ids.map((id) => byId.get(id)!.w)) : 0;
    x += widest + colGap;
  }
  const out = new Map<string, { x: number; y: number }>();
  for (let d = 0; d <= maxDepth; d++) {
    const ids = (layers.get(d) ?? []).slice().sort(cmp);
    let y = 0;
    for (const id of ids) {
      out.set(id, { x: colX.get(d)!, y: Math.round(y) });
      y += byId.get(id)!.h + rowGap;
    }
  }
  return out;
};

// ── Strategy 3: radial mind-map (root-centred, depth→ring, leaf-count wedge) ──

/**
 * Radial mind-map: the root sits at the centre; depth maps to concentric rings (radius =
 * depth · ringGap); each subtree is allocated an angular WEDGE proportional to its leaf count,
 * so dense branches fan out and sparse ones stay tight (the real mind-map look, not a plain
 * circle). Multiple roots / disconnected components each get their own centre, offset
 * horizontally by `componentGap`. Cycle-safe (back-edges on the path skipped). EMPTY map when
 * no root/edge exists. Output is LOCAL top-lefts (centre-fixed), anchored by the caller.
 */
export const radialTreeLayout: GraphLayoutStrategy = (nodes, edges, opts = {}) => {
  const ringGap = finiteGap(opts.ringGap, 160);
  const componentGap = finiteGap(opts.componentGap, 80);
  const adj = buildAdjacency(nodes, edges);
  if (!hasAnyEdge(adj)) return new Map();
  const { byId, children } = adj;
  const roots = pickRoots(adj, opts, false, true);
  if (roots.length === 0) return new Map();
  const cmp = byVisual(byId);

  const out = new Map<string, { x: number; y: number }>(); // centre-based x,y (converted to TL at end)
  const claimed = new Set<string>(); // a node belongs to the first root that reaches it (forest)
  let componentOriginX = 0;

  for (const root of roots) {
    if (claimed.has(root)) continue;
    // First pass: subtree leaf counts (a "leaf" = no unclaimed children).
    const leaves = new Map<string, number>();
    const onPath = new Set<string>();
    const seen = new Set<string>();
    const countLeaves = (id: string, rec = 0): number => {
      if (leaves.has(id)) return leaves.get(id)!;
      seen.add(id);
      // Depth guard: beyond MAX_GRAPH_DEPTH, treat as a leaf (don't recurse) — bounds the stack on a
      // pathological deep chain; a real subtree is never this deep.
      const kids = rec >= MAX_GRAPH_DEPTH ? [] : children.get(id)!.filter((k) => byId.has(k) && !onPath.has(k) && !claimed.has(k) && k !== id);
      let n: number;
      if (kids.length === 0) n = 1;
      else {
        onPath.add(id);
        n = kids.reduce((s, k) => s + countLeaves(k, rec + 1), 0);
        onPath.delete(id);
      }
      leaves.set(id, n);
      return n;
    };
    countLeaves(root);

    // Second pass: assign each node an angle within its wedge + radius = depth·ringGap.
    let maxRadius = 0;
    const place = (id: string, depth: number, a0: number, a1: number): void => {
      if (claimed.has(id)) return;
      claimed.add(id);
      const radius = depth * ringGap;
      maxRadius = Math.max(maxRadius, radius);
      const mid = (a0 + a1) / 2;
      out.set(id, { x: Math.cos(mid) * radius, y: Math.sin(mid) * radius });
      // Depth guard: beyond MAX_GRAPH_DEPTH, place the node but don't recurse into its subtree — bounds
      // the stack on a pathological deep chain (a real radial map is a few dozen rings at most).
      const kids = depth >= MAX_GRAPH_DEPTH
        ? []
        : children
            .get(id)!
            .filter((k) => byId.has(k) && !claimed.has(k) && k !== id)
            .slice()
            .sort(cmp);
      if (kids.length === 0) return;
      const total = kids.reduce((s, k) => s + (leaves.get(k) ?? 1), 0) || 1;
      let a = a0;
      for (const k of kids) {
        const frac = (leaves.get(k) ?? 1) / total;
        const span = (a1 - a0) * frac;
        place(k, depth + 1, a, a + span);
        a += span;
      }
    };
    place(root, 0, 0, Math.PI * 2);

    // Offset this whole component so components don't overlap; shift to positive quadrant.
    for (const id of seen) {
      if (!out.has(id)) continue;
      const p = out.get(id)!;
      out.set(id, { x: p.x + componentOriginX + maxRadius, y: p.y + maxRadius });
    }
    componentOriginX += 2 * maxRadius + componentGap;
  }

  // Convert centre-anchored coords to LOCAL top-lefts (subtract half the node size).
  const tl = new Map<string, { x: number; y: number }>();
  for (const [id, p] of out) {
    const node = byId.get(id)!;
    tl.set(id, { x: Math.round(p.x - node.w / 2), y: Math.round(p.y - node.h / 2) });
  }
  return tl;
};

/**
 * FORCE-DIRECTED (spring) layout (b96) — the organic counterpart to the hierarchical tidy/DAG/radial
 * strategies: connected nodes ATTRACT (springs) and every pair REPELS, so a graph settles into an even,
 * cluster-revealing web (the mind-map / relationship-map canon that a tree can't express when the graph
 * has cycles or no clear root). Deterministic Fruchterman-Reingold: each node seeds from its current centre
 * (if given) else a per-index ring, then over a cooling schedule repulsion `k²/d` pushes every pair apart
 * while each edge's attraction `d²/k` pulls its ends together; equilibrium edge length ≈ `k` (the ideal
 * spacing, tied to node size + `componentGap`). No randomness (reproducible; `Math.random` is unavailable
 * anyway) — seeds and iteration are fully determined by the input. Cycle-safe (edges are undirected here).
 */
export const forceDirectedLayout: GraphLayoutStrategy = (nodes, edges, opts = {}) => {
  const out = new Map<string, { x: number; y: number }>();
  const n = nodes.length;
  if (n === 0) return out;
  const fin = (v: number): number => (Number.isFinite(v) ? v : 0);
  let maxDim = 0;
  for (const nd of nodes) maxDim = Math.max(maxDim, nd.w, nd.h);
  const k = maxDim + finiteGap(opts.componentGap, 80); // ideal edge length
  const R = k * Math.max(1, Math.sqrt(n) / 2);
  const pos = new Map<string, { x: number; y: number }>();
  nodes.forEach((nd, i) => {
    const cx = Number.isFinite(nd.x) ? (nd.x as number) + nd.w / 2 : R * Math.cos((2 * Math.PI * i) / n);
    const cy = Number.isFinite(nd.y) ? (nd.y as number) + nd.h / 2 : R * Math.sin((2 * Math.PI * i) / n);
    pos.set(nd.memberId, { x: cx, y: cy });
  });
  const emit = (): Map<string, { x: number; y: number }> => {
    let minX = Infinity;
    let minY = Infinity;
    for (const nd of nodes) {
      const p = pos.get(nd.memberId)!;
      minX = Math.min(minX, p.x - nd.w / 2);
      minY = Math.min(minY, p.y - nd.h / 2);
    }
    for (const nd of nodes) {
      const p = pos.get(nd.memberId)!;
      out.set(nd.memberId, { x: fin(p.x - nd.w / 2 - minX), y: fin(p.y - nd.h / 2 - minY) });
    }
    return out;
  };
  if (n === 1) return emit();
  const ids = new Set(nodes.map((nd) => nd.memberId));
  const es = edges.filter((e) => e.from !== e.to && ids.has(e.from) && ids.has(e.to));
  const iters = n > 200 ? 60 : n > 80 ? 150 : 300;
  const EPS = 0.01;
  for (let it = 0; it < iters; it += 1) {
    const temp = k * (1 - it / iters); // linear cooling → settles, never oscillates
    const disp = new Map<string, { x: number; y: number }>();
    for (const nd of nodes) disp.set(nd.memberId, { x: 0, y: 0 });
    for (let i = 0; i < n; i += 1) {
      const pa = pos.get(nodes[i].memberId)!;
      const da = disp.get(nodes[i].memberId)!;
      for (let j = i + 1; j < n; j += 1) {
        const pb = pos.get(nodes[j].memberId)!;
        let dx = pa.x - pb.x;
        let dy = pa.y - pb.y;
        let d = Math.hypot(dx, dy);
        if (d < EPS) { dx = ((i - j) || 1) * EPS; dy = EPS; d = Math.hypot(dx, dy); } // deterministic un-stack
        const f = (k * k) / d;
        const db = disp.get(nodes[j].memberId)!;
        da.x += (dx / d) * f; da.y += (dy / d) * f;
        db.x -= (dx / d) * f; db.y -= (dy / d) * f;
      }
    }
    for (const e of es) {
      const pu = pos.get(e.from)!;
      const pv = pos.get(e.to)!;
      let dx = pu.x - pv.x;
      let dy = pu.y - pv.y;
      let d = Math.hypot(dx, dy);
      if (d < EPS) d = EPS;
      const f = (d * d) / k;
      const du = disp.get(e.from)!;
      const dv = disp.get(e.to)!;
      du.x -= (dx / d) * f; du.y -= (dy / d) * f;
      dv.x += (dx / d) * f; dv.y += (dy / d) * f;
    }
    for (const nd of nodes) {
      const dp = disp.get(nd.memberId)!;
      const p = pos.get(nd.memberId)!;
      const d = Math.hypot(dp.x, dp.y);
      if (d < EPS) continue;
      const step = Math.min(d, temp);
      p.x += (dp.x / d) * step;
      p.y += (dp.y / d) * step;
    }
  }
  return emit();
};

/**
 * CIRCULAR / RING layout (b104) — the connectivity view a hierarchy can't express: place EVERY node on ONE
 * ring, ordered so connected nodes sit next to each other (edges become short chords instead of long ones).
 * Distinct from `tree`/`flow` (hierarchical) and `radial` (rings by DEPTH) and `force` (physics): here depth
 * is irrelevant — it shows the graph as a cycle of relationships (the chord-diagram / network-circle canon).
 *
 * Ordering (deterministic, no random): BFS over the UNDIRECTED graph, seeding each component from its
 * highest-degree unvisited node (id tie-break) and visiting neighbours highest-degree-first — so a node's
 * neighbours land adjacent on the ring and each connected component occupies a contiguous arc. Isolated nodes
 * (degree 0) trail in id order. The ring radius sizes to the node footprint so boxes don't overlap.
 */
export const circularLayout: GraphLayoutStrategy = (nodes, edges, opts = {}) => {
  const out = new Map<string, { x: number; y: number }>();
  const n = nodes.length;
  if (n === 0) return out;
  const byId = new Map(nodes.map((nd) => [nd.memberId, nd]));
  if (n === 1) {
    out.set(nodes[0].memberId, { x: 0, y: 0 });
    return out;
  }
  const ids = new Set(nodes.map((nd) => nd.memberId));
  // undirected adjacency among known nodes (self-loops + dangling edges dropped)
  const adj = new Map<string, Set<string>>();
  for (const id of ids) adj.set(id, new Set());
  for (const e of edges) {
    if (e.from === e.to || !ids.has(e.from) || !ids.has(e.to)) continue;
    adj.get(e.from)!.add(e.to);
    adj.get(e.to)!.add(e.from);
  }
  const deg = (id: string) => adj.get(id)!.size;
  const byDegThenId = (a: string, b: string) => deg(b) - deg(a) || (a < b ? -1 : a > b ? 1 : 0);
  // DFS order (NOT BFS): follow each chain to its end before backtracking, so a path's nodes stay contiguous
  // on the ring (short chords) — BFS would split a hub's leaf away from the hub. Seed each component from its
  // highest-degree node, and dive into the LOWEST-degree neighbour first (chase leaves/chains and return),
  // so connected components occupy contiguous arcs. Deterministic tie-breaks; a hub's many neighbours must of
  // course still spread (a degree-k node can only have 2 ring-neighbours — a geometric limit, not a bug).
  const order: string[] = [];
  const visited = new Set<string>();
  for (const seed of [...ids].sort(byDegThenId)) {
    if (visited.has(seed)) continue;
    const stack = [seed];
    visited.add(seed);
    while (stack.length) {
      const cur = stack.pop()!;
      order.push(cur);
      // push high-degree neighbours first so the lowest-degree lands on TOP of the stack and is visited next.
      for (const nb of [...adj.get(cur)!].filter((x) => !visited.has(x)).sort(byDegThenId)) {
        visited.add(nb);
        stack.push(nb);
      }
    }
  }
  let maxDim = 0;
  for (const nd of nodes) maxDim = Math.max(maxDim, finiteCoord(nd.w), finiteCoord(nd.h));
  const gap = finiteGap(opts.rowGap, 40);
  const count = order.length;
  // radius so the ring's circumference fits every node's footprint side by side (no overlap), floored so a
  // 2-node ring isn't degenerate.
  const radius = Math.max(maxDim, (count * (maxDim + gap)) / (2 * Math.PI));
  const center = new Map<string, { x: number; y: number }>();
  order.forEach((id, i) => {
    const a = (2 * Math.PI * i) / count;
    center.set(id, { x: radius * Math.cos(a), y: radius * Math.sin(a) });
  });
  let minX = Infinity;
  let minY = Infinity;
  for (const id of order) {
    const nd = byId.get(id)!;
    const c = center.get(id)!;
    minX = Math.min(minX, c.x - finiteCoord(nd.w) / 2);
    minY = Math.min(minY, c.y - finiteCoord(nd.h) / 2);
  }
  const fin = (v: number) => (Number.isFinite(v) ? v : 0);
  for (const id of order) {
    const nd = byId.get(id)!;
    const c = center.get(id)!;
    out.set(id, { x: fin(c.x - finiteCoord(nd.w) / 2 - minX), y: fin(c.y - finiteCoord(nd.h) / 2 - minY) });
  }
  return out;
};

// ── DATA catalog: the rows the board GENERATES (never hand-written; a new layout is one row) ──

/** One selectable graph layout — DATA the board maps into a batch row (L090). */
export interface GraphLayoutDef {
  readonly id: string;
  readonly label: string;
  readonly icon: string;
  readonly strategy: GraphLayoutStrategy;
}

export const GRAPH_LAYOUTS: readonly GraphLayoutDef[] = [
  { id: 'tree', label: 'Arrange as mind map', icon: 'Workflow', strategy: tidyTreeLayout },
  { id: 'flow', label: 'Arrange as flowchart', icon: 'GitBranch', strategy: layeredDagLayout },
  { id: 'radial', label: 'Arrange as radial map', icon: 'Sun', strategy: radialTreeLayout },
  { id: 'force', label: 'Arrange as force graph', icon: 'Atom', strategy: forceDirectedLayout },
  { id: 'circular', label: 'Arrange as circle graph', icon: 'Circle', strategy: circularLayout },
] as const;

export function graphLayoutById(id: string | undefined): GraphLayoutDef {
  return GRAPH_LAYOUTS.find((l) => l.id === id) ?? GRAPH_LAYOUTS[0];
}
