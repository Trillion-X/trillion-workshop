// src/list-pairs.mjs
//
// Purpose: one relationship seen from both sides. A person's `company` and a company's `employees` are two link fields
// that each name the other (`pairs_with`); a write to either side changes the other in the same write, so the two can
// never disagree, and "who works at Acme" is read off the company row instead of searched for. A list whose entries
// point at a parent through a required link (a pipeline of deals over companies) and the parent's `entries` field are
// the same pair. Built for src/lists.mjs: save asks checkPairs, putRows asks pairWrites.
//
// Non-Negotiable Invariants:
//   1. A pair is two link fields, each on the list the other links to, each naming the other. Saving one whose partner
//      names nothing yet names it back in the same write; a partner that names another field is refused (`bad_pair`),
//      and unpairing a field clears its partner's pointer. A field may pair with itself on its own list (a symmetric
//      link: two people who know each other).
//   2. One-to-one, one-to-many and many-to-many are never stored: each side keeps its own max_links, checked on the rows
//      the pair changes as on the rows written, and a change the other side cannot hold is refused (`link_too_many`).
//   3. The other side is worked out from what the write changed (rows added to or taken from a link, and rows removed),
//      never by reading the lists: a write costs the links it changes.
//   4. Both lists of a pair are kept in the same store; a partner kept elsewhere is refused when the pair is made. A
//      pair whose lists keep their ROWS in different stores of the account (src/placed-lists.mjs) is not written here:
//      `keptApart` leaves it out, and placed-lists writes the other side as a second write after an intent row.
//
import data from '../../keep-and-wake-ai-sessions-on-this-computer/src/lists.json' with { type: 'json' };
import { listSay as say } from './list-refusals.mjs';

const KINDS = new Map(data.field_kinds.map(kind => [kind.id, kind]));
const isLink = field => Boolean(field && KINDS.get(field.kind)?.links);
const idsOf = value => (Array.isArray(value) ? value : typeof value === 'string' && value ? [value] : []).filter(item => typeof item === 'string' && item);

/**
 * The pair pointers of a list being saved. `fields` are the checked fields; `before` the fields it held; `listOf(slug)`
 * the kept definition of another list (null when this store keeps none). Answers the fields (pointers checked) and the
 * other lists whose partner field gains or loses its pointer: [{ id, list }] to write with the list.
 */
export function checkPairs(slug, fields, before, listOf) {
  const partners = new Map();
  const definitionOf = target => {
    if (target === slug) return { id: slug, fields };
    if (!partners.has(target)) {
      const kept = listOf(target);
      partners.set(target, kept ? { id: target, ...kept, fields: kept.fields.map(field => ({ ...field })) } : null);
    }
    return partners.get(target);
  };
  const refuse = (field, partner) => say('bad_pair', { field_id: field.id, links_to: field.links_to, pairs_with: JSON.stringify(partner ?? field.pairs_with) });
  // A field that paired before and pairs no more (or is gone) lets its partner on another list go too; on its own list
  // the fields given are the whole truth.
  for (const old of before ?? []) {
    if (old.pairs_with === undefined || old.links_to === slug) continue;
    const now = fields.find(field => field.id === old.id);
    if (now?.pairs_with === old.pairs_with && now.links_to === old.links_to) continue;
    const partner = definitionOf(old.links_to)?.fields.find(item => item.id === old.pairs_with);
    if (partner?.pairs_with === old.id) delete partner.pairs_with;
  }
  for (const field of fields) {
    if (field.pairs_with === undefined) continue;
    const target = definitionOf(field.links_to);
    if (!isLink(field) || !target) throw refuse(field);
    const partner = target.fields.find(item => item.id === field.pairs_with);
    if (!isLink(partner) || partner.links_to !== slug) throw refuse(field);
    if (partner.pairs_with === undefined) partner.pairs_with = field.id;
    else if (partner.pairs_with !== field.id) throw refuse(field, partner.pairs_with);
  }
  return [...partners.values()].filter(Boolean).filter(list => {
    const kept = listOf(list.id);
    return JSON.stringify(kept.fields) !== JSON.stringify(list.fields);
  }).map(({ id, ...list }) => ({ id, list }));
}

