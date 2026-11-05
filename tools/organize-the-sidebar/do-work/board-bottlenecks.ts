// packages/group/do-work/board-bottlenecks.ts
//
// BOARD BOTTLENECKS — the structural single-point-of-failure finder (b130). Hubs (b126) find the most-CONNECTED
// cards; this finds the most-STRUCTURALLY-CRITICAL cards: the ones that HOLD THE PLAN TOGETHER, so that removing
// one splits the board into disconnected pieces. In graph terms these are the ARTICULATION POINTS (cut
// vertices) of the undirected connector graph. This is DISTINCT from hubs: a hub (high degree) can sit on
// redundant paths and NOT be load-bearing (removing it changes nothing), while a low-degree card bridging two
// clusters IS load-bearing. It is also distinct from critical-path's "bottleneck" (which is slack/effort-time on
// the longest chain, not structural connectivity) and from components/b127 (this finds the cards whose removal
// CREATES islands).
//
// Pure COMPOSITION of the `relationship-graph` leaf (`buildRelationGraph` builds the connector adjacency + drops
// dangling edges) — owns no graph construction. Tarjan's articulation-point DFS, ITERATED with an explicit frame
// stack (a deep chain cannot overflow the call stack). Undirected (a connector holds two cards together
// regardless of arrow direction); self-loops are ignored (they never change connectivity). For each
// bottleneck it reports `splitInto` — how many disconnected pieces its removal would create. Deterministic
// (nodes + adjacency in sorted id order; bottlenecks sorted by splitInto desc then id). Zero I/O.

import type { BoardItem } from '../read-data/group-board-model.ts';
import { buildRelationGraph } from '../read-data/relationship-graph.ts';

/** A load-bearing card: removing it disconnects the board. */
export interface ArticulationCard {
  readonly memberId: string;
  /** How many disconnected pieces removing this card would create (always ≥ 2). */
  readonly splitInto: number;
}

interface Frame {
  readonly u: string;
  readonly parent: string | null;
  i: number;
  childCount: number;
}

/**
 * The board's structural bottlenecks — the cards whose removal would split the connector graph into more
 * pieces (articulation points). Only connector-carrying cards participate. Sorted by `splitInto` (desc) then id.
 * Deterministic, cycle-safe, iterative.
 */
export function articulationCards(items: readonly BoardItem[]): ArticulationCard[] {
  const graph = buildRelationGraph(items);

  // Undirected, de-duped adjacency; self-loops dropped (they never affect connectivity).
  const adj = new Map<string, Set<string>>();
  const ensure = (id: string): Set<string> => {
    let s = adj.get(id);
    if (!s) {
      s = new Set<string>();
      adj.set(id, s);
    }
    return s;
  };
  for (const e of graph.edges) {
    if (e.from === e.to) continue;
    ensure(e.from).add(e.to);
    ensure(e.to).add(e.from);
  }
  const nodes = [...adj.keys()].sort((a, b) => a.localeCompare(b));
  const adjSorted = new Map<string, string[]>();
  for (const id of nodes) adjSorted.set(id, [...(adj.get(id) as Set<string>)].sort((a, b) => a.localeCompare(b)));

  const disc = new Map<string, number>();
  const low = new Map<string, number>();
  const childCut = new Map<string, number>(); // non-root p → # children v with low[v] >= disc[p]
  const rootSplit = new Map<string, number>(); // root r → # DFS children (articulation iff ≥ 2)
  let timer = 0;

  for (const start of nodes) {
    if (disc.has(start)) continue;
    const stack: Frame[] = [{ u: start, parent: null, i: 0, childCount: 0 }];
    disc.set(start, timer);
    low.set(start, timer);
    timer += 1;
    while (stack.length > 0) {
      const frame = stack[stack.length - 1];
      const u = frame.u;
      const neighbors = adjSorted.get(u) as string[];
      if (frame.i < neighbors.length) {
        const v = neighbors[frame.i];
        frame.i += 1;
        if (v === frame.parent) continue; // skip the single edge back to the DFS parent
        if (!disc.has(v)) {
          frame.childCount += 1;
          disc.set(v, timer);
          low.set(v, timer);
          timer += 1;
          stack.push({ u: v, parent: u, i: 0, childCount: 0 });
        } else {
          low.set(u, Math.min(low.get(u) as number, disc.get(v) as number)); // back edge
        }
      } else {
        // u is finished — fold its low into its parent and test the parent for articulation.
        stack.pop();
        if (stack.length > 0) {
          const pFrame = stack[stack.length - 1];
          const p = pFrame.u;
          low.set(p, Math.min(low.get(p) as number, low.get(u) as number));
          if (pFrame.parent !== null && (low.get(u) as number) >= (disc.get(p) as number)) {
            childCut.set(p, (childCut.get(p) ?? 0) + 1);
          }
        } else if (frame.childCount >= 2) {
          rootSplit.set(u, frame.childCount); // the DFS-tree root is an articulation point iff it has ≥ 2 children
        }
      }
    }
  }

  const out: ArticulationCard[] = [];
  for (const [id, cuts] of childCut) if (cuts >= 1) out.push({ memberId: id, splitInto: cuts + 1 });
  for (const [id, children] of rootSplit) out.push({ memberId: id, splitInto: children });
  out.sort((a, b) => b.splitInto - a.splitInto || a.memberId.localeCompare(b.memberId));
  return out;
}

/** True iff the board has any structural single point of failure. */
export function hasBottleneck(items: readonly BoardItem[]): boolean {
  return articulationCards(items).length > 0;
}

/** How many load-bearing cards the board has. */
export function bottleneckCount(items: readonly BoardItem[]): number {
  return articulationCards(items).length;
}
