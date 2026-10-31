// tools/relationship-graph/do-work/keep-who-is-connected.mjs
//
// Reads the person's connection records through the records door, works out each person or company once with the
// connections it is in (read-connection-graph.ts), and keeps that map as records: one `graph-node` record per node and
// one `graph-connection` record per connection (build-graph-query-request.ts lowers the map into those operations).
// Run by the Workshop tool `tool:keep-who-is-connected` through tools/records-door/do-work/run-an-export.mjs:
//
//   node run-an-export.mjs do-work/keep-who-is-connected.mjs keepWhoIsConnected < <the input as JSON>
import { readConnectionGraph } from '../read-data/read-connection-graph.ts';
import { buildGraphQueryRequest } from '../read-data/build-graph-query-request.ts';

export const SOURCE_KIND = 'connection';
export const NODE_KIND = 'graph-node';
export const CONNECTION_KIND = 'graph-connection';
const MOST_PER_WRITE = 256;

/** The records one operation keeps: its id gets the kind in front, so the door's prefix rights can narrow it. */
function recordOf({ operation, id, ...rest }) {
  const type = operation === 'put-node' ? NODE_KIND : CONNECTION_KIND;
  return { id: `${type}:${id}`, type, value: { id, ...rest } };
}

export async function keepWhoIsConnected(input, { door }) {
  if (!input?.how || !Array.isArray(input.how.record_selectors)) throw new Error('give how.record_selectors: how to read connections from the connection records');
  const rows = [];
  for await (const record of door.list({ type: SOURCE_KIND })) if (record.value) rows.push({ address: record.id, payload: record.value });
  const map = readConnectionGraph(rows, { kind: 'generic-connection-projection-descriptor', id: 'connections', ...input.how });
  const records = buildGraphQueryRequest(map).payload.operations.map(recordOf);
  for (let from = 0; from < records.length; from += MOST_PER_WRITE) {
    await door.write(records.slice(from, from + MOST_PER_WRITE));
  }
  return { node_count: map.nodes.length, connection_count: map.connections.length, kept_count: records.length, issues: map.issues };
}
