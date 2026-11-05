// packages/group/do-work/board-components.ts
//
// BOARD COMPONENTS — the connector-graph ISLANDS primitive (b127). Hubs (b126) find the central cards;
// critical-path finds the longest chain; this finds the separate CLUSTERS — the disconnected sub-graphs a board
// splits into ("you actually have three unrelated diagrams here"). Distinct from the SPATIAL clusters (b107/
// b109, which group by position/tag): this groups by who is CONNECTED to whom, regardless of where they sit.
//
// Pure COMPOSITION of the existing `relationship-graph` leaf (`buildRelationGraph` builds the connector
// adjacency graph + drops dangling edges) via union-find over its edges — owns no graph construction. Only cards
// with at least one connector belong to a component (an isolated card is not an island). Deterministic
// (components sorted by size desc then first member id; members sorted within a component). Zero I/O.

import type { BoardItem } from '../read-data/group-board-model.ts';
import { buildRelationGraph } from '../read-data/relationship-graph.ts';

/** One connected sub-graph of the board's connectors. */
export interface ConnectorComponent {
  /** The member ids in this island, sorted. */
  readonly memberIds: readonly string[];
  readonly size: number;
  /** Connectors whose BOTH endpoints are inside this island. */
  readonly edgeCount: number;
}

/**
 * Partition the connected cards into islands (weakly-connected components) via union-find over the connector
 * edges. Isolated cards (no connector) are NOT returned — an island has ≥ 2 members by construction. Components
 * are sorted by size (desc) then their first member id; members are sorted within each. Deterministic.
 */
export function connectorComponents(items: readonly BoardItem[]): ConnectorComponent[] {
  const graph = buildRelationGraph(items);
  const parent = new Map<string, string>();
  const find = (x: string): string => {
    let r = x;
    while (parent.get(r) !== r) r = parent.get(r) as string;
    // path-compress toward the root for near-flat repeated lookups
    let c = x;
    while (parent.get(c) !== r) {
      const nxt = parent.get(c) as string;
      parent.set(c, r);
      c = nxt;
    }
    return r;
  };
  const ensure = (x: string): void => {
    if (!parent.has(x)) parent.set(x, x);
  };
  for (const e of graph.edges) {
    ensure(e.from);
    ensure(e.to);
    const a = find(e.from);
    const b = find(e.to);
    if (a !== b) parent.set(a, b); // deterministic: attach a's root under b's root
  }

  const members = new Map<string, string[]>();
  for (const node of parent.keys()) {
    const root = find(node);
    (members.get(root) ?? members.set(root, []).get(root)!).push(node);
  }
  const edgeCounts = new Map<string, number>();
  for (const e of graph.edges) {
    const root = find(e.from); // from & to share a root (unioned above)
    edgeCounts.set(root, (edgeCounts.get(root) ?? 0) + 1);
  }

  const out: ConnectorComponent[] = [];
  for (const [root, ids] of members) {
    const sorted = [...ids].sort((a, b) => a.localeCompare(b));
    out.push({ memberIds: sorted, size: sorted.length, edgeCount: edgeCounts.get(root) ?? 0 });
  }
  out.sort((a, b) => b.size - a.size || a.memberIds[0].localeCompare(b.memberIds[0]));
  return out;
}

/** How many separate islands the board's connectors form. */
export function componentCount(items: readonly BoardItem[]): number {
  return connectorComponents(items).length;
}
