// tools/record-graph/read-data/graph-walk.mjs
//
// The record graph as one bounded read, and the walks over it. A walk reads the relations (and the activities, unless
// left out) once through records:list, at most graph.scan_most of each kind, and keeps them as adjacency in memory:
//
//   - a relation is an edge between its subject and its object, carrying its id and role; each end is on its side
//     (`subject` or `object`);
//   - an activity is a record of its own that every participant reaches under its role (side `participant`), and that
//     reaches each participant back (side `activity`); so the people at one meeting are two steps apart, through it.
//
// Every answer says `complete: false` when a bound in record-graph.json cut it (rows not read, records not visited,
// steps not taken), so what is not shown reads as not known yet, never as absent. Nothing here writes.
import { MODEL, listBounded, activityRows, object } from './graph-records.mjs';

const order = (a, b) => a.to < b.to ? -1 : a.to > b.to ? 1 : a.by < b.by ? -1 : a.by > b.by ? 1 : a.side < b.side ? -1 : a.side > b.side ? 1 : 0;

/** Reads the graph: { edges: Map<record id, [{ to, by, kind, role, side }]>, complete, read: { relations, activities } }.
 *  roles keeps only relations of these roles; kinds only activities of these kinds; ended keeps ended relations too;
 *  activities false leaves activities out. */
export async function loadGraph(door, { roles = null, kinds = null, ended = false, activities = true } = {}, model = MODEL) {
  const most = model.graph.scan_most;
  const edges = new Map();
  const add = (from, edge) => {
    if (from === edge.to) return;
    if (!edges.has(from)) edges.set(from, []);
    edges.get(from).push(edge);
  };
  let complete = true;
  const relations = [];
  for (const role of roles ?? [null]) {
    const page = await listBounded(door, model, { type: model.relations.type, fields: ['subject', 'role', 'object', 'alive'],
      ...(role ? { where: { role } } : {}) }, most - relations.length);
    relations.push(...page.rows);
    if (!page.complete) { complete = false; break; }
  }
  for (const { id, value } of relations) {
    if (!object(value) || typeof value.subject !== 'string' || typeof value.object !== 'string' || typeof value.role !== 'string') continue;
    if (!ended && value.alive === false) continue;
    add(value.subject, { to: value.object, by: id, kind: 'relation', role: value.role, side: 'subject' });
    add(value.object, { to: value.subject, by: id, kind: 'relation', role: value.role, side: 'object' });
  }
  let happened = [];
  if (activities) {
    const page = await activityRows(door, { ...model, activities: { ...model.activities, scan_most: most } }, kinds, ['kind', 'at', 'participants']);
    happened = page.rows;
    complete &&= page.complete;
    for (const { id, value } of happened) {
      for (const part of value.participants) {
        if (!object(part) || typeof part.record !== 'string') continue;
        const role = typeof part.role === 'string' ? part.role : 'participant';
        add(part.record, { to: id, by: id, kind: 'activity', role, side: 'participant' });
        add(id, { to: part.record, by: id, kind: 'activity', role, side: 'activity' });
      }
    }
  }
  for (const list of edges.values()) list.sort(order);
  return { edges, complete, read: { relations: relations.length, activities: happened.length } };
}

const stepOf = (from, edge) => ({ from, to: edge.to, by: edge.by, kind: edge.kind, role: edge.role, side: edge.side });

