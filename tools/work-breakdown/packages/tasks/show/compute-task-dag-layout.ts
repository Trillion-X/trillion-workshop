// packages/tasks/show/compute-task-dag-layout.ts
//
// =============================================================================
// PURPOSE
// =============================================================================
//
// Pure function: compute DAG layout positions using the dagre graph layout
// algorithm. Takes nodes and edges, returns positioned nodes suitable for
// rendering with React Flow or any other graph renderer.
//
// =============================================================================
// NON-NEGOTIABLE INVARIANTS
// =============================================================================
//
// 1. Pure function — ZERO side effects, ZERO I/O
// 2. dagre layout with configurable direction (TB or LR)
// 3. Returns positioned nodes with x, y coordinates
// 4. Handles empty graphs gracefully (returns empty array)
//
// =============================================================================
// =============================================================================
//
// The extensive documentation in this codebase is a critical design feature.
// You are forbidden from simplifying or removing it.
// =============================================================================

import type { DAGNode, DAGEdge, DAGDirection } from '@/packages/tasks/read-data/task-graph-types';

// ============================================================================
// TYPES
// ============================================================================

export interface PositionedNode {
  id: string;
  label: string;
  status: DAGNode['status'];
  agentCount?: number;
  x: number;
  y: number;
  width: number;
  height: number;
}

// ============================================================================
// LAYOUT CONSTANTS
// ============================================================================

const NODE_WIDTH = 160;
const NODE_HEIGHT = 60;
const NODE_SEP = 30;
const RANK_SEP = 60;

// ============================================================================
// LAYOUT FUNCTION
// ============================================================================

/**
 * Compute DAG layout positions.
 *
 * This is a simplified topological layout that arranges nodes in ranks
 * based on their dependency depth. For full dagre integration, the
 * React Flow + dagre wiring happens in TaskDAG.tsx. This function
 * provides a fallback pure layout for when dagre is unavailable.
 *
 * Layout algorithm: topological sort by dependency depth, arrange nodes
 * left-to-right (LR) or top-to-bottom (TB) in rank columns/rows.
 */
export function computeDAGLayout(
  nodes: DAGNode[],
  edges: DAGEdge[],
  direction: DAGDirection = 'LR'
): PositionedNode[] {
  if (nodes.length === 0) return [];

  // Build adjacency: source -> targets
  const outgoing = new Map<string, string[]>();
  const incoming = new Map<string, string[]>();
  for (const node of nodes) {
    outgoing.set(node.id, []);
    incoming.set(node.id, []);
  }
  for (const edge of edges) {
    outgoing.get(edge.source)?.push(edge.target);
    incoming.get(edge.source); // ensure exists
    incoming.get(edge.target)?.push(edge.source);
  }

  // Compute rank (depth) for each node via BFS from roots
  const rank = new Map<string, number>();
  const roots = nodes.filter((n) => (incoming.get(n.id)?.length ?? 0) === 0);

  // If no roots (cycles), use all nodes as rank 0
  if (roots.length === 0) {
    for (const node of nodes) {
      rank.set(node.id, 0);
    }
  } else {
    const queue: string[] = roots.map((n) => n.id);
    for (const id of queue) {
      rank.set(id, 0);
    }
    // Cycle-safe BFS: in a DAG the longest path is at most nodes.length - 1.
    // If a rank would exceed that bound, the graph has a cycle — stop propagating.
    const maxRankBound = nodes.length;
    while (queue.length > 0) {
      const current = queue.shift()!;
      const currentRank = rank.get(current) ?? 0;
      for (const target of outgoing.get(current) ?? []) {
        const newRank = currentRank + 1;
        if (newRank >= maxRankBound) continue; // cycle detected — cap rank
        const existingRank = rank.get(target);
        if (existingRank == null || existingRank < newRank) {
          rank.set(target, newRank);
          queue.push(target);
        }
      }
    }
    // Ensure all nodes have a rank
    for (const node of nodes) {
      if (!rank.has(node.id)) rank.set(node.id, 0);
    }
  }

  // Group by rank
  const maxRank = Math.max(...Array.from(rank.values()));
  const rankGroups: DAGNode[][] = Array.from(
    { length: maxRank + 1 },
    () => []
  );
  for (const node of nodes) {
    rankGroups[rank.get(node.id) ?? 0].push(node);
  }

  // Position nodes
  const positioned: PositionedNode[] = [];
  for (let r = 0; r <= maxRank; r++) {
    const group = rankGroups[r];
    for (let i = 0; i < group.length; i++) {
      const node = group[i];
      const isHorizontal = direction === 'LR';

      const x = isHorizontal
        ? r * (NODE_WIDTH + RANK_SEP)
        : i * (NODE_WIDTH + NODE_SEP);
      const y = isHorizontal
        ? i * (NODE_HEIGHT + NODE_SEP)
        : r * (NODE_HEIGHT + RANK_SEP);

      positioned.push({
        id: node.id,
        label: node.label,
        status: node.status,
        agentCount: node.agentCount,
        x,
        y,
        width: NODE_WIDTH,
        height: NODE_HEIGHT,
      });
    }
  }

  return positioned;
}
