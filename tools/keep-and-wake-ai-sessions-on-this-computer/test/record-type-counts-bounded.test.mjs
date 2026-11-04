import test from 'node:test';
import assert from 'node:assert/strict';
import { sqliteHost } from '../src/local-store.mjs';
import { recordLogStore } from '../parts/record-log/do-work/record-log-store.mjs';

const options = host => ({ transaction: host.transaction, runs: { page_bytes: 512, memtable_bytes: 4 * 1024 * 1024, cache_bytes: 1024 } });
const seed = count => Array.from({ length: count }, (_, n) => ({ id: `note:${String(n).padStart(6, '0')}`, type: 'note', value: { text: `Note ${n}` } }));

test('cold exact type diagnostics do not read a growing list of record IDs', t => {
  const costs = [];
  for (const count of [256, 1024]) {
    const host = sqliteHost(':memory:'); t.after(() => host.db.close());
    const first = recordLogStore(host.sql, options(host));
    first.write(seed(count)); first.checkpoint();
    let rows = 0, statements = 0;
    const sql = { exec(query, ...params) { const cursor = host.sql.exec(query, ...params); rows += cursor.toArray().length; statements += 1; return cursor; } };
    const reopened = recordLogStore(sql, options(host));
    rows = 0; statements = 0;
    assert.deepEqual(reopened.countsByType(), [{ type: 'note', n: count }]);
    costs.push({ rows, statements });
  }
  assert.ok(costs[1].rows <= costs[0].rows + 4, JSON.stringify(costs));
  assert.ok(costs[1].statements <= costs[0].statements + 4, JSON.stringify(costs));
});

test('type diagnostics keep exact edits, deletions, type changes and rollback through cold replay', t => {
  const host = sqliteHost(':memory:'); t.after(() => host.db.close());
  let store = recordLogStore(host.sql, options(host));
  store.write(seed(40)); store.checkpoint();
  store.write([{ id: 'note:000000', type: 'other', value: { text: 'Changed type' } }, { id: 'note:000001', value: null }]);
  assert.throws(() => host.transaction(() => { store.write([{ id: 'rolled-back', type: 'other', value: { text: 'Never committed' } }]); throw Error('rollback'); }), /rollback/);
  const expected = [{ type: 'note', n: 38 }, { type: 'other', n: 1 }];
  assert.equal(store.count('other'), 1, 'unreported rollback also invalidates a point count');
  assert.deepEqual(store.countsByType(), expected);
  store = recordLogStore(host.sql, options(host));
  assert.deepEqual(store.countsByType(), expected);
  store.checkpoint();
  assert.deepEqual(recordLogStore(host.sql, options(host)).countsByType(), expected);
});

test('older projections without kept counts retain exact diagnostic answers until their build completes', t => {
  const host = sqliteHost(':memory:'); t.after(() => host.db.close());
  let store = recordLogStore(host.sql, options(host));
  store.write(seed(600)); store.checkpoint();
  const position = JSON.parse(host.sql.exec("SELECT value FROM record_keys_meta WHERE key = 'covered'").toArray()[0].value);
  delete position.counts;
  host.sql.exec("UPDATE record_keys_meta SET value = ? WHERE key = 'covered'", JSON.stringify(position));
  store = recordLogStore(host.sql, { ...options(host), checksum_page: 8 });
  assert.equal(store.count('note'), null);
  assert.deepEqual(store.countsByType(), [{ type: 'note', n: 600 }]);
  store.write([{ id: 'note:000000', value: null }, { id: 'new', type: 'other', value: { text: 'New' } }]);
  const expected = [{ type: 'note', n: 599 }, { type: 'other', n: 1 }];
  assert.deepEqual(store.countsByType(), expected);
  for (let wake = 0; store.count('note') === null && wake < 200; wake += 1) store.maintain({ max_pages: 64 });
  assert.equal(store.count('note'), 599);
  assert.deepEqual(store.countsByType(), expected);
  assert.deepEqual(recordLogStore(host.sql, options(host)).countsByType(), expected);
});
