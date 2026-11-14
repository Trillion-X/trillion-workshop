// frontends/web/src/packages/ui/show/graph-layout/graph-layout.ts
//
// =============================================================================
// PURPOSE
// =============================================================================
//
// Physics-layer graph auto-layout. Pure function: given a set of nodes, a set of
// directed edges, and a layout mode, compute a world-space position {x, y} for
// every node. Zero I/O, zero domain vocabulary, fully deterministic — the same
// input always yields the same output (unit-testable, replay-safe).
//
// The output coordinate contract matches CanvasNode exactly: {x, y} is the
// TOP-LEFT of the node's bounding box in world-space (the same coordinates
// CanvasNode consumes via CSS transform translate). A node's computed ANCHOR is
// its center; top-left = anchor - (width/2, height/2). Nodes without a declared
// width/height use DEFAULT_NODE_W/H so a caller can lay out unsized nodes.
//
// This leaf is what turns a live record-topology projection ({nodes, edges})
// into positions the canvas-* primitives render. It privileges NO product
// concept: "worker graph", "build pipeline", "org chart", "dependency tree" are
// all the SAME call with different data + a different mode.
//
// =============================================================================
// NON-NEGOTIABLE INVARIANTS
// =============================================================================
//
// 1. ZERO domain vocabulary — knows only ids, edges, geometry, and layout mode.
// 2. PURE + DETERMINISTIC — no clock, no randomness, no mutation of inputs.
//    Given identical input, byte-identical output (force uses a fixed seed +
//    fixed iteration count so it is deterministic too).
// 3. TOTAL — every node in `nodes` gets exactly one position, even when it has
//    no edges, is in a cycle, is disconnected, or the graph is empty.
// 4. EXTENSIBLE WITHOUT EDITING CORE — a caller may pass a custom layout
//    function ({compute}) instead of a built-in mode name; the dispatcher never
//    grows a branch for a new algorithm (enum-dissolution compliant).
// 5. Output {x, y} = TOP-LEFT world-space, identical contract to CanvasNode.
//
// The extensive documentation in this codebase is a critical design feature.
// You are forbidden from simplifying or removing it.
// =============================================================================

// ---------------------------------------------------------------------------
// TYPES
// ---------------------------------------------------------------------------

/** A node to place. Only geometry-relevant fields — no domain fields. */
export interface LayoutNode {
  readonly id: string;
  /** Declared size; defaults applied when absent. */
  readonly width?: number;
  readonly height?: number;
  /** Pre-set world-space top-left; honored by mode 'manual', ignored otherwise. */
  readonly x?: number;
  readonly y?: number;
}

/** A directed edge. `from`/`to` are node ids. Self-loops and dangling refs are tolerated. */
export interface LayoutEdge {
  readonly from: string;
  readonly to: string;
}

/** World-space top-left position — the CanvasNode {x, y} contract. */
export interface Position {
  readonly x: number;
  readonly y: number;
}

/** Built-in layout algorithm names. Physics (geometry), not Society. */
export type LayoutMode = 'radial' | 'hierarchical' | 'dag' | 'force' | 'grid' | 'manual';

/** Tunables; every field has a maximally-capable default (L083). */
export interface LayoutOptions {
  /** Node id to anchor at the origin (radial center / hierarchical top). Auto-picked if absent. */
  readonly rootId?: string;
  /** Center-to-center gap between adjacent ring/layer levels (px). */
  readonly levelGap?: number;
  /** Center-to-center gap between siblings within a level/row (px). */
  readonly siblingGap?: number;
  /** Fallback node size when a node declares none. */
  readonly defaultWidth?: number;
  readonly defaultHeight?: number;
  /** Wrap wide layers into readable rows within this world-space width. */
  readonly maxRowWidth?: number;
  /**
   * The clear space between one level's cards and the next level's, edge to edge (layered layouts). Absent or 0 →
   * levels step by `levelGap` or the tallest card plus `siblingGap`, as before.
   */
  readonly levelSpace?: number;
  /**
   * Which way levels advance: 'down' (each level below the last, the default) or
   * 'right' (each level beside the last, a left-to-right flow). Any mode is laid
   * out in its own frame and the frame turned, so a new algorithm gets both
   * directions without knowing about them.
   */
  readonly direction?: LayoutDirection;
}

