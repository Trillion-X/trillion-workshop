// packages/group/read-data/read-knowledge-graph.ts
//
// Purpose: the composition step that runs the W8 knowledge-graph projection
//   CLIENT-SIDE (mirroring how funnel-offer-graph projects its raw records with
//   `layoutTornado`, and how other owners compose visual-database read-data at the
//   surface layer). Given the raw EEAF record feed + the T1 edge-source
//   descriptors (both DATA read via useBitfieldData), it runs relationship-graph's
//   pure `readConnectionGraph` ONCE PER descriptor and merges the results into a
//   single connection-graph projection that `buildKnowledgeGraphView` consumes.
//
// Why the import is allowed: `readConnectionGraph` is a PURE function (no I/O);
//   importing it at this composition layer is the same pattern funnel uses for
//   visual-database. The relationship-graph slot still OWNS the projection
//   grammar — this file only composes it over multiple descriptors + dedupes.
//   (Ideal future debt: extract readConnectionGraph to a shared leaf crate.)
//
// Fail-closed: a malformed descriptor is skipped (never fatal); nodes are deduped
//   by id across sources; empty inputs → an empty projection (no fake nodes).

import { readConnectionGraph } from 'trillion-workshop/tools/relationship-graph/read-data/read-connection-graph.ts';

export type KnowledgeGraphProjection = {
  readonly nodes: ReadonlyArray<{ readonly id: string; readonly attributes: unknown }>;
  readonly connections: ReadonlyArray<{ readonly id: string; readonly endpoints: unknown; readonly attributes: unknown }>;
};

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

/** A scoped feed delivers WHOLE records (`{address, payload, ...}`); a descriptor
 *  may also be handed in directly. `readConnectionGraph` wants the descriptor
 *  itself (record_selectors at top level), so unwrap `.payload` when present. */
function unwrapDescriptor(value: unknown): unknown {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    const payload = (value as Record<string, unknown>).payload;
    if (payload && typeof payload === 'object') return payload;
  }
  return value;
}

/**
 * Project raw EEAF records into a merged connection graph over N edge-source
 * descriptors. `records` are InputRow-compatible (readConnectionGraph's
 * `rowPayload` reads row.payload ?? row.record ?? row). Descriptors that the
 * projection engine rejects are skipped, so one bad DATA row never blanks the map.
 */
export function projectKnowledgeGraph(records: unknown, descriptors: unknown): KnowledgeGraphProjection {
  const rows = asArray(records);
  const nodesById = new Map<string, { id: string; attributes: unknown }>();
  const connections: Array<{ id: string; endpoints: unknown; attributes: unknown }> = [];

  for (const descriptorRow of asArray(descriptors)) {
    let model;
    try {
      model = readConnectionGraph(rows as never, unwrapDescriptor(descriptorRow));
    } catch {
      continue; // a malformed descriptor is DATA the user can fix — never crash the surface
    }
    for (const node of model.nodes) {
      if (!nodesById.has(node.id)) nodesById.set(node.id, { id: node.id, attributes: node.attributes });
    }
    for (const edge of model.connections) {
      connections.push({ id: edge.id, endpoints: edge.endpoints, attributes: edge.attributes });
    }
  }

  return { nodes: [...nodesById.values()], connections };
}
