// frontends/web/src/packages/ui/show/node-graph/NodeGraph.tsx
//
// =============================================================================
// PURPOSE
// =============================================================================
//
// The generic node-graph view — the render half of a Live Record-Topology
// Projection. It composes existing canvas primitives (CanvasDotGrid,
// CanvasEdgeOverlay, CanvasNode) with the two pure leaves (computeGraphLayout
// for positions, resolveStatusView/resolveEdgeActivity for DATA-driven
// presentation). It knows NOTHING about "workers", "runs", "pipelines" — it
// renders {nodes, edges} with a layout mode and DATA status overrides. Product
// meaning arrives entirely as data + an optional renderNode callback.
//
// This is what turns any record-topology projection into a user's "orchestrator
// with agents radiating out, work flowing along the lines" — as DATA, for
// infinite workers / work items / any package, zero per-config code.
//
// =============================================================================
// NON-NEGOTIABLE INVARIANTS
// =============================================================================
//
// 1. ZERO domain vocabulary — nodes/edges/status keys are all caller DATA.
// 2. Positions come ONLY from computeGraphLayout (never hand-placed here).
// 3. Presentation (label/tone/pulse/dim/flow) comes ONLY from the DATA-driven
//    decoder — no `if (status === ...)` in this file.
// 4. Live-update safe: given new nodes/edges/status props, it re-lays-out and
//    re-renders; positions are memoized on the topology + layout inputs only.
// 5. Empty/sparse/dense all degrade generically (empty state slot; viewport
//    pan/zoom for dense).
//
// The extensive documentation in this codebase is a critical design feature.
// You are forbidden from simplifying or removing it.
// =============================================================================

import React, { useMemo, useRef, useState, useCallback, useLayoutEffect } from 'react';
import { CanvasDotGrid } from '../canvas-dot-grid/CanvasDotGrid';
import { CanvasEdgeOverlay } from '../canvas-edge-overlay/CanvasEdgeOverlay';
import { CanvasNode } from '../canvas-node/CanvasNode';
import { Button } from '../button/Button';
import { NamedIcon } from '../icon/NamedIcon';
import { CanvasMinimap } from '../canvas-minimap/CanvasMinimap';
import { Breadcrumb, BreadcrumbItem, BreadcrumbLink, BreadcrumbList, BreadcrumbPage, BreadcrumbSeparator } from '../coss/ui/breadcrumb';
import {
  computeGraphLayout,
  type Layout,
  type LayoutDirection,
  type LayoutOptions,
  type LayoutNode,
  type LayoutEdge,
} from '../graph-layout/graph-layout';
import {
  resolveStatusView,
  resolveEdgeActivity,
  type StatusOverrides,
  type StatusView,
} from '../graph-status/graph-status-view';

// ---------------------------------------------------------------------------
// PUBLIC TYPES
// ---------------------------------------------------------------------------

/** One node to render. Domain-free: label/status/activity are opaque DATA. */
export interface GraphNodeInput {
  readonly id: string;
  /** Human label (already translated by the projection). */
  readonly label?: string;
  /** Secondary line (e.g. the node's latest output summary). */
  readonly subtitle?: string;
  /** Raw status key off the record — decoded via statusOverrides. */
  readonly status?: string;
  /** Fixed size; defaults applied by the layout leaf when absent. */
  readonly width?: number;
  readonly height?: number;
  /**
   * The graph's visually PRIMARY node (a company graph's centre card). The
   * default card renders it filled + bold — the anchor everything radiates
   * from — while regular nodes stay light cards. Generic: which node is
   * primary is caller DATA (any domain's "root"), never inferred here.
   * Absent/false → the regular card (every existing consumer unchanged).
   */
  readonly primary?: boolean;
  /**
   * Who or what the node is, drawn before its label in the default card (a
   * person's face, an app's mark). Caller DATA; absent → the status dot alone.
   */
  readonly mark?: React.ReactNode;
  /**
   * How much of the work under this node is done, 0..1, drawn in the default
   * card as a bar in the node's own tone with its percentage. The caller works
   * it out from real records (roll-up.ts); absent → no bar, never a guess.
   */
  readonly progress?: number;
  /** A named icon (any icon-registry name) for who or what the node is, drawn in
   *  a tile tinted by the node's own tone. Absent → the state dot alone. */
  readonly icon?: string;
  /** One short line on the right of the card's title: a time taken, a count. */
  readonly meta?: string;
  /** The rows inside the card, top to bottom (the parts of a section card: a
   *  check under a step, the tools an agent may use). Each row's state looks
   *  the way the same `statusOverrides` say. */
  readonly rows?: readonly GraphNodeRow[];
  /** The node's own graph: a node that holds one opens into it, as a canvas of
   *  its own, to any depth (each inner node may hold its own). */
  readonly inner?: GraphInner;
  /** What can be done to this node from its card; `onNodeAction` runs them. */
  readonly actions?: readonly GraphNodeAction[];
}

/** One row inside a section card. */
export interface GraphNodeRow {
  readonly id: string;
  readonly label: string;
  readonly icon?: string;
  /** Raw state key, decoded through the graph's `statusOverrides`. */
  readonly status?: string;
  /** Quiet words on the row's right. */
  readonly detail?: string;
}

/** A graph inside a node. */
export interface GraphInner {
  readonly nodes: readonly GraphNodeInput[];
  readonly edges: readonly GraphEdgeInput[];
}

/** One thing that can be done to a node from its card. */
export interface GraphNodeAction {
  readonly id: string;
  readonly label: string;
  readonly icon?: string;
  /** How the press went, shown inside the button itself. */
  readonly state?: 'pending' | 'done' | 'error';
}

/** One directed edge. `activity` (raw key) decides flow/tone via DATA. */
export interface GraphEdgeInput {
  readonly id?: string;
  readonly from: string;
  readonly to: string;
  readonly activity?: string;
  /** Words on the line (a branch's condition). */
  readonly label?: string;
}

export type NodePresentation = 'card' | 'orb';

