// src/list-paths.mjs
//
// Purpose: a saved view that reaches through links. "People whose company has more than 50 employees" and "show each
// person's company domain as a column" are one idea: a field written as links followed by a field,
// `company.employees`, `company.parent.name`. The view's filter, sort, groups, columns and time range name it exactly as
// they name an ordinary field; this file works out what it is (a field of the linked list, a list of such values when
// a link holds several rows) and reads the values for the rows being shown.
//
// Non-Negotiable Invariants:
//   1. A path is `link.link.field` (at most limits.path_hops steps): every step before the last is a link field of the list
//      the step before it reached, the last is any field of the last list. Nothing else is a path; a name with no dot is
//      an ordinary field. A path that does not resolve against the lists is refused with the view's words (`bad_path`).
//   2. A path through links that each hold at most one row keeps the kind of the field it ends on. A path through a link that
//      can hold several rows is the list of the reached values as text (kind `tags`), so `any of` and `contains` work and
//      no number is compared against a guess.
//   3. Values are read from the lists that own them (read with row_ids), a hop at a time, only for the rows being shown;
//      nothing is copied into the row that is stored.
//   4. A dotted id whose first step is a namespace one of the list's row sources declares (src/lists.json
//      source_namespaces: note.status of a folder of documents) is that source's own value, not a path.
//
import data from '../../keep-and-wake-ai-sessions-on-this-computer/src/lists.json' with { type: 'json' };
import { listSay as say } from './list-refusals.mjs';

const { limits } = data;
const KINDS = new Map(data.field_kinds.map(kind => [kind.id, kind]));
const PATH = /^[A-Za-z][A-Za-z0-9_-]{0,63}(?:\.[A-Za-z][A-Za-z0-9_-]{0,63})+$/;
const isObject = value => Boolean(value) && typeof value === 'object' && !Array.isArray(value);
const listValue = value => (Array.isArray(value) ? value : typeof value === 'string' && value ? [value] : []);

export const isPathId = id => typeof id === 'string' && PATH.test(id);

/**
 * The namespaces a list's row sources name their own values under (src/lists.json source_namespaces): a dotted id whose
 * first step is one of them (note.status, file.mtime) is that source's value, never a path through links.
 */
export const sourceNamespacesOf = rowSources => new Set((rowSources ?? []).flatMap(row => Object.values(data.source_namespaces?.[row.source] ?? {})));
export const isSourceId = (id, namespaces) => isPathId(id) && namespaces.has(id.slice(0, id.indexOf('.')));

/** Every path a saved view names, in its rules, sort, groups, columns and time range. */
export function pathIdsOf(view) {
  const found = new Set();
  const note = id => { if (isPathId(id)) found.add(id); };
  const walk = node => {
    if (!isObject(node)) return;
    note(node.field);
    if (Array.isArray(node.rules)) node.rules.forEach(walk);
  };
  walk(view?.rules);
  for (const entry of [...(Array.isArray(view?.sort) ? view.sort : []), ...(Array.isArray(view?.groups) ? view.groups : [])]) note(entry?.field);
  for (const id of [...listValue(view?.columns?.order), ...listValue(view?.columns?.hidden)]) note(id);
  note(view?.time?.field);
  return [...found];
}

/**
 * What a path is, against the lists that exist: { id, label, kind, hops: [{ list, field }], leaf, many } or a `bad_path` refusal.
 * `listOf(slug)` is the list definition ({ id, label, fields }) or null.
 */
export function planPath(list, pathId, listOf, viewId = '') {
  const refuse = () => say('bad_path', { view_id: viewId, path: JSON.stringify(pathId), hops: limits.path_hops });
  const steps = pathId.split('.');
  if (!isPathId(pathId) || steps.length > limits.path_hops) throw refuse();
  const hops = [];
  let here = list;
  const labels = [];
  let many = false;
  for (const step of steps.slice(0, -1)) {
    const field = here.fields.find(item => item.id === step);
    if (!field || !KINDS.get(field.kind)?.links) throw refuse();
    const next = listOf(field.links_to);
    if (!next) throw refuse();
    hops.push({ list: here, field });
    labels.push(field.label);
    many ||= field.link_constraints?.max_links !== 1;
    here = next;
  }
  const leaf = here.fields.find(item => item.id === steps.at(-1));
  if (!leaf) throw refuse();
  labels.push(leaf.label);
  return { id: pathId, label: labels.join(' › '), kind: many ? 'tags' : leaf.kind, hops, leaf, leafList: here, many };
}

/**
 * planPath when `listOf(slug)` answers a promise (lists reached through the door): the lists the path's hops name are read
 * first, in order and at most limits.path_hops of them, then the path is planned over what was read, so its rules stay
 * the ones above.
 */
export async function planPathAhead(list, pathId, listOf, viewId = '') {
  const read = new Map();
  let here = list;
  for (const step of String(pathId).split('.').slice(0, -1).slice(0, limits.path_hops)) {
    const field = here?.fields?.find(item => item.id === step);
    if (!field || typeof field.links_to !== 'string') break;
    if (!read.has(field.links_to)) read.set(field.links_to, await listOf(field.links_to));
    here = read.get(field.links_to);
  }
  return planPath(list, pathId, slug => read.get(slug) ?? null, viewId);
}

const chunks = (items, size) => Array.from({ length: Math.ceil(items.length / size) }, (_, index) => items.slice(index * size, (index + 1) * size));

// The rows of one list by id, reading only `only`, in groups the list owner accepts.
async function rowsOf(lists, listId, ids, only) {
  const out = new Map();
  for (const group of chunks([...new Set(ids)], limits.rows_per_read))
    for (const row of (await lists.read(listId, { row_ids: group, only })).rows) out.set(row.id, row.values);
  return out;
}

/**
 * Puts each path's value into the values of the rows being shown: `rows` become copies with values[pathId] set.
 * A row that reaches nothing holds no value for the path (so `is empty` matches it).
 */
export async function withPathValues(lists, plans, rows) {
  if (!plans.length) return rows;
  const shown = rows.map(row => ({ ...row, values: { ...row.values } }));
  for (const plan of plans) {
    // reach[i]: the ids the i-th row reaches at the current hop.
    let reach = shown.map(row => listValue(row.values[plan.hops[0].field.id]));
    for (let hop = 1; hop < plan.hops.length; hop += 1) {
      const held = await rowsOf(lists, plan.hops[hop].list.id, reach.flat(), [plan.hops[hop].field.id]);
      reach = reach.map(ids => [...new Set(ids.flatMap(id => listValue(held.get(id)?.[plan.hops[hop].field.id])))]);
    }
    const leaves = await rowsOf(lists, plan.leafList.id, reach.flat(), [plan.leaf.id]);
    shown.forEach((row, index) => {
      const reached = reach[index].map(id => leaves.get(id)?.[plan.leaf.id]).filter(value => value !== undefined && value !== null && value !== '');
      if (!reached.length) return;
      row.values[plan.id] = plan.many ? [...new Set(reached.flatMap(value => (Array.isArray(value) ? value : [value]).map(String)))] : reached[0];
    });
  }
  return shown;
}