/** Which way a layout's levels advance. Geometry only. */
export type LayoutDirection = 'down' | 'right';

/**
 * A layout is EITHER a built-in mode name OR a caller-supplied pure function.
 * The custom form is why adding a new algorithm never edits this file.
 */
export type Layout =
  | LayoutMode
  | { readonly compute: (nodes: readonly LayoutNode[], edges: readonly LayoutEdge[], opts: Required<LayoutOptions>) => Map<string, Position> };

// ---------------------------------------------------------------------------
// DEFAULTS
// ---------------------------------------------------------------------------

const DEFAULT_NODE_W = 200;
const DEFAULT_NODE_H = 92;
const DEFAULT_LEVEL_GAP = 220;
const DEFAULT_SIBLING_GAP = 60;

function resolveOpts(o: LayoutOptions | undefined): Required<LayoutOptions> {
  return {
    rootId: o?.rootId ?? '',
    levelGap: o?.levelGap ?? DEFAULT_LEVEL_GAP,
    siblingGap: o?.siblingGap ?? DEFAULT_SIBLING_GAP,
    defaultWidth: o?.defaultWidth ?? DEFAULT_NODE_W,
    defaultHeight: o?.defaultHeight ?? DEFAULT_NODE_H,
    maxRowWidth: o?.maxRowWidth ?? Infinity,
    levelSpace: o?.levelSpace ?? 0,
    direction: o?.direction ?? 'down',
  };
}

function sizeOf(n: LayoutNode, o: Required<LayoutOptions>): { w: number; h: number } {
  return { w: n.width ?? o.defaultWidth, h: n.height ?? o.defaultHeight };
}

/** Convert a computed CENTER anchor into a TOP-LEFT position for a node. */
function anchorToTopLeft(n: LayoutNode, cx: number, cy: number, o: Required<LayoutOptions>): Position {
  const { w, h } = sizeOf(n, o);
  return { x: cx - w / 2, y: cy - h / 2 };
}

// ---------------------------------------------------------------------------
// GRAPH HELPERS (pure)
// ---------------------------------------------------------------------------

/** Adjacency (out-neighbors) + in-degree, ignoring self-loops and dangling refs. */
function buildAdjacency(nodes: readonly LayoutNode[], edges: readonly LayoutEdge[]) {
  const ids = new Set(nodes.map((n) => n.id));
  const out = new Map<string, string[]>();
  const inDeg = new Map<string, number>();
  for (const n of nodes) { out.set(n.id, []); inDeg.set(n.id, 0); }
  for (const e of edges) {
    if (e.from === e.to) continue;
    if (!ids.has(e.from) || !ids.has(e.to)) continue;
    out.get(e.from)!.push(e.to);
    inDeg.set(e.to, (inDeg.get(e.to) ?? 0) + 1);
  }
  return { out, inDeg };
}

/**
 * Pick a root: caller's rootId if valid, else the node with the highest
 * out-degree and lowest in-degree — the natural "orchestrator".
 * Deterministic: ties break by first appearance in `nodes`.
 */
function pickRoot(nodes: readonly LayoutNode[], out: Map<string, string[]>, inDeg: Map<string, number>, rootId: string): string {
  if (rootId && nodes.some((n) => n.id === rootId)) return rootId;
  let best = nodes[0]?.id ?? '';
  let bestScore = -Infinity;
  for (const n of nodes) {
    const score = (out.get(n.id)?.length ?? 0) * 1000 - (inDeg.get(n.id) ?? 0);
    if (score > bestScore) { bestScore = score; best = n.id; }
  }
  return best;
}

/**
 * BFS layering from the roots. Returns layer index per node (BFS distance) and
 * preserves deterministic sibling order. Disconnected nodes get their own
 * trailing layers so nothing overlaps.
 */
function bfsLayers(nodes: readonly LayoutNode[], out: Map<string, string[]>, roots: string[]): Map<string, number> {
  const layer = new Map<string, number>();
  const queue: string[] = [];
  for (const r of roots) { if (!layer.has(r)) { layer.set(r, 0); queue.push(r); } }
  let head = 0;
  while (head < queue.length) {
    const cur = queue[head++];
    const d = layer.get(cur)!;
    for (const nb of out.get(cur) ?? []) {
      if (!layer.has(nb)) { layer.set(nb, d + 1); queue.push(nb); }
    }
  }
  // Any node not reached (isolated / in an unreached cycle) is placed on a
  // trailing layer, in stable order, so it never overlaps the reached graph.
  let trailing = queue.length ? Math.max(...Array.from(layer.values())) + 1 : 0;
  for (const n of nodes) if (!layer.has(n.id)) layer.set(n.id, trailing++);
  return layer;
}