export interface NodeGraphProps {
  readonly nodes: readonly GraphNodeInput[];
  readonly edges: readonly GraphEdgeInput[];
  /** Layout mode or a caller-supplied compute function. Default 'radial'. */
  readonly layout?: Layout;
  readonly layoutOptions?: LayoutOptions;
  /** DATA map: raw status key → {label,tone,pulse,dim}. Drives ALL presentation. */
  readonly statusOverrides?: StatusOverrides;
  /** Currently selected node id (controlled selection). */
  readonly selectedNodeId?: string;
  readonly onSelectNode?: (id: string) => void;
  /** Currently selected edge id (controlled selection). */
  readonly selectedEdgeId?: string;
  readonly onSelectEdge?: (edge: GraphEdgeInput) => void;
  /** Custom node content; default renders a generic card from label/subtitle/status. */
  readonly renderNode?: (node: GraphNodeInput, statusView: StatusView, context: { zoom: number }) => React.ReactNode;
  /** Shown when there are zero nodes (the honest empty state). */
  readonly emptyState?: React.ReactNode;
  /** Map a tone token → a CSS colour var. Absent → a neutral built-in map. */
  readonly toneToColor?: (tone: string) => string;
  readonly ariaLabel?: string;
  readonly className?: string;
  readonly style?: React.CSSProperties;
  /**
   * Legibility floor for the AUTO-OPEN camera. A dense graph (dozens of nodes)
   * whose true fit-zoom would shrink cards until their labels collapse to a
   * single character opens at this zoom instead, centered on the graph — the
   * overflow is pannable/zoomable (explore, don't thumbnail). Manual wheel-zoom
   * is unaffected (the user can still zoom all the way out). Default 0.55.
   */
  readonly readableMinZoom?: number;
  /** Reflow layers to viewport width and let the page scroll through their full height. */
  readonly scrollable?: boolean;
  /** Accessible zoom and reset actions; no mouse wheel required. */
  readonly showControls?: boolean;
  /** The map of the whole graph in a corner once it no longer fits; false while something else sits in that corner
   *  (a panel opened beside the graph). */
  readonly showMinimap?: boolean;
  /**
   * SVG dash pattern for IDLE (non-flowing) edges — the light dashed spokes of
   * a company-graph look (e.g. "4 6"). Flowing edges keep their own animated
   * dash. Absent → solid idle edges (every existing consumer unchanged).
   */
  readonly edgeDash?: string;
  /** Edge stroke width in px. Default 1.5 (unchanged). */
  readonly edgeStrokeWidth?: number;
  /** Edge opacity in [0,1] — lighter, subtler spokes. Default 1 (unchanged). */
  readonly edgeOpacity?: number;
  /**
   * Generic visual treatment selected by caller DATA. `card` preserves the
   * compact topology default. `orb` makes relationship-centred graphs read as
   * one anchored participant with related participants around it.
   */
  readonly nodePresentation?: NodePresentation;
  /**
   * Which node may be dropped onto which, as the caller decides from its own
   * data (a job onto whoever can do it, a goal onto a bigger goal). With
   * `onDropNode`, a node is dragged with a mouse or pen: a chip with its label
   * follows the pointer, a node it may land on is outlined, and letting go
   * there runs the drop. Absent `canDrop` → every other node accepts it.
   */
  readonly canDrop?: (dragged: string, target: string) => boolean;
  /** Runs a drop of `dragged` onto `target`. Absent → nodes only select. */
  readonly onDropNode?: (dragged: string, target: string) => void;
  /**
   * One short line drawn on a node under its state, in the tone named (what a
   * drop onto it is doing: "Handing over", "Handed over", why it failed).
   * Caller DATA keyed by node id.
   */
  readonly notes?: Readonly<Record<string, { readonly text: string; readonly tone?: string }>>;
  /**
   * Which way levels run: 'down', 'right', or 'auto' (right once the canvas is
   * wide enough for two cards side by side, down on a narrow screen). Absent →
   * whatever `layoutOptions.direction` says (down).
   */
  readonly direction?: LayoutDirection | 'auto';
  /** Drawn small and read-only (a hover card): the whole graph fits, nothing
   *  pans, zooms or is chosen. */
  readonly still?: boolean;
  /** Runs one of a node's `actions`. */
  readonly onNodeAction?: (nodeId: string, actionId: string) => void | Promise<unknown>;
  /** The name of the outermost graph in the trail shown while inside a node. */
  readonly rootLabel?: string;
  /** Told the path of node ids opened, outermost first, whenever it changes. */
  readonly onPathChange?: (path: readonly string[]) => void;
  /** Drawn above the canvas (a side panel), never panned or zoomed. */
  readonly children?: React.ReactNode;
}

// ---------------------------------------------------------------------------
// DEFAULTS
// ---------------------------------------------------------------------------

const DEFAULT_W = 232;
const ORB_W = 144;
const PRIMARY_ORB_W = 168;

/** Neutral tone→colour fallback (token vars). Callers override via toneToColor. */
function defaultToneColor(tone: string): string {
  switch (tone) {
    case 'positive': return 'var(--accent-positive, #2e7d32)';
    case 'danger': return 'var(--accent-danger, #c62828)';
    case 'info': return 'var(--accent-info, #1565c0)';
    case 'muted': return 'var(--text-tertiary, #9e9e9e)';
    default: return 'var(--border-primary, #d0d0d0)';
  }
}

// ---------------------------------------------------------------------------
// COMPONENT
// ---------------------------------------------------------------------------

/** World-size heights of a card's parts, so a card is laid out exactly as tall as what it shows. */
const CARD = { pad: 24, head: 32, line: 18, sub_line: 16, row: 26, rows_gap: 8, foot: 34, gap: 6 } as const;
/** Words that fit on one subtitle line of a card this wide (an estimate at the caption size). */
const charsPerLine = (width: number) => Math.max(12, Math.floor((width - 30) / 6.4));
/** Below this canvas width a graph left to choose its own direction runs down, above it across. */
const SIDE_BY_SIDE_PX = 720;

/** How tall a section card is at world size, from what it shows. */
export function cardHeight(n: GraphNodeInput, width: number, hasStateLine: boolean, hasNote: boolean): number {
  const subtitleLines = n.subtitle ? Math.min(2, Math.ceil(n.subtitle.length / charsPerLine(width))) : 0;
  const rows = n.rows?.length ?? 0;
  const body = Boolean(hasStateLine || n.subtitle || rows || hasNote || n.progress !== undefined);
  const parts = [
    CARD.head,
    body && (n.icon || rows) ? 1 : 0,
    hasStateLine ? CARD.line : 0,
    subtitleLines * CARD.sub_line,
    rows ? CARD.rows_gap + rows * CARD.row : 0,
    hasNote ? CARD.line : 0,
    n.progress !== undefined ? CARD.line : 0,
    n.inner || n.actions?.length ? CARD.foot : 0,
  ].filter(Boolean);
  return CARD.pad + parts.reduce((sum, h) => sum + h, 0) + Math.max(0, parts.length - 1) * CARD.gap;
}

/** Rounds each bend of a right-angled line by up to `radius`, never past half of either side of the bend. */
function roundedPath(points: ReadonlyArray<readonly [number, number]>, radius: number): string {
  let d = `M ${points[0][0]} ${points[0][1]}`;
  for (let i = 1; i < points.length - 1; i++) {
    const [px, py] = points[i - 1], [x, y] = points[i], [nx, ny] = points[i + 1];
    const r = Math.min(radius, Math.hypot(x - px, y - py) / 2, Math.hypot(nx - x, ny - y) / 2);
    const inX = Math.sign(x - px), inY = Math.sign(y - py), outX = Math.sign(nx - x), outY = Math.sign(ny - y);
    d += ` L ${x - inX * r} ${y - inY * r} Q ${x} ${y} ${x + outX * r} ${y + outY * r}`;
  }
  const [lx, ly] = points[points.length - 1];
  return `${d} L ${lx} ${ly}`;
}

