// tools/record-graph/read-data/read-around.mjs
//
// tool:read-the-graph-around-a-record. The model around any one record, read through the records door:
//   - its relations, by side (subject: the relations it is the subject of; object: the ones naming it as the role) and
//     role, each group in that end's own order (the old orderedRelations, read_model side + role);
//   - its activities, newest first, with when they were last in touch (the old contactHistory, read_model history);
//   - with hops, every record within that many steps of it (relations and activities), nearest first.
//
//   readAround({ id, side?, role?, ended?, history?, hops?, roles?, kinds?, limit? }, { door }) ->
//     { id, relations: [{ side, role, relations, complete }], history?, neighbours?, complete }
//
// It only reads. Every part says `complete: false` when a bound in record-graph.json cut it.
import { MODEL, SIDES, byKey, kindsOf, limitOf, object, recordId, sideRelations, activityRows, word } from './graph-records.mjs';
import { loadGraph, neighbours } from './graph-walk.mjs';

/** The relations of one end, in that end's own order: { id, side, role, ended? } -> { id, side, role, relations,
 *  complete }. Ended relations are left out unless `ended` is true. */
export async function orderedRelations(door, { id, side = 'subject', role, ended = false } = {}, { model = MODEL } = {}) {
  if (!SIDES[side]) throw new Error('side is subject or object: which end the relations are read from.');
  const endId = recordId(model, id);
  const named = typeof role === 'string' ? role.trim().toLowerCase() : '';
  if (!endId || !named) throw new Error('Say which record (id) and which role to read the relations of.');
  const { found, complete } = await sideRelations(door, model, side, endId, named);
  return { id: endId, side, role: named, relations: found.sort(byKey(SIDES[side].key)).filter(one => ended || one.alive !== false), complete };
}

/** Every relation of one end on each side (or the one side asked), grouped by role, each group in that end's order. */
async function relationsAround(door, model, endId, { side, role, ended }) {
  const groups = [];
  for (const one of side ? [side] : Object.keys(SIDES)) {
    const { found, complete } = await sideRelations(door, model, one, endId, role);
    const byRole = new Map();
    for (const relation of found) {
      if (!byRole.has(relation.role)) byRole.set(relation.role, []);
      byRole.get(relation.role).push(relation);
    }
    for (const [named, list] of [...byRole].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)) {
      const relations = list.sort(byKey(SIDES[one].key)).filter(relation => ended || relation.alive !== false);
      if (relations.length) groups.push({ side: one, role: named, relations, complete });
    }
    if (!complete && !byRole.size) groups.push({ side: one, role: role ?? null, relations: [], complete });
  }
  return groups;
}

/** Everything that happened with one record, newest first: { id, with?, kinds?, role?, since?, until?, limit? } ->
 *  { id, activities, count, last_contact, complete }. `with` keeps the activities another record also took part in (a
 *  pair's shared history); `role` the ones this record took part in under that role; `last_contact` is the newest
 *  activity at or before now (or before `until`). Each activity says `as`: the roles this record took in it. */
export async function contactHistory(door, { id, with: other, kinds, role, since, until, limit } = {}, { model = MODEL } = {}) {
  const ACTIVITIES = model.activities;
  const endId = recordId(model, id);
  if (!endId) throw new Error('Say whose history to read (history).');
  const withId = other === undefined || other === null ? null : recordId(model, other);
  const kindList = kindsOf(model, kinds);
  const roleWord = role === undefined || role === null ? null : String(role).trim().toLowerCase();
  if (roleWord && !ACTIVITIES.participant_roles.includes(roleWord)) throw new Error(`A participant's role is one of ${ACTIVITIES.participant_roles.join(', ')}.`);
  const time = (name, value) => {
    if (value === undefined || value === null || value === '') return null;
    const ms = Date.parse(value);
    if (!Number.isFinite(ms)) throw new Error(`${name} is a date-time.`);
    return ms;
  };
  const from = time('since', since), to = time('until', until);
  const most = limitOf(model, limit);
  const read = await activityRows(door, model, kindList);
  const found = [];
  for (const { id: activityId, value } of read.rows) {
    const mine = value.participants.filter(part => object(part) && part.record === endId);
    if (!mine.length) continue;
    const ms = Date.parse(value.at);
    if ((kindList && !kindList.includes(value.kind)) || (roleWord && !mine.some(part => part.role === roleWord))
      || (withId && !value.participants.some(part => part?.record === withId)) || (from !== null && ms < from) || (to !== null && ms > to)) continue;
    found.push({ id: activityId, ...value, as: mine.map(part => part.role) });
  }
  found.sort((a, b) => a.at < b.at ? 1 : a.at > b.at ? -1 : a.id < b.id ? -1 : 1);
  const kept = found.slice(0, ACTIVITIES.history_most);
  const edge = to ?? Date.now();
  return { id: endId, activities: kept.slice(0, most), count: kept.length,
    last_contact: kept.find(one => Date.parse(one.at) <= edge)?.at ?? null,
    complete: read.complete && found.length <= ACTIVITIES.history_most };
}

/** The row's function: fn(input, { door }). */
export async function readAround(input = {}, { door, model = MODEL } = {}) {
  if (!object(input)) throw new Error('Give { id } and, if wanted, side, role, history and hops.');
  const id = recordId(model, input.id);
  if (!id) throw new Error('Say which record to read the graph around (id): a record id, or me.');
  if (input.side !== undefined && !SIDES[input.side]) throw new Error('side is subject or object: which end the relations are read from.');
  const role = input.role === undefined || input.role === null ? null : word(String(input.role))?.toLowerCase() ?? null;
  if (input.ended !== undefined && typeof input.ended !== 'boolean') throw new Error('ended is true or false.');
  const ended = input.ended === true;
  const relations = await relationsAround(door, model, id, { side: input.side, role, ended });
  const answer = { id, relations };
  if (input.history !== false) {
    if (input.history !== undefined && !object(input.history)) throw new Error('history is { with?, kinds?, role?, since?, until?, limit? }, or false to leave it out.');
    answer.history = await contactHistory(door, { ...(input.history ?? {}), id }, { model });
  }
  if (input.hops !== undefined && input.hops !== null) {
    const hops = Number(input.hops);
    if (!Number.isInteger(hops) || hops < 1 || hops > model.graph.hops_most) throw new Error(`hops is a whole number from 1 to ${model.graph.hops_most}.`);
    const roles = input.roles === undefined ? null : rolesOf(input.roles);
    const graph = await loadGraph(door, { roles, kinds: kindsOf(model, input.kinds), ended, activities: input.activities !== false }, model);
    answer.neighbours = { ...neighbours(graph, id, hops, limitOf(model, input.limit), model), read: graph.read };
  }
  answer.complete = relations.every(group => group.complete) && (answer.history?.complete ?? true) && (answer.neighbours?.complete ?? true);
  return answer;
}

/** A list of relation roles (or a comma list), each lowercased, or null for every role. */
export function rolesOf(roles) {
  const list = (Array.isArray(roles) ? roles : String(roles ?? '').split(',')).map(one => String(one).trim().toLowerCase()).filter(Boolean);
  return list.length ? [...new Set(list)] : null;
}
