// packages/group/read-data/knowledge-graph-feed.test.ts
//
// Gauntlet coverage for the knowledge-graph feed fold: node/edge mapping,
// dangling endpoints as honest "missing record" stubs, hyper-connections as
// hubs (never pairwise explosion), self-references, and shape tolerance.

import { describe, expect, it } from 'vitest';
import {
  asGraphFeedModel,
  foldKnowledgeGraphFeed,
} from './knowledge-graph-feed';
import { buildRelationGraph } from './relationship-graph';
import { connectorEndpoints } from '../show/connector-models';

describe('knowledge graph feed', () => {
  it('folds nodes and pairwise connections into board members', () => {
    const result = foldKnowledgeGraphFeed({
      nodes: [
        { id: 'e:sam', attributes: { label: 'Sam' } },
        { id: 'e:lakeside', attributes: { name: 'Lakeside' } },
      ],
      connections: [
        { id: 'c1', endpoints: [{ role: 'source', node_id: 'e:sam' }, { role: 'target', node_id: 'e:lakeside' }], attributes: { relation: 'founded' } },
      ],
    });
    expect(result.items.map((i) => i.memberId)).toEqual(['kg-node:e:sam', 'kg-node:e:lakeside', 'kg-edge:c1']);
    const edge = result.items[2];
    expect(connectorEndpoints(edge)).toEqual({ from: 'kg-node:e:sam', to: 'kg-node:e:lakeside' });
    expect(edge.extra.relationKind).toBe('founded');
    expect(result.diagnostics).toEqual({ nodeCount: 2, edgeCount: 1, hubCount: 0, missingEndpointCount: 0 });
  });

  it('renders a dangling endpoint as a missing-record stub, never a crash', () => {
    const result = foldKnowledgeGraphFeed({
      nodes: [{ id: 'a' }],
      connections: [{ id: 'c1', endpoints: [{ node_id: 'a' }, { node_id: 'gone' }] }],
    });
    const stub = result.items.find((i) => i.extra.missingRecord === true);
    expect(stub?.text).toBe('Missing record');
    expect(result.diagnostics.missingEndpointCount).toBe(1);
    // The connector still links to the stub — visible, honest.
    const edge = result.items.find((i) => i.kind === 'connector');
    expect(connectorEndpoints(edge!)).toEqual({ from: 'kg-node:a', to: 'kg-node:gone' });
  });

  it('renders a hyper-connection as one hub with a spoke per endpoint', () => {
    const endpoints = Array.from({ length: 5 }, (_, i) => ({ role: 'participant', node_id: `p${i}` }));
    const result = foldKnowledgeGraphFeed({
      nodes: endpoints.map((e) => ({ id: e.node_id })),
      connections: [{ id: 'meet', endpoints, attributes: { relation: 'attended' } }],
    });
    expect(result.diagnostics.hubCount).toBe(1);
    expect(result.diagnostics.edgeCount).toBe(5); // spokes, not 5*4/2 pairwise
    const hub = result.items.find((i) => i.extra.hub === true);
    expect(hub).toBeDefined();
  });

  it('handles self-referencing connections with no special case', () => {
    const result = foldKnowledgeGraphFeed({
      nodes: [{ id: 'a' }],
      connections: [{ id: 'self', endpoints: [{ node_id: 'a' }, { node_id: 'a' }] }],
    });
    expect(connectorEndpoints(result.items.find((i) => i.kind === 'connector')!))
      .toEqual({ from: 'kg-node:a', to: 'kg-node:a' });
  });

  it('feed output composes with the existing in-board relation graph queries', () => {
    const result = foldKnowledgeGraphFeed({
      nodes: [{ id: 'a' }, { id: 'b' }, { id: 'c' }],
      connections: [
        { id: 'ab', endpoints: [{ node_id: 'a' }, { node_id: 'b' }], attributes: { relation: 'depends-on' } },
        { id: 'bc', endpoints: [{ node_id: 'b' }, { node_id: 'c' }], attributes: { relation: 'depends-on' } },
      ],
    });
    const graph = buildRelationGraph(result.items);
    expect(graph.edges.length).toBe(2);
  });

  it('tolerates malformed payloads structurally', () => {
    expect(asGraphFeedModel(null)).toEqual({ nodes: [], connections: [] });
    expect(asGraphFeedModel({ nodes: 'nope', connections: [{ id: 1 }] })).toEqual({ nodes: [], connections: [] });
    const mixed = asGraphFeedModel({
      nodes: [{ id: 'ok' }, { noId: true }],
      connections: [{ id: 'c', endpoints: [{ node_id: 'ok' }] }, { id: 'bad', endpoints: [{}] }],
    });
    expect(mixed.nodes.length).toBe(1);
    expect(mixed.connections.length).toBe(1);
  });
});
