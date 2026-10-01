// Vendored unchanged except for import paths from bitfield-packages/packages/relationship-graph/read-data/__tests__/read-connection-graph.test.ts.
import { describe, expect, it } from '../../../test-helpers/vitest-shim.mjs';
import { readConnectionGraph } from '../read-data/read-connection-graph.ts';
import type { ConnectionProjectionDescriptor, InputRow } from '../read-data/connection-model.ts';

const descriptor: ConnectionProjectionDescriptor = {
  kind: 'generic-connection-projection-descriptor',
  id: 'connection-graph.test',
  record_selectors: [
    {
      id: 'example data selector',
      match: { method: 'json-field-equals', params: { path: ['kind'], value: 'example data connection' } },
      connection: {
        identity: { method: 'json-path', params: { path: ['id'] } },
        endpoints: [
          { role: 'source', value: { method: 'json-path', params: { path: ['source'] } } },
          { role: 'target', value: { method: 'json-path', params: { path: ['target'] } } },
          { role: 'observer', value: { method: 'json-path', params: { path: ['observer'] } } },
        ],
        attributes: [
          { name: 'label', value: { method: 'json-path', params: { path: ['label'] } } },
          { name: 'status', value: { method: 'json-path', params: { path: ['status'] } } },
        ],
      },
    },
    {
      id: 'example process evidence selector',
      match: { method: 'json-field-equals', params: { path: ['kind'], value: 'example data process evidence' } },
      connection: {
        identity: { method: 'json-path', params: { path: ['id'] } },
        endpoints: [
          { role: 'request', value: { method: 'json-path', params: { path: ['request'] } } },
          { role: 'result', value: { method: 'json-path', params: { path: ['result'] } } },
        ],
      },
    },
  ],
  views: [{ id: 'all', label: 'All', filter: { method: 'include-all' } }],
  actions: [{ id: 'save', target: 'slot::workflow', definition_id: 'action:data-owned' }],
};

function row(payload: unknown, address?: string): InputRow {
  return { ...(address ? { address } : {}), payload };
}

describe('readConnectionGraph', () => {
  it('projects sparse, dense, hyperedge, and process evidence rows through the same descriptor path', () => {
    const model = readConnectionGraph([
      row({ kind: 'example data connection', id: 'c:1', source: 'n:a', target: 'n:b', label: 'lead', status: 'won' }, 'r:1'),
      row({ kind: 'example data connection', id: 'c:2', source: 'n:b', target: 'n:c', observer: 'n:d', label: 'campaign' }, 'r:2'),
      row({ kind: 'example data process evidence', id: 'c:3', request: 'operation:start', result: 'operation:done' }, 'r:3'),
    ], descriptor);

    expect(model.nodes.map((node) => node.id)).toEqual([
      'n:a',
      'n:b',
      'n:c',
      'n:d',
      'operation:done',
      'operation:start',
    ]);
    expect(model.connections).toHaveLength(3);
    expect(model.connections.find((connection) => connection.id === 'c:2')?.endpoints).toHaveLength(3);
    expect(model.issues).toEqual([]);
    expect(model.actions[0]?.target).toBe('slot::workflow');
  });

  it('keeps valid connections when malformed rows create issues', () => {
    const model = readConnectionGraph([
      row({ kind: 'example data connection', id: 'c:1', source: 'n:a', target: 'n:b' }),
      row({ kind: 'example data connection', id: 'c:broken', source: '', target: '' }),
      row({ kind: 'ignored data', id: 'c:ignored' }),
    ], descriptor);

    expect(model.connections.map((connection) => connection.id)).toEqual(['c:1']);
    expect(model.issues.map((issue) => issue.code)).toContain('connection-has-no-endpoints');
  });

  it('represents self loops without adding a special branch', () => {
    const model = readConnectionGraph([
      row({ kind: 'example data connection', id: 'c:self', source: 'n:self', target: 'n:self' }),
    ], descriptor);

    expect(model.nodes).toHaveLength(1);
    expect(model.nodes[0]?.connection_ids).toEqual(['c:self']);
    expect(model.connections[0]?.endpoints.map((endpoint) => endpoint.node_id)).toEqual(['n:self', 'n:self']);
  });
});
