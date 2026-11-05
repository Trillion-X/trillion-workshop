// packages/group/read-data/knowledge-graph-adapter.test.ts
//
// Gauntlet coverage for the connection-graph -> GraphFeedModel adapter seam:
// structural (decoupled) input tolerance, node/edge mapping, endpoint/role/attr
// passthrough, and fail-closed drop discipline (never guess a malformed row).

import { describe, expect, it } from '../../../../../test-helpers/vitest-shim.mjs';
import { connectionGraphToFeedModel } from '../../../read-data/knowledge-graph-adapter.ts';
import { foldKnowledgeGraphFeed } from '../../../read-data/knowledge-graph-feed.ts';

describe('connectionGraphToFeedModel', () => {
  it('maps a well-formed connection-graph projection to a GraphFeedModel', () => {
    const { model, dropped } = connectionGraphToFeedModel({
      descriptor_id: 'kg-edge-participation',
      nodes: [
        { id: 'entity/a', attributes: { label: 'Ada' } },
        { id: 'entity/b', attributes: { label: 'Ben' } },
      ],
      connections: [
        {
          id: 'part/1',
          endpoints: [
            { role: 'from', node_id: 'entity/a' },
            { role: 'to', node_id: 'entity/b' },
          ],
          attributes: { relation: 'coached' },
        },
      ],
    });
    expect(dropped).toEqual({ nodes: 0, connections: 0 });
    expect(model.nodes).toHaveLength(2);
    expect(model.nodes[0]).toEqual({ id: 'entity/a', attributes: { label: 'Ada' } });
    expect(model.connections).toHaveLength(1);
    expect(model.connections[0].id).toBe('part/1');
    expect(model.connections[0].endpoints).toEqual([
      { role: 'from', node_id: 'entity/a' },
      { role: 'to', node_id: 'entity/b' },
    ]);
    expect(model.connections[0].attributes).toEqual({ relation: 'coached' });
  });

  it('feeds straight into foldKnowledgeGraphFeed (the committed consumer) without extra shaping', () => {
    const { model } = connectionGraphToFeedModel({
      nodes: [{ id: 'n1' }, { id: 'n2' }],
      connections: [{ id: 'e1', endpoints: [{ node_id: 'n1' }, { node_id: 'n2' }] }],
    });
    const result = foldKnowledgeGraphFeed(model);
    expect(result.diagnostics.nodeCount).toBe(2);
    expect(result.diagnostics.edgeCount).toBe(1);
    expect(result.items.length).toBeGreaterThan(0);
  });

  it('drops nodes missing a usable id, counts them, never guesses', () => {
    const { model, dropped } = connectionGraphToFeedModel({
      nodes: [{ id: 'ok' }, { id: '' }, { attributes: {} }, 'not-a-record'],
      connections: [],
    });
    expect(model.nodes).toEqual([{ id: 'ok' }]);
    expect(dropped.nodes).toBe(3);
  });

  it('drops connections with fewer than two resolvable endpoints (not an edge)', () => {
    const { model, dropped } = connectionGraphToFeedModel({
      nodes: [{ id: 'n1' }],
      connections: [
        { id: 'dangling', endpoints: [{ node_id: 'n1' }] },
        { id: 'no-endpoints', endpoints: [] },
        { id: 'bad-endpoint', endpoints: [{ node_id: 'n1' }, { role: 'to' }] },
      ],
    });
    expect(model.connections).toEqual([]);
    expect(dropped.connections).toBe(3);
  });

  it('preserves a hyper-connection (>2 participants) as one edge, not pairwise explosion', () => {
    const { model } = connectionGraphToFeedModel({
      nodes: [{ id: 'a' }, { id: 'b' }, { id: 'c' }],
      connections: [
        {
          id: 'set/1',
          endpoints: [
            { role: 'participant', node_id: 'a' },
            { role: 'participant', node_id: 'b' },
            { role: 'participant', node_id: 'c' },
          ],
        },
      ],
    });
    expect(model.connections).toHaveLength(1);
    expect(model.connections[0].endpoints).toHaveLength(3);
  });

  it('tolerates absent / non-record / non-array input structurally (decoupled, fail-closed)', () => {
    expect(connectionGraphToFeedModel(undefined).model).toEqual({ nodes: [], connections: [] });
    expect(connectionGraphToFeedModel(null).model).toEqual({ nodes: [], connections: [] });
    expect(connectionGraphToFeedModel({ nodes: 'x', connections: 7 }).model).toEqual({ nodes: [], connections: [] });
  });
});
