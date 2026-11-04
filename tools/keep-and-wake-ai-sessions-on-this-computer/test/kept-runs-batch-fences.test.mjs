import test from 'node:test';
import assert from 'node:assert/strict';
import { sqliteHost } from '../src/local-store.mjs';
import { keptRuns, KeptRangeBudgetExceeded } from '../parts/record-log/do-work/kept-runs.mjs';

const key = n => `key:${String(n).padStart(5, '0')}`;
function fixture() {
  const host = sqliteHost(':memory:');
  const options = { transaction: host.transaction, prefix: 'batch_fence', page_bytes: 256,
    memtable_bytes: 8 * 1024 * 1024, cache_bytes: 0, filter_bytes: 0, max_runs: 1000 };
  const open = () => keptRuns(host.sql, options);
  const space = open(), model = new Map();
  for (let n = 0; n < 1100; n++) {
    for (const suffix of ['', '\u{1f600}', '\uffff']) {
      const id = key(n) + suffix, value = { n, suffix };
      space.put(id, value); model.set(id, value);
    }
  }
  space.flush();
  for (let n = 0; n < 1100; n += 19) { space.remove(key(n)); model.delete(key(n)); }
  space.put(key(400), { updated: true }); model.set(key(400), { updated: true });
  space.flush();
  const expected = bounds => [...model].filter(([id]) => bounds.some(({ lo, hi }) => lo <= id && id < hi))
    .sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0);
  return { host, open, expected };
}

test('large exact and strict range batches preserve UTF-16 fences and newest tombstones', () => {
  const f = fixture();
  try {
    const bounds = Array.from({ length: 600 }, (_, n) => {
      const lo = key(n + 200) + (n % 3 === 0 ? '\u{1f600}' : n % 3 === 1 ? '\uffff' : '');
      return { lo, hi: `${lo}\u0000` };
    });
    assert.deepEqual(f.open().ranges(bounds), f.expected(bounds));
    const ranges = Array.from({ length: 32 }, (_, n) => ({ lo: key(50 + n * 30), hi: key(52 + n * 30) + '\uffff' }));
    assert.deepEqual(f.open().ranges(ranges), f.expected(ranges));
    assert.deepEqual(f.open().ranges([]), []);
  } finally { f.host.db.close(); }
});

test('small SQL fence searches preserve inclusive, strict and Unicode boundaries without a cache', () => {
  const f = fixture();
  try {
    const space = f.open();
    const bounds = [
      { lo: '', hi: key(0) },
      { lo: key(50), hi: key(50) + '\u0000' },
      { lo: key(400), hi: key(400) + '\u{1f600}' },
      { lo: key(401) + '\u{1f600}', hi: key(401) + '\uffff' },
      { lo: key(1099) + '\uffff', hi: 'z' },
      { lo: 'z', hi: 'zz' },
    ];
    for (const bound of bounds) {
      const expected = f.expected([bound]);
      assert.deepEqual(space.range(bound.lo, bound.hi), expected);
      assert.deepEqual(space.range(bound.lo, bound.hi, { reverse: true }), expected.slice().reverse());
      assert.deepEqual(space.ranges([bound]), expected);
    }
  } finally { f.host.db.close(); }
});

test('a cold walk validates its strict upper fence after a nonzero page frontier', () => {
  const f = fixture();
  try {
    const lo = key(500);
    const hi = f.host.sql.exec('SELECT first FROM batch_fence_run_1 ORDER BY page').toArray()
      .map(row => JSON.parse(row.first)).find(fence => fence > key(520));
    assert.ok(hi, 'the upper bound is an actual later page fence');
    const space = f.open(), exec = f.host.sql.exec.bind(f.host.sql);
    const frontiers = [];
    f.host.sql.exec = (query, ...params) => {
      if (query.includes('WITH RECURSIVE halving'))
        frontiers.push(...JSON.parse(params[1]).map(probe => probe[2]));
      return exec(query, ...params);
    };
    assert.deepEqual([...space.walk(lo, hi)], f.expected([{ lo, hi }]));
    assert.ok(frontiers.some(from => from > 1), 'the upper fence uses an interior predecessor');
  } finally { f.host.db.close(); }
});

test('page admission precedes bodies and a failed fence read is retryable on the same space', () => {
  const f = fixture();
  try {
    const bounds = Array.from({ length: 32 }, (_, n) => ({ lo: key(100 + n * 20), hi: `${key(100 + n * 20)}\u0000` }));
    const exec = f.host.sql.exec.bind(f.host.sql); let bodies = 0, fail = false, maxParams = 0;
    f.host.sql.exec = (query, ...params) => {
      if (query.includes('SELECT page, first') && query.includes('WHERE page IN')) {
        maxParams = Math.max(maxParams, params.length);
        if (fail) { fail = false; throw new Error('injected fence read'); }
      }
      if (query.includes('SELECT page, body')) bodies++;
      return exec(query, ...params);
    };
    const space = f.open();
    assert.throws(() => space.ranges(bounds, { page_budget: { remaining: 0 } }), KeptRangeBudgetExceeded);
    assert.equal(bodies, 0);
    fail = true;
    assert.throws(() => space.ranges(bounds), /injected fence read/);
    assert.deepEqual(space.ranges(bounds), f.expected(bounds));
    assert.ok(maxParams > 0 && maxParams <= 100);
    assert.throws(() => space.ranges(bounds, { value_budget: { remaining: 0 } }), KeptRangeBudgetExceeded);
    assert.deepEqual(f.open().ranges(bounds), f.expected(bounds));
  } finally { f.host.db.close(); }
});
