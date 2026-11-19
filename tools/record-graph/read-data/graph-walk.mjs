// tools/record-graph/read-data/graph-walk.mjs
//
// The record graph as one bounded read, and the walks over it. A walk reads the relations (and the activities, unless
// left out) once from the rows it is handed, at most graph.scan_most of each kind, and keeps them as adjacency in memory:
//
//   - a relation is an edge between its subject and its object, carrying its id and role; each end is on its side
//     (`subject` or `object`);
//   - an activity is a record of its own that every participant reaches under its role (side `participant`), and that
//     reaches each participant back (side `activity`); so the people at one meeting are two steps apart, through it.
//
// Every answer says `complete: false` when a bound in record-graph.json cut it (rows not read, records not visited,
// steps not taken), so what is not shown reads as not known yet, never as absent. Nothing here reads a store or writes.
import { MODEL, listBounded, activityRows, object, word } from './graph-records.mjs';
import { canonicalJson } from '../../content-identity/read-data/identity.mjs';

const order = (a, b) => a.to < b.to ? -1 : a.to > b.to ? 1 : a.by < b.by ? -1 : a.by > b.by ? 1 : a.side < b.side ? -1 : a.side > b.side ? 1 : 0;

// The two projections (walks over the rows handed in and a supplied record feed) share this topology.
// An activity keeps its own identity as a hub, never a pairwise expansion.
// Stored identities are opaque: validation must never trim them into another ID.
const recordKey = value => word(value) ? value : null;
const relationValue = value => object(value) && word(value.subject) && word(value.object) && word(value.role)
  && (value.alive === undefined || typeof value.alive === 'boolean');
const activityValue = value => object(value) && word(value.kind) && Array.isArray(value.participants) && value.participants.length > 0;

function relationSteps(id, value, { roles = null, ended = false } = {}) {
  if (!word(id) || !relationValue(value)
    || (!ended && value.alive === false) || (roles && !roles.includes(value.role))) return [];
  return [
    { from: value.subject, to: value.object, by: id, kind: 'relation', role: value.role, side: 'subject' },
    { from: value.object, to: value.subject, by: id, kind: 'relation', role: value.role, side: 'object' },
  ];
}

function activitySteps(id, value, { kinds = null, activities = true } = {}, model = MODEL) {
  const empty = complete => ({ steps: [], complete, participants: [] });
  if (!activities) return empty(true);
  if (!word(id) || !activityValue(value)) return empty(false);
  if (kinds && !kinds.includes(value.kind)) return empty(true);
  const participants = value.participants.slice(0, model.activities.participants_most);
  let complete = participants.length === value.participants.length;
  const steps = participants.flatMap(part => {
    if (!object(part) || !word(part.record) || (part.role !== undefined && !word(part.role))) { complete = false; return []; }
    const role = part.role === undefined ? 'participant' : part.role;
    return [
      { from: part.record, to: id, by: id, kind: 'activity', role, side: 'participant' },
      { from: id, to: part.record, by: id, kind: 'activity', role, side: 'activity' },
    ];
  });
  return { steps, participants, complete };
}

/** Pure record-feed projection, over the same DATA and topology as loadGraph.
 * Input is rows {id,type,value}, or scoped-feed {address,payload} with
 * an explicit type on the row or its payload (type/kind). No descriptor grammar
 * or identity inference from an address. Only actual supplied records become
 * nodes; exact stored IDs are retained, and conflicting duplicates are omitted
 * as ambiguous rather than choosing a row. Absent endpoints remain references for the consumer's missing-record
 * view. Each category is bounded by graph.scan_most, with complete:false on a cut.
 * A producer can supply {records: rows, complete:false} to carry an upstream cut.
 * Known empty arrays are complete. Missing/unsupported feeds and malformed
 * graph rows are incomplete, without throwing during an async mount.
 * Completeness concerns this supplied scope, never the whole account.
 * No I/O and no writes. Extra record fields stay opaque attributes. */
