// tools/record-graph/read-data/find-connections.mjs
//
// tool:find-how-records-connect. A connection query over the whole record graph, read through the records door:
//   - from and to: the paths between two records, shortest first, through relations and the activities both sides took
//     part in, each at most max_length steps;
//   - of (or from alone): the records they all relate to (hubs: a group, an organisation, a meeting, a person), and the
//     other records related to those hubs (the hubs' members), most hubs shared first.
//
//   findConnections({ from?, to?, of?, max_length?, roles?, kinds?, ended?, activities?, limit? }, { door }) ->
//     { from, to, paths, complete, read } | { of, hubs, members, count, complete, read }
//
// It only reads. Bounded by record-graph.json `graph`, so it stays fast; `complete: false` says a bound cut it.
import { MODEL, kindsOf, limitOf, object, recordId } from './graph-records.mjs';
import { loadGraph, paths, shared } from './graph-walk.mjs';
import { rolesOf } from './read-around.mjs';

export async function findConnections(input = {}, { door, model = MODEL } = {}) {
  if (!object(input)) throw new Error('Give { from, to } for the paths between two records, or { of: [record ids] } for what they share.');
  const GRAPH = model.graph;
  if (input.ended !== undefined && typeof input.ended !== 'boolean') throw new Error('ended is true or false.');
  if (input.activities !== undefined && typeof input.activities !== 'boolean') throw new Error('activities is true or false.');
  const options = { roles: input.roles === undefined ? null : rolesOf(input.roles), kinds: kindsOf(model, input.kinds),
    ended: input.ended === true, activities: input.activities !== false };
  const from = input.from === undefined || input.from === null ? null : recordId(model, input.from);
  if (input.from !== undefined && input.from !== null && !from) throw new Error('from is a record id, or me.');
  if (input.to !== undefined && input.to !== null) {
    const to = recordId(model, input.to);
    if (!from || !to) throw new Error('The paths between two records need both: from and to, each a record id or me.');
    if (from === to) throw new Error('from and to are the same record: name two different records.');
    const length = input.max_length === undefined ? GRAPH.path_length_default : Number(input.max_length);
    if (!Number.isInteger(length) || length < 1 || length > GRAPH.path_length_most) throw new Error(`max_length is a whole number of steps from 1 to ${GRAPH.path_length_most}.`);
    const graph = await loadGraph(door, options, model);
    return { from, to, max_length: length, ...paths(graph, from, to, length, model), read: graph.read };
  }
  const of = input.of === undefined || input.of === null ? (from ? [from] : null)
    : Array.isArray(input.of) ? input.of.map(id => recordId(model, id)) : null;
  if (!of || !of.length || of.some(id => !id)) throw new Error('Say which records to find connections for: from and to for the paths between them, or of: [record ids] for what they share.');
  if (of.length > GRAPH.of_most) throw new Error(`of names at most ${GRAPH.of_most} records.`);
  const graph = await loadGraph(door, options, model);
  return { of: [...new Set(of)], ...shared(graph, [...new Set(of)], limitOf(model, input.limit), model), read: graph.read };
}
