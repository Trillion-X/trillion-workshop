// src/list-filters.mjs
//
// Purpose: a saved filter as a resource of its own. A filter is a rule group with a name, kept apart from every view
// (src/lists.json `filters`), so several views of a list, and other filters, use one definition. A view puts
// { kind: "filter", filter_id } where a rule goes; reading the view replaces that node with the filter's group.
//
// Non-Negotiable Invariants:
//   1. The saved view keeps the reference; only a read expands a copy of it (as list-view-parameters binds parameters).
//   2. A reference to a filter the list does not have refuses the save naming the filters it has, and a filter never
//      reaches itself, however many filters lie between (`filter_cycle`).
//   3. A filter used by a view or another filter is not removed (`filter_in_use`); its users are named.
//   4. Every field a filter's rules name is a field of the list, checked on save.
//
import data from '../../keep-and-wake-ai-sessions-on-this-computer/src/lists.json' with { type: 'json' };
import { listSay as say } from './list-refusals.mjs';

const { filters: filterData, limits } = data;
const isObject = value => Boolean(value) && typeof value === 'object' && !Array.isArray(value);
const isReference = node => isObject(node) && node.kind === filterData.reference_kind;
const NAME = /^[a-z0-9][a-z0-9-]{0,63}$/;

/** The filter ids a rule tree uses. */
export function filterIdsIn(tree) {
  const found = new Set();
  const walk = node => {
    if (isReference(node)) found.add(node.filter_id);
    else if (isObject(node) && Array.isArray(node.rules)) node.rules.forEach(walk);
  };
  walk(tree);
  return [...found];
}

/** The field ids a rule tree names (not through filter references). */
const fieldsIn = tree => {
  const found = new Set();
  const walk = node => {
    if (!isObject(node) || isReference(node)) return;
    if (typeof node.field === 'string') found.add(node.field);
    if (Array.isArray(node.rules)) node.rules.forEach(walk);
  };
  walk(tree);
  return [...found];
};

/**
 * The rule tree with each filter reference replaced by that filter's group, `filters` being { id: { rules } }. A reference
 * to a filter that is not there, or a chain deeper than limits.filter_depth, refuses.
 */
export function expandFilters(tree, filters, listId, depth = 0, through = []) {
  if (!isObject(tree)) return tree;
  if (isReference(tree)) {
    const found = filters.get(tree.filter_id);
    if (!found) throw say('no_filter', { list_id: listId, filter_id: tree.filter_id, filters: [...filters.keys()].join(', ') || 'none' });
    if (through.includes(tree.filter_id) || depth >= limits.filter_depth) throw say('filter_cycle', { filter_id: tree.filter_id, through: [...through, tree.filter_id].join(' > ') });
    return expandFilters(found.rules, filters, listId, depth + 1, [...through, tree.filter_id]);
  }
  return Array.isArray(tree.rules) ? { ...tree, rules: tree.rules.map(node => expandFilters(node, filters, listId, depth, through)) } : tree;
}

/**
 * The list with each view's filter references replaced by the filters' groups, so whatever reads a list's views to filter
 * rows (a read through a view, a shared view, an audience) sees plain rules. A view whose filter is gone or reaches itself
 * keeps its rules as saved and says `unresolved_filters`, which a consumer treats as a view it cannot check.
 */
export function viewsWithFiltersExpanded(list, filters) {
  if (!list.views?.some(view => filterIdsIn(view.rules).length)) return list;
  return { ...list, views: list.views.map(view => {
    const used = filterIdsIn(view.rules);
    if (!used.length) return view;
    try { return { ...view, rules: expandFilters(view.rules, filters, list.id) }; } catch { return { ...view, unresolved_filters: used }; }
  }) };
}

/**
 * The list owner's filters: `eeaf` the record store, `write` the list owner's one write road, `readList(slug)` the list,
 * `viewsOf(slug)` its views, `slugOf(text)` and `listKey(id)` the owner's naming.
 */
