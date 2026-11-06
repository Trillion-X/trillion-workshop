// Ported from old trillion test/own-ais-full-store-recovery.test.mjs (tag old-trillion-before-worker-retire, b6ae0ebf81),
// deleted by Trillion-X/trillion #243. The one test kept is "B: a page of large rows is sized from row headers": this
// tool's record-log store (parts/record-log/do-work/record-log-store.mjs sealLog, sealedLogPage) over this tool's
// sqliteHost, counted below as the old simulated person's countedDatabase counted: a row is charged as it is consumed,
// as a Durable Object's cursor charges it, and take() sums rows and bytes. Its assertions are the old ones.
// Left out: the three "A" tests of src/own-ais-routing.mjs ownAisRouting and carriedOwnAisRuns (searched the three repos
// for ownAisRouting, OWN_AIS_RUN_MAPS, carriedOwnAisRuns, no_taker_retry_minutes, again_at_once_most, own_ais_runs: no
// running code; tools/shared-code/test/own-ais.test.mjs records the same search), the one that booted the retired
// PersonStore to carry the own_ais_runs setting into its operational rows (ownAisRuns, setFact), and "B: a store full of
// repeated large setting copies archives itself" (the retired PersonStore's storeHealthInstance.atCapacity, its
// namespaceResults and alarm: searched for atCapacity and full_headroom_bytes, nothing outside old fixtures).
//
// B: a store full of repeated large setting copies archives itself before a write is refused: the gate starts within
//    full_headroom_bytes of the limit (a write needing a few pages fails before the count reaches it), each verified
//    page is freed as it is kept, in larger full-store pages, and a page is sized from row headers only.
import test from 'node:test';
import assert from 'node:assert/strict';
import { recordLogStore } from '../parts/record-log/do-work/record-log-store.mjs';
import { sqliteHost } from '../src/local-store.mjs';

// The old countedDatabase's reads: rows and bytes charged as the caller consumes them, summed until take().
function countedDatabase() {
  const host = sqliteHost(':memory:');
  let reads = { rows: 0, bytes: 0 };
  const charge = row => {
    reads.rows += 1;
    for (const value of Object.values(row)) reads.bytes += typeof value === 'string' ? value.length : (value?.byteLength ?? 8);
    return row;
  };
  const sql = { exec(query, ...params) {
    const cursor = host.sql.exec(query, ...params);
    const iterator = () => { const rows = cursor[Symbol.iterator](); return { next() { const item = rows.next(); if (!item.done) charge(item.value); return item; }, [Symbol.iterator]() { return this; } }; };
    const toArray = () => Array.from(iterator());
    return { toArray, one: () => { const values = toArray(); if (values.length !== 1) throw new Error(`Expected exactly one row, got ${values.length}.`); return values[0]; }, [Symbol.iterator]: iterator };
  } };
  return { host, sql, transaction: host.transaction, take: () => { const taken = reads; reads = { rows: 0, bytes: 0 }; return taken; } };
}

test('B: a page of large rows is sized from row headers and the size pass stops at the cap', () => {
  const database = countedDatabase();
  const take = database.take;
  const records = recordLogStore(database.sql, { transaction: database.transaction });
  for (let n = 0; n < 60; n += 1) records.write([{ id: 'setting:copies', type: 'setting', value: { value: { n, copy: 'c'.repeat(100_000) } } }]);
  const table = records.sealLog();
  take();
  const page = records.sealedLogPage(table, 0, 1024, 2 * 1024 * 1024);
  const read = take();
  assert.ok(page.rows.length > 0 && page.rows.length < 60);
  assert.equal(page.rowids.length, page.rows.length);
  assert.equal(page.last, page.rowids.at(-1));
  // The size pass takes at most one row past the cap; the page read takes its rows. Never all 1,024 (or all 60).
  assert.ok(read.rows <= 2 * page.rows.length + 2, `${read.rows} rows read for a page of ${page.rows.length}`);
  const pageBytes = page.rows.reduce((sum, row) => sum + row.envelopes.length, 0);
  assert.ok(read.bytes <= pageBytes * 1.1 + 4096, `${read.bytes} bytes read for ${pageBytes} bytes of page`);
  database.host.db.close();
});
