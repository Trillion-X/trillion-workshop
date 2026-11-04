// src/live-keys.mjs
//
// Purpose: each screen revision says WHAT changed, as record ids, never as values. An open page compares the ids (and
// the fields written) with what each of its screens last read (src/record-depends.mjs) and reads again only the screens
// a change touches, instead of every screen on every write (src/workspace/store-changes.ts). The ids come from the
// record store's own change journal (src/record-engine.mjs changedSince), which every writer of the database goes
// through, so a writer that never says what it wrote is still named. Which fields a write set is told by the writers
// that know (the lists owner, src/lists.mjs); a record no one described is told with its fields unknown.
//
// Non-Negotiable Invariants:
//   1. Never fewer: every root record the journal saw written since the last revision is named. When the journal cannot
//      say (a rolled-back transaction, past what it keeps, a store without one) or names more than `most_records`, the
//      revision names nothing and every screen reads again as before.
//   2. Fields are told only when they are the whole truth: a record written again after its fields were noted (by any
//      writer, or a rollback) is told with fields null.
//   3. Fields are noted only for a store whose revisions are described (a describer is attached), and at most
//      `most_noted` between two revisions, so nothing grows in a store no screen watches.
//   4. Ids and field ids only: no value ever leaves in a frame.
//   5. A table a screen draws from outside the records (live-keys.json `tables`) is named by its key whenever the store's
//      write count for it moved (`tableRevision`, src/sql-writes.mjs revision), never only when it is sure.

import settings from './live-keys.json' with { type: 'json' };

// The stores whose revisions are described: the fields their writes set since the last revision, by record id.
const notedOf = new WeakMap();

const sameValue = (a, b) => a === b || JSON.stringify(a ?? null) === JSON.stringify(b ?? null);

/** The fields a write changes on one record, or null when the record is made or removed (every field changes). */
export function fieldsWritten(before, after) {
  if (!before || !after || typeof before !== 'object' || typeof after !== 'object') return null;
  return [...new Set([...Object.keys(before), ...Object.keys(after)])].filter(field => !sameValue(before[field], after[field]));
}

/** Before a write of `records` ({ id, value }): works out their written fields and answers the call to make once the
 *  write is kept (it notes them as of that moment), or null when no describer watches this store (invariant 3). */
export function noteRecordsWriting(eeaf, records) {
  const noted = notedOf.get(eeaf);
  if (!noted) return null;
  const written = records.map(record => ({ id: record.id, fields: fieldsWritten(eeaf.read(record.id), record.value) }));
  return () => {
    const at = eeaf.changeSeq();
    for (const { id, fields } of written) {
      if (!noted.has(id) && noted.size >= settings.most_noted) continue;
      const earlier = noted.get(id);
      noted.set(id, { at, fields: earlier && earlier.fields !== null && fields !== null ? [...new Set([...earlier.fields, ...fields])] : earlier ? null : fields });
    }
  };
}

/** The describer a live screen asks at each revision (src/live-screen.mjs describe): `{ at, version, records }`, or null
 *  when it cannot name every change (invariant 1). `eeafOf()` answers the store's records, or null while it is not open. */
export function recordChangeDescriber(eeafOf, { tableRevision = null, now = () => new Date().toISOString() } = {}) {
  let watched = null;
  let since = null;
  // Each named table's write count as of the last revision (invariant 5).
  const tablesSeen = new Map();
  const tablesChanged = () => {
    if (!tableRevision) return [];
    const changed = [];
    for (const { table, key } of settings.tables) {
      const count = tableRevision([table]);
      if (tablesSeen.has(table) && tablesSeen.get(table) !== count) changed.push({ id: key, fields: null });
      tablesSeen.set(table, count);
    }
    return changed;
  };
  return () => {
    const eeaf = eeafOf();
    if (!eeaf || typeof eeaf.changeSeq !== 'function' || typeof eeaf.changedSince !== 'function' || typeof eeaf.changedAfter !== 'function') return null;
    // A store opened anew (made again after deleting everything) starts describing from here.
    if (eeaf !== watched) { watched = eeaf; since = null; notedOf.set(eeaf, new Map()); }
    const seq = eeaf.changeSeq();
    const ids = since === null ? null : eeaf.changedSince(since);
    since = seq;
    const noted = notedOf.get(eeaf);
    notedOf.set(eeaf, new Map());
    const tables = tablesChanged();
    if (!ids || ids.length > settings.most_records) return null;
    return {
      at: now(),
      version: eeaf.lastLogId?.() ?? null,
      records: [...ids.map(id => {
        const note = noted.get(id);
        return { id, fields: note && !eeaf.changedAfter(id, note.at) ? note.fields : null };
      }), ...tables],
    };
  };
}
