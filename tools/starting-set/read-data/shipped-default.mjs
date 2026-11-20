// tools/starting-set/read-data/shipped-default.mjs
//
// PURPOSE
//   The one reader that lays a shipped default (../shipped-defaults.json) under a person's own record, and takes it
//   back off before the record is written. Every reader of a record that ships a default reads it through
//   shippedUnder: the page (workspace-screens show-rules-live.ts) and the tool rows (decide-when-things-show). It did
//   this in the engine (src/records/shipped_defaults.rs) until that reader left it (engine commit 8330deedf);
//   since then no account had the simple workspace laid under its show rules.
//
// NON-NEGOTIABLE INVARIANTS
//   1. Nothing here names a record, a type or a field: the shipped default names its `record` and its `merge` rules.
//   2. A shipped default is never written into the person's record: shippedOff takes off what the person did not change.
//   3. `by_id` lists: the person's entry with the same id wins over the shipped one. `switched` lists of ids: a shipped
//      id is on unless the person's `off_in` map holds it with on false.
//   4. Runs in a page and in Node alike: no Node module is read here.
//
// AI DIRECTIVE: You are forbidden from simplifying or removing this documentation.

import shippedDefaults from '../shipped-defaults.json' with { type: 'json' };

const object = value => Boolean(value) && typeof value === 'object' && !Array.isArray(value);
const word = value => typeof value === 'string' && value.trim().length > 0;
const listOf = value => (Array.isArray(value) ? value : []);
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

/** The shipped default read under `label`, or null when none ships. */
export const shippedFor = label => shippedDefaults.records.map(row => row.payload).find(one => one?.kind === 'shipped-default' && one.record === label) ?? null;

const parts = shipped => {
  const byId = shipped ? listOf(shipped.merge?.by_id) : [];
  // Each by_id field's shipped entries, kept as [field, entries].
  const lists = byId.map(field => [field, listOf(shipped.value?.[field]).filter(entry => object(entry) && word(entry.id))]);
  const switches = shipped ? listOf(shipped.merge?.switched).filter(one => word(one.field) && word(one.off_in)) : [];
  const on = switches.flatMap(({ field, off_in }) => listOf(shipped.value?.[field]).map(id => ({ field, id, off_in })));
  return { lists, on };
};

/** The person's record with the default shipped for `label` laid under it; the record itself when nothing ships. */
export function shippedUnder(label, record) {
  const { lists, on } = parts(shippedFor(label));
  if (!lists.some(([, entries]) => entries.length) && !on.length) return record ?? null;
  const own = object(record) ? record : {};
  const laid = { ...own };
  for (const [field, entries] of lists) {
    const owned = listOf(own[field]);
    const merged = [...entries.filter(entry => !owned.some(one => object(one) && one.id === entry.id)), ...owned];
    if (merged.length) laid[field] = merged;
  }
  for (const field of new Set(on.map(one => one.field))) {
    // A switched id stays on unless the person switched it off; it counts only while its entry is known (a by_id list
    // holding it, when the field is the ids of one).
    const known = id => lists.every(([, entries]) => !entries.length) || lists.some(([listField]) => listOf(laid[listField]).some(one => object(one) && one.id === id));
    const shippedOn = on.filter(one => one.field === field && own[one.off_in]?.[one.id]?.on !== false && known(one.id)).map(one => one.id);
    const ids = [...new Set([...shippedOn, ...listOf(own[field])])];
    if (ids.length) laid[field] = ids;
  }
  // The switches were read into their fields, so the off_in maps keep only what is not a shipped switch.
  for (const off_in of new Set(on.map(one => one.off_in))) {
    if (!object(own[off_in])) continue;
    laid[off_in] = Object.fromEntries(Object.entries(own[off_in]).filter(([id]) => !on.some(one => one.id === id && one.off_in === off_in)));
  }
  return laid;
}

/** What the person's own record holds after a change made over shippedUnder(label, before): the shipped entries they
 *  did not change are left out, and each shipped switch is kept as their `off_in.<id>.on` instead of in its field. */
export function shippedOff(label, after, before) {
  const { lists, on } = parts(shippedFor(label));
  if ((!lists.some(([, entries]) => entries.length) && !on.length) || !object(after)) return after;
  const own = object(before) ? before : {};
  const next = { ...after };
  const keptIds = new Set();
  for (const [field, entries] of lists) {
    const kept = listOf(after[field]).filter(entry => {
      const shipped = entries.find(one => one.id === entry?.id);
      return !shipped || listOf(own[field]).some(one => object(one) && one.id === entry.id) || !same(entry, shipped);
    });
    for (const entry of kept) if (object(entry)) keptIds.add(entry.id);
    delete next[field];
    if (kept.length) next[field] = kept;
  }
  for (const field of new Set(on.map(one => one.field))) {
    const shippedIds = new Set(on.filter(one => one.field === field).map(one => one.id));
    const ids = listOf(after[field]).filter(id => !shippedIds.has(id) || keptIds.has(id));
    delete next[field];
    if (ids.length) next[field] = ids;
  }
  for (const { field, id, off_in } of on) {
    if (keptIds.has(id)) continue; // the person keeps their own copy: their own list says
    const switches = object(next[off_in]) ? { ...next[off_in] } : {};
    if (listOf(after[field]).includes(id)) delete switches[id];
    else switches[id] = { on: false };
    next[off_in] = switches;
  }
  return next;
}
