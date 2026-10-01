import {
  defaultSelectorRegistry,
  evaluateSelector,
  objectValue,
  rowPayload,
  textValue,
  validateConnectionProjectionDescriptor,
  type SelectorRegistry,
} from './connection-descriptor.ts';
import type {
  ConnectionEdge,
  ConnectionEndpoint,
  ConnectionGraphModel,
  ConnectionNode,
  ConnectionProjectionDescriptor,
  InputRow,
  JsonObject,
  ProjectionIssue,
} from './connection-model.ts';

type MutableNode = {
  id: string;
  attributes: Record<string, unknown>;
  connectionIds: Set<string>;
};

function issue(code: string, row: InputRow, selectorId?: string): ProjectionIssue {
  return {
    code,
    ...(selectorId ? { selector_id: selectorId } : {}),
    ...(row.address ? { row_address: row.address } : {}),
  };
}

function sortedObjectEntries(value: JsonObject): readonly [string, unknown][] {
  return Object.entries(value).sort(([left], [right]) => left.localeCompare(right));
}

function addNode(nodes: Map<string, MutableNode>, nodeId: string, connectionId: string): void {
  const node = nodes.get(nodeId) ?? { id: nodeId, attributes: {}, connectionIds: new Set<string>() };
  node.connectionIds.add(connectionId);
  nodes.set(nodeId, node);
}

export function readConnectionGraph(
  rows: readonly InputRow[],
  descriptorInput: unknown,
  registry: SelectorRegistry = defaultSelectorRegistry,
): ConnectionGraphModel {
  const descriptor: ConnectionProjectionDescriptor =
    validateConnectionProjectionDescriptor(descriptorInput);
  const nodes = new Map<string, MutableNode>();
  const connections = new Map<string, ConnectionEdge>();
  const issues: ProjectionIssue[] = [];

  for (const row of rows) {
    const payload = rowPayload(row);
    const context = { row, payload };
    for (const selector of descriptor.record_selectors) {
      if (evaluateSelector(selector.match, context, registry) !== true) continue;
      const connectionId = textValue(evaluateSelector(selector.connection.identity, context, registry));
      if (!connectionId) {
        issues.push(issue('connection-identity-missing', row, selector.id));
        continue;
      }

      const endpoints: ConnectionEndpoint[] = [];
      for (const endpoint of selector.connection.endpoints) {
        const nodeId = textValue(evaluateSelector(endpoint.value, context, registry));
        if (!nodeId) continue;
        endpoints.push({ role: endpoint.role, node_id: nodeId });
      }
      if (endpoints.length === 0) {
        issues.push(issue('connection-has-no-endpoints', row, selector.id));
        continue;
      }

      const attributes: Record<string, unknown> = {};
      for (const attribute of selector.connection.attributes ?? []) {
        const value = evaluateSelector(attribute.value, context, registry);
        if (value !== undefined) attributes[attribute.name] = value;
      }

      const edge: ConnectionEdge = {
        id: connectionId,
        endpoints,
        attributes: objectValue(attributes),
        ...(row.address ? { source_row_address: row.address } : {}),
      };
      connections.set(edge.id, edge);
      for (const endpoint of edge.endpoints) addNode(nodes, endpoint.node_id, edge.id);
    }
  }

  const nodeList: ConnectionNode[] = [...nodes.values()]
    .map((node) => ({
      id: node.id,
      attributes: objectValue(node.attributes),
      connection_ids: [...node.connectionIds].sort(),
    }))
    .sort((left, right) => left.id.localeCompare(right.id));
  const connectionList = [...connections.values()].sort((left, right) => left.id.localeCompare(right.id));

  return {
    descriptor_id: descriptor.id,
    nodes: nodeList,
    connections: connectionList,
    views: [...(descriptor.views ?? [])].sort((left, right) => left.id.localeCompare(right.id)),
    actions: [...(descriptor.actions ?? [])].sort((left, right) => left.id.localeCompare(right.id)),
    issues,
    changed: {
      node_ids: nodeList.map((node) => node.id),
      connection_ids: connectionList.map((connection) => connection.id),
    },
  };
}

export function stableConnectionModelText(model: ConnectionGraphModel): string {
  return JSON.stringify(model, (_key, value) => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return value;
    return Object.fromEntries(sortedObjectEntries(value as JsonObject));
  });
}
