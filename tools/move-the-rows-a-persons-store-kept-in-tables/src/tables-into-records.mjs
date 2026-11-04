// src/tables-into-records.mjs
//
// Purpose: moves rows a person's store kept in tables of their own into records of the record store (parts/record-log),
// once the store is on the log engine: the rows a caller needs at once on its first call, then the rest a batch at a
// time from the store's scheduler, then the table is dropped (a dropped table writes no row). A row whose record a
// newer write already made is left as that write made it.
//
// NON-NEGOTIABLE INVARIANTS
//   1. Nothing here names a table, a kind of record or a question: each owner hands in its own rows
//      ({ table, first, recordOf }) and the record store's own load/loadDone bring them in without a log row each.
//   2. A record that already exists is never replaced: what the store wrote since it moved is newer than any table row.
//   3. Progress is kept as one record per table (id: 'table-move:' and the table's name; src/agent-legacy-rows.mjs
//      reads it as the line between moved and unmoved rows). It is written only in the transaction that writes out
//      what was brought in up to it: rows are written out when the memtable is full or a phase ends, never once per
//      batch (a write-out per batch made a run per batch; with merges held, one busy store reached 126 runs on
//      2026-10-05 and every read walked them all). Between write-outs the places ahead are held in memory; a reset
//      loses only what was brought in since the last write-out, and the next step brings it in again.
//   4. A partial `first` move is never presented as a complete record store. Until every first row has arrived, the
//      owner reads its earlier tables and mirrors new writes into records; it switches reads only when firstReady().
//
// Shapes
//   tablesIntoRecords({ sql, records, transaction, tables, batch }) -> {
//     start()     brings in at most one bounded page of `first` rows, once per store lifetime; returns firstReady()
//     firstReady() whether every table's `first` rows are available as records
//     step()      brings in one `first` page until they are all ready, then one historical batch, then lets the table
//                 go a bounded piece at a time (an index, a batch of rows, then the empty table);
//                 -> { table, moved, dropped }
//     placeOf(table) where that table's move has reached (in memory, ahead of its record until the next write-out)
//     nextAt()    now while a table is left, else null (the scheduler source's due time)
//   }
//

import { letGoStep } from './let-go-of-table.mjs';

const PLACE = 'table-move';
const ACTOR = { actor: { by: 'trillion' } };
const FIRST_PAGE = 64;
// Rowids one first step looks at: their small columns only, no row value read. At 512 a 195,000-row delivery table
// took 380 wakes to find its waiting rows, and until it had, every read of the agents walked the old table too (a busy
// store, 2026-10-06: 56,000 rows read for each events pull).
export const FIRST_SCAN = 16384;
const PAGE_BYTES = 1024 * 1024;
// Records brought in sort before anything the store writes itself and after what the move from the decomposed tables
// brought in ('00', src/record-move.mjs): '01', the table's place in the list, then the row's own rowid.
const seqOf = (tableIndex, rowid) => `01${tableIndex.toString(16).padStart(2, '0')}${rowid.toString(16).padStart(13, '0')}00`;

