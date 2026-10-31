import type { ConnectionGraphModel } from './connection-model.ts';

export type GraphQueryRequest = {
  readonly payload: {
    readonly operations: readonly unknown[];
  };
};

export function buildGraphQueryRequest(model: ConnectionGraphModel): GraphQueryRequest {
  const nodeOperations = model.nodes.map((node) => ({
    operation: 'put-node',
    id: node.id,
    attributes: node.attributes,
  }));
  const connectionOperations = model.connections.map((connection) => ({
    operation: 'put-connection',
    id: connection.id,
    endpoints: connection.endpoints,
    attributes: connection.attributes,
  }));
  return {
    payload: { operations: [...nodeOperations, ...connectionOperations] },
  };
}