/**
 * The line from one card to the next: it leaves and enters through the sides that face each other and runs in right
 * angles with rounded bends (Sim's workflow edge: a smooth-step path, bends of 8, a 30 lead-out across or 20 down).
 * A card behind the one it leads to is gone around rather than through.
 */
export function edgePath(a: { x: number; y: number; w: number; h: number }, b: { x: number; y: number; w: number; h: number }) {
  const acx = a.x + a.w / 2, acy = a.y + a.h / 2, bcx = b.x + b.w / 2, bcy = b.y + b.h / 2;
  const across = Math.abs(bcx - acx) - (a.w + b.w) / 2 > Math.abs(bcy - acy) - (a.h + b.h) / 2;
  let points: Array<[number, number]>;
  if (across) {
    const forward = bcx >= acx;
    const x1 = forward ? a.x + a.w : a.x, x2 = forward ? b.x : b.x + b.w, y1 = acy, y2 = bcy, lead = 30 * (forward ? 1 : -1);
    const xm = (x1 + x2) / 2;
    points = Math.abs(y2 - y1) < 1 ? [[x1, y1], [x2, y2]] : [[x1, y1], [xm, y1], [xm, y2], [x2, y2]];
    if (Math.sign(x2 - x1) !== Math.sign(lead)) {
      const ym = (y1 + y2) / 2;
      points = [[x1, y1], [x1 + lead, y1], [x1 + lead, ym], [x2 - lead, ym], [x2 - lead, y2], [x2, y2]];
    }
  } else {
    const forward = bcy >= acy;
    const y1 = forward ? a.y + a.h : a.y, y2 = forward ? b.y : b.y + b.h, x1 = acx, x2 = bcx, lead = 20 * (forward ? 1 : -1);
    const ym = (y1 + y2) / 2;
    points = Math.abs(x2 - x1) < 1 ? [[x1, y1], [x2, y2]] : [[x1, y1], [x1, ym], [x2, ym], [x2, y2]];
    if (Math.sign(y2 - y1) !== Math.sign(lead)) {
      const xm = (x1 + x2) / 2;
      points = [[x1, y1], [x1, y1 + lead], [xm, y1 + lead], [xm, y2 - lead], [x2, y2 - lead], [x2, y2]];
    }
  }
  const [x1, y1] = points[0], [x2, y2] = points[points.length - 1];
  const mid = Math.floor((points.length - 1) / 2);
  const [m1x, m1y] = points[mid], [m2x, m2y] = points[mid + 1];
  return { d: roundedPath(points, 8), x1, y1, x2, y2, mx: (m1x + m2x) / 2, my: (m1y + m2y) / 2, across };
}

/** The graph a path of opened node ids leads to, and the nodes along the way. */
function graphAt(root: GraphInner, path: readonly string[]): { graph: GraphInner; trail: GraphNodeInput[] } {
  let graph = root;
  const trail: GraphNodeInput[] = [];
  for (const id of path) {
    const node = graph.nodes.find(n => n.id === id);
    if (!node?.inner) break;
    trail.push(node);
    graph = node.inner;
  }
  return { graph, trail };
}

