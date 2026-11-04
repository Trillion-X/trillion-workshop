// src/carry-tables-into-records.mjs
//
// PURPOSE
//   Moves a person's lasting facts out of a side table of their Durable Object and into their EEAF records, once, the
//   first time their store opens after the reader moved. Each owner that used to keep something in its own table
//   exports a carrier ({ table, carry(rows) }); the person's store runs every carrier at start. A carrier writes what
//   each row meant as EEAF records, reads them back and throws when they differ; only then is the table dropped, in the
//   same transaction, so a store either still holds the table untouched or holds the records and no table.
//
// NON-NEGOTIABLE INVARIANTS
//   1. Nothing is lost: a carry that throws rolls back its transaction, the table stays, and the next start tries again.
//   2. A record the person changed after the move wins over the old row (every carrier merges old rows UNDER what the
//      records already say), so a carry that runs late never undoes a newer choice.
//   3. A table that does not exist is skipped: a store made after the move, or one already carried, does nothing here.
//   4. Readers read only the records. Nothing reads the old table after the move; its only reader is its carrier.
//
import { canonical } from '../decide-with-a-method/read-data/decision-records.mjs';

/**
 * Runs each carrier whose table is still present. Returns { carried: [{ table, rows }], failed: [{ table, reason }] };
 * a failed table is left in place for the next start.
 *   sql:         the store's SQLite ({ exec(query, ...values) → { toArray() } })
 *   transaction: (fn) → runs fn in one transaction, rolled back when it throws
 *   carriers:    [{ table, carry(rows) }], carry writing the rows' meaning as records and throwing on a bad read-back
 */
export function carryTablesIntoRecords(sql, { transaction, carriers }) {
  const names = carriers.map(carrier => carrier.table);
  // Cold stores can have many record-run tables. Inspect only the legacy tables these carriers own.
  const present = new Set(names.length ? sql.exec("SELECT name FROM sqlite_master WHERE type = 'table' AND name IN (SELECT value FROM json_each(?))", JSON.stringify(names)).toArray().map(row => row.name) : []);
  const carried = [];
  const failed = [];
  for (const { table, carry } of carriers) {
    if (!present.has(table)) continue;
    console.info('carry into records entering', { table });
    try {
      const rows = transaction(() => {
        const held = sql.exec(`SELECT * FROM ${table}`).toArray().map(row => ({ ...row }));
        carry(held);
        sql.exec(`DROP TABLE ${table}`);
        return held.length;
      });
      carried.push({ table, rows });
    } catch (error) {
      failed.push({ table, reason: String(error?.message ?? error) });
    }
  }
  return { carried, failed };
}

/** Throws when what the records now say differs from what the carry meant to write (compared as canonical JSON). */
export function checkCarried(table, wrote, readBack) {
  if (canonical(wrote) !== canonical(readBack)) throw new Error(`${table} did not read back as carried`);
}
