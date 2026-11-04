import test from 'node:test';
import assert from 'node:assert/strict';
import { sqliteHost } from '../src/local-store.mjs';
import { recordLogStore } from '../parts/record-log/do-work/record-log-store.mjs';

test('nested sizing preserves exact refusal diagnostics and accepted caller isolation', () => {
  const host = sqliteHost(':memory:');
  try {
    const options = { transaction: host.transaction, runs: { page_bytes: 4096, cache_bytes: 0 } };
    const value = { title: 'abc', detail: { n: 7, missing: undefined, child: { flag: true } },
      entries: [{ word: 'hello', start: 1, end: 2 }, { word: '🌍', start: 3, end: 4 }], empty: [], mixed: [{ n: 1 }, null], unset: undefined };
    const writer = recordLogStore(host.sql, options);
    writer.write([{ id: 'sizing', type: 'note', value }]);
    writer.checkpoint();
    const expected = { rows: 22, bytes: 41, by_field: [
      { field: 'entries', values_held: 12, bytes: 15 },
      { field: 'detail', values_held: 6, bytes: 5 },
      { field: 'title', values_held: 1, bytes: 5 },
      { field: 'empty', values_held: 1, bytes: 2 },
      { field: 'mixed', values_held: 1, bytes: 14 },
    ] };
    for (const bounds of [{ rows: 21, bytes: 100 }, { rows: 100, bytes: 40 }]) {
      const limited = recordLogStore(host.sql, { ...options, bounds });
      assert.throws(() => limited.read('sizing'), error => {
        assert.equal(error.code, 'record_too_large');
        assert.deepEqual(error.size, expected);
        return true;
      });
    }
    const reader = recordLogStore(host.sql, { ...options, bounds: { rows: 22, bytes: 41 } });
    const read = reader.read('sizing');
    assert.deepEqual(read, JSON.parse(JSON.stringify(value)));
    read.entries[0].word = 'changed'; read.detail.child.flag = false;
    assert.deepEqual(reader.read('sizing'), JSON.parse(JSON.stringify(value)));
  } finally { host.db.close(); }
});