export function projectGraphRecords(rows, options = {}, model = MODEL) {
  const records = new Map(), relations = new Map(), activities = new Map();
  const hasSource = Array.isArray(rows) || (object(rows) && Array.isArray(rows.records));
  const source = Array.isArray(rows) ? rows : hasSource ? rows.records : [];
  let complete = hasSource && !(object(rows) && rows.complete !== undefined && rows.complete !== true);
  const supplied = new Map();
  const categories = [records, relations, activities];
  const ambiguous = id => {
    complete = false;
    supplied.set(id, null);
    for (const category of categories) category.delete(id);
  };
  for (const row of source) {
    if (!object(row)) { complete = false; continue; }
    const value = row.value ?? row.payload ?? row.record;
    const id = recordKey(row.id) ?? recordKey(row.address);
    if (!id) { complete = false; continue; }
    const type = recordKey(row.type) ?? (object(value) ? recordKey(value.type) ?? recordKey(value.kind) : null);
    if ((recordKey(row.id) && recordKey(row.address) && row.id !== row.address)
      || (object(value) && recordKey(row.type) && recordKey(value.type) && row.type !== value.type)) { ambiguous(id); continue; }
    if (supplied.has(id)) {
      const previous = supplied.get(id);
      let identical = previous !== null && previous.type === type;
      if (identical && previous.value !== value) {
        try { identical = canonicalJson(previous.value) === canonicalJson(value); }
        catch { identical = false; }
      }
      if (!identical) ambiguous(id);
      continue;
    }
    // Compare identities across the supplied feed, including filtered rows.
    // This does not read more records or change per-category projection limits.
    supplied.set(id, { type, value });
    if (!object(value)) { complete = false; continue; }
    if (!type) { complete = false; continue; }
    // Corrupt typed graph records cannot turn into a known-empty answer. Check
    // their topology before treating valid filters/ended records as exclusions.
    if ((type === model.relations.type && !relationValue(value))
      || (type === model.activities.type && !activityValue(value))) { complete = false; continue; }
    // Match the role/kind filtering of the walk before applying its per-kind bound.
    if (type === model.relations.type && options.roles && !options.roles.includes(value.role)) continue;
    if (type === model.activities.type && (options.activities === false || (options.kinds && !options.kinds.includes(value.kind)))) continue;
    const target = type === model.relations.type ? relations : type === model.activities.type ? activities : records;
    if (target.has(id)) continue;
    if (target.size >= model.graph.scan_most) { complete = false; continue; }
    target.set(id, value);
  }
  const nodes = new Map(), connections = [];
  const keepRecord = id => {
    if (records.has(id) && !nodes.has(id)) nodes.set(id, { id, attributes: records.get(id) });
  };
  for (const [id, value] of relations) {
    const steps = relationSteps(id, value, options);
    if (!steps.length) continue;
    keepRecord(value.subject); keepRecord(value.object);
    connections.push({ id, endpoints: [{ node_id: value.subject, role: 'subject' }, { node_id: value.object, role: 'object' }],
      attributes: { ...value, relation: value.role } });
  }
  for (const [id, value] of activities) {
    const activity = activitySteps(id, value, options, model);
    complete &&= activity.complete;
    const steps = activity.steps.filter(step => step.side === 'activity' && step.to !== id);
    if (!steps.length) continue;
    nodes.set(id, { id, attributes: { ...value, participants: activity.participants, label: word(value.label) ?? word(value.summary) ?? word(value.kind) ?? id } });
    const seen = new Set();
    for (const step of steps) {
      const key = JSON.stringify([step.to, step.role]);
      if (seen.has(key)) continue;
      seen.add(key); keepRecord(step.to);
      connections.push({ id: `${id}:participant:${seen.size - 1}`,
        endpoints: [{ node_id: id, role: 'activity' }, { node_id: step.to, role: step.role }],
        attributes: { kind: value.kind, role: step.role } });
    }
  }
  return { nodes: [...nodes.values()], connections, complete, read: { relations: relations.size, activities: activities.size, records: records.size } };
}

/** Reads the graph from the rows given: { edges: Map<record id, [{ to, by, kind, role, side }]>, complete, read: { relations,
 *  activities } }. roles keeps only relations of these roles; kinds only activities of these kinds; ended keeps ended
 *  relations too; activities false leaves activities out. */
export function loadGraph(rows, { roles = null, kinds = null, ended = false, activities = true } = {}, model = MODEL) {
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
    const page = listBounded(rows, { type: model.relations.type, ...(role ? { where: { role } } : {}) }, most - relations.length);
    relations.push(...page.rows);
    if (!page.complete) { complete = false; break; }
  }
  for (const { id, value } of relations) {
    for (const { from, ...edge } of relationSteps(id, value, { roles, ended })) add(from, edge);
  }
  let happened = [];
  if (activities) {
    const page = activityRows(rows, { ...model, activities: { ...model.activities, scan_most: most } }, kinds);
    happened = page.rows;
    complete &&= page.complete;
    for (const { id, value } of happened) {
      const activity = activitySteps(id, value, { kinds, activities }, model);
      complete &&= activity.complete;
      for (const { from, ...edge } of activity.steps) add(from, edge);
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