// ---------------------------------------------------------------------------
// BUILT-IN LAYOUTS (each pure: (nodes, edges, opts) -> Map<id, Position>)
// ---------------------------------------------------------------------------

/** Manual: honor each node's declared {x, y}; missing coords fall to an origin row. */
function layoutManual(nodes: readonly LayoutNode[], _edges: readonly LayoutEdge[], o: Required<LayoutOptions>): Map<string, Position> {
  const pos = new Map<string, Position>();
  let fallbackCol = 0;
  for (const n of nodes) {
    if (typeof n.x === 'number' && typeof n.y === 'number') pos.set(n.id, { x: n.x, y: n.y });
    else { pos.set(n.id, { x: fallbackCol * (o.defaultWidth + o.siblingGap), y: 0 }); fallbackCol++; }
  }
  return pos;
}

/** Grid: stable row-major grid — the universal fallback (no edges needed). */
function layoutGrid(nodes: readonly LayoutNode[], _edges: readonly LayoutEdge[], o: Required<LayoutOptions>): Map<string, Position> {
  const pos = new Map<string, Position>();
  const cols = Math.max(1, Math.ceil(Math.sqrt(nodes.length)));
  const cellW = o.defaultWidth + o.siblingGap;
  const cellH = o.defaultHeight + o.siblingGap;
  nodes.forEach((n, i) => {
    const cx = (i % cols) * cellW;
    const cy = Math.floor(i / cols) * cellH;
    pos.set(n.id, anchorToTopLeft(n, cx, cy, o));
  });
  return pos;
}

/**
 * Radial: root at origin; each BFS level on a concentric ring; siblings spread
 * evenly around the ring. This is a user's "central orchestrator with agents
 * radiating out" — as a LAYOUT MODE, not a special case.
 */
function layoutRadial(nodes: readonly LayoutNode[], edges: readonly LayoutEdge[], o: Required<LayoutOptions>): Map<string, Position> {
  if (nodes.length === 0) return new Map();
  // No edges = no hierarchy to radiate. A radial layout then puts every node on its
  // own trailing ring at the same angle, degenerating to a vertical COLUMN. A grid is
  // the honest layout for an unlinked set (a flat roster) — it spreads evenly with no
  // overlap. Once the nodes carry parent/child edges, the real radial graph emerges.
  if (edges.length === 0) return layoutGrid(nodes, edges, o);
  const { out, inDeg } = buildAdjacency(nodes, edges);
  const root = pickRoot(nodes, out, inDeg, o.rootId);
  const layer = bfsLayers(nodes, out, [root]);
  // group nodes by ring, stable order
  const rings = new Map<number, LayoutNode[]>();
  for (const n of nodes) {
    const L = layer.get(n.id) ?? 0;
    if (!rings.has(L)) rings.set(L, []);
    rings.get(L)!.push(n);
  }
  const pos = new Map<string, Position>();
  // MULTI-RING distribution: a BFS level with many members is spread across as many
  // COMPACT concentric sub-rings as needed, filling the innermost first, so no ring
  // is overcrowded and the whole level stays close to the centre. A single ring big
  // enough to seat 38 cards without overlap would be ~1500px across — too large to
  // frame in a panel (only the centre showed). Instead each sub-ring holds only what
  // its circumference legibly seats (capacity = floor(2πr / chord)); the innermost
  // band of workers sits readably around the root, more radiate outward, and pan/zoom
  // reaches the rest — the Cofounder company-graph anatomy. Generic: any radial with a
  // fat level benefits; a small level still lands on one tidy ring.
  const chord = o.defaultWidth + o.siblingGap;
  const ringCapacity = (radius: number) => Math.max(1, Math.floor((2 * Math.PI * radius) / chord));
  for (const [ring, members] of Array.from(rings.entries()).sort((a, b) => a[0] - b[0])) {
    if (ring === 0) { for (const n of members) pos.set(n.id, anchorToTopLeft(n, 0, 0, o)); continue; }
    const base = ring * o.levelGap;
    let placed = 0;
    let sub = 0;
    while (placed < members.length) {
      const radius = base + sub * o.levelGap;
      const remaining = members.length - placed;
      const take = Math.min(ringCapacity(radius), remaining);
      const band = members.slice(placed, placed + take);
      band.forEach((n, i) => {
        // stagger alternate rings by half a slot so outer nodes sit between inner ones
        const angle = take === 1
          ? 0
          : take === 2
            ? Math.PI * i
            : (2 * Math.PI * i) / take - Math.PI / 2 + (sub % 2 ? Math.PI / take : 0);
        pos.set(n.id, anchorToTopLeft(n, radius * Math.cos(angle), radius * Math.sin(angle), o));
      });
      placed += take;
      sub++;
    }
  }
  return pos;
}

