// packages/group/read-data/knowledge-graph-feed.ts
//
// =============================================================================
// PURPOSE
// =============================================================================
//
// The knowledge-graph FEED: folds a descriptor-compiled connection graph model
// (plain DATA: nodes + connections, the shape the connection-projection owner
// publishes) into the board's own BoardItem + connector members, so the group
// board's EXISTING layout/hulls/connector layers render the whole substrate map
// with zero new rendering code.
//
// Decoupling law: this module never imports another package. The graph model
// arrives as opaque DATA whose shape is checked structurally (L090) — nodes
// carry {id, attributes}, connections carry {id, endpoints[{role,node_id}],
// attributes}. Whoever produced it (and from which records) is descriptor DATA,
// not this module's business.
//
// Honest-data laws:
// - A connection endpoint naming a node that is not in the model becomes a
//   "missing record" STUB item (rendered as a chip), never a crash and never a
//   silent drop — the user sees that something references a record they can't
//   see.
// - A hyper-connection with N>2 endpoints renders as a HUB: one hub item plus
//   one connector per endpoint — never N² pairwise fake edges.
// - Self-referencing connections render as ordinary connectors (no special
//   case).
//
// Pure computation, deterministic, zero I/O.
//
// =============================================================================
//
// The extensive documentation in this codebase is a critical design feature.
// You are forbidden from simplifying or removing it.
// =============================================================================

import type { BoardItem } from './group-board-model.ts';

/** Structural shape of one graph node as published by a connection-projection
 *  owner. Checked by shape, never by package name. */
export type GraphFeedNode = {
  id: string;
  attributes?: Record<string, unknown>;
};

export type GraphFeedEndpoint = { role?: string; node_id: string };

export type GraphFeedConnection = {
  id: string;
  endpoints: readonly GraphFeedEndpoint[];
  attributes?: Record<string, unknown>;
};

export type GraphFeedModel = {
  nodes: readonly GraphFeedNode[];
  connections: readonly GraphFeedConnection[];
};

export type KnowledgeGraphFeedResult = {
  items: BoardItem[];
  diagnostics: {
    nodeCount: number;
    edgeCount: number;
    hubCount: number;
    missingEndpointCount: number;
  };
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

/** Structurally validate an unknown payload as a graph feed model. Rows with
 *  the wrong shape are dropped (counted by the caller via diagnostics deltas),
 *  never guessed. */
export function asGraphFeedModel(value: unknown): GraphFeedModel {
  if (!isRecord(value)) return { nodes: [], connections: [] };
  const nodes = Array.isArray(value.nodes)
    ? value.nodes.filter((n): n is GraphFeedNode => isRecord(n) && typeof n.id === 'string')
    : [];
  const connections = Array.isArray(value.connections)
    ? value.connections.filter((c): c is GraphFeedConnection =>
      isRecord(c) && typeof c.id === 'string' && Array.isArray(c.endpoints)
      && c.endpoints.every((e: unknown) => isRecord(e) && typeof e.node_id === 'string'))
    : [];
  return { nodes, connections };
}

const NODE_W = 180;
const NODE_H = 72;

function text(value: unknown, fallback: string): string {
  return typeof value === 'string' && value.length > 0 ? value : fallback;
}

const KG_NODE_FAMILY = 'knowledge-graph.node';
const KG_EDGE_FAMILY = 'knowledge-graph.edge';

function nodeItem(id: string, label: string, extra: Record<string, unknown>): BoardItem {
  return {
    memberId: `kg-node:${id}`,
    nodeRef: { family: KG_NODE_FAMILY, parts: { ref: id } },
    kind: 'note',
    x: 0,
    y: 0,
    w: NODE_W,
    h: NODE_H,
    text: label,
    isSection: false,
    childCount: 0,
    extra,
  };
}

function connectorItem(id: string, from: string, to: string, extra: Record<string, unknown>): BoardItem {
  return {
    memberId: `kg-edge:${id}`,
    nodeRef: { family: KG_EDGE_FAMILY, parts: { ref: id } },
    kind: 'connector',
    x: 0,
    y: 0,
    w: 0,
    h: 0,
    isSection: false,
    childCount: 0,
    extra: { ...extra, fromMemberId: from, toMemberId: to },
  };
}

/**
 * Fold a graph feed model into board members. Positions are zeroed — the
 * board's existing arrange engines (graph layout, clusters, axis) own
 * placement; this feed owns membership and edge topology only.
 */
export function foldKnowledgeGraphFeed(model: GraphFeedModel): KnowledgeGraphFeedResult {
  const items: BoardItem[] = [];
  const present = new Set(model.nodes.map((n) => n.id));
  const stubbed = new Set<string>();
  let hubCount = 0;
  let missingEndpointCount = 0;

  for (const node of model.nodes) {
    const attrs = node.attributes ?? {};
    items.push(nodeItem(node.id, text(attrs.label ?? attrs.title ?? attrs.name, node.id), {
      relationAttributes: attrs,
    }));
  }

  const ensureEndpoint = (nodeId: string): string => {
    if (present.has(nodeId)) return `kg-node:${nodeId}`;
    if (!stubbed.has(nodeId)) {
      stubbed.add(nodeId);
      missingEndpointCount += 1;
      items.push(nodeItem(nodeId, 'Missing record', { missingRecord: true, ref: nodeId }));
    }
    return `kg-node:${nodeId}`;
  };

  for (const connection of model.connections) {
    const attrs = connection.attributes ?? {};
    const relationKind = text(attrs.relation ?? attrs.kind ?? attrs.label, 'relates-to');
    const endpoints = connection.endpoints;
    if (endpoints.length <= 2) {
      const from = ensureEndpoint(endpoints[0]?.node_id ?? '');
      const to = ensureEndpoint(endpoints[endpoints.length - 1]?.node_id ?? endpoints[0]?.node_id ?? '');
      if (!endpoints[0]?.node_id) continue;
      items.push(connectorItem(connection.id, from, to, {
        relationKind,
        label: typeof attrs.label === 'string' ? attrs.label : undefined,
      }));
    } else {
      // Hyper-connection: one hub + a spoke per endpoint.
      hubCount += 1;
      const hubId = `kg-hub:${connection.id}`;
      items.push({
        ...nodeItem(hubId, text(attrs.label, relationKind), { hub: true, relationKind }),
        memberId: hubId,
      });
      endpoints.forEach((endpoint, index) => {
        items.push(connectorItem(`${connection.id}:${index}`, hubId, ensureEndpoint(endpoint.node_id), {
          relationKind,
          role: endpoint.role,
        }));
      });
    }
  }

  return {
    items,
    diagnostics: {
      nodeCount: model.nodes.length + stubbed.size + hubCount,
      edgeCount: items.filter((i) => i.kind === 'connector').length,
      hubCount,
      missingEndpointCount,
    },
  };
}