export function tablesIntoRecords({ sql, records, transaction = fn => fn(), tables, batch = 2000, now = () => Date.now() }) {
  if (!Number.isSafeInteger(batch) || batch < 1) throw new RangeError('The table move needs a positive row limit.');
  const present = new Map();
  const exists = table => {
    if (!present.has(table)) present.set(table, sql.exec("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?", table).toArray().length > 0);
    return present.get(table);
  };
  // Rows are brought in by the log engine itself (the person's record store answers load only through it).
  const into = () => (typeof records.logStore === 'function' ? records.logStore() : records);
  // Every table's place: where its first rows and its other rows have reached. `places` runs ahead of the records while
  // what was brought in waits in the memtable; the records are written with each write-out.
  const placeId = table => `${PLACE}:${table}`;
  let places = null;
  const placesNow = () => (places ??= Object.fromEntries(tables.map(owner => [owner.table, records.read(placeId(owner.table)) ?? {}])));
  const placeOf = table => placesNow()[table] ?? {};
  const withPlace = (table, place) => ({ ...placesNow(), [table]: { ...placeOf(table), ...place } });
  const keepPlaces = next => {
    const changed = tables.filter(owner => next[owner.table] && JSON.stringify(next[owner.table]) !== JSON.stringify(records.read(placeId(owner.table))));
    if (changed.length) records.write(changed.map(owner => ({ id: placeId(owner.table), type: PLACE, value: next[owner.table] })), ACTOR);
  };
  // Each bring-in names its progress; the store records it only with a write-out, so seeing it back means this load
  // wrote out, and the places reached so far are kept in the same transaction.
  let mark = 0;
  const bringIn = (index, rows, next) => {
    const owner = tables[index];
    const fresh = rows.map(row => ({ ...owner.recordOf(row), seq: seqOf(index, row.rowid) })).filter(record => records.typeOf(record.id) === null);
    const progress = { table_move: `${now()}:${mark += 1}` };
    into().load(fresh, progress);
    if (into().loadProgress?.()?.table_move === progress.table_move) keepPlaces(next);
    places = next;
    return fresh.length;
  };
  // A phase ends: everything brought in is written out now, with the places.
  const settle = next => { into().loadDone({ table_move: `${now()}:${mark += 1}` }); keepPlaces(next); places = next; };
  // A transaction that rolls back takes back what it brought in, so the places are read again from what is written.
  const inTransaction = work => { try { return transaction(work); } catch (error) { places = null; throw error; } };
  // A first set may contain thousands of large open jobs. SQLite's cursor streams them; only one bounded page is
  // converted to records per call, and its place is committed with that page so a reset resumes there.
  const page = (owner, where, params, limit) => {
    const rows = [];
    let bytes = 0;
    for (const row of sql.exec(`SELECT rowid, * FROM ${owner.table} WHERE ${where} ORDER BY rowid LIMIT ?`, ...params, limit)) {
      const size = Object.values(row).reduce((sum, value) => sum + (typeof value === 'string' ? value.length * 2 : 16), 0);
      if (rows.length && bytes + size > PAGE_BYTES) break;
      rows.push(row);
      bytes += size;
    }
    return rows;
  };
  // A moved table is let go a bounded piece per step (src/let-go-of-table.mjs), then dropped with its place recorded.
  const letGo = owner => {
    if (!placeOf(owner.table).moved) inTransaction(() => settle(withPlace(owner.table, { moved: true })));
    const piece = letGoStep(sql, owner.table);
    if (piece !== 'drop') return { table: owner.table, moved: 0, dropped: false, let_go: piece };
    transaction(() => sql.exec(`DROP TABLE ${owner.table}`));
    present.set(owner.table, false);
    return { table: owner.table, moved: 0, dropped: true };
  };
  let started = false;
  const firstReady = () => tables.every(owner => !exists(owner.table) || placeOf(owner.table)?.first_done === true);
  const firstStep = () => {
    const index = tables.findIndex(owner => exists(owner.table) && placeOf(owner.table)?.first_done !== true);
    if (index === -1) return { table: null, moved: 0, first: true };
    const owner = tables[index];
    const place = placeOf(owner.table);
    // Walk a fixed rowid window first. A selective first predicate without an index otherwise scans an unlimited
    // finished prefix just to return one open row, even though the returned page is only 64 rows. The walk stops once
    // it holds a page of first rows: where they lie close together (thousands of deliveries still waiting), reading
    // the rest of the window only to move the same page cost 16,384 rows a step on a busy store.
    const wanted = Math.min(batch, FIRST_PAGE);
    const inspected = [];
    const selected = [];
    for (const row of sql.exec(`SELECT rowid, CASE WHEN ${owner.first} THEN 1 ELSE 0 END AS first_row FROM ${owner.table} WHERE rowid > ? ORDER BY rowid LIMIT ?`, place.first_after ?? 0, FIRST_SCAN)) {
      inspected.push(row);
      if (row.first_row && selected.push(row) === wanted) break;
    }
    if (!inspected.length) {
      inTransaction(() => settle(withPlace(owner.table, { first_done: true })));
      return { table: owner.table, moved: 0, first: true };
    }
    const rows = selected.length
      ? page(owner, `rowid IN (${selected.map(() => '?').join(', ')})`, selected.map(row => row.rowid), selected.length)
      : [];
    const after = rows.length === selected.length && selected.length < wanted
      ? inspected.at(-1).rowid : rows.at(-1)?.rowid ?? inspected.at(-1).rowid;
    const moved = inTransaction(() => bringIn(index, rows, withPlace(owner.table, { first_after: after })));
    return { table: owner.table, moved, first: true };
  };

  return {
    start() {
      if (started) return firstReady();
      started = true;
      if (!firstReady()) firstStep();
      return firstReady();
    },
    firstReady,
    step() {
      if (!firstReady()) return firstStep();
      const index = tables.findIndex(owner => exists(owner.table));
      if (index === -1) return { table: null, moved: 0, dropped: false };
      const owner = tables[index];
      const place = placeOf(owner.table);
      const rows = place.moved ? [] : page(owner, 'rowid > ?', [place.after ?? 0], batch);
      if (!rows.length) return letGo(owner);
      const moved = inTransaction(() => bringIn(index, rows, withPlace(owner.table, { after: rows.at(-1).rowid })));
      return { table: owner.table, moved, dropped: false };
    },
    firstDone: table => !exists(table) || placeOf(table)?.first_done === true,
    /** Where a table's move has reached in this store's memory (ahead of its record until the next write-out). */
    placeOf,
    nextAt: () => (tables.some(owner => exists(owner.table)) ? now() : null),
  };
}
