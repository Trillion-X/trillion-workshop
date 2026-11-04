// test/kept-runs-meta-writes.test.mjs
//
// The run store's checkpoint keys (merge state, coverage, fill progress) are set on every merge step, and most of those
// steps set the value already stored. Each upsert is a billed write, so a set that stores what is there must write
// nothing, while a set that changes the value still stores it.
import assert from 'node:assert/strict';
import test from 'node:test';
import { sqliteHost } from '../src/local-store.mjs';
import { keptRuns } from '../parts/record-log/do-work/kept-runs.mjs';

test('setting a run store checkpoint to the value it holds writes nothing, and a changed value is stored', () => {
  const host = sqliteHost(':memory:');
  let upserts = 0;
  const sql = {
    exec(query, ...params) {
      if (/ON CONFLICT \(key\) DO UPDATE/.test(query)) upserts += 1;
      return host.sql.exec(query, ...params);
    },
  };
  const space = keptRuns(sql, { transaction: host.transaction, prefix: 'meta_writes', page_bytes: 256, memtable_bytes: 1 << 30, fan_in: 4, max_runs: 4 });
  space.meta.set('covered', { through: 7, after: 0 });
  assert.equal(upserts, 1);
  space.meta.set('covered', { through: 7, after: 0 });
  space.meta.set('covered', { through: 7, after: 0 });
  assert.equal(upserts, 1, 'setting the value already stored wrote again');
  assert.deepEqual(space.meta.get('covered'), { through: 7, after: 0 });
  space.meta.set('covered', { through: 8, after: 0 });
  assert.equal(upserts, 2);
  assert.deepEqual(space.meta.get('covered'), { through: 8, after: 0 });
});


test('selected metadata pages retain absence, exact identities and fresh transactional state across100-key bounds', () => {
  const host = sqliteHost(':memory:');
  try {
    const asked = [];
    const sql = { exec(query, ...params) {
      if (query.startsWith('SELECT key, value FROM meta_selected_meta')) asked.push({ query, params });
      return host.sql.exec(query, ...params);
    } };
    const options = { transaction: host.transaction, prefix: 'meta_selected' };
    const first = keptRuns(sql, options), second = keptRuns(host.sql, options);
    const names = Array.from({ length: 201 }, (_, n) => `key:${n}`);
    for (let n = 0; n < names.length; n++) first.meta.set(names[n], { n, text: `exact ${n}` });
    first.meta.set('not-selected', { huge: 'x'.repeat(4096) });
    assert.equal(first.meta.getMany([]).size, 0); assert.equal(asked.length, 0);
    const found = first.meta.getMany([...names, names[0], 'missing']);
    assert.equal(asked.length, 3); assert.ok(asked.every(read => read.params.length <= 100));
    assert.ok(asked.every(read => !read.params.includes('not-selected')));
    assert.equal(found.size, 201); assert.equal(found.has('missing'), false);
    for (let n = 0; n < names.length; n++) assert.deepEqual(found.get(names[n]), { n, text: `exact ${n}` });
    second.meta.set(names[0], { changed: true });
    assert.deepEqual(first.meta.getMany([names[0]]).get(names[0]), { changed: true }, 'another owner is visible');
    assert.throws(() => host.transaction(() => {
      first.meta.set(names[0], { rolled_back: true });
      assert.deepEqual(first.meta.getMany([names[0]]).get(names[0]), { rolled_back: true });
      throw Error('rollback');
    }), /rollback/);
    assert.deepEqual(first.meta.getMany([names[0]]).get(names[0]), { changed: true });
    second.meta.remove(names[0]); assert.equal(first.meta.getMany([names[0]]).has(names[0]), false);
    assert.throws(() => first.meta.getMany(['safe', 1]), /strings/);
  } finally { host.db.close(); }
});
