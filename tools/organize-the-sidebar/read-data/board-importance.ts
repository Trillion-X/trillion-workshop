// packages/group/read-data/board-importance.ts
//
// TRANSITIVE IMPORTANCE (PageRank) over the board's relationship graph — "which cards are the CORE ideas
// everything traces back to?". This is fundamentally DISTINCT from `board-hubs` (degree centrality: how many
// connectors touch a card): degree is LOCAL and cannot see transitivity, while PageRank is RECURSIVE — a card
// endorsed by IMPORTANT cards is itself important, even with few direct links, and a card pointed to by many
// TRIVIAL cards is not. A peripheral card that the two biggest hubs both point to outranks a card with more
// raw connections to leaves. That recursive signal is exactly what degree misses.
//
// A directed edge `from → to` means `from` ENDORSES `to` (importance flows along the edge to the target), so a
// card that important cards point AT accrues importance. Standard PageRank: score(v) = (1-d)/N + d·Σ over each
// u→v of score(u)/outdeg(u), with dangling mass (a card with no out-edges) redistributed uniformly so no rank
// leaks. Damping d = 0.85. Deterministic: a FIXED iteration count (no random init, no wall-clock, no
// epsilon-timing) → byte-identical ranks every run.
//
// Pure COMPOSITION of the `relationship-graph` leaf (`buildRelationGraph` builds the directed connector
// adjacency + drops dangling connectors) — owns no graph construction (L069/L093). Connectors and sections are
// not ranked (a connector is a line, a section is a container). Zero I/O.

import type { BoardItem } from './group-board-model';
import { itemIsConnector } from './group-board-model';
import { buildRelationGraph } from './relationship-graph';

const DAMPING = 0.85;
const ITERATIONS = 60; // ample for board-sized graphs to converge; fixed → deterministic

/**
 * PageRank importance per content card (connectors + sections excluded), summing to ~1 across the board.
 * A card endorsed (pointed at) by important cards ranks high, transitively — what pure degree cannot see.
 * Deterministic (fixed iterations). An empty board → empty map; an edgeless board → uniform 1/N each.
 */
export function importanceRanks(items: readonly BoardItem[]): Map<string, number> {
  const nodes = items.filter((it) => !itemIsConnector(it) && !it.isSection).map((it) => it.memberId);
  const n = nodes.length;
  const ranks = new Map<string, number>();
  if (n === 0) return ranks;

  const graph = buildRelationGraph(items);
  const nodeSet = new Set(nodes);
  // Out-neighbours restricted to real ranked nodes (drop self-loops + edges to a connector/section/absent id),
  // de-duped so a card wired twice to the same target does not double its endorsement weight.
  const outNeighbors = new Map<string, string[]>();
  for (const id of nodes) {
    const outs = new Set<string>();
    for (const e of graph.out[id] ?? []) if (e.to !== id && nodeSet.has(e.to)) outs.add(e.to);
    outNeighbors.set(id, [...outs]);
  }

  let score = new Map<string, number>(nodes.map((id) => [id, 1 / n]));
  for (let iter = 0; iter < ITERATIONS; iter += 1) {
    // Dangling mass = the score sitting on cards with no out-endorsements; redistribute it uniformly so total
    // rank is conserved (otherwise a sink would silently drain the board's importance to zero).
    let dangling = 0;
    for (const id of nodes) if (outNeighbors.get(id)!.length === 0) dangling += score.get(id)!;
    const base = (1 - DAMPING) / n + (DAMPING * dangling) / n;
    const next = new Map<string, number>(nodes.map((id) => [id, base]));
    for (const id of nodes) {
      const outs = outNeighbors.get(id)!;
      if (outs.length === 0) continue;
      const share = (DAMPING * score.get(id)!) / outs.length;
      for (const t of outs) next.set(t, next.get(t)! + share);
    }
    score = next;
  }
  return score;
}

/** A card's importance value for the axis engine (0 when unranked), so "line up by importance" is one lookup. */
export function importanceValue(ranks: Map<string, number>, cardId: string): number {
  return ranks.get(cardId) ?? 0;
}

/** The most important card ids, highest first (deterministic id tie-break). `k` caps the list (default: all). */
export function mostImportant(items: readonly BoardItem[], k = Number.POSITIVE_INFINITY): string[] {
  const ranks = importanceRanks(items);
  return [...ranks.entries()]
    .sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
    .slice(0, k)
    .map(([id]) => id);
}
