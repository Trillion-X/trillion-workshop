// packages/group/read-data/knowledge-graph-view.ts
//
// Purpose: the PURE (no React, no I/O) view builder for the W8 knowledge-graph
//   surface. Composes the decoupled pieces already proven in isolation —
//   connectionGraphToFeedModel (adapter) → foldKnowledgeGraphFeed (membership +
//   edge topology) → forceDirectedLayout (positions) — into the exact
//   prop-shapes the shared `graph-canvas` render primitive consumes
//   (CanvasNodeFrame[] + EdgeRoute[]). The React shell (mount-knowledge-graph.tsx)
//   is a thin wrapper over this; ALL logic lives here so it is unit-testable
//   without a browser, a studio, or graph-canvas at runtime.
//
// Reuse contract (no god surface): rendering/pan/zoom/empty-state = `graph-canvas`
//   (the P4 primitive, already used live by W4 funnel); positions = `graph-layout`
//   (the clean leaf); membership/edges = the committed knowledge-graph-feed.
//   This file owns ZERO rendering and ZERO record truth — only the shape map.

import { connectionGraphToFeedModel } from './knowledge-graph-adapter';
import { foldKnowledgeGraphFeed } from './knowledge-graph-feed';
import { forceDirectedLayout, type GraphNode, type GraphEdge } from '../show/graph-layout';
// Type-only imports (erased at runtime — no graph-canvas coupling in this leaf).
import type { CanvasNodeFrame, EdgeRoute } from '../../graph-canvas/show/types';

export type KnowledgeGraphNodeView = {
  readonly id: string;
  readonly label: string;
  /** True when this node is a dangling edge endpoint with no backing record — render honestly, never hide. */
  readonly missing: boolean;
  /** True when this node is a hyper-connection hub (relation with >2 participants). */
  readonly hub: boolean;
};

export type KnowledgeGraphView = {
  readonly frames: CanvasNodeFrame[];
  readonly edgeRoutes: EdgeRoute[];
  readonly nodes: Map<string, KnowledgeGraphNodeView>;
  readonly diagnostics: { nodeCount: number; edgeCount: number; hubCount: number; missingEndpointCount: number };
};

/**
 * Build the graph-canvas prop-shapes from a raw connection-graph projection
 * (delivered as DATA from relationship-graph's readConnectionGraph). Pure:
 * same input → same output; empty input → an honest empty view (no fake nodes).
 */
export function buildKnowledgeGraphView(rawProjection: unknown): KnowledgeGraphView {
  const feed = foldKnowledgeGraphFeed(connectionGraphToFeedModel(rawProjection).model);

  const nodeItems = feed.items.filter((item) => item.kind === 'note');
  const connectorItems = feed.items.filter((item) => item.kind === 'connector');

  // Layout inputs — connectors excluded (the leaf positions nodes only).
  const layoutNodes: GraphNode[] = nodeItems.map((n) => ({ memberId: n.memberId, w: n.w, h: n.h, x: n.x, y: n.y }));
  const layoutEdges: GraphEdge[] = connectorItems
    .map((c) => ({ from: String((c.extra as Record<string, unknown>)?.fromMemberId ?? ''), to: String((c.extra as Record<string, unknown>)?.toMemberId ?? '') }))
    .filter((e) => e.from !== '' && e.to !== '');

  const positions = forceDirectedLayout(layoutNodes, layoutEdges);

  const frames: CanvasNodeFrame[] = [];
  const nodes = new Map<string, KnowledgeGraphNodeView>();
  for (const n of nodeItems) {
    const p = positions.get(n.memberId) ?? { x: n.x, y: n.y };
    frames.push({ id: n.memberId, x: p.x, y: p.y, width: n.w, height: n.h });
    const extra = (n.extra ?? {}) as Record<string, unknown>;
    nodes.set(n.memberId, {
      id: n.memberId,
      label: typeof n.text === 'string' && n.text.length > 0 ? n.text : n.memberId,
      missing: extra.missingRecord === true,
      hub: extra.hub === true,
    });
  }

  const center = (id: string): { x: number; y: number } | null => {
    const p = positions.get(id);
    if (!p) return null;
    const frame = frames.find((f) => f.id === id);
    return frame ? { x: p.x + frame.width / 2, y: p.y + frame.height / 2 } : { x: p.x, y: p.y };
  };

  const edgeRoutes: EdgeRoute[] = [];
  for (const c of connectorItems) {
    const extra = (c.extra ?? {}) as Record<string, unknown>;
    const from = center(String(extra.fromMemberId ?? ''));
    const to = center(String(extra.toMemberId ?? ''));
    if (!from || !to) continue; // endpoint not laid out — drop the route honestly, never draw to (0,0)
    edgeRoutes.push({ edge_id: c.memberId, points: [from, to] });
  }

  return { frames, edgeRoutes, nodes, diagnostics: feed.diagnostics };
}
