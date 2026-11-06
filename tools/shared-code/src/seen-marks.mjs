import { tableGeneration } from '../../keep-and-wake-ai-sessions-on-this-computer/src/table-generation.mjs';
// src/seen-marks.mjs
//
// PURPOSE
//   When a reader last saw a place: one mark per (place, reader), the one thing every "what is new to you" count reads.
//   A space's unread (src/spaces.mjs, src/community-activity.mjs) and a person's new work on each screen
//   (src/new-work.mjs) are both "what arrived after this reader's mark on this computer"; they differ only in what they
//   count, never in how the mark is kept.
//
// NON-NEGOTIABLE INVARIANTS
//   1. One row per place and reader; marking again replaces it. A place never marked reads null, and each owner says
//      what null means for it (everything, or a recent window).
//   2. The table and its column names are the owner's (a store that already kept marks keeps its table and its rows);
//      this file holds the only SQL that reads or writes a mark.
//   3. A mark is an ISO time, compared as text with the times of what it counts.
//   4. A mark moves forward only (`advance`): replaying an old "seen through here" never makes seen things new again. It
//      moves back only by `mark`, which the owner calls for an explicit mark-unread anchored one tick below an item.

const READY = new WeakMap();

/** The marks kept in `table`, keyed by its `place` and `reader` columns, created when missing. */
export function seenMarks(sql, { table, place, reader }) {
  let tables = READY.get(sql);
  if (tables?.generation !== tableGeneration(sql)) READY.set(sql, tables = { generation: tableGeneration(sql), made: new Set() });
  if (!tables.made.has(table)) {
    sql.exec(`CREATE TABLE IF NOT EXISTS ${table} (${place} TEXT NOT NULL, ${reader} TEXT NOT NULL, seen_at TEXT NOT NULL, PRIMARY KEY (${place}, ${reader}))`);
    tables.made.add(table);
  }
  return {
    /** When `who` last saw `where`, or null. */
    seenAt(where, who) {
      return sql.exec(`SELECT seen_at FROM ${table} WHERE ${place} = ? AND ${reader} = ?`, where, who).toArray()[0]?.seen_at ?? null;
    },
    /** Every place `who` has a mark on: { place: seen_at }. */
    marksOf(who) {
      return Object.fromEntries(sql.exec(`SELECT ${place} AS place, seen_at FROM ${table} WHERE ${reader} = ?`, who).toArray().map(row => [row.place, row.seen_at]));
    },
    /** Only the named places for this reader, using the (place, reader) primary key. */
    marksFor(who, places) {
      const wanted = [...new Set((places ?? []).filter(value => typeof value === 'string' && value))];
      const found = [];
      for (let start = 0; start < wanted.length; start += 100) {
        const rows = sql.exec(`SELECT ${place} AS place, seen_at FROM ${table} WHERE ${place} IN (SELECT value FROM json_each(?)) AND ${reader} = ?`, JSON.stringify(wanted.slice(start, start + 100)), who).toArray();
        for (const row of rows) found.push([row.place, row.seen_at]);
      }
      return Object.fromEntries(found);
    },
    /** `who` has now seen `where` as of `at`; returns `at`. */
    mark(where, who, at) {
      sql.exec(`INSERT INTO ${table} (${place}, ${reader}, seen_at) VALUES (?, ?, ?) ON CONFLICT(${place}, ${reader}) DO UPDATE SET seen_at = excluded.seen_at`, where, who, at);
      return at;
    },
    /** `who` has seen `where` through `at`, forward only: an older time than the mark leaves it; returns the mark now kept. */
    advance(where, who, at) {
      sql.exec(`INSERT INTO ${table} (${place}, ${reader}, seen_at) VALUES (?, ?, ?) ON CONFLICT(${place}, ${reader}) DO UPDATE SET seen_at = MAX(seen_at, excluded.seen_at)`, where, who, at);
      return sql.exec(`SELECT seen_at FROM ${table} WHERE ${place} = ? AND ${reader} = ?`, where, who).toArray()[0].seen_at;
    },
    /** `who` has not seen `where` after all: its mark is gone, and it reads null again. */
    forget(where, who) {
      sql.exec(`DELETE FROM ${table} WHERE ${place} = ? AND ${reader} = ?`, where, who);
    },
  };
}
