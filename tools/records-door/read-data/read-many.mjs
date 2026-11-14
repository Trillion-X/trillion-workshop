// tools/records-door/read-data/read-many.mjs
//
// Purpose
//   The values of many records of one kind, by id, in as few door calls as the store allows, however many ids are asked
//   and however large the store is. A caller that must learn which of its keys the person already keeps (a document's
//   piece rows, a batch of rows to merge over) calls this instead of one `records:read` per key.
//
// Non-negotiable invariants
//   1. The answer is one value (or null, when absent) for each distinct id asked, the same as `door.read(type, id)` gives.
//   2. Two ways to learn them, and each run takes the cheaper as its own pages show, never one for good:
//      - by page: the door lists ids greatest first (`listPages`, one page one call), so a page that ends at id X settles
//        every asked id at or above X, present (its value is in the page) or absent (it is not); a last page settles
//        every id left.
//      - by key: one `records:read` each, `at_once` at a time, so a round of reads settles `at_once` ids in the time of
//        one call.
//      A page is kept going only while it settles at least `at_once` asked ids: below that a round of reads settles as
//      many in the same time, so the ids left are read by key. The number is not chosen here: it is the width of a round
//      of reads, the caller's `at_once`.
//   3. Door calls are at most the pages that settled `at_once` ids or more, plus one page that did not, plus one read per
//      id left: never more than the ids asked plus one, and one call for any number of ids when the store holds no row
//      among them. A small ask pays at most one page more than the reads it needs; a large ask on a large store pays
//      pages, never one read per id.
//   4. Only the ids asked are returned and held; the pages are folded in as they come and let go.
//
// Shapes
//   readMany(door, ids, { type, at_once, prefix? }) -> { values: Map(id -> value | null), pages, reads }
//     door: { listPages(query), read(type, id) } (tools/records-door openRecordsDoor)
//     prefix: the id prefix the door lists under (a run's right to list names one); default the longest prefix every id
//       shares, which keeps the range as narrow as the ids allow.

// `work` over every item, `at_once` at a time, answers in order.
async function each(items, atOnce, work) {
  const out = new Array(items.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(atOnce, items.length) }, async () => {
    while (next < items.length) { const at = next++; out[at] = await work(items[at]); }
  }));
  return out;
}

// The longest prefix every id shares.
function commonPrefix(ids) {
  let prefix = ids[0];
  for (const id of ids) {
    let at = 0;
    while (at < prefix.length && at < id.length && prefix[at] === id[at]) at += 1;
    prefix = prefix.slice(0, at);
  }
  return prefix;
}

export async function readMany(door, ids, { type, at_once: atOnce, prefix } = {}) {
  if (typeof type !== 'string' || !Number.isInteger(atOnce) || atOnce < 1) throw new TypeError('readMany needs a record type and at_once, a positive whole number.');
  const values = new Map();
  // Greatest first, the order the door lists in.
  const pending = [...new Set(ids)].sort().reverse();
  const stats = { values, pages: 0, reads: 0 };
  if (!pending.length) return stats;
  const asked = new Set(pending);
  let settled = 0;
  const settle = to => { for (; settled < to; settled += 1) if (!values.has(pending[settled])) values.set(pending[settled], null); };
  // The range of the asked ids: above the least id's own start (its last character cut, so the least id is inside), below
  // the greatest id's end (a character after every id's).
  const least = pending.at(-1), greatest = pending[0];
  const query = { type, prefix: prefix ?? commonPrefix(pending), above: least.slice(0, -1), below: `${greatest}\uffff` };
  for await (const { records, next } of door.listPages(query)) {
    stats.pages += 1;
    for (const record of records) if (asked.has(record.id)) values.set(record.id, record.value ?? null);
    // A page that is the last settles every id left; another settles those at or above its own last id.
    const end = records.at(-1)?.id;
    const before = settled;
    if (next === null) settle(pending.length);
    else if (end !== undefined) { let to = settled; while (to < pending.length && pending[to] >= end) to += 1; settle(to); }
    if (settled === pending.length || settled - before < atOnce) break;
  }
  const left = pending.slice(settled);
  stats.reads = left.length;
  const read = await each(left, atOnce, id => door.read(type, id));
  left.forEach((id, at) => values.set(id, read[at] ?? null));
  return stats;
}