/**
 * The other side of every paired link a write changes. `list` and `slug` are the list written; `rows` the written rows
 * as { recordId, rowId, before, after } (after null for a removed row); `read(recordId)` a point read of the store;
 * `listOf(slug)` a kept definition; `prefixOf(list)` a list's row record prefix; `touch(list, value, field_id, before)` what else a
 * changed row keeps (its stamps, its field's history), given the row as it was. `keptApart(field)` is true for a pair
 * whose other list keeps its rows in another store: this write cannot reach those rows, and src/placed-lists.mjs keeps that
 * pair whole as two writes with an intent row between them. Answers { same: Map(recordId -> value),
 * others: [{ slug, list, records }] }: rows of this list to write with the caller's rows, and other lists' rows.
 */
export function pairWrites({ list, slug, rows, read, listOf, prefixOf, touch = (_list, value) => value, keptApart = () => false }) {
  const paired = list.fields.filter(field => isLink(field) && field.pairs_with !== undefined && !keptApart(field));
  if (!paired.length) return { same: new Map(), others: [] };
  // target record id -> { list, field, add: Set, drop: Set }
  const changes = new Map();
  const note = (targetList, targetSlug, field, targetRowId, holderRowId, adding) => {
    const recordId = `${prefixOf(targetList)}${targetRowId}`;
    const key = `${recordId}\u0000${field.id}`;
    if (!changes.has(key)) changes.set(key, { recordId, slug: targetSlug, list: targetList, field, add: new Set(), drop: new Set() });
    const change = changes.get(key);
    (adding ? change.add : change.drop).add(holderRowId);
    (adding ? change.drop : change.add).delete(holderRowId);
  };
  for (const field of paired) {
    const targetList = field.links_to === slug ? list : listOf(field.links_to);
    if (!targetList) throw say('bad_pair', { field_id: field.id, links_to: field.links_to, pairs_with: JSON.stringify(field.pairs_with) });
    const partner = targetList.fields.find(item => item.id === field.pairs_with);
    if (!isLink(partner)) throw say('bad_pair', { field_id: field.id, links_to: field.links_to, pairs_with: JSON.stringify(field.pairs_with) });
    for (const row of rows) {
      const before = new Set(idsOf(row.before?.[field.id]));
      const after = new Set(row.after ? idsOf(row.after[field.id]) : []);
      for (const target of after) if (!before.has(target)) note(targetList, field.links_to, partner, target, row.rowId, true);
      for (const target of before) if (!after.has(target)) note(targetList, field.links_to, partner, target, row.rowId, false);
    }
  }
  const written = new Map(rows.map(row => [row.recordId, row]));
  const same = new Map();
  const others = new Map();
  for (const change of changes.values()) {
    const own = change.slug === slug;
    const inBatch = own ? written.get(change.recordId) : null;
    if (inBatch && !inBatch.after) continue; // the row on the other side goes in this same write
    const pending = own ? same.get(change.recordId) : others.get(change.slug)?.records.get(change.recordId);
    const current = pending ?? (inBatch ? inBatch.after : read(change.recordId));
    if (!current) continue; // a link to a row that is not kept has no other side to change
    const held = idsOf(current[change.field.id]);
    const next = [...held.filter(item => !change.drop.has(item)), ...[...change.add].filter(item => !held.includes(item))];
    if (next.length === held.length && next.every((item, index) => item === held[index])) continue;
    const max = change.field.link_constraints?.max_links;
    if (max !== undefined && next.length > max) throw say('link_too_many', { row_id: change.recordId.slice(prefixOf(change.list).length), field_id: change.field.id, limit: max });
    let value = { ...current };
    if (next.length) value[change.field.id] = next; else delete value[change.field.id];
    value = touch(change.list, value, change.field.id, current);
    if (own) same.set(change.recordId, value);
    else {
      if (!others.has(change.slug)) others.set(change.slug, { slug: change.slug, list: change.list, records: new Map() });
      others.get(change.slug).records.set(change.recordId, value);
    }
  }
  return { same, others: [...others.values()].map(entry => ({ slug: entry.slug, list: entry.list, records: [...entry.records].map(([id, value]) => ({ id, type: `record:${entry.list.row_type}`, value })) })) };
}
