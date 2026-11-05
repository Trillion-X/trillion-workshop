// packages/group/read-data/board-islands.ts
//
// BOARD ISLANDS — the CONNECTED COMPONENTS of a board's connector graph. A mind-map is meant to be ONE
// connected structure, but a canvas quietly accumulates several: you sketch one cluster here, another over
// there, and never draw the link between them — so what looks like a single map is really three disconnected
// maps sharing a page. This finds them: the maximal sets of cards reachable from each other through
// connectors (UNDIRECTED — a link is a link regardless of arrow direction). "Is my board one structure or
// several?" and "select this whole cluster" fall out.
//
// Distinct from every neighbouring reader — `board-orphans` = 0-edge SINGLETON cards; `board-communities`
// (Louvain) = dense modularity sub-clusters WITHIN one connected graph (a FINER cut); `reachableFrom`/
// `impactCone` = DIRECTED reach from an anchor (misses a cousin linked only through a sibling). An island is
// the COARSE undirected partition: the true separate pieces. A pure composition of the relationship-graph
// (`buildRelationGraph` + `neighbors`, L069/L093 — owns no edge logic). Pure, deterministic (board order).

import type { BoardItem } from './group-board-model.ts';
import { itemIsConnector } from './group-board-model.ts';
import { buildRelationGraph, neighbors, type RelationGraph } from './relationship-graph.ts';

/** One connected component — a maximal set of cards linked to each other through connectors. */
export interface Island {
  /** The card ids in this component, sorted. */
  readonly memberIds: readonly string[];
  /** The component size (`memberIds.length`). */
  readonly size: number;
}

/** BFS the undirected component containing `start` over the relation graph (both edge directions). */
function componentOf(graph: RelationGraph, start: string, seen: Set<string>): string[] {
  const found: string[] = [];
  const stack = [start];
  seen.add(start);
  while (stack.length > 0) {
    const id = stack.pop() as string;
    found.push(id);
    for (const nb of neighbors(graph, id)) {
      if (!seen.has(nb)) { seen.add(nb); stack.push(nb); }
    }
  }
  return found;
}

/** Every connected component of the board (including single, unconnected cards), each as an {@link Island}.
 *  Sorted largest-first, ties broken by the smallest member id — so the main structure leads deterministically.
 *  Connectors are EDGES, never nodes, so they are excluded from the components they define. */
export function boardIslands(items: readonly BoardItem[]): Island[] {
  const graph = buildRelationGraph(items);
  const nodes = items.filter((i) => !itemIsConnector(i)).map((i) => i.memberId);
  const seen = new Set<string>();
  const islands: Island[] = [];
  for (const id of nodes) {
    if (seen.has(id)) continue;
    const memberIds = componentOf(graph, id, seen).sort();
    islands.push({ memberIds, size: memberIds.length });
  }
  // Largest first; tie → the island whose first (smallest) id sorts first. Deterministic.
  return islands.sort((a, b) => b.size - a.size || a.memberIds[0].localeCompare(b.memberIds[0]));
}

/** The components of ≥2 cards — the actual connected CLUSTERS (a singleton is an orphan, covered elsewhere). */
export function multiCardIslands(items: readonly BoardItem[]): Island[] {
  return boardIslands(items).filter((i) => i.size >= 2);
}

/** The whole component containing `cardId` (sorted) — the "select this entire cluster" set. `[cardId]` when it
 *  is unconnected; `[]` when the id is not on the board. Undirected, so it captures cousins a directed
 *  branch/upstream walk would miss. */
export function islandOf(items: readonly BoardItem[], cardId: string): string[] {
  for (const island of boardIslands(items)) if (island.memberIds.includes(cardId)) return [...island.memberIds];
  return [];
}

/** The largest connected component's cards (sorted) — the board's main structure. `[]` on an empty board. */
export function largestIsland(items: readonly BoardItem[]): string[] {
  const islands = boardIslands(items);
  return islands.length > 0 ? [...islands[0].memberIds] : [];
}

/** The number of connected CLUSTERS (components of ≥2) — how many separate structures the board holds. */
export function islandCount(items: readonly BoardItem[]): number {
  return multiCardIslands(items).length;
}

/** True iff the board is FRAGMENTED — ≥2 separate multi-card clusters that share no connector path. The gate
 *  for surfacing the "isolate a cluster" affordance (L118): one connected map (or none) has nothing to split. */
export function boardHasMultipleClusters(items: readonly BoardItem[]): boolean {
  return multiCardIslands(items).length >= 2;
}

/** Render the topology: a "## Board clusters (N)" report of each multi-card cluster's size, plus the count of
 *  unconnected loose cards. "One connected board" when there is a single cluster (or nothing). */
export function clustersText(items: readonly BoardItem[], title?: string): string {
  const islands = boardIslands(items);
  const clusters = islands.filter((i) => i.size >= 2);
  const loose = islands.filter((i) => i.size === 1).length;
  const head: string[] = title && title.trim() !== '' ? [`# ${title.trim()}`, ''] : [];
  if (clusters.length <= 1) {
    const note = clusters.length === 1 && loose > 0 ? ` (+ ${loose} loose ${loose === 1 ? 'card' : 'cards'})` : '';
    return [...head, `One connected board${note}`].join('\n');
  }
  const lines = clusters.map((c, i) => `- Cluster ${i + 1} — ${c.size} cards`);
  if (loose > 0) lines.push(`- ${loose} loose ${loose === 1 ? 'card' : 'cards'} (unconnected)`);
  return [...head, `## Board clusters (${clusters.length})`, ...lines].join('\n');
}