/**
 * Layered (hierarchical + dag share this): BFS layers become rows; nodes within
 * a row are spread horizontally and centered. Handles multiple parents (dag),
 * multiple roots, cycles (BFS breaks them), and disconnected nodes.
 */
function layoutLayered(nodes: readonly LayoutNode[], edges: readonly LayoutEdge[], o: Required<LayoutOptions>): Map<string, Position> {
  if (nodes.length === 0) return new Map();
  const { out, inDeg } = buildAdjacency(nodes, edges);
  // roots = zero in-degree; if none (pure cycle), fall back to a single picked root.
  const roots = nodes.filter((n) => (inDeg.get(n.id) ?? 0) === 0).map((n) => n.id);
  const seedRoots = roots.length ? roots : [pickRoot(nodes, out, inDeg, o.rootId)];
  const layer = bfsLayers(nodes, out, seedRoots);
  const rows = new Map<number, LayoutNode[]>();
  for (const n of nodes) {
    const L = layer.get(n.id) ?? 0;
    if (!rows.has(L)) rows.set(L, []);
    rows.get(L)!.push(n);
  }
  // Each level's cards wrapped into bands no wider than maxRowWidth, every band in order, top to bottom.
  const bands: LayoutNode[][] = [];
  for (const [, members] of Array.from(rows.entries()).sort((a, b) => a[0] - b[0])) {
    const own: LayoutNode[][] = [[]];
    let width = 0;
    for (const node of members) {
      const w = sizeOf(node, o).w;
      if (width && width + o.siblingGap + w > o.maxRowWidth) { own.push([]); width = 0; }
      own[own.length - 1].push(node);
      width += (width ? o.siblingGap : 0) + w;
    }
    bands.push(...own);
  }
  const tallest = (band: readonly LayoutNode[]) => Math.max(...band.map(node => sizeOf(node, o).h));
  const pos = new Map<string, Position>();
  let cy = 0;
  bands.forEach((band, i) => {
    const totalW = band.reduce((sum, node) => sum + sizeOf(node, o).w, 0) + (band.length - 1) * o.siblingGap;
    let left = -totalW / 2;
    for (const node of band) {
      const { w } = sizeOf(node, o);
      pos.set(node.id, anchorToTopLeft(node, left + w / 2, cy, o));
      left += w + o.siblingGap;
    }
    const next = bands[i + 1];
    const clear = o.levelSpace > 0 && next ? tallest(band) / 2 + tallest(next) / 2 + o.levelSpace : 0;
    cy += Math.max(o.levelGap, tallest(band) + o.siblingGap, clear);
  });
  return pos;
}

/**
 * Force: deterministic seeded spring-embedder. Initial positions come from a
 * radial seed (stable), then a FIXED number of iterations of repulsion +
 * spring attraction. No randomness → same input, same output. Good for
 * many-to-many graphs with no clear hierarchy.
 */
