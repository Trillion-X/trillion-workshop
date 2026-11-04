// packages/group/do-work/graph-to-board.ts
//
// GRAPH (nodes + edges) → positioned board items (b174). The shared body of every GRAPH importer — Mermaid,
// GraphML, and DOT all parse their syntax to the SAME `{nodes:{id,label}, edges:{from,to,relation?}}` shape,
// then lay a card per node in dependency columns + a connector item per edge. That layout + item-shaping was
// hand-rolled (with its own `depthByNode`) in EACH importer; this is the ONE builder they now share (L069/L100
// — the per-format parsers stay, the common tail is extracted, deleting the duplicated builders + depth code).
//
// DISTINCT from `outlineLinesToBoardItems` (board-opml-import): that builds from depth-tagged `OutlineLine[]`
// (nesting-derived parents, index ids) for the OUTLINE importers (OPML/FreeMind); this builds from an EXPLICIT
// id'd edge list (dependency-depth columns, the node's own id as memberId) for the GRAPH importers. Two genuinely
// different inputs, two builders — not one forced abstraction. Pure, deterministic; names no kind (L090).

import type { BoardItem } from '../read-data/group-board-model';

/** A graph node: a stable id + a human label. */
export interface GraphNode {
  readonly id: string;
  readonly label: string;
}
/** A graph edge: endpoints (by node id) + an optional relation label (→ the connector's `relationKind`). */
export interface GraphEdge {
  readonly from: string;
  readonly to: string;
  readonly relation?: string;
}

const COL_GAP = 240;
const ROW_GAP = 96;

/**
 * Each node's column = its longest incoming-edge depth (roots at 0), so the board reads left→right by
 * dependency. Kahn-style longest-path over a topological order; cycle nodes never dequeue and stay at 0 (a
 * bounded guard caps the loop). Deterministic. Edges to/from an unknown id are ignored.
 */
export function graphDepths(nodes: readonly GraphNode[], edges: readonly GraphEdge[]): Map<string, number> {
  const ids = new Set(nodes.map((n) => n.id));
  const out = new Map<string, string[]>();
  const indeg = new Map<string, number>();
  for (const n of nodes) {
    out.set(n.id, []);
    indeg.set(n.id, 0);
  }
  for (const e of edges) {
    if (!ids.has(e.from) || !ids.has(e.to)) continue;
    (out.get(e.from) as string[]).push(e.to);
    indeg.set(e.to, (indeg.get(e.to) as number) + 1);
  }
  const depth = new Map<string, number>(nodes.map((n) => [n.id, 0]));
  const rem = new Map(indeg);
  const queue = nodes.filter((n) => (indeg.get(n.id) as number) === 0).map((n) => n.id);
  let guard = 0;
  const cap = nodes.length * (edges.length + 1) + 1;
  while (queue.length > 0 && guard++ < cap) {
    const u = queue.shift() as string;
    for (const v of out.get(u) as string[]) {
      depth.set(v, Math.max(depth.get(v) as number, (depth.get(u) as number) + 1));
      rem.set(v, (rem.get(v) as number) - 1);
      if ((rem.get(v) as number) === 0) queue.push(v);
    }
  }
  return depth;
}

/**
 * Build positioned board items from a graph — a note card per node (laid out left→right by dependency depth,
 * stacked within a column, keyed by the node's own id) + a connector item per edge (`extra.fromMemberId`/
 * `toMemberId`, the relation → `relationKind`). An edge to/from an unknown id is dropped. The live paste pipeline
 * mints fresh ids + re-anchors the connectors. Empty / node-less → []. Pure.
 */
export function graphToBoardItems(
  nodes: readonly GraphNode[],
  edges: readonly GraphEdge[],
  originX = 40,
  originY = 40,
): BoardItem[] {
  if (nodes.length === 0) return [];
  const depth = graphDepths(nodes, edges);
  const rowOfCol = new Map<number, number>();
  const items: BoardItem[] = [];
  for (const n of nodes) {
    const d = depth.get(n.id) ?? 0;
    const row = rowOfCol.get(d) ?? 0;
    rowOfCol.set(d, row + 1);
    items.push({
      memberId: n.id,
      nodeRef: { id: n.id } as never,
      kind: 'note',
      x: originX + d * COL_GAP,
      y: originY + row * ROW_GAP,
      w: 160,
      h: 60,
      isSection: false,
      childCount: 0,
      text: n.label,
      extra: {},
    } as BoardItem);
  }
  const nodeIds = new Set(nodes.map((n) => n.id));
  edges.forEach((e, i) => {
    if (!nodeIds.has(e.from) || !nodeIds.has(e.to)) return;
    items.push({
      memberId: 'edge_' + i,
      nodeRef: { id: 'edge_' + i } as never,
      kind: 'note',
      x: 0,
      y: 0,
      w: 4,
      h: 4,
      isSection: false,
      childCount: 0,
      extra: { fromMemberId: e.from, toMemberId: e.to, ...(e.relation ? { relationKind: e.relation } : {}) },
    } as BoardItem);
  });
  return items;
}
