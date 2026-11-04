// src/let-go-of-table.mjs
//
// PURPOSE
//   Lets a table go from a person's store a bounded piece per call, for every owner that ends a table: the record
//   history's sealed log generations (src/record-history.mjs), the decomposed tables after a store moved to records
//   (src/record-move.mjs) and the tables whose rows moved into records (src/tables-into-records.mjs). One DROP TABLE
//   frees every page a table holds at once; a table of a million rows ran past the time a Durable Object storage
//   operation may take, so the store was reset, the drop rolled back, and the next wake tried the same drop again
//   (Sam's store, 2026-10-05 from 19:55Z: every call answered with a reset).
//
// NON-NEGOTIABLE INVARIANTS
//   1. One call does one bounded piece: drop one of the table's own indexes, or delete one batch of rows, or answer
//      that the table is now small enough for its owner to drop. The owner drops it, so its own bookkeeping (the
//      sealed log's kept place, the move's state) changes in the same transaction as the drop.
//   2. Indexes go first: a deleted row then writes only itself, never an index entry.
//   3. Rows are deleted only while the table spans more than drop_rows rowids (rowid span: read from the rowid index,
//      never a count of the table; gaps only overstate it). Below that the drop is cheap and writes no row, so a small
//      table is never paid for row by row.
//   4. Sizes are DATA (src/let-go-of-table.json).
//
// Shape
//   letGoStep(sql, table, settings?) -> 'index' | 'rows' | 'drop'   ('drop': the owner may drop the table now)
//
import defaults from '../../keep-and-wake-ai-sessions-on-this-computer/src/let-go-of-table.json' with { type: 'json' };

// Rows one 'rows' piece deletes at most, for an owner that paces its pieces by the rows they write.
export const LET_GO_ROWS = defaults.delete_rows;
const quoted = name => `"${String(name).replace(/"/g, '""')}"`;
// How many rowids a table spans, from two seeks on its rowid. MAX(rowid) - MIN(rowid) in one statement is not a seek:
// SQLite answers a lone MIN or MAX from the index end, but both in one expression walk every row, which on a table of
// millions of rows was a whole-table read on every let-go call.
export function spanOf(sql, table) {
  const lo = sql.exec(`SELECT MIN(rowid) AS n FROM ${quoted(table)}`).toArray()[0]?.n;
  if (lo === null || lo === undefined) return 0;
  const hi = sql.exec(`SELECT MAX(rowid) AS n FROM ${quoted(table)}`).toArray()[0]?.n;
  return hi - lo + 1;
}

export function letGoStep(sql, table, settings = defaults) {
  const index = sql.exec("SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = ? AND sql IS NOT NULL LIMIT 1", table).toArray()[0]?.name;
  if (index) {
    sql.exec(`DROP INDEX ${quoted(index)}`);
    return 'index';
  }
  const span = spanOf(sql, table);
  if (span > settings.drop_rows) {
    sql.exec(`DELETE FROM ${quoted(table)} WHERE rowid IN (SELECT rowid FROM ${quoted(table)} ORDER BY rowid LIMIT ?)`, settings.delete_rows).toArray();
    return 'rows';
  }
  return 'drop';
}