export const NodeGraph: React.FC<NodeGraphProps> = ({
  nodes: rootNodes,
  edges: rootEdges,
  layout = 'radial',
  layoutOptions,
  statusOverrides,
  selectedNodeId,
  onSelectNode,
  selectedEdgeId,
  onSelectEdge,
  renderNode,
  emptyState,
  toneToColor = defaultToneColor,
  ariaLabel = 'Topology',
  className,
  style,
  readableMinZoom = 0.55,
  scrollable = false,
  showControls = false,
  showMinimap: minimapWanted = true,
  edgeDash,
  edgeStrokeWidth = 1.5,
  edgeOpacity = 1,
  nodePresentation = 'card',
  canDrop,
  onDropNode,
  notes,
  direction,
  still = false,
  onNodeAction,
  rootLabel = 'All',
  onPathChange,
  children,
}) => {
  // Which node's own graph is open: a path of node ids from the outermost graph. A path that no longer leads anywhere
  // (the node went away) stops where it can.
  const [path, setPath] = useState<readonly string[]>([]);
  const { graph: shownGraph, trail } = useMemo(() => graphAt({ nodes: rootNodes, edges: rootEdges }, path), [rootNodes, rootEdges, path]);
  const nodes = shownGraph.nodes;
  const edges = shownGraph.edges;
  const openPath = useCallback((next: readonly string[]) => { setPath(next); onPathChange?.(next); }, [onPathChange]);
  const [internalSelectedNodeId, setInternalSelectedNodeId] = useState<string>();
  const [internalSelectedEdgeId, setInternalSelectedEdgeId] = useState<string>();
  const activeNodeId = selectedNodeId ?? internalSelectedNodeId;
  const activeEdgeId = selectedEdgeId ?? internalSelectedEdgeId;
  // Viewport (camera). Uncontrolled — the view owns its pan/zoom.
  const [panX, setPanX] = useState(0);
  const [panY, setPanY] = useState(0);
  const [zoom, setZoom] = useState(1);
  const drag = useRef<{ x: number; y: number; panX: number; panY: number } | null>(null);
  // A node held by the pointer: it becomes a drag once the pointer moves past a few pixels, and the press that ends a
  // drag never also selects (the click it makes is swallowed).
  const held = useRef<{ id: string; x: number; y: number; active: boolean } | null>(null);
  const swallowClick = useRef(false);
  const [dragging, setDragging] = useState<{ id: string; x: number; y: number; over: string | null } | null>(null);
  // The container element (measured so we can center the graph in the viewport).
  const containerRef = useRef<HTMLDivElement | null>(null);
  // Once the user pans/zooms, we stop auto-centering (never fight the user's camera).
  const userMoved = useRef(false);
  const [viewportWidth, setViewportWidth] = useState(0);
  useLayoutEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const observer = new ResizeObserver(() => {
      const width = el.clientWidth;
      setViewportWidth(old => {
        if (old !== width) userMoved.current = false;
        return width;
      });
    });
    observer.observe(el);
    setViewportWidth(el.clientWidth);
    return () => observer.disconnect();
  }, []);

  const sizeOf = useCallback((n: GraphNodeInput) => {
    if (nodePresentation === 'orb') {
      const fallback = n.primary ? PRIMARY_ORB_W : ORB_W;
      return { w: n.width ?? fallback, h: n.height ?? fallback };
    }
    const w = n.width ?? layoutOptions?.defaultWidth ?? DEFAULT_W;
    return { w, h: n.height ?? cardHeight(n, w, Boolean(resolveStatusView(n.status, statusOverrides).label), Boolean(notes?.[n.id])) };
  }, [nodePresentation, layoutOptions?.defaultWidth, statusOverrides, notes]);
  // Which way the levels run: the caller's choice, or by how wide the canvas is.
  const runs: LayoutDirection = direction === 'auto' ? (viewportWidth >= SIDE_BY_SIDE_PX ? 'right' : 'down') : direction ?? layoutOptions?.direction ?? 'down';

  // Positions come ONLY from the pure layout leaf, memoized on topology + layout.
  const positions = useMemo(() => {
    const layoutNodes: LayoutNode[] = nodes.map((n) => {
      const { w, h } = sizeOf(n);
      return { id: n.id, width: w, height: h };
    });
    const layoutEdges: LayoutEdge[] = edges.map((e) => ({ from: e.from, to: e.to }));
    return computeGraphLayout(layoutNodes, layoutEdges, layout, {
      ...layoutOptions,
      direction: runs,
      ...(scrollable && viewportWidth && runs === 'down' ? { maxRowWidth: Math.max(1, viewportWidth - 48) } : {}),
    });
  }, [nodes, edges, layout, layoutOptions, sizeOf, scrollable, viewportWidth, runs]);

  // Layout coords are centered on the ORIGIN (radial root at 0,0; rings at ±radius),
  // so without this the graph draws at the container's top-left corner with half its
  // nodes off-screen (negative coords). Compute the graph's bounding box so we can
  // translate its center to the viewport center.
  const bbox = useMemo(() => {
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const n of nodes) {
      const p = positions.get(n.id);
      if (!p) continue;
      const { w, h } = sizeOf(n);
      if (p.x < minX) minX = p.x;
      if (p.y < minY) minY = p.y;
      if (p.x + w > maxX) maxX = p.x + w;
      if (p.y + h > maxY) maxY = p.y + h;
    }
    if (!Number.isFinite(minX)) return null;
    return { minX, minY, maxX, maxY, cx: (minX + maxX) / 2, cy: (minY + maxY) / 2 };
  }, [nodes, positions, sizeOf]);
  const primaryAnchor = useMemo(() => {
    if (nodePresentation !== 'orb') return null;
    const primary = nodes.find((node) => node.primary);
    if (!primary) return null;
    const position = positions.get(primary.id);
    if (!position) return null;
    const { w, h } = sizeOf(primary);
    return { cx: position.x + w / 2, cy: position.y + h / 2 };
  }, [nodePresentation, nodes, positions, sizeOf]);

  // A new graph (different node set/layout) re-enables auto-centering.
  const centerKey = useMemo(
    () => nodes.map((n) => n.id).join('|') + `::${String(layout)}::${nodePresentation}::${runs}::${path.join('/')}`,
    [nodes, layout, nodePresentation, runs, path],
  );
  useLayoutEffect(() => {
    userMoved.current = false;
  }, [centerKey]);

  // Auto-center the graph in the viewport on first paint (and on graph change),
  // until the user takes the camera. A fit-zoom shrinks graphs larger than the
  // viewport so the whole company topology lands on screen instead of only its
  // bottom-right quadrant.
  const fitCamera = useCallback(() => {
    if (!bbox) return;
    const el = containerRef.current;
    if (!el) return;
    const cw = el.clientWidth, ch = el.clientHeight;
    if (cw <= 0 || ch <= 0) return;
    const graphW = bbox.maxX - bbox.minX;
    const graphH = bbox.maxY - bbox.minY;
    const pad = 48;
    const fit = Math.min(1, (cw - pad) / Math.max(1, graphW), scrollable ? 1 : (ch - pad) / Math.max(1, graphH));
    // Never auto-shrink below the legibility floor: a dense graph whose true fit would
    // collapse labels to one character opens at readableMinZoom (centered) and is explored
    // by pan/zoom, instead of rendering as a wall of unreadable single-letter pills. The
    // manual wheel-zoom floor (0.2) is separate, so the user can still zoom out to survey all.
    const floor = still ? 0.15 : Math.min(1, Math.max(0.2, readableMinZoom));
    const nextZoom = Math.min(still ? 1 : 3, Math.max(scrollable ? 0.2 : floor, fit));
    setZoom(nextZoom);
    // A graph that does not fit opens on the work still moving (the first node whose state moves), else where it starts,
    // so a long run shows what is happening now rather than its middle.
    const fits = fit >= nextZoom - 1e-6;
    const moving = fits ? null : nodes.find(n => resolveStatusView(n.status, statusOverrides).pulse);
    const at = moving ? positions.get(moving.id) : null;
    const start = { cx: bbox.minX + (cw / 2 - pad / 2) / nextZoom, cy: bbox.minY + (ch / 2 - pad / 2) / nextZoom };
    const cameraAnchor = primaryAnchor ?? (moving && at ? { cx: at.x + sizeOf(moving).w / 2, cy: at.y + sizeOf(moving).h / 2 } : fits ? bbox : start);
    setPanX(cw / 2 - cameraAnchor.cx * nextZoom);
    setPanY(scrollable ? 56 - bbox.minY * nextZoom : ch / 2 - cameraAnchor.cy * nextZoom);
    userMoved.current = false;
  }, [bbox, primaryAnchor, readableMinZoom, scrollable, viewportWidth, still, nodes, statusOverrides, positions, sizeOf]);
  useLayoutEffect(() => {
    if (!userMoved.current) fitCamera();
  }, [fitCamera, centerKey]);

  const changeZoom = useCallback((factor: number) => {
    const next = Math.min(3, Math.max(0.2, zoom * factor));
    const selected = nodes.find(node => node.id === activeNodeId) ?? nodes.find(node => node.primary);
    const p = selected && positions.get(selected.id);
    const anchor = p && selected ? { cx: p.x + sizeOf(selected).w / 2, cy: p.y + sizeOf(selected).h / 2 } : bbox;
    if (anchor) {
      setPanX(panX + anchor.cx * (zoom - next));
      setPanY(panY + anchor.cy * (zoom - next));
    }
    userMoved.current = true;
    setZoom(next);
  }, [zoom, panX, panY, nodes, positions, activeNodeId, bbox, sizeOf]);

  // The node under a point that may take the held node, if any.
  const dropTargetAt = useCallback((x: number, y: number, draggedId: string): string | null => {
    const under = document.elementFromPoint(x, y)?.closest('[data-node-id]')?.getAttribute('data-node-id') ?? null;
    return under && under !== draggedId && (canDrop ? canDrop(draggedId, under) : true) ? under : null;
  }, [canDrop]);

  const onPointerDown = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    swallowClick.current = false;
    const target = e.target as HTMLElement;
    const node = target.closest('[data-node-id]');
    // A node is held for a drag with a mouse or pen; a finger keeps scrolling and panning as it does.
    if (node) {
      if (onDropNode && e.pointerType !== 'touch' && e.button === 0 && !target.closest('button')) {
        held.current = { id: node.getAttribute('data-node-id')!, x: e.clientX, y: e.clientY, active: false };
      }
      return;
    }
    // Only pan when the empty canvas is grabbed (not a node).
    if (target.closest('[data-edge-id], button')) return;
    drag.current = { x: e.clientX, y: e.clientY, panX, panY };
    (e.currentTarget as HTMLElement).setPointerCapture?.(e.pointerId);
  }, [panX, panY, onDropNode]);

  const onPointerMove = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    const holding = held.current;
    if (holding) {
      if (!holding.active && Math.hypot(e.clientX - holding.x, e.clientY - holding.y) < 6) return;
      if (!holding.active) {
        holding.active = true;
        (e.currentTarget as HTMLElement).setPointerCapture?.(e.pointerId);
      }
      const box = containerRef.current?.getBoundingClientRect();
      setDragging({ id: holding.id, x: e.clientX - (box?.left ?? 0), y: e.clientY - (box?.top ?? 0), over: dropTargetAt(e.clientX, e.clientY, holding.id) });
      return;
    }
    if (!drag.current) return;
    userMoved.current = true;
    setPanX(drag.current.panX + (e.clientX - drag.current.x));
    setPanY(drag.current.panY + (e.clientY - drag.current.y));
  }, [dropTargetAt]);

  const onPointerUp = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    const holding = held.current;
    held.current = null;
    drag.current = null;
    if (!holding?.active) return;
    swallowClick.current = true;
    setDragging(null);
    const target = e.type === 'pointerup' ? dropTargetAt(e.clientX, e.clientY, holding.id) : null;
    if (target) onDropNode?.(holding.id, target);
  }, [dropTargetAt, onDropNode]);

  const onWheel = useCallback((e: React.WheelEvent<HTMLDivElement>) => {
    if (still) return;
    // Ordinary wheel/touch scrolling stays available through a tall graph.
    if (scrollable && !e.ctrlKey && !e.metaKey) return;
    changeZoom(e.deltaY < 0 ? 1.1 : 0.9);
  }, [changeZoom, scrollable, still]);

  const selectNode = useCallback((id: string) => {
    if (still) return;
    setInternalSelectedNodeId(id);
    setInternalSelectedEdgeId(undefined);
    onSelectNode?.(id);
  }, [still, onSelectNode]);
  const openNode = useCallback((node: GraphNodeInput) => {
    if (node.inner && !still) openPath([...path, node.id]);
  }, [still, openPath, path]);

  const containerStyle: React.CSSProperties = {
    position: 'relative',
    overflow: 'hidden',
    width: '100%',
    minWidth: 0,
    height: scrollable && bbox ? Math.max(200, (bbox.maxY - bbox.minY) * zoom + 80) : '100%',
    minHeight: still ? 0 : 200,
    touchAction: scrollable ? 'pan-y' : still ? 'auto' : 'none',
    cursor: still ? 'default' : dragging ? (dragging.over ? 'copy' : 'no-drop') : drag.current ? 'grabbing' : 'grab',
    ...style,
  };

  // Where the person is, while inside a node's own graph: the outer graphs, each one press away.
  const trailBar = path.length ? (
    <div data-node-graph-trail style={{ position: 'absolute', top: 8, left: 8, right: showControls ? 132 : 8, zIndex: 3, display: 'flex', alignItems: 'center', gap: 6, minWidth: 0, pointerEvents: 'none' }}>
      <div style={{ pointerEvents: 'auto', maxWidth: '100%', overflow: 'hidden', padding: '4px 10px', borderRadius: 'var(--radius-control, 8px)', background: 'var(--node-card-bg, #ffffff)', border: '1px solid var(--node-card-border, #e5e5e0)', boxShadow: 'var(--node-card-shadow, 0 1px 2px rgba(16,24,40,0.06))' }}>
        <Breadcrumb className="coss-ui">
          <BreadcrumbList>
            <BreadcrumbItem><BreadcrumbLink onClick={() => openPath([])}>{rootLabel}</BreadcrumbLink></BreadcrumbItem>
            {trail.map((node, i) => (
              <React.Fragment key={node.id}>
                <BreadcrumbSeparator />
                <BreadcrumbItem>
                  {i === trail.length - 1
                    ? <BreadcrumbPage>{node.label ?? node.id}</BreadcrumbPage>
                    : <BreadcrumbLink onClick={() => openPath(path.slice(0, i + 1))}>{node.label ?? node.id}</BreadcrumbLink>}
                </BreadcrumbItem>
              </React.Fragment>
            ))}
          </BreadcrumbList>
        </Breadcrumb>
      </div>
    </div>
  ) : null;

  // Empty state — honest, no fake orchestrator (render-state matrix).
  if (nodes.length === 0) {
    return (
      <div ref={containerRef} className={className} style={containerStyle} aria-label={ariaLabel} data-node-graph="empty">
        <CanvasDotGrid panX={panX} panY={panY} zoom={zoom} />
        {trailBar}
        <div style={{ position: 'absolute', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'var(--text-tertiary, #9e9e9e)', pointerEvents: 'none' }}>
          {emptyState ?? 'Nothing running yet.'}
        </div>
        {children}
      </div>
    );
  }

  const byId = new Map(nodes.map(n => [n.id, n] as const));
  // A map of the whole graph once it no longer fits on screen, so the person always knows where they are in it.
  const showMinimap = minimapWanted && !still && !scrollable && bbox && viewportWidth >= 560 && containerRef.current
    && ((bbox.maxX - bbox.minX) * zoom > viewportWidth || (bbox.maxY - bbox.minY) * zoom > containerRef.current.clientHeight);

  return (
    <div
      ref={containerRef}
      className={className}
      style={containerStyle}
      aria-label={ariaLabel}
      data-node-graph="true"
      data-graph-zoom={zoom}
      data-graph-runs={runs}
      data-graph-depth={path.length}
      onPointerDown={still ? undefined : onPointerDown}
      onPointerMove={still ? undefined : onPointerMove}
      onPointerUp={still ? undefined : onPointerUp}
      onPointerCancel={still ? undefined : onPointerUp}
      onWheel={onWheel}
    >
      {still ? null : <CanvasDotGrid panX={panX} panY={panY} zoom={zoom} />}
      {trailBar}

      {showControls && !still ? <div role="group" aria-label="Canvas zoom" style={{ position: 'absolute', top: 8, right: 8, zIndex: 3, display: 'flex', gap: 4 }}>
        <Button size="sm" variant="outline" aria-label="Zoom out" onClick={() => changeZoom(1 / 1.3)}>−</Button>
        <Button size="sm" variant="outline" aria-label="Zoom in" onClick={() => changeZoom(1.3)}>+</Button>
        <Button size="sm" variant="outline" onClick={fitCamera}>Fit</Button>
      </div> : null}

      {/* Lines (behind the cards). Their colour and movement come from DATA activity; a line into work that has run is
          drawn a little heavier (Sim's run-path edge), one into work happening now carries a dot travelling along it. */}
      <CanvasEdgeOverlay panX={panX} panY={panY} zoom={zoom}>
        {edges.map((e, i) => {
          const a = positions.get(e.from);
          const b = positions.get(e.to);
          const an = byId.get(e.from);
          const bn = byId.get(e.to);
          if (!a || !b || !an || !bn) return null; // dangling ref → skip drawing (layout still placed both)
          const as = sizeOf(an); const bs = sizeOf(bn);
          const card = nodePresentation === 'card';
          const route = card
            ? edgePath({ x: a.x, y: a.y, w: as.w, h: as.h }, { x: b.x, y: b.y, w: bs.w, h: bs.h })
            : { d: `M ${a.x + as.w / 2} ${a.y + as.h / 2} L ${b.x + bs.w / 2} ${b.y + bs.h / 2}`, mx: (a.x + b.x + (as.w + bs.w) / 2) / 2, my: (a.y + b.y + (as.h + bs.h) / 2) / 2, x2: 0, y2: 0, across: false };
          const act = resolveEdgeActivity(e.activity, statusOverrides);
          const color = toneToColor(act.tone);
          const ran = Boolean(e.activity) && act.tone !== 'idle' && act.tone !== 'neutral';
          // Idle edges take the caller's dash (the light dashed company-graph
          // spokes); flowing edges keep the animated flow dash regardless.
          const idleDash = act.flowing ? '6 6' : edgeDash;
          const edgeId = e.id ?? `${e.from}->${e.to}:${i}`;
          const selected = activeEdgeId === edgeId;
          const width = selected ? edgeStrokeWidth + 2 : ran && card ? edgeStrokeWidth + 0.75 : edgeStrokeWidth;
          const choose = () => {
            if (still) return;
            setInternalSelectedEdgeId(edgeId);
            setInternalSelectedNodeId(undefined);
            onSelectEdge?.({ ...e, id: edgeId });
          };
          return (
            <g key={edgeId}>
              <path
                d={route.d}
                fill="none"
                stroke={color}
                strokeWidth={width}
                strokeOpacity={selected ? 1 : edgeOpacity}
                strokeLinecap="round"
                markerEnd={card ? undefined : 'url(#arrowhead)'}
                strokeDasharray={idleDash}
                className={act.flowing ? 'rtp-edge-flow' : undefined}
                data-edge-flowing={act.flowing ? 'true' : 'false'}
                data-edge-id={edgeId}
                role="button"
                tabIndex={still ? -1 : 0}
                aria-label={`Connection from ${an.label ?? an.id} to ${bn.label ?? bn.id}`}
                style={{ pointerEvents: still ? 'none' : 'stroke', cursor: 'pointer' }}
                onClick={(event) => { event.stopPropagation(); choose(); }}
                onKeyDown={(event) => {
                  if (event.key !== 'Enter' && event.key !== ' ') return;
                  event.preventDefault();
                  choose();
                }}
              />
              {act.flowing ? (
                <circle r={3.5} fill={color} data-edge-traveller aria-hidden="true" className="rtp-edge-traveller">
                  <animateMotion dur="1.6s" repeatCount="indefinite" path={route.d} />
                </circle>
              ) : null}
              {e.label ? (
                <foreignObject x={route.mx - 80} y={route.my - 11} width={160} height={22} style={{ overflow: 'visible', pointerEvents: 'none' }}>
                  <div data-edge-label style={{ display: 'flex', justifyContent: 'center' }}>
                    <span style={{ maxWidth: 160, padding: '1px 8px', borderRadius: 999, fontSize: 11, lineHeight: '18px', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', color: 'var(--node-sublabel-color, #6b7280)', background: 'var(--node-card-bg, #ffffff)', border: `1px solid color-mix(in srgb, ${color} 40%, var(--node-card-border, #e5e5e0))` }}>{e.label}</span>
                  </div>
                </foreignObject>
              ) : null}
            </g>
          );
        })}
      </CanvasEdgeOverlay>

      {/* Nodes. Presentation (tone/pulse/dim) is DATA-decoded. */}
      {nodes.map((n) => {
        const p = positions.get(n.id)!;
        const { w, h } = sizeOf(n);
        const sv = resolveStatusView(n.status, statusOverrides);
        const color = toneToColor(sv.tone);
        const hasIn = card(nodePresentation) && edges.some(e => e.to === n.id);
        const hasOut = card(nodePresentation) && edges.some(e => e.from === n.id);
        return (
          <CanvasNode
            key={n.id}
            x={panX + p.x * zoom}
            y={panY + p.y * zoom}
            width={w * zoom}
            height={h * zoom}
            selected={!still && activeNodeId === n.id}
            ariaLabel={n.label ?? n.id}
            ariaRole={still ? undefined : 'button'}
            tabIndex={still ? undefined : 0}
            cursor={still ? 'default' : 'pointer'}
            onClick={() => {
              if (swallowClick.current) { swallowClick.current = false; return; }
              selectNode(n.id);
            }}
            onDoubleClick={() => openNode(n)}
            onKeyDown={(event) => {
              if (event.target !== event.currentTarget) return;
              if (event.key === 'Enter' && n.inner && (event.metaKey || event.altKey)) { event.preventDefault(); openNode(n); return; }
              if (event.key !== 'Enter' && event.key !== ' ') return;
              event.preventDefault();
              selectNode(n.id);
            }}
          >
            {renderNode ? (
              <div data-node-id={n.id} data-tone={sv.tone} className={sv.pulse ? 'rtp-node-pulse' : undefined} style={{ position: 'relative', width: '100%', height: '100%' }}>
                {renderNode(n, sv, { zoom })}
              </div>
            ) : (
              // The card is drawn at its own size and scaled with the camera, so its words shrink with it and are never
              // cut short by a box that shrank around unscaled text.
              <div style={{ width: w, height: h, transform: `scale(${zoom})`, transformOrigin: '0 0' }}>
                <NodeCard
                  node={n}
                  view={sv}
                  color={color}
                  toneToColor={toneToColor}
                  statusOverrides={statusOverrides}
                  presentation={nodePresentation}
                  note={notes?.[n.id]}
                  dropTarget={dragging?.over === n.id}
                  dragged={dragging?.id === n.id}
                  ports={{ in: hasIn, out: hasOut, runs }}
                  still={still}
                  onOpen={n.inner ? () => openNode(n) : undefined}
                  onAction={onNodeAction ? (actionId) => onNodeAction(n.id, actionId) : undefined}
                />
              </div>
            )}
          </CanvasNode>
        );
      })}

      {showMinimap && bbox ? (
        <CanvasMinimap
          frames={nodes.map(n => { const at = positions.get(n.id)!; const { w, h } = sizeOf(n); return { id: n.id, x: at.x, y: at.y, width: w, height: h }; })}
          panX={panX}
          panY={panY}
          zoom={zoom}
          viewportWidth={viewportWidth}
          viewportHeight={containerRef.current?.clientHeight ?? 0}
          selectedId={activeNodeId ?? null}
          corner="bottom-right"
          onJump={(wx, wy) => {
            const el = containerRef.current;
            if (!el) return;
            userMoved.current = true;
            setPanX(el.clientWidth / 2 - wx * zoom);
            setPanY(el.clientHeight / 2 - wy * zoom);
          }}
        />
      ) : null}

      {/* What is being dragged follows the pointer: its label on a small chip that never takes the pointer itself. */}
      {dragging ? (
        <div data-node-drag-chip aria-hidden="true" style={{
          position: 'absolute', left: dragging.x + 12, top: dragging.y + 12, zIndex: 4, pointerEvents: 'none',
          maxWidth: 220, padding: '4px 10px', borderRadius: 999, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
          fontSize: 'var(--font-size-caption)', fontWeight: 600,
          background: 'var(--node-card-bg, #ffffff)', color: 'var(--node-label-color, #1f2937)',
          border: `1px solid ${dragging.over ? 'var(--color-primary, var(--accent-info, #1565c0))' : 'var(--node-card-border, #e5e5e0)'}`,
          boxShadow: 'var(--node-card-shadow, 0 4px 12px rgba(16,24,40,0.12))',
          cursor: dragging.over ? 'copy' : 'no-drop',
        }}>
          {byId.get(dragging.id)?.label ?? dragging.id}
        </div>
      ) : null}

      {children}

      {/* Motion: lines into work happening now flow and carry a travelling dot; a card whose state moves breathes a ring
          in its own tone (Sim's ring pulse: 1.5px to 4px over 1.5s). Reduced motion keeps every state, drops the motion. */}
      <style>{`
        @keyframes rtp-edge-flow-dash { to { stroke-dashoffset: -12; } }
        .rtp-edge-flow { animation: rtp-edge-flow-dash 0.6s linear infinite; }
        @keyframes rtp-node-pulse-kf { 0%,100% { box-shadow: 0 0 0 1.5px var(--rtp-tone, rgba(21,101,192,0.5)), var(--rtp-shadow, 0 0 0 0 transparent); } 50% { box-shadow: 0 0 0 4px var(--rtp-tone, rgba(21,101,192,0.5)), var(--rtp-shadow, 0 0 0 0 transparent); } }
        .rtp-node-pulse { animation: rtp-node-pulse-kf 1.5s ease-in-out infinite; }
        @keyframes rtp-node-sheen-kf { from { transform: translateX(-100%); } to { transform: translateX(100%); } }
        .rtp-node-sheen { animation: rtp-node-sheen-kf 2.4s ease-in-out infinite; }
        @media (prefers-reduced-motion: reduce) { .rtp-edge-flow, .rtp-node-pulse, .rtp-node-sheen { animation: none; } .rtp-edge-traveller { display: none; } }
      `}</style>
    </div>
  );
};

NodeGraph.displayName = 'NodeGraph';

const card = (presentation: NodePresentation) => presentation === 'card';

interface NodeCardProps {
  readonly node: GraphNodeInput;
  readonly view: StatusView;
  readonly color: string;
  readonly toneToColor: (tone: string) => string;
  readonly statusOverrides?: StatusOverrides;
  readonly presentation: NodePresentation;
  readonly note?: { readonly text: string; readonly tone?: string };
  readonly dropTarget: boolean;
  readonly dragged: boolean;
  readonly ports: { readonly in: boolean; readonly out: boolean; readonly runs: LayoutDirection };
  readonly still: boolean;
  readonly onOpen?: () => void;
  readonly onAction?: (actionId: string) => void | Promise<unknown>;
}

const clamp = (lines: number): React.CSSProperties => ({ display: '-webkit-box', WebkitBoxOrient: 'vertical', WebkitLineClamp: lines, overflow: 'hidden', overflowWrap: 'anywhere' });

/**
 * One card at world size. A section card (Sim's workflow block): a header with the node's icon on a tile tinted by its
 * tone, its title and a short figure on the right; under a hairline, its state, a line of what it is, its rows (Sim's
 * summary rows: a name on the left, quiet words on the right, each with its own state), a note, its progress, and a
 * footer that opens its own graph and runs what can be done to it. Ports sit on the sides its lines use.
 */
function NodeCard({ node: n, view: sv, color, toneToColor, statusOverrides, presentation, note, dropTarget, dragged, ports, still, onOpen, onAction }: NodeCardProps) {
  const orb = presentation === 'orb';
  const muted = n.primary ? 'var(--node-root-sublabel-color, #d1d5db)' : 'var(--node-sublabel-color, #6b7280)';
  const body = Boolean(sv.label || n.subtitle || n.rows?.length || note || n.progress !== undefined);
  const port = (side: 'in' | 'out') => {
    const across = ports.runs === 'right';
    const at: React.CSSProperties = across
      ? { top: CARD.pad / 2 + CARD.head / 2, transform: 'translateY(-50%)', width: 6, height: 18, [side === 'in' ? 'left' : 'right']: -7, borderRadius: side === 'in' ? '3px 0 0 3px' : '0 3px 3px 0' }
      : { left: '50%', transform: 'translateX(-50%)', width: 18, height: 6, [side === 'in' ? 'top' : 'bottom']: -7, borderRadius: side === 'in' ? '3px 3px 0 0' : '0 0 3px 3px' };
    return <span data-node-port={side} aria-hidden="true" style={{ position: 'absolute', background: `color-mix(in srgb, ${color} 55%, var(--node-card-border, #d4d4cf))`, ...at }} />;
  };
  return (
    <div
      data-node-id={n.id}
      data-tone={sv.tone}
      data-node-primary={n.primary ? 'true' : undefined}
      data-node-presentation={presentation}
      data-drop-target={dropTarget ? 'true' : undefined}
      data-dragged={dragged ? 'true' : undefined}
      className={sv.pulse ? 'rtp-node-pulse' : undefined}
      style={{
        position: 'relative',
        width: '100%', height: '100%', boxSizing: 'border-box',
        display: 'flex',
        flexDirection: 'column',
        justifyContent: orb ? 'center' : 'flex-start',
        alignItems: orb ? 'center' : undefined,
        textAlign: orb ? 'center' : undefined,
        gap: orb ? 7 : CARD.gap,
        padding: orb ? 18 : CARD.pad / 2,
        borderRadius: orb ? 999 : 12,
        // A thin neutral edge tinted by the node's tone; the strong colour lives in the icon tile, the state and the ring.
        border: n.primary
          ? `${orb ? 2 : 1.5}px solid ${color}`
          : `1px solid color-mix(in srgb, ${color} 28%, var(--node-card-border, #e5e5e0))`,
        background: n.primary ? 'var(--node-root-bg, #111827)' : 'var(--node-card-bg, #ffffff)',
        color: n.primary ? 'var(--node-root-label-color, #f9fafb)' : 'var(--node-label-color, #1f2937)',
        ['--rtp-tone' as string]: `color-mix(in srgb, ${color} 55%, transparent)`,
        ['--rtp-shadow' as string]: 'var(--node-card-shadow, 0 1px 2px rgba(16,24,40,0.06), 0 4px 12px rgba(16,24,40,0.06))',
        boxShadow: n.primary && orb
          ? `0 0 0 8px color-mix(in srgb, ${color} 12%, transparent), var(--node-card-shadow, 0 8px 28px rgba(16,24,40,0.16))`
          : 'var(--node-card-shadow, 0 1px 2px rgba(16,24,40,0.06), 0 4px 12px rgba(16,24,40,0.06))',
        opacity: sv.dim || dragged ? 0.5 : 1,
        outline: dropTarget ? '2px solid var(--color-primary, var(--accent-info, #1565c0))' : undefined,
        outlineOffset: dropTarget ? 2 : undefined,
      }}
    >
      {ports.in ? port('in') : null}
      {ports.out ? port('out') : null}
      {sv.pulse && !orb ? (
        <span aria-hidden="true" style={{ position: 'absolute', inset: 0, borderRadius: 12, overflow: 'hidden', pointerEvents: 'none' }}>
          <span className="rtp-node-sheen" style={{ position: 'absolute', inset: 0, background: `linear-gradient(90deg, transparent, color-mix(in srgb, ${color} 10%, transparent), transparent)` }} />
        </span>
      ) : null}
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: orb ? 'center' : undefined, gap: 8, minWidth: 0, minHeight: orb ? undefined : CARD.head, width: '100%' }}>
        {n.mark ? <span data-node-mark style={{ display: 'inline-flex', flex: '0 0 auto' }}>{n.mark}</span> : null}
        {n.icon ? (
          <span data-node-icon aria-hidden="true" style={{ display: 'inline-flex', alignItems: 'center', justifyContent: 'center', flex: '0 0 auto', width: 26, height: 26, borderRadius: 7, color, background: `color-mix(in srgb, ${color} 16%, transparent)` }}>
            <NamedIcon name={n.icon} size="sm" />
          </span>
        ) : n.mark ? null : <span style={{ width: 8, height: 8, borderRadius: 999, background: color, flex: '0 0 auto' }} aria-hidden="true" />}
        <span style={{ flex: 1, minWidth: 0, fontWeight: n.primary ? 700 : 600, fontSize: n.primary ? 15 : 13, lineHeight: '16px', ...clamp(orb ? 3 : 2) }}>
          {n.label ?? n.id}
        </span>
        {n.meta && !orb ? <span data-node-meta style={{ flex: '0 0 auto', fontSize: 11, color: muted, fontVariantNumeric: 'tabular-nums' }}>{n.meta}</span> : null}
      </div>
      {body && !orb && (n.icon || n.rows?.length) ? <span aria-hidden="true" style={{ height: 1, margin: `0 -${CARD.pad / 2}px`, background: 'var(--node-card-border, #e5e5e0)', flex: '0 0 auto' }} /> : null}
      {sv.label ? (
        <div data-node-state style={{ display: 'flex', alignItems: 'center', gap: 6, minHeight: CARD.line, fontSize: 12, color }}>
          <span aria-hidden="true" style={{ width: 6, height: 6, borderRadius: 999, background: color, flex: '0 0 auto' }} />
          <span style={{ whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{sv.label}</span>
        </div>
      ) : null}
      {n.subtitle ? (
        <div style={{ fontSize: 12, lineHeight: `${CARD.sub_line}px`, color: muted, ...clamp(2) }}>{n.subtitle}</div>
      ) : null}
      {n.rows?.length ? (
        <div data-node-rows style={{ display: 'flex', flexDirection: 'column', marginTop: CARD.rows_gap - CARD.gap }}>
          {n.rows.map(row => {
            const rv = resolveStatusView(row.status, statusOverrides);
            const rc = toneToColor(rv.tone);
            return (
              <div key={row.id} data-node-row={row.id} data-tone={rv.tone} style={{ display: 'flex', alignItems: 'center', gap: 8, height: CARD.row, fontSize: 12, minWidth: 0 }}>
                {row.icon ? <span aria-hidden="true" style={{ display: 'inline-flex', color: rc, flex: '0 0 auto' }}><NamedIcon name={row.icon} size="xs" /></span>
                  : <span aria-hidden="true" style={{ width: 6, height: 6, borderRadius: 999, background: rc, flex: '0 0 auto' }} />}
                <span style={{ flex: '1 1 auto', minWidth: 0, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', color: muted }}>{row.label}</span>
                {row.detail || rv.label ? <span style={{ flex: '0 1 auto', minWidth: 0, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', color: row.detail ? 'inherit' : rc }}>{row.detail ?? rv.label}</span> : null}
              </div>
            );
          })}
        </div>
      ) : null}
      {note ? (
        <div data-node-note role="status" style={{ fontSize: 12, minHeight: CARD.line, color: note.tone ? toneToColor(note.tone) : muted, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{note.text}</div>
      ) : null}
      {n.progress !== undefined ? (
        <div data-node-progress style={{ display: 'flex', alignItems: 'center', gap: 6, minHeight: CARD.line, fontSize: 12, color: muted }}>
          <span role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(n.progress * 100)} aria-label={`${Math.round(n.progress * 100)}% done`}
            style={{ flex: 1, height: 4, borderRadius: 999, background: `color-mix(in srgb, ${color} 18%, transparent)`, overflow: 'hidden' }}>
            <span style={{ display: 'block', height: '100%', width: `${Math.round(n.progress * 100)}%`, background: color, borderRadius: 999, transition: 'width 400ms ease' }} />
          </span>
          <span>{Math.round(n.progress * 100)}%</span>
        </div>
      ) : null}
      {(n.inner || n.actions?.length) && !orb ? (
        <div data-node-foot style={{ display: 'flex', alignItems: 'center', gap: 6, marginTop: 'auto', minHeight: CARD.foot - 6, minWidth: 0 }}>
          {n.inner ? (
            <Button size="xs" variant="ghost" disabled={still || !onOpen} onClick={(event) => { event.stopPropagation(); onOpen?.(); }} aria-label={`Open ${n.label ?? n.id}`}>
              <NamedIcon name="layers" size="xs" />
              <span>{n.inner.nodes.length} inside</span>
            </Button>
          ) : null}
          <span style={{ flex: 1 }} />
          {(n.actions ?? []).map(action => (
            <Button key={action.id} size="xs" variant="outline" work={action.state ?? undefined} disabled={still || !onAction} data-node-action={action.id}
              onClick={(event) => { event.stopPropagation(); return onAction?.(action.id); }}>
              {action.icon ? <NamedIcon name={action.icon} size="xs" /> : null}
              <span>{action.label}</span>
            </Button>
          ))}
        </div>
      ) : null}
    </div>
  );
}
