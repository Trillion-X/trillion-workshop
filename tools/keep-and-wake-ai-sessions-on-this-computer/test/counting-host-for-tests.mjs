// A SQLite handle that counts what each statement hands back (reads: { query, params, rows, bytes }) and can refuse one
// statement, as a reset would: the old trillion test/person-store-reads-for-tests.mjs countingHost (tag
// old-trillion-before-worker-retire, b6ae0ebf81), without the retired PersonStore it also built. Ported tests that
// measured a store's reads use it over this tool's src/local-store.mjs sqliteHost.
import { sqliteHost } from '../src/local-store.mjs';

export function countingHost(file = ':memory:') {
  const host = sqliteHost(file);
  const reads = [];
  let refuse = null;
  const sql = {
    exec(query, ...params) {
      if (refuse?.(query, params)) throw new Error('the store was reset');
      const cursor = host.sql.exec(query, ...params);
      const rows = cursor.toArray();
      let bytes = 0;
      for (const row of rows) for (const value of Object.values(row)) bytes += typeof value === 'string' ? value.length : (value?.byteLength ?? 8);
      reads.push({ query, params, rows: rows.length, bytes });
      return cursor;
    },
  };
  return { host, sql, reads, refuseWhen: fn => { refuse = fn; }, take: () => reads.splice(0) };
}
export const total = reads => reads.reduce((sum, read) => sum + read.bytes, 0);
export const largest = reads => Math.max(0, ...reads.map(read => read.bytes));
