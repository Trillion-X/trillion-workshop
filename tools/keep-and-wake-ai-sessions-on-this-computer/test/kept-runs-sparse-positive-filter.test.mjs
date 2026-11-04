import test from 'node:test';
import assert from 'node:assert/strict';
import { sqliteHost } from '../src/local-store.mjs';
import { keptRuns, KeptRangeBudgetExceeded } from '../parts/record-log/do-work/kept-runs.mjs';

const key = n => `key:${String(n).padStart(5, '0')}`;
function fixture({ count = 2000, cache_bytes = 0, legacy = false, filter_bytes = 4096 } = {}) {
  const host = sqliteHost(':memory:');
  const options = { prefix: 'sparse_positive', transaction: host.transaction, page_bytes: 256,
    memtable_bytes: 8 * 1024 * 1024, filter_bytes, cache_bytes, max_runs: 1000, fan_in: 1000 };
  const reads = [], exec = host.sql.exec.bind(host.sql);
  host.sql.exec = (query, ...params) => { reads.push({ query, params }); return exec(query, ...params); };
  // The writer persists the whole positive filter; a reader opens with `filter_bytes` of memory, so a filter larger
  // than that stays stored and answers through selected bytes.
  const writer = keptRuns(host.sql, { ...options, filter_bytes: 8 * 1024 * 1024 }), model = new Map();
  for (let n = 0; n < count; n++) for (const suffix of ['', '\u{1f600}', '\uffff']) {
    const id = key(n) + suffix, value = { n, suffix };
    writer.put(id, value); model.set(id, value);
  }
  writer.flush();
  if (legacy) for (const row of exec('SELECT page, body FROM sparse_positive_run_1 WHERE page < 0'))
    exec('UPDATE sparse_positive_run_1 SET body = ? WHERE page = ?', Buffer.from(row.body).toString('base64'), row.page);
  const geometry = exec('SELECT filter_bits FROM sparse_positive_runs').one().filter_bits;
  const open = () => keptRuns(host.sql, options);
  const reset = () => { reads.length = 0; };
  return { host, exec, options, reads, model, geometry, warm: writer, open, reset };
}

for (const legacy of [false, true]) test(`cold ${legacy ? 'base64' : 'binary'} positive filters preserve geometry and bound selected reads`, () => {
  const f = fixture({ legacy });
  try {
    f.reset(); const space = f.open();
    assert.equal(space.held().filter_bytes, 0, 'the large persisted positive filter is not admitted cold');
    assert.equal(space.held().runs[0].filter, 'stored');
    assert.equal(f.exec('SELECT filter_bits FROM sparse_positive_runs').one().filter_bits, f.geometry);
    assert.equal(f.reads.some(({ query }) => query.includes('WHERE page < 0 ORDER BY page DESC')), false, 'no eager full-filter read');
    for (const id of [key(0), key(800), key(800) + '\u{1f600}', key(800) + '\uffff', key(1999) + '\uffff']) {
      f.reset(); assert.deepEqual(space.get(id), f.model.get(id));
      assert.ok(f.reads.filter(({ query }) => query.startsWith('WITH filter_chunks')).length <= 1, 'point membership and body share one statement');
    }
    const absent = Array.from({ length: 64 }, (_, n) => key(n * 29) + '~');
    f.reset(); assert.deepEqual(space.ranges(absent.map(lo => ({ lo, hi: lo + '\u0000' }))), []);
    assert.equal(f.reads.filter(({ query }) => query.startsWith('WITH filter_chunks')).length, 1, 'cache-free batch uses one membership query');
    // Most absent probes must be rejected before the exact pages; Bloom false positives remain legal.
    const decoded = f.reads.filter(({ query }) => query.startsWith('SELECT page, body')).flatMap(({ params }) => JSON.parse(params[0]));
    assert.ok(decoded.length < 8, `absent roots fetched ${decoded.length} pages`);
    const bounds = [key(80), key(150) + '\u{1f600}', key(300) + '\uffff'].map(lo => ({ lo, hi: lo + '\u0000' }));
    f.reset(); assert.throws(() => space.ranges(bounds, { page_budget: { remaining: 0 } }), KeptRangeBudgetExceeded);
    assert.equal(f.reads.some(({ query }) => query.startsWith('SELECT page, body')), false, 'page admission precedes body retrieval');
    assert.deepEqual(space.ranges(bounds), bounds.map(({ lo }) => [lo, f.model.get(lo)]));
  } finally { f.host.db.close(); }
});

