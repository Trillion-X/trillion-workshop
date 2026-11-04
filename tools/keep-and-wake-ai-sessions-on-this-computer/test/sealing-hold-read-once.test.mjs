// test/sealing-hold-read-once.test.mjs
// Every oldest-log and seal check (src/record-engine.mjs sealingHeld) asked the database whether the record move was
// holding the open log. On 2026-10-12 a warm boot of a person store ran 28 of its 292 statements as that one read,
// once per check. The hold changes only through holdSealing or a rollback, so these tests prove one read serves every
// check, a hold set on one records object is seen by another over the same database, and a rolled-back hold is seen
// again after forgetCached (the person store calls it when a transaction throws).
import test from 'node:test';
import assert from 'node:assert/strict';
import { sqliteHost } from '../src/local-store.mjs';
import { openRecords } from '../src/record-engine.mjs';

// Records written, so the log has something the hold can keep (an empty log answers null whatever the hold says).
const written = records => { for (let n = 1; n <= 3; n += 1) records.write([{ id: `table-move:n${n}`, type: 'table-move', value: { first_after: n } }], { actor: { by: 'trillion' } }); return records; };

function countingHost() {
  const host = sqliteHost(':memory:');
  const reads = [];
  const exec = host.sql.exec.bind(host.sql);
  host.sql.exec = (query, ...args) => {
    if (/^SELECT value FROM record_keys_meta/.test(query) && args[0] === 'sealing_held') reads.push(query);
    return exec(query, ...args);
  };
  return { host, reads };
}

test('thirty oldest-log and seal checks read the sealing hold from the database once', () => {
  const { host, reads } = countingHost();
  const records = written(openRecords(host.sql, { transaction: host.transaction }));
  for (let n = 0; n < 15; n += 1) { records.oldestLogId(); records.sealLog(); }
  assert.ok(reads.length <= 1, `expected at most one read of the hold, saw ${reads.length}`);
});

test('a hold set on one records object over the same database is seen by another', () => {
  const { host, reads } = countingHost();
  const first = written(openRecords(host.sql, { transaction: host.transaction }));
  const second = openRecords(host.sql, { transaction: host.transaction });
  assert.notEqual(first.oldestLogId(), null);
  first.holdSealing(true);
  assert.equal(second.oldestLogId(), null);
  second.holdSealing(false);
  assert.notEqual(first.oldestLogId(), null);
  assert.ok(reads.length <= 1, `expected at most one read of the hold, saw ${reads.length}`);
});

test('a rolled-back hold is read from the database again after forgetCached', () => {
  const { host, reads } = countingHost();
  const records = written(openRecords(host.sql, { transaction: host.transaction }));
  records.holdSealing(true);
  assert.equal(records.oldestLogId(), null);
  host.sql.exec("UPDATE record_keys_meta SET value = 'false' WHERE key = 'sealing_held'");
  assert.equal(records.oldestLogId(), null, 'the remembered hold still stands until forgetCached');
  records.forgetCached();
  assert.notEqual(records.oldestLogId(), null);
  assert.equal(reads.length, 1, 'the hold set here is remembered; only the read after forgetCached goes to the database');
});