function layoutForce(nodes: readonly LayoutNode[], edges: readonly LayoutEdge[], o: Required<LayoutOptions>): Map<string, Position> {
  if (nodes.length === 0) return new Map();
  if (nodes.length === 1) { const m = new Map<string, Position>(); m.set(nodes[0].id, anchorToTopLeft(nodes[0], 0, 0, o)); return m; }
  // Seed from radial anchors (centers), deterministic.
  const seed = layoutRadial(nodes, edges, o);
  const center = new Map<string, { x: number; y: number }>();
  for (const n of nodes) {
    const tl = seed.get(n.id)!; const { w, h } = sizeOf(n, o);
    center.set(n.id, { x: tl.x + w / 2, y: tl.y + h / 2 });
  }
  const ids = new Set(nodes.map((n) => n.id));
  const springs = edges.filter((e) => e.from !== e.to && ids.has(e.from) && ids.has(e.to));
  const k = o.levelGap;            // ideal spring length
  const repulse = k * k;           // repulsion constant
  const ITER = 120;                // fixed → deterministic
  for (let it = 0; it < ITER; it++) {
    const disp = new Map<string, { x: number; y: number }>();
    for (const n of nodes) disp.set(n.id, { x: 0, y: 0 });
    // repulsion (all pairs, stable order)
    for (let i = 0; i < nodes.length; i++) {
      for (let j = i + 1; j < nodes.length; j++) {
        const a = center.get(nodes[i].id)!; const b = center.get(nodes[j].id)!;
        let dx = a.x - b.x, dy = a.y - b.y;
        const dist = Math.hypot(dx, dy) || 0.01;
        const f = repulse / dist;
        dx = (dx / dist) * f; dy = (dy / dist) * f;
        const da = disp.get(nodes[i].id)!; const db = disp.get(nodes[j].id)!;
        da.x += dx; da.y += dy; db.x -= dx; db.y -= dy;
      }
    }
    // spring attraction along edges
    for (const e of springs) {
      const a = center.get(e.from)!; const b = center.get(e.to)!;
      let dx = a.x - b.x, dy = a.y - b.y;
      const dist = Math.hypot(dx, dy) || 0.01;
      const f = (dist * dist) / k;
      dx = (dx / dist) * f; dy = (dy / dist) * f;
      const da = disp.get(e.from)!; const db = disp.get(e.to)!;
      da.x -= dx; da.y -= dy; db.x += dx; db.y += dy;
    }
    // integrate with cooling
    const temp = k * (1 - it / ITER);
    for (const n of nodes) {
      const d = disp.get(n.id)!;
      const len = Math.hypot(d.x, d.y) || 0.01;
      const c = center.get(n.id)!;
      c.x += (d.x / len) * Math.min(len, temp);
      c.y += (d.y / len) * Math.min(len, temp);
    }
  }
  const pos = new Map<string, Position>();
  for (const n of nodes) { const c = center.get(n.id)!; pos.set(n.id, anchorToTopLeft(n, c.x, c.y, o)); }
  return pos;
}

// ---------------------------------------------------------------------------
// DISPATCH (the ONLY place mode-name → algorithm is resolved)
// ---------------------------------------------------------------------------

const BUILTINS: Record<LayoutMode, (n: readonly LayoutNode[], e: readonly LayoutEdge[], o: Required<LayoutOptions>) => Map<string, Position>> = {
  radial: layoutRadial,
  hierarchical: layoutLayered,
  dag: layoutLayered,
  force: layoutForce,
  grid: layoutGrid,
  manual: layoutManual,
};

/**
 * Compute world-space top-left positions for every node.
 *
 * @param nodes  nodes to place (order is the deterministic tie-breaker)
 * @param edges  directed edges (self-loops / dangling refs tolerated)
 * @param layout a built-in mode name OR {compute} for a caller-supplied algorithm
 * @param options tunables (maximally-capable defaults applied)
 * @returns Map<nodeId, {x, y}> — one entry per input node, always
 */
export function computeGraphLayout(
  nodes: readonly LayoutNode[],
  edges: readonly LayoutEdge[],
  layout: Layout = 'radial',
  options?: LayoutOptions,
): Map<string, Position> {
  const o = resolveOpts(options);
  // Unknown string that isn't a builtin → grid fallback (total function, never throws).
  const compute = (typeof layout === 'string' ? BUILTINS[layout] : layout.compute) ?? layoutGrid;
  if (o.direction !== 'right') return compute(nodes, edges, o);
  // Left to right: lay the graph out with every node's width and height swapped, then turn the frame (x <-> y), so
  // levels that ran down now run across and siblings that ran across now stack down.
  const turned = nodes.map(n => ({ ...n, width: n.height ?? o.defaultHeight, height: n.width ?? o.defaultWidth, x: n.y, y: n.x }));
  const placed = compute(turned, edges, { ...o, defaultWidth: o.defaultHeight, defaultHeight: o.defaultWidth });
  return new Map([...placed].map(([id, p]) => [id, { x: p.y, y: p.x }]));
}