/** Every record within `hops` steps of start, nearest first, each with the step that first reached it. */
export function neighbours(graph, start, hops, limit, model = MODEL) {
  const reached = new Map([[start, null]]);
  let frontier = [start], complete = graph.complete;
  for (let distance = 1; distance <= hops && frontier.length; distance += 1) {
    const next = [];
    for (const from of frontier) {
      for (const edge of graph.edges.get(from) ?? []) {
        if (reached.has(edge.to)) continue;
        if (reached.size > model.graph.visits_most) { complete = false; break; }
        reached.set(edge.to, { distance, via: stepOf(from, edge) });
        next.push(edge.to);
      }
    }
    frontier = next;
  }
  const records = [...reached].filter(([id]) => id !== start)
    .map(([id, found]) => ({ id, distance: found.distance, via: found.via }))
    .sort((a, b) => a.distance - b.distance || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  return { hops, records: records.slice(0, limit), count: records.length, complete: complete && records.length <= limit };
}

/** The paths from one record to another, shortest first, each at most `length` steps, at most graph.paths_most of
 *  them: { paths: [{ length, records, steps }], complete }. No record is visited twice on one path. */
export function paths(graph, from, to, length, model = MODEL) {
  const most = model.graph.paths_most;
  let complete = graph.complete;
  // How far each record is from `to`, so the search below only takes steps that can still arrive in time.
  const away = new Map([[to, 0]]);
  for (let frontier = [to], distance = 1; distance <= length && frontier.length; distance += 1) {
    const next = [];
    for (const at of frontier) {
      for (const edge of graph.edges.get(at) ?? []) {
        if (away.has(edge.to)) continue;
        if (away.size > model.graph.visits_most) { complete = false; break; }
        away.set(edge.to, distance);
        next.push(edge.to);
      }
    }
    frontier = next;
  }
  const found = [];
  if (!away.has(from) || from === to) return { paths: found, complete };
  let steps = 0;
  // Shortest first: each pass keeps the paths of exactly `exact` steps.
  for (let exact = away.get(from); exact <= length && found.length < most; exact += 1) {
    const trail = [from], taken = [], on = new Set([from]);
    const walk = at => {
      if (found.length >= most) return;
      if (at === to) { if (taken.length === exact) found.push({ length: exact, records: [...trail], steps: [...taken] }); return; }
      for (const edge of graph.edges.get(at) ?? []) {
        if (on.has(edge.to) || !away.has(edge.to) || taken.length + 1 + away.get(edge.to) > exact) continue;
        if (++steps > model.graph.steps_most) { complete = false; return; }
        trail.push(edge.to); taken.push(stepOf(at, edge)); on.add(edge.to);
        walk(edge.to);
        trail.pop(); taken.pop(); on.delete(edge.to);
        if (found.length >= most || steps > model.graph.steps_most) return;
      }
    };
    walk(from);
    if (steps > model.graph.steps_most) break;
  }
  // More paths may exist when the answer is full.
  return { paths: found, complete: complete && found.length < most };
}

/** What the records in `of` all relate to (the hubs: a group they are all members of, a meeting they all took part
 *  in, a person each of them is related to), and every other record related to those hubs (the hubs' members), most
 *  hubs shared first. */
export function shared(graph, of, limit, model = MODEL) {
  const stepsOf = id => graph.edges.get(id) ?? [];
  const reach = of.map(id => new Map(stepsOf(id).filter(edge => !of.includes(edge.to)).map(edge => [edge.to, []])));
  of.forEach((id, at) => { for (const edge of stepsOf(id)) reach[at].get(edge.to)?.push({ record: id, by: edge.by, kind: edge.kind, role: edge.role, side: edge.side }); });
  const hubIds = [...reach[0].keys()].filter(hub => reach.every(map => map.has(hub))).sort();
  const hubs = hubIds.map(hub => ({ id: hub, held: reach.flatMap(map => map.get(hub)) }));
  const members = new Map();
  for (const hub of hubIds) {
    for (const edge of stepsOf(hub)) {
      if (of.includes(edge.to)) continue;
      if (!members.has(edge.to)) members.set(edge.to, []);
      members.get(edge.to).push({ hub, by: edge.by, kind: edge.kind, role: edge.role, side: edge.side === 'activity' ? 'participant' : edge.side === 'participant' ? 'activity' : edge.side === 'subject' ? 'object' : 'subject' });
    }
  }
  const most = Math.min(limit, model.graph.members_most);
  const ranked = [...members].map(([id, through]) => ({ id, hubs: new Set(through.map(one => one.hub)).size, through }))
    .sort((a, b) => b.hubs - a.hubs || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  return { hubs: hubs.slice(0, most), members: ranked.slice(0, most), count: { hubs: hubs.length, members: ranked.length },
    complete: graph.complete && hubs.length <= most && ranked.length <= most };
}