test('invalid or absent optional filter chunks cannot reject a present point or exact batch', () => {
  const f = fixture();
  try {
    const ids = [key(100), key(100) + '\u{1f600}', key(100) + '\uffff'];
    for (const body of [new Uint8Array(), '', '!!!!', 8]) {
      f.exec('UPDATE sparse_positive_run_1 SET body = ? WHERE page < 0', body);
      const space = f.open();
      for (const id of ids) assert.deepEqual(space.get(id), f.model.get(id));
      assert.deepEqual(space.ranges(ids.map(lo => ({ lo, hi: lo + '\u0000' }))), ids.map(id => [id, f.model.get(id)]));
    }
    f.exec('DELETE FROM sparse_positive_run_1 WHERE page < 0');
    assert.deepEqual(f.open().get(ids[0]), f.model.get(ids[0]));
  } finally { f.host.db.close(); }
});

for (const legacy of [false, true]) for (const cache_bytes of [512, 4096])
test(`resident ${legacy ? 'base64' : 'binary'} page settles unprobed neighbors with ${cache_bytes} cache bytes`, () => {
  const f = fixture({ legacy, cache_bytes });
  try {
    const fences = [...f.exec('SELECT page, first FROM sparse_positive_run_1 WHERE page >= 0 ORDER BY page')];
    const ordered = [...f.model.keys()].sort();
    const index = fences.findIndex((row, at) => at > 0 && at + 1 < fences.length
      && ordered.filter(id => id >= JSON.parse(row.first) && id < JSON.parse(fences[at + 1].first)).length > 1);
    assert.ok(index > 0, 'the real run contains a multi-key interior page');
    const ids = ordered.filter(id => id >= JSON.parse(fences[index].first) && id < JSON.parse(fences[index + 1].first));
    const absent = ids[0] + '\u0000';
    const space = f.open();
    assert.deepEqual(space.get(ids[0]), f.model.get(ids[0]));
    f.reset();
    for (const id of ids.slice(1)) assert.deepEqual(space.get(id), f.model.get(id));
    assert.equal(space.get(absent), undefined);
    assert.equal(f.reads.length, 0, 'exact resident pages need neither sparse membership nor repeated body output');
    const bounds = [{ lo: ids[0], hi: ids[0] + '\u0000' }];
    assert.throws(() => space.ranges(bounds, { page_budget: { remaining: 0 } }), KeptRangeBudgetExceeded);
    assert.throws(() => space.ranges(bounds, { value_budget: { remaining: 0 } }), KeptRangeBudgetExceeded);
    assert.equal(f.reads.length, 0, 'resident reads still honor admission without SQL');
    const neighborBounds = [...ids, absent].map(lo => ({ lo, hi: lo + '\u0000' }));
    const onePage = { remaining: 1 };
    assert.deepEqual(space.ranges(neighborBounds, { page_budget: onePage }), ids.map(id => [id, f.model.get(id)]));
    assert.equal(onePage.remaining, 0, 'several exact keys charge their shared resident page once');
    assert.equal(f.reads.length, 0);
    const far = key(1400), mixed = [...neighborBounds, { lo: far, hi: far + '\u0000' }];
    f.reset(); const twoPages = { remaining: 2 };
    assert.deepEqual(space.ranges(mixed, { page_budget: twoPages }), [...ids, far].sort().map(id => [id, f.model.get(id)]));
    assert.equal(twoPages.remaining, 0, 'sparse admission of another page retains unique-page accounting');
    const fetched = f.reads.filter(({ query }) => query.startsWith('SELECT page, body'))
      .flatMap(({ params }) => JSON.parse(params[0]));
    assert.equal(fetched.includes(fences[index].page), false, 'sparse samples cannot force rereading the captured page');
    assert.ok(space.held().cache_bytes <= cache_bytes);
    const reopened = f.open(); f.reset();
    assert.deepEqual(reopened.get(ids[0]), f.model.get(ids[0]));
    assert.ok(f.reads.length > 0, 'a fresh owner cannot reuse another owner\'s resident proof');
  } finally { f.host.db.close(); }
});

