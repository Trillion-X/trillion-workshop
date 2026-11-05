// packages/group/do-work/board-cycles.ts
//
// BOARD CYCLES — the circular-dependency finder (b128). Hubs (b126) find the central cards; components (b127)
// find the separate ISLANDS (undirected weak connectivity); this finds the directed LOOPS — the rings of cards
// that depend on each other in a circle (A -> B -> C -> A). A dependency board with a cycle is a broken plan:
// nothing in the ring can start, because each card waits on another in the same ring. That is a real, invisible
// DEFECT the user wants flagged and jumped to.
//
// The well-defined, deterministic answer to "which cards form a circular dependency" is the directed graph's
// STRONGLY-CONNECTED COMPONENTS: a set of cards all mutually reachable following the connectors. A non-trivial
// SCC (size >= 2), or a single card with a self-edge, IS a circular-dependency tangle. This is DISTINCT from the
// b127 islands (undirected weak connectivity — two cards linked either way sit in one island but only form a
// cycle if the links point BOTH ways) and from critical-path's per-goal `cycleDetected` boolean (which only says
// "somewhere in this root's closure" without naming the ring).
//
// Pure COMPOSITION of the existing `relationship-graph` leaf (`buildRelationGraph` builds the connector
// adjacency + drops dangling edges) — owns no graph construction. Tarjan's SCC, iterative (no recursion, so a
// deep chain cannot overflow the stack). Deterministic: nodes and adjacency are visited in sorted id order, and
// tangles are sorted by size (desc) then first member id. Zero I/O.

import type { BoardItem } from '../read-data/group-board-model.ts';
import { buildRelationGraph } from '../read-data/relationship-graph.ts';

/** One circular-dependency tangle — a ring of cards that all wait on each other. */
export interface CardCycle {
  /** The member ids caught in the loop, sorted. */
  readonly memberIds: readonly string[];
  readonly size: number;
  /** A single card that points at itself (A -> A). */
  readonly isSelfLoop: boolean;
}

/**
 * Every circular-dependency tangle on the board — each strongly-connected component of the directed connector
 * graph with size >= 2, plus any single card carrying a self-edge. Cards not caught in a loop are not returned.
 * Tangles are sorted by size (desc) then first member id; members sorted within each. Deterministic, cycle-safe.
 */
export function connectorCycles(items: readonly BoardItem[]): CardCycle[] {
  const graph = buildRelationGraph(items);

  // Node set = only cards that carry a connector (an isolated card cannot be in a loop). Directed adjacency:
  // sorted, de-duped targets — so the traversal order is fully determined by ids.
  const nodeSet = new Set<string>();
  for (const e of graph.edges) {
    nodeSet.add(e.from);
    nodeSet.add(e.to);
  }
  const nodes = [...nodeSet].sort((a, b) => a.localeCompare(b));
  const adj = new Map<string, string[]>();
  for (const id of nodes) {
    const targets = [...new Set((graph.out[id] ?? []).map((e) => e.to))].sort((a, b) => a.localeCompare(b));
    adj.set(id, targets);
  }

  // Tarjan's strongly-connected-components, iterated with an explicit frame stack so a long chain cannot
  // overflow the call stack. `index` = discovery order; `low` = lowest index reachable; `S`/`onStack` = the
  // current SCC-in-progress stack.
  let counter = 0;
  const index = new Map<string, number>();
  const low = new Map<string, number>();
  const onStack = new Set<string>();
  const S: string[] = [];
  const sccs: string[][] = [];

  for (const start of nodes) {
    if (index.has(start)) continue;
    const work: Array<{ v: string; i: number }> = [{ v: start, i: 0 }];
    while (work.length > 0) {
      const frame = work[work.length - 1];
      const v = frame.v;
      if (frame.i === 0) {
        index.set(v, counter);
        low.set(v, counter);
        counter += 1;
        S.push(v);
        onStack.add(v);
      }
      const targets = adj.get(v) ?? [];
      if (frame.i < targets.length) {
        const w = targets[frame.i];
        frame.i += 1;
        if (!index.has(w)) {
          work.push({ v: w, i: 0 }); // descend — the child's low is folded back when it finishes
        } else if (onStack.has(w)) {
          low.set(v, Math.min(low.get(v) as number, index.get(w) as number));
        }
      } else {
        // v is finished — if it is the root of an SCC, pop the whole component off the stack.
        if ((low.get(v) as number) === (index.get(v) as number)) {
          const comp: string[] = [];
          for (;;) {
            const w = S.pop() as string;
            onStack.delete(w);
            comp.push(w);
            if (w === v) break;
          }
          sccs.push(comp);
        }
        work.pop();
        if (work.length > 0) {
          const parent = work[work.length - 1].v;
          low.set(parent, Math.min(low.get(parent) as number, low.get(v) as number));
        }
      }
    }
  }

  const cycles: CardCycle[] = [];
  for (const comp of sccs) {
    if (comp.length >= 2) {
      const sorted = [...comp].sort((a, b) => a.localeCompare(b));
      cycles.push({ memberIds: sorted, size: sorted.length, isSelfLoop: false });
    } else {
      const v = comp[0];
      if ((adj.get(v) ?? []).includes(v)) cycles.push({ memberIds: [v], size: 1, isSelfLoop: true });
    }
  }
  cycles.sort((a, b) => b.size - a.size || a.memberIds[0].localeCompare(b.memberIds[0]));
  return cycles;
}

/** True iff the board has any circular dependency. */
export function hasCycle(items: readonly BoardItem[]): boolean {
  return connectorCycles(items).length > 0;
}

/** How many distinct circular-dependency tangles the board has. */
export function cycleCount(items: readonly BoardItem[]): number {
  return connectorCycles(items).length;
}
