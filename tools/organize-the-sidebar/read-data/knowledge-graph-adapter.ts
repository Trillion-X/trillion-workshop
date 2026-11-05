// packages/group/read-data/knowledge-graph-adapter.ts
//
// Purpose: the pure seam between a `relationship-graph` connection-projection
//   result (delivered to this package as DATA — never a cross-package import)
//   and the `GraphFeedModel` that `foldKnowledgeGraphFeed` (this package's
//   committed graph fold) consumes. W8 §8 T2 adapter contract.
//
// Non-negotiable invariants:
//   - ZERO cross-package coupling: the connection-graph projection arrives as an
//     opaque JSON payload (via a DATA feed / useBitfieldData), so this leaf reads
//     it STRUCTURALLY as `unknown` and never imports relationship-graph types.
//   - Self-describing data, generic handler (L090): edges carry their own
//     endpoints/role; this leaf enumerates nothing. It maps shape → shape.
//   - Fail-closed like the feed: malformed rows are DROPPED and counted, never
//     guessed (mirrors `asGraphFeedModel` in knowledge-graph-feed.ts).
//   - Edges are participation/connection projections — NEVER an invented
//     {source,target,relation} family. The role/attributes ride through opaquely.

import type { GraphFeedModel, GraphFeedNode, GraphFeedConnection, GraphFeedEndpoint } from './knowledge-graph-feed.ts';

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function asString(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

export type ConnectionGraphAdaptResult = {
  readonly model: GraphFeedModel;
  readonly dropped: { readonly nodes: number; readonly connections: number };
};

/**
 * Map a `relationship-graph` connection-projection payload (structural, from a
 * DATA feed) into a `GraphFeedModel`. Accepts the payload as `unknown` so this
 * package stays decoupled from relationship-graph.
 *
 * Source shape (read defensively, matching relationship-graph's ConnectionGraphModel):
 *   { nodes: [{ id, attributes }], connections: [{ id, endpoints: [{ role, node_id }], attributes }] }
 * Rows missing a usable `id` (nodes) or usable endpoints (connections) are dropped + counted.
 */
export function connectionGraphToFeedModel(payload: unknown): ConnectionGraphAdaptResult {
  const root = isRecord(payload) ? payload : {};
  const rawNodes = Array.isArray(root.nodes) ? root.nodes : [];
  const rawConnections = Array.isArray(root.connections) ? root.connections : [];

  const nodes: GraphFeedNode[] = [];
  let droppedNodes = 0;
  for (const raw of rawNodes) {
    if (!isRecord(raw)) { droppedNodes++; continue; }
    const id = asString(raw.id);
    if (id === null) { droppedNodes++; continue; }
    const node: GraphFeedNode = { id };
    if (isRecord(raw.attributes)) node.attributes = raw.attributes;
    nodes.push(node);
  }

  const connections: GraphFeedConnection[] = [];
  let droppedConnections = 0;
  for (const raw of rawConnections) {
    if (!isRecord(raw)) { droppedConnections++; continue; }
    const id = asString(raw.id);
    const rawEndpoints = Array.isArray(raw.endpoints) ? raw.endpoints : [];
    const endpoints: GraphFeedEndpoint[] = [];
    for (const rawEndpoint of rawEndpoints) {
      if (!isRecord(rawEndpoint)) continue;
      const nodeId = asString(rawEndpoint.node_id);
      if (nodeId === null) continue;
      const endpoint: GraphFeedEndpoint = { node_id: nodeId };
      const role = asString(rawEndpoint.role);
      if (role !== null) endpoint.role = role;
      endpoints.push(endpoint);
    }
    // A connection needs an id and at least two resolvable endpoints to be an edge.
    if (id === null || endpoints.length < 2) { droppedConnections++; continue; }
    const connection: GraphFeedConnection = { id, endpoints };
    if (isRecord(raw.attributes)) connection.attributes = raw.attributes;
    connections.push(connection);
  }

  return {
    model: { nodes, connections },
    dropped: { nodes: droppedNodes, connections: droppedConnections },
  };
}