test('cold sparse membership preserves newer tombstones, cache bounds and persisted geometry through reload', () => {
  const f = fixture({ cache_bytes: 512 });
  try {
    let space = f.open();
    for (const id of [key(100), key(101), key(102)]) space.remove(id);
    space.put(key(103), { replaced: true }); space.flush();
    space = f.open();
    const bounds = Array.from({ length: 120 }, (_, n) => ({ lo: key(n + 60), hi: key(n + 60) + '\u0000' }));
    const expected = bounds.filter(({ lo }) => ![key(100), key(101), key(102)].includes(lo))
      .map(({ lo }) => [lo, lo === key(103) ? { replaced: true } : f.model.get(lo)]);
    assert.deepEqual(space.ranges(bounds), expected);
    assert.ok(space.held().cache_bytes <= f.options.cache_bytes);
    space.reloadCatalog();
    assert.deepEqual(space.ranges(bounds), expected);
    assert.equal(f.exec('SELECT filter_bits FROM sparse_positive_runs WHERE run = 1').one().filter_bits, f.geometry);
  } finally { f.host.db.close(); }
});

test('cold fragmented ordinary filters retain their existing aggregate residency', () => {
  const host = sqliteHost(':memory:');
  try {
    const options = { prefix: 'small_positive', transaction: host.transaction, page_bytes: 256,
      filter_bytes: 4096, cache_bytes: 0, max_runs: 1000, fan_in: 1000 };
    const writer = keptRuns(host.sql, options);
    for (let n = 0; n < 24; n++) { writer.put(key(n), { n }); writer.flush(); }
    const cold = keptRuns(host.sql, options);
    assert.equal(cold.held().runs.filter(run => run.filter === 'resident').length, 24);
    assert.ok(cold.held().filter_bytes > options.page_bytes);
    assert.ok(cold.held().filter_bytes <= options.filter_bytes);
  } finally { host.db.close(); }
});

test('ordinary membership-row filters stay resident independently of tiny data-page geometry', () => {
  const f = fixture({ count: 100 });
  try {
    const bytes = f.geometry / 8;
    assert.ok(bytes > f.options.page_bytes && bytes <= 4096, 'the filter fits the existing blocked-membership row, not a data page');
    const space = f.open();
    assert.equal(space.held().runs[0].filter, 'resident');
    assert.equal(space.held().filter_bytes, bytes);
    assert.ok(space.held().filter_bytes <= f.options.filter_bytes);
    f.reset(); assert.deepEqual(space.get(key(80)), f.model.get(key(80)));
    assert.equal(f.reads.some(({ query }) => query.startsWith('WITH filter_chunks')), false);
  } finally { f.host.db.close(); }
});

test('sparse membership shares the first fence round instead of adding a batch statement', () => {
  const f = fixture();
  try {
    const bounds = Array.from({ length: 60 }, (_, n) => ({ lo: key(n * 31), hi: key(n * 31) + '\u0000' }));
    f.reset(); const expected = f.warm.ranges(bounds), warmStatements = f.reads.length;
    const cold = f.open(); f.reset();
    assert.deepEqual(cold.ranges(bounds), expected);
    assert.ok(f.reads.length <= warmStatements, `sparse batch used ${f.reads.length} statements; resident batch used ${warmStatements}`);
    assert.equal(f.reads.filter(({ query }) => query.startsWith('WITH filter_chunks')).length, 1);
    assert.ok(f.reads.find(({ query }) => query.startsWith('WITH filter_chunks')).query.includes('AS fences'));
  } finally { f.host.db.close(); }
});
