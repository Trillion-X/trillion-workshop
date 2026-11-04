// src/list-relationships.mjs
//
// Purpose: how well a person knows someone, as columns of the row that is that someone (a person in a people list): the
// first, last and next interaction, how many there were, and a strength label. Each is worked out on every read from the
// records that name the row (a message mentioning them, an arrival they spoke in), read through the record store's own
// participation index (holdersOf, kept on every write), so it is never out of date, never kept and never typed: a
// relationship field is always derived, and a write naming it is refused like any computed field.
//
// Non-Negotiable Invariants:
//   1. Which records count as interactions, when each happened, what a field can show and the strength bands are DATA
//      (src/list-relationships.json); nothing here names a record type, a role or a label.
//   2. Bounded: one row reads at most `holders_read` naming records per source, one list read at most
//      `reads_per_list_read`; past either the row's relationship fields answer nothing rather than a partial value.
//   3. Only the rows being read are looked at, only for the relationship fields asked for.
//
//   relationshipFieldsOf(list, only) → the relationship fields a read works out
//   checkRelationships(fields) → throws on a relationship field naming no attribute row
//   relationshipReader(eeaf, { now }) → (rowRecordId, fields) → { [field id]: value }
//   relationshipViewed(field) → the field as a view compares it (the kind its attribute answers)
import data from './list-relationships.json' with { type: 'json' };
import lists from '../../keep-and-wake-ai-sessions-on-this-computer/src/lists.json' with { type: 'json' };
import { listSay as say } from './list-refusals.mjs';

const KEY = 'relationship';
const KINDS = new Map(lists.field_kinds.map(kind => [kind.id, kind]));
const ATTRIBUTES = new Map(data.attributes.map(row => [row.id, row]));
const DAY = 86_400_000;
const isRelationship = field => KINDS.get(field.kind)?.carries?.key === KEY;
const attributeOf = field => ATTRIBUTES.get(field?.[KEY]?.attribute);
const atOf = (value, names) => {
  for (const name of names) {
    const ms = typeof value?.[name] === 'string' ? Date.parse(value[name]) : NaN;
    if (Number.isFinite(ms)) return ms;
  }
  return null;
};

/** The relationship fields of a list a read works out (all of them, or those `only` names). */
export const relationshipFieldsOf = (list, only) => (list.fields ?? []).filter(field => isRelationship(field) && (!only || only.includes(field.id)));

/** Refuses a relationship field whose attribute is not a row of the DATA. */
export function checkRelationships(fields) {
  for (const field of fields) {
    if (isRelationship(field) && !attributeOf(field)) throw say('bad_relationship', { field_id: field.id, attributes: [...ATTRIBUTES.keys()].join(', ') });
  }
}

/** A relationship field as a view compares it: the field kind its attribute answers. */
export const relationshipViewed = field => (isRelationship(field) && attributeOf(field) && KINDS.has(attributeOf(field).answers) ? { ...field, kind: attributeOf(field).answers } : field);

// One attribute over a row's interactions ([{ at, kind }], at in ms), as of `now`.
function answer(attribute, interactions, now) {
  const counted = attribute.kinds ? interactions.filter(item => attribute.kinds.includes(item.kind)) : interactions;
  const past = counted.filter(item => item.at <= now).map(item => item.at).sort((a, b) => a - b);
  const future = counted.filter(item => item.at > now).map(item => item.at).sort((a, b) => a - b);
  const day = ms => (ms === undefined ? null : new Date(ms).toISOString());
  if (attribute.of === 'first') return day(past[0]);
  if (attribute.of === 'last') return day(past.at(-1));
  if (attribute.of === 'next') return day(future[0]);
  if (attribute.of === 'count') return past.length;
  if (attribute.of === 'strength') return data.strength.find(band => past.filter(at => at >= now - band.within_days * DAY).length >= band.min)?.label ?? null;
  return null;
}

/** A reader for one list read: each call answers one row's relationship fields from the records naming it, within the
 *  read's budget. A store with no participation index answers nothing. */
export function relationshipReader(eeaf, { now = Date.now() } = {}) {
  let budget = data.reads_per_list_read;
  const indexed = typeof eeaf.holdersOf === 'function';
  return (rowRecordId, fields) => {
    const nothing = Object.fromEntries(fields.map(field => [field.id, null]));
    if (!indexed || !fields.length) return nothing;
    const interactions = [];
    for (const source of data.sources) {
      const page = eeaf.holdersOf(rowRecordId, { role: source.role, limit: data.holders_read });
      const ids = [...new Set(page.holders.filter(holder => holder.type === source.type).map(holder => holder.id))];
      budget -= ids.length;
      if (page.next || page.complete === false || budget < 0) return nothing;
      const values = typeof eeaf.readMany === 'function' ? eeaf.readMany(ids) : new Map(ids.map(id => [id, eeaf.read(id)]));
      for (const id of ids) {
        const at = atOf(values.get(id), source.at);
        if (at !== null) interactions.push({ at, kind: source.kind });
      }
    }
    return Object.fromEntries(fields.map(field => [field.id, answer(attributeOf(field), interactions, now)]));
  };
}
