// test/eeaf-deletes-search-by-index.test.mjs
//
// Removing an entity checks every column that references it, and each check is an index search: none scans a whole
// table. participation.role_id had no index, so every part a write removed scanned every participation the person's
// store holds (300 logged decision calls took 57.9 s with the scan and 26.3 s without it, on a store holding nothing
// else); Sam's store spent up to 32 s of CPU on one call on 2026-10-03.
import test from 'node:test';
import assert from 'node:assert/strict';
import { sqliteHost } from '../src/local-store.mjs';
import { eeafStore } from '../parts/eeaf/do-work/eeaf-sqlite-store.mjs';

test('removing an entity searches every table that references it by index', () => {
  const { sql, transaction } = sqliteHost(':memory:');
  eeafStore(sql, { transaction, hash: text => `set:${text.length}` });
  const plan = sql.exec("EXPLAIN QUERY PLAN DELETE FROM entity WHERE id = 'x'").toArray().map(row => row.detail);
  assert.ok(plan.length > 1, 'the delete checks the tables that reference entity');
  assert.deepEqual(plan.filter(detail => /^SCAN /.test(detail)), [], `a check scans a whole table: ${plan.join('; ')}`);
});
