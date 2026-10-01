// tools/relationship-graph/do-work/map-who-is-connected.mjs
//
// Maps who is connected to whom from records (introductions, deals between a person and a company, referrals): each
// person or company once, with the connections it is part of, and each connection with its ends and details. Run by the
// Workshop tool `tool:map-who-is-connected` in the tool container:
//
//   node do-work/map-who-is-connected.mjs < <the input as JSON>
//
// The records (bare or as { address, payload }) come in `records`, or as a JSON file from the person's own files
// (`records_file`). `how` says which records are connections and how to read each one (record_selectors). Prints the
// map (nodes, connections, issues) on its last line.
import { text } from 'node:stream/consumers';
import { readConnectionGraph } from '../read-data/read-connection-graph.ts';

const input = JSON.parse((await text(process.stdin)) || '{}');
const listed = value => (Array.isArray(value) ? value : Array.isArray(value?.records) ? value.records : []);
const rows = input.records ?? listed(input.records_file ? await (await fetch(input.records_file)).json() : []);
const map = readConnectionGraph(rows, { kind: 'generic-connection-projection-descriptor', id: 'connections', ...input.how });
console.log(JSON.stringify({ nodes: map.nodes, connections: map.connections, issues: map.issues, node_count: map.nodes.length, connection_count: map.connections.length }));
