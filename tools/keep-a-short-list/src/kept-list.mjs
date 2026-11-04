// src/kept-list.mjs
//
// Purpose
//   A short list kept in the person's record store (notices every AI sees, what Trillion told the person) as one small
//   head record naming its items in order and one record per item. Adding an item writes that item and the head; it
//   never writes the whole list again. Kept whole, each addition rewrote every item, and the record history kept the
//   list twice per addition (the new value and the one it replaced), so one 50-item list wrote ~100 KB a time and the
//   kept history grew with the square of what was added (store-month guard, 2026-10-05).
//
// Non-negotiable invariants
//   1. items() is the list in its order, the same whichever way it was last kept: a head written by an earlier
//      version, holding the whole list as `items`, is read as it is and turned into item records on the next put.
//   2. put(next) writes only what changed: an item whose value differs or is new, a removal (value null) for an item
//      dropped, and the head when the order changed; the same list again writes nothing.
//   3. Items are told apart by their own `seq`; the caller keeps seq unique in a list.
//   4. Every record a list keeps carries the list's own type, so whatever leaves a type out (search, mentions) leaves
//      the whole list out.
//   5. items({ after }) reads the head and only the item records whose seq is past `after`: a device asking for what is
//      new since the last seq it saw reads one record when nothing is new (2026-10-07: the Mac app asked for its notices
//      2.5 times a second on the busiest account and each ask read all 200 kept notices).
//
// Key concepts
//   head   record `<id>` of the list's type: { seqs: [seq, ...] }
//   item   record `<id>:<seq>` of the list's type: { item }
//

const same = (left, right) => JSON.stringify(left) === JSON.stringify(right);

/**
 * eeaf: the record store ({ read(id), write(envelopes, options) }); read: how records are read (a caching reader of
 * the same store, say), eeaf.read when left out. indexFields names item fields whose value counts are kept in the head.
 */
export function keptList(eeaf, { id, type, read = recordId => eeaf.read(recordId), indexFields = [] }) {
  const itemId = seq => `${id}:${seq}`;
  const indexed = [...new Set(indexFields.filter(field => typeof field === 'string' && field.length))];
  const head = () => read(id) ?? {};
  // The list in its order; with `after`, only the items whose seq is past it, read from the head and those items alone
  // (invariant 5), so a reader that keeps the last seq it saw reads nothing more when nothing was added.
  function items({ after = null } = {}) {
    const kept = head();
    const past = item => after === null || item.seq > after;
    if (Array.isArray(kept.items)) return kept.items.filter(past);
    return (kept.seqs ?? []).filter(seq => after === null || seq > after).map(seq => read(itemId(seq))?.item).filter(Boolean);
  }
  // A declared field can be tested from the head alone. Older heads have no count rows, so discover just far enough
  // to answer the question; the next put upgrades their summary along with the ordinary list representation.
  function hasValue(field, value) {
    const kept = head();
    if (Array.isArray(kept.items)) return kept.items.some(item => item?.[field] === value);
    if (kept.indexed_fields?.includes(field) && Array.isArray(kept.field_counts)) {
      return kept.field_counts.some(row => row.field === field && row.value === value && row.count > 0);
    }
    for (const seq of kept.seqs ?? []) if (read(itemId(seq))?.item?.[field] === value) return true;
    return false;
  }
  return {
    items,
    hasValue,
    /** The seq of the newest item, read from the head alone. */
    lastSeq() {
      const kept = head();
      return Array.isArray(kept.items) ? kept.items.at(-1)?.seq ?? null : kept.seqs?.at(-1) ?? null;
    },
    /** Keeps `next` as the whole list, writing only what changed (invariant 2). */
    put(next, options) {
      const kept = head();
      const whole = Array.isArray(kept.items);
      const before = new Map(items().map(item => [item.seq, item]));
      const envelopes = [];
      for (const item of next) {
        if (whole || !before.has(item.seq) || !same(before.get(item.seq), item)) envelopes.push({ id: itemId(item.seq), type, value: { item } });
      }
      const seqs = next.map(item => item.seq);
      const wanted = new Set(seqs);
      for (const seq of before.keys()) if (!wanted.has(seq) && !whole) envelopes.push({ id: itemId(seq), type, value: null });
      const fieldCounts = indexed.flatMap(field => {
        const counts = new Map();
        for (const item of next) {
          const value = item?.[field];
          if (value !== undefined) counts.set(value, (counts.get(value) ?? 0) + 1);
        }
        return [...counts].map(([value, count]) => ({ field, value, count }));
      });
      const summaryChanged = indexed.length > 0 && (!same(kept.indexed_fields ?? [], indexed)
        || !same(kept.field_counts ?? [], fieldCounts));
      if (whole || !same(kept.seqs ?? [], seqs) || summaryChanged) {
        envelopes.push({ id, type, value: { seqs, ...(indexed.length ? { indexed_fields: indexed, field_counts: fieldCounts } : {}) } });
      }
      if (envelopes.length) eeaf.write(envelopes, options);
      return { written: envelopes.length };
    },
  };
}
