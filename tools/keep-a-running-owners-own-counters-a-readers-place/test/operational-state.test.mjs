// test/operational-state.test.mjs
//
// The owner of operational state (src/operational-state.mjs): plain rows that each write overwrites, one per key of a
// split field, so a write that changes one handoff writes one row and nothing is kept as record history. Checked over a
// real SQLite host: rows written per change, no-op writes, rollback, version-token stamps, carry-in once, table drops.
import test from 'node:test';
import assert from 'node:assert/strict';
import { sqliteHost } from '../../keep-and-wake-ai-sessions-on-this-computer/src/local-store.mjs';
import { operationalState } from '../src/operational-state.mjs';
import { dropTables } from '../../keep-and-wake-ai-sessions-on-this-computer/src/table-generation.mjs';

const changes = host => host.db.prepare('SELECT total_changes() AS n').get().n;

test('a write changes only the rows of the keys and fields that changed, and a write that changes nothing writes nothing', () => {
  const host = sqliteHost(':memory:');
  try {
    const state = operationalState({ sql: host.sql, transaction: host.transaction, doc: 'routing', split: ['again_at', 'tried'] });
    assert.equal(state.read(), null, 'never written');
    assert.equal(state.present(), false);
    const again_at = Object.fromEntries(Array.from({ length: 300 }, (_, n) => [`h_${n}`, `2026-10-14T00:00:${String(n % 60).padStart(2, '0')}Z`]));
    state.write({ again_at, tried: { h_1: ['ai:a'] }, last: { finished: false, why: 'x'.repeat(600) } });
    assert.equal(state.present(), true);
    assert.deepEqual(state.read(), { again_at, tried: { h_1: ['ai:a'] }, last: { finished: false, why: 'x'.repeat(600) } });
    let before = changes(host);
    assert.equal(state.write(state.read()), false, 'an unchanged value');
    assert.equal(changes(host) - before, 0, 'writes no row');
    before = changes(host);
    const next = state.read();
    next.again_at.h_7 = '2026-10-15T00:00:00Z';
    assert.equal(state.write(next), true);
    assert.equal(changes(host) - before, 2, 'one handoff row and the version token, however many handoffs are kept');
    before = changes(host);
    const fewer = state.read();
    delete fewer.again_at.h_8;
    delete fewer.last;
    state.write(fewer);
    assert.equal(changes(host) - before, 3, 'a key and a field left out are deleted, with the token');
    assert.equal(state.read().last, undefined);
    assert.equal(state.read().again_at.h_8, undefined);
    assert.equal(Object.keys(state.read().again_at).length, 299);
    const records = host.sql.exec("SELECT name FROM sqlite_master WHERE type = 'table'").toArray().map(row => row.name);
    assert.deepEqual(records, ['operational_state'], 'no record log, no history table: rows that are overwritten');
  } finally { host.db.close(); }
});

test('the version token is the stamp; a rolled-back write and another owner instance are read again', () => {
  const host = sqliteHost(':memory:');
  try {
    const state = operationalState({ sql: host.sql, transaction: host.transaction, doc: 'routing', split: ['no_taker'] });
    assert.equal(state.stamp(), null);
    state.write({ no_taker: { h: { revision: 'a', at: '2026-10-14T00:00:00Z' } } });
    const first = state.stamp();
    assert.match(first, /^[0-9a-f-]{36}$/);
    assert.equal(state.stamp(), first, 'stable while nothing changed');
    state.write(state.read());
    assert.equal(state.stamp(), first, 'an unchanged write keeps the stamp');
    assert.throws(() => host.transaction(() => {
      state.write({ no_taker: { h: { revision: 'b', at: '2026-10-14T00:01:00Z' } } });
      assert.equal(state.read().no_taker.h.revision, 'b', 'seen inside its transaction');
      throw new Error('rollback fixture');
    }), /rollback fixture/);
    assert.equal(state.stamp(), first, 'the token rolled back with the rows');
    assert.equal(state.read().no_taker.h.revision, 'a', 'the memory copy of a rolled-back write is never served');
    const other = operationalState({ sql: host.sql, transaction: host.transaction, doc: 'routing', split: ['no_taker'] });
    other.write({ no_taker: { h: { revision: 'c', at: '2026-10-14T00:02:00Z' } } });
    assert.notEqual(state.stamp(), first);
    assert.equal(state.read().no_taker.h.revision, 'c', 'another instance’s write is read');
    const elsewhere = operationalState({ sql: host.sql, transaction: host.transaction, doc: 'place' });
    elsewhere.write({ through: '2026-10-14T00:00:00Z' });
    assert.equal(state.read().through, undefined, 'documents never share rows');
  } finally { host.db.close(); }
});

test('an earlier value is carried in once, and a dropped table starts empty', () => {
  const host = sqliteHost(':memory:');
  try {
    const state = operationalState({ sql: host.sql, transaction: host.transaction, doc: 'place' });
    assert.equal(state.adopt({ through: 'earlier', waiting: [{ id: 'm1' }] }), true);
    assert.equal(state.adopt({ through: 'later' }), false, 'carried in once');
    assert.deepEqual(state.read(), { through: 'earlier', waiting: [{ id: 'm1' }] });
    host.sql.exec('DROP TABLE operational_state');
    dropTables(host.sql);
    assert.equal(state.read(), null, 'the drop is seen, and the table is made again');
    state.write({ through: 'after' });
    assert.deepEqual(state.read(), { through: 'after' });
    assert.throws(() => state.write({ 'a\u001fb': 1 }), /cannot keep the field/);
    assert.throws(() => state.write([1]), /keeps an object/);
  } finally { host.db.close(); }
});
