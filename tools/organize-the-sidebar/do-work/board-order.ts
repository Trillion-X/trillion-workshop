// packages/group/do-work/board-order.ts
//
// BOARD ORDER — the execution-order / parallel-waves primitive (b129). Hubs (b126) find the central cards;
// components (b127) find the ISLANDS; cycles (b128) find the broken RINGS; this answers the actionable question:
// "in what ORDER do I do this dependency board, and which cards can I do AT THE SAME TIME?" A connector A -> B
// means "A comes before B" (A is a prerequisite of B). Wave 0 = every card that waits on nothing (start now);
// removing them frees the next wave; and so on. Cards caught in a cycle never come free — they are reported as
// `blocked` (there is no order for a ring), which is exactly the b128 defect, kept out of the plan here.
//
// This is DISTINCT from critical-path (which returns only the single longest CHAIN for one goal): the waves are
// the WHOLE board's layered plan, and each wave is a set of independent cards that can run in parallel. The
// number of waves IS the length of the longest dependency chain, and the widest wave IS the peak parallelism —
// both emerge from the layering for free (L069).
//
// Pure COMPOSITION of the `relationship-graph` leaf (`buildRelationGraph` builds the directed connector
// adjacency + drops dangling edges) — owns no graph construction. Kahn's algorithm by in-degree. Deterministic
// (nodes visited in sorted id order within each wave; parallel edges de-duped so a double connector never makes
// a card wait twice). Zero I/O.

import type { BoardItem } from '../read-data/group-board-model';
import { buildRelationGraph } from '../read-data/relationship-graph';

/** One wave of the plan — cards with no remaining prerequisites, so they can all be done together. */
export interface OrderWave {
  /** 0-based wave number. */
  readonly index: number;
  /** The member ids in this wave, sorted — independent, runnable in parallel. */
  readonly memberIds: readonly string[];
}

export interface ExecutionOrder {
  /** The layered plan, wave 0 first. */
  readonly waves: readonly OrderWave[];
  /** Cards that never come free because they sit in a cycle (a self-loop or a ring) — unorderable, sorted. */
  readonly blocked: readonly string[];
}

const EDGE_SEP = '\u0000';

/**
 * The board's execution plan: the connected cards laid out in dependency waves (Kahn's algorithm), plus the
 * cards stuck in a cycle. Only cards carrying a connector participate (an isolated card is not part of the
 * dependency structure). Deterministic: within each wave, ids are sorted; parallel edges are de-duped.
 */
export function executionOrder(items: readonly BoardItem[]): ExecutionOrder {
  const graph = buildRelationGraph(items);

  const nodeSet = new Set<string>();
  for (const e of graph.edges) {
    nodeSet.add(e.from);
    nodeSet.add(e.to);
  }
  const inDeg = new Map<string, number>();
  const outAdj = new Map<string, string[]>();
  for (const id of nodeSet) {
    inDeg.set(id, 0);
    outAdj.set(id, []);
  }
  const seenEdge = new Set<string>();
  for (const e of graph.edges) {
    const key = e.from + EDGE_SEP + e.to;
    if (seenEdge.has(key)) continue; // a double connector must not make the target wait twice
    seenEdge.add(key);
    inDeg.set(e.to, (inDeg.get(e.to) as number) + 1);
    (outAdj.get(e.from) as string[]).push(e.to);
  }

  const remaining = new Set(nodeSet);
  const waves: OrderWave[] = [];
  for (let index = 0; ; index += 1) {
    const ready = [...remaining].filter((id) => (inDeg.get(id) as number) === 0).sort((a, b) => a.localeCompare(b));
    if (ready.length === 0) break; // either done, or everything left is in a cycle
    waves.push({ index, memberIds: ready });
    for (const id of ready) {
      remaining.delete(id);
      for (const t of outAdj.get(id) as string[]) {
        if (remaining.has(t)) inDeg.set(t, (inDeg.get(t) as number) - 1);
      }
    }
  }

  const blocked = [...remaining].sort((a, b) => a.localeCompare(b));
  return { waves, blocked };
}

/** How many sequential waves the plan needs — the length of the longest dependency chain. */
export function waveCount(items: readonly BoardItem[]): number {
  return executionOrder(items).waves.length;
}

/** The widest wave — the most cards that can be worked on at the same time (peak parallelism). */
export function parallelWidth(items: readonly BoardItem[]): number {
  let max = 0;
  for (const w of executionOrder(items).waves) if (w.memberIds.length > max) max = w.memberIds.length;
  return max;
}

/** True iff any card is unorderable because it sits in a cycle. */
export function hasBlockedByCycle(items: readonly BoardItem[]): boolean {
  return executionOrder(items).blocked.length > 0;
}
