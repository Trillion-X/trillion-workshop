// Ported from bitfield-packages/packages/relationship-graph/read-data/__tests__/build-graph-query-request.test.ts.
// Changed: imports, and the expected request no longer names the old runtime's `slot::graph-query` target.
import { describe, expect, it } from '../../../test-helpers/vitest-shim.mjs';
import { buildGraphQueryRequest } from '../read-data/build-graph-query-request.ts';
import type { ConnectionGraphModel } from '../read-data/connection-model.ts';

describe('buildGraphQueryRequest', () => {
  it('lowers a generic model into graph operations without running graph algorithms', () => {
    const model: ConnectionGraphModel = {
      descriptor_id: 'connection-graph.test',
      nodes: [
        { id: 'n:a', attributes: {}, connection_ids: ['c:1'] },
        { id: 'n:b', attributes: {}, connection_ids: ['c:1'] },
      ],
      connections: [
        {
          id: 'c:1',
          endpoints: [
            { role: 'source', node_id: 'n:a' },
            { role: 'target', node_id: 'n:b' },
          ],
          attributes: { label: 'example data' },
        },
      ],
      views: [],
      actions: [],
      issues: [],
      changed: { node_ids: ['n:a', 'n:b'], connection_ids: ['c:1'] },
    };

    expect(buildGraphQueryRequest(model)).toEqual({
      payload: {
        operations: [
          { operation: 'put-node', id: 'n:a', attributes: {} },
          { operation: 'put-node', id: 'n:b', attributes: {} },
          {
            operation: 'put-connection',
            id: 'c:1',
            endpoints: [
              { role: 'source', node_id: 'n:a' },
              { role: 'target', node_id: 'n:b' },
            ],
            attributes: { label: 'example data' },
          },
        ],
      },
    });
  });
});
