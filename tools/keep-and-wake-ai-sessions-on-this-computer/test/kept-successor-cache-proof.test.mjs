import test from 'node:test';
import assert from 'node:assert/strict';
import { sqliteHost } from '../src/local-store.mjs';
import { keptRuns } from '../parts/record-log/do-work/kept-runs.mjs';

// Keys in a page's header: its suffixes follow the offsets' JSON after \u0002 (kept-runs.mjs), or an earlier page's s array.
const keysInHeader = body => {
  const end = body.indexOf('\n'), sep = body.indexOf('\u0002');
  return sep < 0 || sep > end ? JSON.parse(body.slice(0, end)).s.length : body.slice(sep + 1, end).split('\u0003').length;
};
const pageBytes = body => 64 + body.length * 2 + keysInHeader(body) * 16;

function fixture(host, tight = false) {
  const options = { prefix: 'cache_proof', transaction: host.transaction, page_bytes: 128,
    cache_bytes: 0, filter_bytes: 0, max_runs: 1000 };
  let space = keptRuns(host.sql, options);
  const values = new Map();
  for (let n = 0; n < 96; n += 1) {
    const key = 'k' + String(n).padStart(4, '0') + '~'.repeat(96), value = { n, text: 'x'.repeat(256) };
    values.set(key, value); space.put(key, value);
  }
  space.flush();
  const run = space.held().runs[0];
  const rows = host.sql.exec(`SELECT page, first, body FROM cache_proof_run_${run.run} WHERE page >= 0 ORDER BY page LIMIT 128`).toArray();
  assert.equal(rows.length, 96); assert.equal(run.pages, 96);
  const capacity = tight ? 4 * Math.max(...rows.map(row => pageBytes(row.body))) : 128 * 1024;
  space = keptRuns(host.sql, { ...options, cache_bytes: capacity });
  const gap = page => ({ lo: JSON.parse(rows[page].first) + '\u0000', hi: JSON.parse(rows[page + 1].first) });
  return { space, options: { ...options, cache_bytes: capacity }, rows, values, gap, capacity };
}

function measured(host, read) {
  const queries = [], original = host.sql.exec, exec = original.bind(host.sql);
  host.sql.exec = (query, ...params) => { queries.push({ query, params }); return exec(query, ...params); };
  try { return { answer: read(), queries }; } finally { host.sql.exec = original; }
}

test('successor proof adds one explicit charge to its cached page and strict fence equality keeps the right page', () => {
  const host = sqliteHost(':memory:');
  try {
    const f = fixture(host), bound = f.gap(3);
    assert.equal(f.space.held().cache_bytes, 0);
    assert.deepEqual(f.space.ranges([bound], { limit_per_range: 32 }), []);
    const expected = pageBytes(f.rows[3].body) + 64 + bound.hi.length * 2;
    assert.equal(f.space.held().cache_bytes, expected, 'one original page plus its charged successor key');
    for (let n = 0; n < 3; n += 1) {
      const warm = measured(host, () => f.space.ranges([bound], { limit_per_range: 32 }));
      assert.deepEqual(warm.answer, []); assert.deepEqual(warm.queries, []);
      assert.equal(f.space.held().cache_bytes, expected, 'reusing proof does not charge it again');
    }
    assert.deepEqual(f.space.range(bound.hi, bound.hi + '\u0000', { limit: 1 }), [[bound.hi, f.values.get(bound.hi)]],
      'inclusive seek at the next fence cannot settle the predecessor');
    assert.deepEqual(f.space.range(bound.lo, bound.hi, { reverse: true }), [],
      'strict seek at the next fence belongs to the predecessor in JS order');
    // Boundary reads may cache an unrelated successor's large value. Reopen
    // before isolating the predecessor page and proof invalidation witness.
    f.space.reloadCatalog();
    assert.deepEqual(f.space.ranges([bound], { limit_per_range: 32 }), []);
    assert.equal(f.space.held().cache_bytes, expected);
    assert.equal(f.space.rewriteKey(JSON.parse(f.rows[3].first), value => ({ ...value, changed: true })), 1);
    assert.equal(f.space.held().cache_bytes, 0, 'run invalidation releases page and successor-proof charges');
    f.space.reloadCatalog(); assert.equal(f.space.held().cache_bytes, 0);
    const recovered = measured(host, () => f.space.ranges([bound], { limit_per_range: 32 }));
    assert.deepEqual(recovered.answer, []); assert.ok(recovered.queries.length > 0, 'recovery must rebuild proof');
    const run = f.space.held().runs[0].run;
    const rewritten = host.sql.exec(`SELECT body FROM cache_proof_run_${run} WHERE page = ?`, 3).toArray()[0].body;
    assert.equal(f.space.held().cache_bytes, pageBytes(rewritten) + 64 + bound.hi.length * 2);
  } finally { host.db.close(); }
});