export function listFilters({ eeaf, write, readList, viewsOf, slugOf, listKey }) {
  const prefix = slug => `${filterData.type}:${slug}:`;
  const recordOf = (slug, id) => `${prefix(slug)}${id}`;
  const all = slug => eeaf.ids(filterData.type, { prefix: prefix(slug), limit: limits.filters_per_list + 1 }).filter(id => id.startsWith(prefix(slug)))
    .map(id => eeaf.read(id)).filter(record => record?.filter).map(record => record.filter).sort((a, b) => (a.id < b.id ? -1 : 1));
  const refuse = what => say('bad_filter', { what });

  const checked = (slug, list, input, id) => {
    if (!isObject(input) || typeof input.label !== 'string' || !input.label.trim()) throw refuse('it needs a label');
    const rules = input.rules;
    if (!isObject(rules) || rules.kind !== 'group' || !Array.isArray(rules.rules)) throw refuse('its rules are not a rule group');
    if (JSON.stringify(rules).length > limits.text_chars) throw refuse('its rules are too long');
    const known = new Set(list.fields.map(field => field.id));
    const unknown = fieldsIn(rules).find(field => !known.has(field) && !field.includes('.'));
    if (unknown) throw refuse(`${unknown} is not a field of the list`);
    return { id, label: input.label.trim(), rules };
  };
  const reaching = (slug, from, filters) => {
    const seen = [];
    const walk = (id, trail) => {
      if (trail.includes(id)) throw say('filter_cycle', { filter_id: from, through: [...trail, id].join(' > ') });
      if (seen.includes(id)) return;
      seen.push(id);
      for (const next of filterIdsIn(filters.get(id)?.rules)) walk(next, [...trail, id]);
    };
    walk(from, []);
  };
  const usersOf = (slug, id) => [
    ...viewsOf(slug).filter(view => filterIdsIn(view.rules).includes(id)).map(view => `view ${view.id}`),
    ...all(slug).filter(filter => filter.id !== id && filterIdsIn(filter.rules).includes(id)).map(filter => `filter ${filter.id}`),
  ];

  return {
    /** Every saved filter of the list, each with the views and filters that use it. */
    filters(id) {
      const slug = listKey(id);
      readList(slug);
      return { list_id: slug, filters: all(slug).map(filter => ({ ...filter, used_by: usersOf(slug, filter.id) })) };
    },
    /** Saves one filter ({ id?, label, rules }); the same id changes it, and every view that uses it follows. */
    save(id, input, { actor } = {}) {
      const slug = listKey(id);
      const list = readList(slug);
      const filterId = input?.id ? listKey(input.id) : listKey(slugOf(input?.label));
      if (!NAME.test(filterId)) throw refuse('it needs an id of letters, digits and dashes');
      const filter = checked(slug, list, input, filterId);
      const others = all(slug).filter(item => item.id !== filterId);
      if (others.length >= limits.filters_per_list) throw say('too_many', { limit: limits.filters_per_list, what: 'filters' });
      const filters = new Map([...others, filter].map(item => [item.id, item]));
      const missing = filterIdsIn(filter.rules).find(used => !filters.has(used));
      if (missing) throw say('no_filter', { list_id: slug, filter_id: missing, filters: [...filters.keys()].join(', ') || 'none' });
      reaching(slug, filterId, filters);
      write([{ id: recordOf(slug, filterId), type: filterData.type, value: { list_id: slug, filter } }], { actor: actor ?? { by: 'lists' } }, { list_ref: `${data.record_type}:${slug}` });
      return { list_id: slug, filter };
    },
    /** Removes a filter nothing uses. */
    remove(id, { filter_id } = {}, { actor } = {}) {
      const slug = listKey(id);
      readList(slug);
      const wanted = listKey(filter_id ?? '');
      const present = all(slug);
      if (!present.some(filter => filter.id === wanted)) throw say('no_filter', { list_id: slug, filter_id: wanted, filters: present.map(filter => filter.id).join(', ') || 'none' });
      const users = usersOf(slug, wanted);
      if (users.length) throw say('filter_in_use', { filter_id: wanted, users: users.join(', ') });
      write([{ id: recordOf(slug, wanted), type: filterData.type, value: null }], { actor: actor ?? { by: 'lists' } }, { list_ref: `${data.record_type}:${slug}` });
      return { list_id: slug, removed: wanted };
    },
    /** The filters of the list by id, for expanding a view's rules. */
    byId: slug => new Map(all(slug).map(filter => [filter.id, filter])),
    /** Refuses a view whose rules use a filter the list does not have. */
    checkViewUses(slug, view) {
      const have = this.byId(slug);
      for (const used of filterIdsIn(view.rules)) if (!have.has(used)) throw say('no_filter', { list_id: slug, filter_id: used, filters: [...have.keys()].join(', ') || 'none' });
    },
  };
}
