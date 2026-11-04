import test from 'node:test';
import assert from 'node:assert/strict';
import { sqliteHost } from '../src/local-store.mjs';
import { keptRuns } from '../parts/record-log/do-work/kept-runs.mjs';

function fixture(prefix) {
  const host = sqliteHost(':memory:');
  const parsed = [];
  const open = () => keptRuns(host.sql, {
    transaction: host.transaction, prefix, page_bytes: 1024, big_bytes: 256,
    memtable_bytes: 2 * 1024 * 1024, max_runs: 24,
    parseJson(text, context) { parsed.push(context); return JSON.parse(text); },
  });
  let bigQueries = 0;
  const exec = host.sql.exec.bind(host.sql);
  host.sql.exec = (query, ...args) => {
    if (query.includes(`SELECT body FROM ${prefix}_big`)) bigQueries += 1;
    return exec(query, ...args);
  };
  return { host, open, parsed, reset() { parsed.length = 0; bigQueries = 0; }, reads: () => bigQueries };
}

test('forward and reverse reads open only the newest value across persisted runs', () => {
  const f = fixture('range_winner');
  let space = f.open();
  space.put('a', { old: 'a'.repeat(20000) });
  space.put('b', { old: 'b'.repeat(20000) });
  space.put('c', { old: 'c'.repeat(20000) });
  space.flush();
  space.put('a', { current: 'a' });
  space.remove('b');
  space.put('c', { current: 'c' });
  space.flush();
  space = f.open();
  for (const reverse of [false, true]) {
    f.reset();
    const expected = [['a', { current: 'a' }], ['c', { current: 'c' }]];
    assert.deepEqual(space.range('a', 'd', { reverse }), reverse ? expected.reverse() : expected);
    assert.equal(f.reads(), 0, 'superseded and deleted spilled values are not fetched');
    assert.equal(f.parsed.filter(context => context.kind === 'big').length, 0);
  }
  f.host.db.close();
});

test('an in-memory winner hides obsolete persisted values without opening them', () => {
  const f = fixture('memory_winner');
  const space = f.open();
  space.put('a', { old: 'a'.repeat(20000) });
  space.put('b', { old: 'b'.repeat(20000) });
  space.flush();
  space.put('a', { current: 'a' });
  space.remove('b');
  for (const reverse of [false, true]) {
    f.reset();
    assert.deepEqual(space.range('a', 'c', { reverse, limit: 1 }), [['a', { current: 'a' }]]);
    assert.equal(f.reads(), 0);
    assert.equal(f.parsed.filter(context => context.kind === 'big').length, 0);
  }
  f.host.db.close();
});

test('limits and seek bounds open the winning large value once and no value outside the result', () => {
  const f = fixture('seek_winner');
  let space = f.open();
  const current = { current: 'm'.repeat(20000) };
  space.put('a', { old: 'a'.repeat(20000) });
  space.put('m', { old: 'm'.repeat(20000) });
  space.put('z', { old: 'z'.repeat(20000) });
  space.flush();
  space.remove('a');
  space.put('m', current);
  space.put('z', { current: 'z' });
  space.flush();
  space = f.open();
  for (const reverse of [false, true]) {
    space = f.open();
    f.reset();
    assert.deepEqual(space.range('m', 'n', { reverse, limit: 1 }), [['m', current]]);
    assert.equal(f.reads(), 1, 'only the winning large value is fetched');
    assert.equal(f.parsed.filter(context => context.kind === 'big').length, 1);
  }
  f.reset();
  assert.deepEqual(space.range('a', 'zz', { reverse: true, limit: 1 }), [['z', { current: 'z' }]]);
  assert.equal(f.reads(), 0, 'a later candidate not selected by the limit is not opened');
  f.host.db.close();
});

test('key-only limited ranges reconcile newest tombstones without opening live spilled values', () => {
  const f = fixture('keys_without_values');
  let space = f.open();
  for (const key of ['a', 'b', 'c', 'd']) space.put(key, { text: key.repeat(20000) });
  space.flush();
  space.remove('b');
  space.put('c', { text: 'current'.repeat(4000) });
  space.flush();
  for (const reverse of [false, true]) {
    space = f.open();
    space.remove('d');
    f.reset();
    assert.deepEqual(space.range('a', 'e', { reverse, limit: 2, readValue: () => false }),
      (reverse ? ['c', 'a'] : ['a', 'c']).map(key => [key, undefined]));
    assert.equal(f.reads(), 0, 'even live spilled values stay unopened');
    assert.equal(f.parsed.filter(context => context.kind === 'big').length, 0);
  }
  f.host.db.close();
});