test('proof is evicted with its page under the original cache bound, and reopening retains no fence registry', () => {
  const host = sqliteHost(':memory:');
  try {
    const f = fixture(host, true), first = f.gap(3);
    assert.deepEqual(f.space.ranges([first], { limit_per_range: 32 }), []);
    assert.deepEqual(measured(host, () => f.space.ranges([first], { limit_per_range: 32 })).queries, []);
    for (let page = 7; page < 77; page += 2) {
      assert.deepEqual(f.space.ranges([f.gap(page)], { limit_per_range: 32 }), []);
      assert.ok(f.space.held().cache_bytes <= f.capacity, 'metadata shares the unchanged LRU budget');
    }
    const evicted = measured(host, () => f.space.ranges([first], { limit_per_range: 32 }));
    assert.deepEqual(evicted.answer, []); assert.ok(evicted.queries.length > 0, 'evicted predecessor carries no surviving proof');
    assert.ok(f.space.held().cache_bytes <= f.capacity);
    const reopened = keptRuns(host.sql, f.options);
    assert.equal(reopened.held().cache_bytes, 0);
    const cold = measured(host, () => reopened.ranges([first], { limit_per_range: 32 }));
    assert.deepEqual(cold.answer, []); assert.ok(cold.queries.length > 0);
  } finally { host.db.close(); }
});

test('rollback clears charged proof before a run number is reused with a matching key inside the old gap', () => {
  const host = sqliteHost(':memory:');
  const options = { prefix: 'proof_rollback', transaction: host.transaction, page_bytes: 128,
    cache_bytes: 128 * 1024, filter_bytes: 0, max_runs: 1000 };
  let space = keptRuns(host.sql, options), rolledBackRun;
  const keyOf = n => 'k' + String(n).padStart(4, '0') + '~'.repeat(96);
  const bound = { lo: keyOf(0) + '\u0000', hi: keyOf(2) };
  const oldValue = { text: 'x'.repeat(256) }, newValue = { text: 'y'.repeat(256) };
  try {
    space.put('a', oldValue); space.put('z', oldValue); space.flush();
    assert.throws(() => host.transaction(() => {
      for (const key of [keyOf(0), keyOf(2), keyOf(4)]) space.put(key, oldValue);
      space.flush(); rolledBackRun = space.held().runs[0].run;
      space.reloadCatalog();
      assert.deepEqual(space.ranges([bound], { limit_per_range: 32 }), []);
      assert.ok(space.held().cache_bytes > 0);
      assert.deepEqual(measured(host, () => space.ranges([bound], { limit_per_range: 32 })).queries, []);
      throw new Error('rollback successor proof');
    }), /rollback successor proof/);
    space.clearMemtable(); space.reloadCatalog();
    assert.equal(space.held().cache_bytes, 0, 'catalog rollback releases page and proof charges');
    for (const key of [keyOf(0), keyOf(1), keyOf(4)]) space.put(key, newValue);
    space.flush(); assert.equal(space.held().runs[0].run, rolledBackRun, 'the fixture genuinely reuses the run number');
    assert.deepEqual(space.ranges([bound], { limit_per_range: 32 }), [[keyOf(1), newValue]],
      'old next-fence proof cannot suppress the new matching page');
    space.reloadCatalog(); space = keptRuns(host.sql, options);
    assert.deepEqual(space.ranges([bound], { limit_per_range: 32 }), [[keyOf(1), newValue]]);
  } finally { host.db.close(); }
});
