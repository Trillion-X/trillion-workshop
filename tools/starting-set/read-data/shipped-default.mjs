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

// A rule of a shipped entry (merge.rules_switched: { field, off_in, list }) belongs to a switch: its `switch` id, or its own
// id when it names none. Rules that share a switch switch together. The person's record names a switch under the entry's
// off_in map: starting.<entry id>.switches.<switch id>.on false. The rules of a switched-off switch are taken out of the
// entry where the entry is laid, and where the entry is unchanged they are kept out of the person's record.
const ruleSwitchOf = shipped => (object(shipped?.merge?.rules_switched) && word(shipped.merge.rules_switched.field) && word(shipped.merge.rules_switched.off_in) && word(shipped.merge.rules_switched.list)
  ? shipped.merge.rules_switched : null);
const switchOf = rule => (word(rule?.switch) ? rule.switch : rule?.id);
const switchedOff = (own, off_in, id, rule) => own[off_in]?.[id]?.switches?.[switchOf(rule)]?.on === false;

// The shipped entry with the rules of the switches the person switched off taken out.
const withRulesSwitched = (entry, own, rules) => {
  if (!rules || !object(own)) return entry;
  const { list, off_in } = rules;
  if (!Array.isArray(entry?.[list])) return entry;
  return { ...entry, [list]: entry[list].filter(rule => !(object(rule) && switchedOff(own, off_in, entry.id, rule))) };
};

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
  const shipped = shippedFor(label);
  const { lists, on } = parts(shipped);
  if (!lists.some(([, entries]) => entries.length) && !on.length) return record ?? null;
  const own = object(record) ? record : {};
  const laid = { ...own };
  const rules = ruleSwitchOf(shipped);
  for (const [field, entries] of lists) {
    const owned = listOf(own[field]);
    const shownEntries = field === rules?.field ? entries.map(entry => withRulesSwitched(entry, own, rules)) : entries;
    const merged = [...shownEntries.filter(entry => !owned.some(one => object(one) && one.id === entry.id)), ...owned];
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
    // A shipped switch's on flag is read into its field; its switches of rules stay where the person keeps them.
    laid[off_in] = Object.fromEntries(Object.entries(own[off_in]).flatMap(([id, state]) => {
      if (!on.some(one => one.id === id && one.off_in === off_in)) return [[id, state]];
      const { on: _flag, ...rest } = object(state) ? state : {};
      return Object.keys(rest).length ? [[id, rest]] : [];
    }));
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
  const rules = ruleSwitchOf(shippedFor(label));
  // A shipped entry the person kept but whose rules they removed is unchanged: the removed rules are switches, not a copy.
  const unlessRulesRemoved = (shipped, entry) => (rules && rules.field && Array.isArray(entry?.[rules.list])
    ? { ...shipped, [rules.list]: listOf(shipped[rules.list]).filter(rule => entry[rules.list].some(one => object(one) && one.id === rule.id)) }
    : shipped);
  for (const [field, entries] of lists) {
    const kept = listOf(after[field]).filter(entry => {
      const shipped = entries.find(one => one.id === entry?.id);
      return !shipped || listOf(own[field]).some(one => object(one) && one.id === entry.id) || !same(entry, unlessRulesRemoved(shipped, entry));
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
    const { on: _flag, ...rest } = object(switches[id]) ? switches[id] : {};
    if (listOf(after[field]).includes(id)) { if (Object.keys(rest).length) switches[id] = rest; else delete switches[id]; }
    else switches[id] = { ...rest, on: false };
    if (Object.keys(switches).length) next[off_in] = switches;
    else delete next[off_in];
  }
  return next;
}
