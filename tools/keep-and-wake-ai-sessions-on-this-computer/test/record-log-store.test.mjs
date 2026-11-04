// test/record-log-store.test.mjs
// The record store whose truth is an append-only log (parts/record-log): one log row per write, records and indexes
// kept as keys of packed pages, a projection rebuilt from the log after a restart or a rollback. These tests hold what
// makes that safe: every read matches a plain model of the writes through flushes, merges, restarts and rollbacks; a
// write costs one row; the declared indexes answer exactly what the records hold.
import test from 'node:test';
import assert from 'node:assert/strict';
import { sqliteHost } from '../src/local-store.mjs';
import { recordLogStore } from '../parts/record-log/do-work/record-log-store.mjs';
import { keptRuns } from '../parts/record-log/do-work/kept-runs.mjs';
import { bucketOf } from '../../record-log/do-work/record-digest.mjs';

test('own-field JSON keeps exact shared Unicode content across chunk boundaries, rollback and cold rewrite', () => {
  const host = sqliteHost(':memory:');
  try {
    const options = { transaction: host.transaction };
    let store = recordLogStore(host.sql, options);
    const word = { text: 'needle 🪡 "\n\t\\\ud800 \udfff', start: 1.25, end: 2.5, final: false, absent: null };
    const payload = {
      label: '𠜎\u2028',
      items: Array.from({ length: 4096 }, (_, n) => ({ n, words: [word, { ...word, text: `${n} 🪡` }] })),
      long: '𐐀'.repeat(40000),
      scalars: { omitted: undefined, empty: '', zero: 0, no: false, nil: null },
    };
    const expected = JSON.stringify(payload);
    store.write([{ id: 'json-chunks', type: 'note', value: { payload, kept: 'unchanged' } }]);
    store.checkpoint();
    store = recordLogStore(host.sql, options);
    assert.equal(store.readOwnFieldJson('json-chunks', 'note', 'payload'), expected);
    assert.equal(store.readOwnFieldJson('json-chunks', 'wrong-kind', 'payload'), null);
    assert.equal(store.readOwnFieldJson('json-chunks', 'note', 'missing'), null);
    assert.equal(store.rewriteOwnFieldJsonIfEqual('json-chunks', 'note', 'payload', `${expected} `, { pointer: 'sealed' }), false);
    assert.throws(() => host.transaction(() => {
      assert.equal(store.rewriteOwnFieldJsonIfEqual('json-chunks', 'note', 'payload', expected, { pointer: 'sealed' }), true);
      throw Error('rollback exact JSON rewrite');
    }), /rollback exact JSON rewrite/);
    store.forgetCached();
    assert.equal(store.readOwnFieldJson('json-chunks', 'note', 'payload'), expected);
    assert.equal(store.rewriteOwnFieldJsonIfEqual('json-chunks', 'note', 'payload', expected, { pointer: 'sealed' }), true);
    store.checkpoint();
    store = recordLogStore(host.sql, options);
    assert.equal(store.readOwnFieldJson('json-chunks', 'note', 'payload'), null);
    assert.deepEqual(store.read('json-chunks'), { kept: 'unchanged', pointer: 'sealed' });
  } finally { host.db.close(); }
});

const small = { page_bytes: 512, memtable_bytes: 4096, cache_bytes: 8192, big_bytes: 2048 };
const INDEXES = [
  { type: 'note', name: 'at', paths: [['at']] },
  { type: 'note', name: 'room', paths: [['room']] },
  { type: 'note', name: 'room_at', paths: [['room'], ['at']] },
  { type: 'note', name: 'state_room_at', paths: [['state'], ['room'], ['at']] },
  { type: 'note', name: 'goal', paths: [['input', 'goal']] },
];

test('cold range heads return the sought page with its fence in one statement', () => {
  const host = sqliteHost(':memory:');
  const options = { transaction: host.transaction, prefix: 'range_head', ...small, page_bytes: 256, memtable_bytes: 1 << 20 };
  const written = keptRuns(host.sql, options);
  const keys = Array.from({ length: 80 }, (_, n) => `k${String(n).padStart(3, '0')}`);
  for (const key of keys) written.put(key, key);
  written.flush();
  assert.ok(host.db.prepare('SELECT COUNT(*) AS n FROM range_head_run_1 WHERE page >= 0').get().n > 4);
  const exec = host.sql.exec.bind(host.sql);
  let reads = [];
  host.sql.exec = (query, ...params) => {
    if (/SELECT/.test(query) && query.includes('range_head_run_1')) reads.push(query);
    return exec(query, ...params);
  };
  for (const reverse of [false, true]) {
    const space = keptRuns(host.sql, options);
    reads = [];
    assert.deepEqual(space.range('k042', 'k042\u0000', { reverse, limit: 1 }), [['k042', 'k042']]);
    assert.equal(reads.length, 1, `a cold ${reverse ? 'reverse' : 'forward'} head reads its fence and page together`);
    assert.ok(reads[0].includes('AS body FROM sought_pages'));
    assert.ok(reads[0].includes('AS MATERIALIZED'), 'each sought result is evaluated once');
  }
  const space = keptRuns(host.sql, options);
  reads = [];
  assert.equal(space.hasRange('k042', 'k042\u0000'), true);
  assert.equal(reads.length, 1, 'cold existence uses the same fused head');
  host.db.close();
});

test('empty selected parent prefixes share one existence seek regardless of parent count', () => {
  const host = sqliteHost(':memory:');
  const options = { transaction: host.transaction, indexes: INDEXES, runs: { ...small, page_bytes: 256, memtable_bytes: 1 << 20 } };
  const written = recordLogStore(host.sql, options);
  written.write(['a', 'z'].flatMap(room => Array.from({ length: 40 }, (_, n) => ({ id: `${room}${n}`, type: 'note', value: { room, at: `${n}` } }))));
  written.checkpoint();
  const exec = host.sql.exec.bind(host.sql);
  let probes = 0;
  host.sql.exec = (query, ...params) => {
    if (query.includes('FROM json_each(?) AS probe')) probes += JSON.parse(params.at(-1)).length;
    return exec(query, ...params);
  };
  let prior;
  for (const count of [2, 80]) {
    const store = recordLogStore(host.sql, options);
    probes = 0;
    const parents = Array.from({ length: count }, (_, n) => `m${String(n).padStart(3, '0')}`);
    assert.deepEqual(store.scanFirstValues('note', 'room_at', parents), []);
    assert.ok(probes > 0 && probes <= 2, `${count} empty parents used ${probes} probes`);
    if (prior !== undefined) assert.equal(probes, prior, 'growing parents does not add fence probes');
    prior = probes;
  }
  written.write([{ id: 'later', type: 'note', value: { room: 'm000', at: 'later' } }]);
  written.checkpoint();
  assert.deepEqual(recordLogStore(host.sql, options).scanFirstValues('note', 'room_at', ['m000', 'm001']), [{ id: 'later', values: ['m000', 'later'] }]);
});

test('resident adjacent gaps preserve strict fences through eviction and reopening', () => {
  const host = sqliteHost(':memory:');
  const options = { transaction: host.transaction, prefix: 'gap_cache', ...small, page_bytes: 256, memtable_bytes: 1 << 20, cache_bytes: 1 << 20 };
  const written = keptRuns(host.sql, options);
  const keys = Array.from({ length: 80 }, (_, n) => `k${String(n).padStart(3, '0')}`);
  for (const key of keys) written.put(key, key);
  written.flush();
  const fences = host.db.prepare('SELECT first FROM gap_cache_run_1 WHERE page >= 0 ORDER BY page').all().map(row => JSON.parse(row.first));
  assert.ok(fences.length > 4);
  const next = fences[3];
  const before = keys[keys.indexOf(next) - 1];
  const gap = `${before}\u0000`;
  const exec = host.sql.exec.bind(host.sql);
  let reads = 0;
  host.sql.exec = (query, ...params) => {
    if (/SELECT/.test(query) && query.includes('gap_cache_run_')) reads += 1;
    return exec(query, ...params);
  };
  let space = keptRuns(host.sql, options);
  reads = 0;
  assert.deepEqual(space.range(next, `${next}\u0000`, { limit: 1 }), [[next, next]]);
  assert.ok(reads > 0, 'a cold seek reads its page');
  space.ranges([{ lo: before, hi: `${next}\u0000` }]);
  reads = 0;
  assert.deepEqual(space.range(gap, next), []);
  assert.deepEqual(space.range(gap, next, { reverse: true }), []);
  assert.deepEqual(space.range(gap, `${next}\u0000`), [[next, next]]);
  assert.equal(reads, 0, 'resident adjacent pages prove their gap and strict upper fence');
  for (const cache_bytes of [256, 1 << 20]) {
    space = keptRuns(host.sql, { ...options, cache_bytes });
    space.range('k', 'l');
    assert.deepEqual(space.range(gap, next), []);
    assert.deepEqual(space.range(gap, `${next}\u0000`, { reverse: true }), [[next, next]]);
    space.remove(next);
    space.flush();
    assert.deepEqual(space.range(gap, `${next}\u0000`), []);
    space.put(next, next);
    space.flush();
  }
});

test('range existence respects newest tombstones and stops before older runs or large values', () => {
  const host = sqliteHost(':memory:');
  const options = { transaction: host.transaction, prefix: 'any_range', ...small, filter_bytes: 0 };
  let space = keptRuns(host.sql, options);
  space.put('keep', { text: 'x'.repeat(10000) });
  space.flush();
  space.remove('keep');
  space.flush();
  assert.equal(space.hasRange('a', 'z'), false);
  space.put('keep', { text: 'y'.repeat(10000) });
  assert.equal(space.hasRange('a', 'z'), true);
  space.flush();
  space = keptRuns(host.sql, options);
  const exec = host.sql.exec.bind(host.sql);
  host.sql.exec = (query, ...params) => {
    assert.ok(!/FROM any_range_big/.test(query), 'existence never opens a large value');
    assert.ok(!/FROM any_range_run_[12]\b/.test(query), 'a live newest key answers before older runs are read');
    return exec(query, ...params);
  };
  assert.equal(space.hasRange('a', 'z'), true);
  assert.equal(space.hasRange('z', 'a'), false);
  host.sql.exec = exec;
  space.remove('keep');
  assert.equal(space.hasRange('a', 'z'), false);
  space.put('second', null);
  assert.equal(space.hasRange('a', 'z'), true, 'null is a live JSON value');
});

test('independent index builds rotate durably past a larger unfinished group', () => {
  const host = sqliteHost(':memory:');
  const options = { transaction: host.transaction, runs: { ...small, memtable_bytes: 1 << 20 } };
  const old = recordLogStore(host.sql, options);
  old.write([
    ...Array.from({ length: 240 }, (_, n) => ({ id: `large-${String(n).padStart(3, '0')}`, type: 'large', value: { at: n } })),
    ...Array.from({ length: 3 }, (_, n) => ({ id: `little-${n}`, type: 'little', value: { at: n } })),
  ]);
  old.checkpoint();
  const indexes = ['large', 'little'].map(type => ({ type, name: 'at', paths: [['at']], backfill: 'at-v1' }));
  let store = recordLogStore(host.sql, { ...options, indexes });
  store.maintain();
  assert.equal(store.indexReady('large', 'at'), false);
  assert.equal(store.indexReady('little', 'at'), false);
  store = recordLogStore(host.sql, { ...options, indexes });
  store.maintain();
  assert.equal(store.indexReady('large', 'at'), false, 'the large rebuild still has old heads to visit');
  assert.equal(store.indexReady('little', 'at'), true, 'cold restart preserves the next group');
  assert.deepEqual(store.scan('little', 'at').map(row => row.id), ['little-0', 'little-1', 'little-2']);
  store = recordLogStore(host.sql, { ...options, indexes: [...indexes].reverse() });
  store.maintain();
  assert.equal(store.indexReady('little', 'at'), true, 'declaration reordering preserves completed groups');
});

test('index backfill fixes its frontier while new records keep arriving', () => {
  const host = sqliteHost(':memory:');
  const options = { transaction: host.transaction, runs: { ...small, memtable_bytes: 1 << 20 } };
  let store = recordLogStore(host.sql, options);
  const rows = (start, count) => Array.from({ length: count }, (_, n) => ({ id: `n${String(start + n).padStart(3, '0')}`, type: 'note', value: { at: start + n } }));
  store.write(rows(0, 64));
  store.checkpoint();
  const indexes = [{ type: 'note', name: 'at', paths: [['at']], backfill: 'at-v1' }];
  store = recordLogStore(host.sql, { ...options, indexes });
  store.maintain();
  const state = () => JSON.parse(host.sql.exec('SELECT value FROM record_keys_meta WHERE key=?', 'index-build:note:at-v1').one().value);
  assert.equal(state().after, 'n031');
  assert.equal(state().through, 'n063');
  assert.equal(store.indexReady('note', 'at'), false);
  store.write(rows(64, 32));
  store.write([{ id: 'n010', type: 'note', value: { at: 1000 } }, { id: 'n040', value: null }]);
  store.checkpoint();
  store = recordLogStore(host.sql, { ...options, indexes });
  store.maintain();
  assert.equal(store.indexReady('note', 'at'), true, 'new writes do not extend the old-data frontier');
  assert.equal(state().through, 'n063');
  const expected = [...rows(0, 96).filter(row => row.id !== 'n040').map(row => ({ id: row.id, values: [row.id === 'n010' ? 1000 : row.value.at] }))]
    .sort((a, b) => JSON.stringify(a.values[0]) < JSON.stringify(b.values[0]) ? -1 : 1);
  assert.deepEqual(store.scan('note', 'at'), expected, 'old-head edits/deletions and all post-frontier writes remain indexed');
});

test('a refused index slice rolls back its progress while admitting the next independent group', () => {
  const host = sqliteHost(':memory:');
  const options = { transaction: host.transaction, runs: { ...small, memtable_bytes: 1 << 20 } };
  let store = recordLogStore(host.sql, options);
  store.write(['large', 'little'].map(type => ({ id: type, type, value: { at: 1 } })));
  store.checkpoint();
  const indexes = ['large', 'little'].map(type => ({ type, name: 'at', paths: [['at']], backfill: 'at-v1' }));
  store = recordLogStore(host.sql, { ...options, indexes });
  const exec = host.sql.exec.bind(host.sql);
  host.sql.exec = (query, ...params) => {
    if (/INSERT INTO record_keys_meta/.test(query) && params[0] === 'index-build:large:at-v1') throw new Error('index progress write refused');
    return exec(query, ...params);
  };
  assert.throws(() => store.maintain(), /index progress write refused/);
  host.sql.exec = exec;
  store = recordLogStore(host.sql, { ...options, indexes });
  assert.equal(store.indexReady('large', 'at'), false);
  store.maintain();
  assert.equal(store.indexReady('little', 'at'), true);
  assert.equal(store.indexReady('large', 'at'), false);
  store.maintain();
  assert.equal(store.indexReady('large', 'at'), true);
  assert.deepEqual(store.scan('large', 'at'), [{ id: 'large', values: [1] }]);
});

test('index transaction commit failure restores the same instance and preserves independent admission', () => {
  const host = sqliteHost(':memory:');
  let fail = false;
  const transaction = fn => host.transaction(() => {
    const answer = fn();
    if (fail) { fail = false; throw new Error('transaction commit refused'); }
    return answer;
  });
  const options = { transaction, runs: { ...small, memtable_bytes: 1 << 20 } };
  let store = recordLogStore(host.sql, options);
  store.write(['large', 'little'].map(type => ({ id: type, type, value: { at: 1 } })));
  store.checkpoint();
  const indexes = ['large', 'little'].map(type => ({ type, name: 'at', paths: [['at']], backfill: 'at-v1' }));
  store = recordLogStore(host.sql, { ...options, indexes });
  // Settle independent checksum work first, leaving only these index builds.
  store.maintain({ left: () => 0 });
  fail = true;
  assert.throws(() => store.maintain(), /transaction commit refused/);
  assert.deepEqual(store.read('large'), { at: 1 }, 'the same instance does not use a rolled-back run');
  assert.equal(store.indexReady('large', 'at'), false);
  store.maintain();
  assert.equal(store.indexReady('little', 'at'), true, 'failed first-group admission survives its rollback');
  store = recordLogStore(host.sql, { ...options, indexes });
  assert.equal(store.indexReady('large', 'at'), false);
  store.maintain();
  assert.equal(store.indexReady('large', 'at'), true);
  assert.deepEqual(store.scan('large', 'at'), [{ id: 'large', values: [1] }]);
});

for (const change of ['replace', 'move', 'remove']) test(`carried index ${change} retires the old value and survives bounded maintenance`, () => {
  const prior = { room: 'before', text: 'a'.repeat(8_000) };
  const current = change === 'remove' ? null : { room: change === 'move' ? 'after' : 'before', text: 'current' };
  const exercises = [false, true].map(carry => {
    const host = sqliteHost(':memory:');
    const options = { transaction: host.transaction,
      indexes: [{ type: 'note', name: 'room', paths: [['room']], ...(carry ? { carry: [['text']] } : {}) }],
      runs: { ...small, big_bytes: 32_768, memtable_bytes: 1 << 20, compaction_debt_min_bytes: 1, compaction_debt_ratio: 0 } };
    let store = recordLogStore(host.sql, options);
    store.write([{ id: 'kept', type: 'note', value: prior }]);
    store.checkpoint();
    store.write([{ id: 'kept', type: 'note', value: current }]);
    store.checkpoint();
    const checksum = store.checksum();
    const debt = store.held().keys.compaction_debt;
    store = recordLogStore(host.sql, options);
    assert.equal(store.held().keys.compaction_debt, debt, 'retirement debt is durable');
    for (let steps = 0; store.maintain({ max_pages: 1 }).more; steps += 1) assert.ok(steps < 200, 'bounded maintenance finishes');
    assert.equal(store.held().keys.compaction_debt, 0);
    store = recordLogStore(host.sql, options);
    assert.deepEqual(store.read('kept'), current);
    assert.deepEqual(store.checksum(), checksum, 'maintenance preserves record checksums');
    assert.deepEqual(store.scan('note', 'room', { equal: ['before'], limit: 10, carried: carry }),
      change === 'replace' ? [{ id: 'kept', values: ['before'], ...(carry ? { carried: { text: 'current' } } : {}) }] : []);
    if (change === 'move') assert.deepEqual(store.scan('note', 'room', { equal: ['after'], limit: 10, carried: carry }),
      [{ id: 'kept', values: ['after'], ...(carry ? { carried: { text: 'current' } } : {}) }]);
    host.db.close();
    return debt;
  });
  assert.ok(exercises[1] - exercises[0] >= prior.text.length * 2,
    `old carried bytes must add retirement debt beyond the same primary record (${exercises.join(', ')})`);
});

test('idle compaction drains overwritten-value debt across incomparable tiers and reopening', () => {
  const host = sqliteHost(':memory:');
  const options = { transaction: host.transaction, runs: { ...small, compaction_debt_min_bytes: 1, compaction_debt_ratio: 0 } };
  let store = recordLogStore(host.sql, options);
  store.write([{ id: 'keep', type: 'note', value: { text: 'a'.repeat(80_000) } }, { id: 'remove', type: 'note', value: { text: 'b'.repeat(80_000) } }]);
  store.checkpoint();
  store.write([{ id: 'keep', type: 'note', value: { text: 'current' } }, { id: 'remove', value: null }]);
  store.checkpoint();
  assert.ok(store.held().keys.compaction_debt > 160_000);
  const bytes = () => host.db.prepare("SELECT SUM(pgsize) AS bytes FROM dbstat WHERE name LIKE 'record_keys_%'").get().bytes;
  const before = bytes();
  store = recordLogStore(host.sql, options);
  assert.ok(store.held().keys.compaction_debt > 160_000, 'debt survives a restart');
  let steps = 0;
  while (store.maintain({ max_pages: 1 }).more) { steps += 1; assert.ok(steps < 100); }
  assert.equal(store.held().keys.compaction_debt, 0);
  assert.equal(store.held().keys.runs.length, 1);
  assert.ok(bytes() < before / 2, 'obsolete big values and tombstones leave the live key tables');
  store = recordLogStore(host.sql, options);
  assert.deepEqual(store.read('keep'), { text: 'current' });
  assert.equal(store.read('remove'), null);
});

test('default compaction folds material obsolete values without a policy override', () => {
  const host = sqliteHost(':memory:');
  const options = { transaction: host.transaction, prefix: 'default_fold', page_bytes: 32_768, big_bytes: 32_768, memtable_bytes: 16 * 1024 * 1024 };
  let state = 31;
  const value = () => Array.from({ length: 8192 }, () => { state ^= state << 13; state ^= state >>> 17; state ^= state << 5; return String.fromCharCode(33 + ((state >>> 0) % 90)); }).join('');
  const expected = new Map(Array.from({ length: 512 }, (_, n) => [`key:${String(n).padStart(4, '0')}`, value()]));
  let store = keptRuns(host.sql, options);
  try {
    for (const [key, text] of expected) store.put(key, text);
    store.flush();
    for (const key of [...expected.keys()].slice(0, 256)) {
      const previous = expected.get(key);
      const text = value();
      expected.set(key, text);
      store.put(key, text, undefined, JSON.stringify(previous).length);
    }
    store.flush();
    const before = store.held();
    const retainedBytes = before.runs.reduce((sum, run) => sum + run.bytes, 0);
    assert.ok(before.compaction_debt >= 1024 * 1024, 'the fixture has enough stale values to pass the default floor');
    assert.ok(before.compaction_debt >= retainedBytes * 0.25, 'the fixture passes the default share of retained run bytes');

    store = keptRuns(host.sql, options);
    assert.equal(store.mergeDue(), true, 'default policy admits the full fold after reopen');
    for (let step = 0; store.mergeDue(); step += 1) {
      assert.ok(step < before.runs.reduce((sum, run) => sum + run.pages, 0) * 2 + 20, 'bounded slices finish');
      const result = store.step({ max_pages: 1 });
      assert.ok(result.pages <= 1, 'the existing page allowance stays intact');
    }
    const after = store.held();
    assert.equal(after.compaction_debt, 0);
    assert.equal(after.runs.length, 1);
    assert.ok(after.runs[0].bytes < retainedBytes * 0.7, 'the fold drops the obsolete values it charged');
    for (const [key, text] of expected) assert.equal(store.get(key), text);
  } finally { host.db.close(); }
});

function counted(host) {
  let written = 0;
  const exec = host.sql.exec.bind(host.sql);
  host.sql.exec = (query, ...params) => {
    const result = exec(query, ...params);
    if (/^\s*(INSERT|UPDATE|DELETE)/i.test(query)) written += host.db.prepare('SELECT changes() AS n').get().n;
    return result;
  };
  return () => written;
}

test('the key space answers like a plain map through flushes, merges and reopening', () => {
  const host = sqliteHost(':memory:');
  let space = keptRuns(host.sql, { transaction: host.transaction, prefix: 'kt', ...small, fan_in: 3 });
  const model = new Map();
  let seed = 7;
  const random = () => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483648; };
  for (let round = 0; round < 3000; round += 1) {
    const key = `k${Math.floor(random() * 400).toString().padStart(4, '0')}`;
    if (random() < 0.2) { space.remove(key); model.delete(key); } else { const value = { round, text: 'x'.repeat(Math.floor(random() * (random() < 0.01 ? 5000 : 60))) }; space.put(key, value); model.set(key, value); }
    if (space.full()) space.flush();
    if (round % 50 === 0) while (space.step({ max_pages: 2 }).more) { /* merge in small steps */ }
    if (round % 500 === 499) { space.flush(); space = keptRuns(host.sql, { transaction: host.transaction, prefix: 'kt', ...small, fan_in: 3 }); }
  }
  for (const [key, value] of model) assert.deepEqual(space.get(key), value, key);
  const expected = [...model.keys()].sort();
  assert.deepEqual(space.range('k', 'l').map(([key]) => key), expected, 'a range walks every live key in order');
  assert.deepEqual(space.range('k', 'l', { reverse: true, limit: 5 }).map(([key]) => key), expected.slice(-5).reverse());
  assert.deepEqual(space.range('k0100', 'k0200').map(([key]) => key), expected.filter(key => key >= 'k0100' && key < 'k0200'));
  assert.ok(space.held().runs.length < 12, `merging keeps the runs few (${space.held().runs.length})`);
});

test('small write-outs merge without copying a much larger base run', () => {
  const host = sqliteHost(':memory:');
  const space = keptRuns(host.sql, { transaction: host.transaction, prefix: 'size_tiers', ...small, big_bytes: 100_000 });
  for (let at = 0; at < 96; at += 1) space.put(`base-${at}`, { text: 'b'.repeat(100) });
  space.flush();
  const base = space.held().runs[0];
  assert.ok(base.bytes > small.memtable_bytes, `base run holds ${base.bytes} bytes`);
  // Each small write-out merges with the small runs written since the base, never with the base itself: a run is
  // copied again only beside at least as many bytes written after it (kept-runs planMerge).
  for (let at = 0; at < 4; at += 1) {
    space.put(`later-${at}`, { text: `later ${at}` });
    space.flush();
    while (space.step({ max_pages: 64 }).more);
  }
  assert.ok(space.held().runs.length <= 3, `${space.held().runs.length} runs after four small write-outs`);
  assert.ok(space.held().runs.some(run => run.run === base.run), 'the large base was not recopied');
  for (let at = 0; at < 64; at += 1) assert.deepEqual(space.get(`base-${at}`), { text: 'b'.repeat(100) });
  for (let at = 0; at < 4; at += 1) assert.deepEqual(space.get(`later-${at}`), { text: `later ${at}` });
});

test('write-outs and mergers keep large values off neighboring key pages', () => {
  const host = sqliteHost(':memory:');
  const open = page_bytes => keptRuns(host.sql, { transaction: host.transaction, prefix: 'page_bound', ...small, page_bytes, big_bytes: 100_000, size_ratio: 1_000_000, max_runs: 2 });
  const earlier = open(8192);
  earlier.put('large', { text: 'z'.repeat(3000) });
  earlier.flush();
  assert.ok(host.db.prepare('SELECT length(body) AS n FROM page_bound_run_1 WHERE page = 0').get().n > 512, 'earlier inline layout has an oversized page');
  const bounded = open(512);
  for (let at = 0; at < 3; at += 1) {
    bounded.put(`later-${at}`, { text: `later ${at}` });
    bounded.flush();
  }
  let steps = 0;
  while (bounded.mergeDue()) {
    bounded.step({ max_pages: 1 });
    assert.ok(++steps < 40, 'bounded steps finish the old-page merge');
  }
  const tables = host.db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'page_bound_run_%'").all();
  for (const { name } of tables.filter(({ name }) => /^page_bound_run_\d+$/.test(name))) {
    const largest = host.db.prepare(`SELECT max(length(body)) AS n FROM ${name} WHERE page >= 0`).get().n ?? 0;
    assert.ok(largest <= 512, `${name} has a ${largest}-character page`);
  }
  assert.deepEqual(bounded.get('large'), { text: 'z'.repeat(3000) });
  for (let at = 0; at < 3; at += 1) assert.deepEqual(bounded.get(`later-${at}`), { text: `later ${at}` });
});

test('selected index prefixes keep exact order and current values across written runs', () => {
  const host = sqliteHost(':memory:');
  const open = () => recordLogStore(host.sql, { transaction: host.transaction, indexes: INDEXES, runs: { ...small, page_bytes: 256 } });
  let store = open();
  for (let round = 0; round < 3; round += 1) {
    const rows = [];
    for (let n = 0; n < 48; n += 1) rows.push({ id: `n${round}-${n}`, type: 'note', value: { room: `r${n % 8}`, at: `t${round}-${String(n).padStart(2, '0')}` } });
    store.write(rows);
    store.checkpoint();
  }
  store.write([
    { id: 'n0-1', type: 'note', value: { room: 'r6', at: 'moved' } },
    { id: 'n1-14', type: 'note', value: null },
  ]);
  store.checkpoint();
  const selected = ['r1', 'r6', 'r1'];
  const expected = selected.slice(0, 2).flatMap(room => store.scan('note', 'room_at', { equal: [room] }))
    .sort((a, b) => a.values[0].localeCompare(b.values[0]) || a.values[1].localeCompare(b.values[1]) || a.id.localeCompare(b.id));
  const exec = host.sql.exec.bind(host.sql);
  let pageQueries = 0;
  host.sql.exec = (query, ...params) => {
    if (/\bFROM record_keys_run_\d+ WHERE page\b/.test(query)) pageQueries += 1;
    return exec(query, ...params);
  };
  store = open();
  pageQueries = 0;
  assert.deepEqual(store.scanFirstValues('note', 'room_at', selected), expected);
  const batchQueries = pageQueries;
  store = open();
  pageQueries = 0;
  for (const room of ['r1', 'r6']) store.scan('note', 'room_at', { equal: [room] });
  assert.ok(batchQueries < pageQueries, `selected ranges used ${batchQueries} page statements; separate scans used ${pageQueries}`);
  assert.deepEqual(store.scanFirstValues('note', 'room_at', []), []);
  assert.ok(expected.every(entry => entry.values[0] === 'r1' || entry.values[0] === 'r6'));
  assert.equal(expected.some(entry => entry.id === 'n1-14'), false, 'removed records stay removed');
});

test('selected values after a fixed prefix batch pages and keep each live top page exact', () => {
  const host = sqliteHost(':memory:');
  const open = selected_scan_budget => recordLogStore(host.sql, {
    transaction: host.transaction, indexes: INDEXES, runs: small,
    ...(selected_scan_budget ? { selected_scan_budget } : {}),
  });
  let store = open();
  for (let round = 0; round < 3; round += 1) {
    const rows = [];
    for (let n = 0; n < 48; n += 1) rows.push({ id: `n${round}-${n}`, type: 'note',
      value: { state: 'open', room: `r${n % 8}`, at: `t${round}-${String(n).padStart(2, '0')}` } });
    store.write(rows);
    store.checkpoint();
  }
  store.write([
    { id: 'n0-1', type: 'note', value: { state: 'open', room: 'r6', at: 'moved' } },
    { id: 'n0-6', type: 'note', value: null },
    { id: 'n1-14', type: 'note', value: null },
  ]);
  store.checkpoint();
  const selected = Array.from({ length: 8 }, (_, n) => `r${n}`);
  const expected = selected.flatMap(room => store.scan('note', 'state_room_at', { equal: ['open', room], limit: 2 }))
    .sort((a, b) => JSON.stringify(a.values).localeCompare(JSON.stringify(b.values)) || a.id.localeCompare(b.id));
  const expectedReverse = selected.flatMap(room => store.scan('note', 'state_room_at', { equal: ['open', room], reverse: true, limit: 2 }))
    .sort((a, b) => JSON.stringify(a.values).localeCompare(JSON.stringify(b.values)) || a.id.localeCompare(b.id)).reverse();
  const exec = host.sql.exec.bind(host.sql);
  let pageQueries = 0;
  host.sql.exec = (query, ...params) => {
    if (/\bFROM record_keys_run_\d+ WHERE page\b/.test(query)) pageQueries += 1;
    return exec(query, ...params);
  };
  store = open();
  pageQueries = 0;
  assert.deepEqual(store.scanSelectedValues('note', 'state_room_at', { equal: ['open'], values: [...selected, 'r1'], limit: 2 }), expected);
  const batched = pageQueries;
  store = open();
  pageQueries = 0;
  for (const room of selected) store.scan('note', 'state_room_at', { equal: ['open', room], limit: 2 });
  assert.ok(batched < pageQueries, `batch used ${batched} page statements; separate scans used ${pageQueries}`);
  assert.deepEqual(store.scanSelectedValues('note', 'state_room_at', { equal: ['open'], values: selected, limit: 0 }), []);

  store = open();
  assert.deepEqual(store.scanSelectedValues('note', 'state_room_at', { equal: ['open'], values: selected, limit: 2, reverse: true }), expectedReverse);
  const boundedOptions = { from: 't1-00', before: 't2-00', reverse: true, limit: 2 };
  const expectedBounded = selected.flatMap(room => store.scan('note', 'state_room_at', { equal: ['open', room], ...boundedOptions }))
    .sort((a, b) => JSON.stringify(a.values).localeCompare(JSON.stringify(b.values)) || a.id.localeCompare(b.id)).reverse();
  store = open();
  assert.deepEqual(store.scanSelectedValues('note', 'state_room_at', { equal: ['open'], values: selected, ...boundedOptions }), expectedBounded);
  store = open({ pages: 0, entries: 0 });
  assert.deepEqual(store.scanSelectedValues('note', 'state_room_at', { equal: ['open'], values: selected, ...boundedOptions }), expectedBounded, 'budget fallback keeps the same reverse time window');

  store = open({ pages: 0, entries: 0 });
  pageQueries = 0;
  assert.deepEqual(store.scanSelectedValues('note', 'state_room_at', { equal: ['open'], values: selected, limit: 2 }), expected);
  assert.ok(pageQueries > 0, 'budget fallback reads the bounded individual prefixes');
  assert.equal(expected.some(entry => entry.id === 'n1-14' || entry.id === 'n0-6'), false);
});

test('catalog, run metadata and keyed pages read without materializing SQLite result sets', () => {
  const host = sqliteHost(':memory:');
  const exec = host.sql.exec.bind(host.sql);
  host.sql.exec = (query, ...params) => {
    const cursor = exec(query, ...params);
    if (!(/SELECT run(?:,| FROM) .*kt_runs/.test(query) || /SELECT first FROM kt_run_/.test(query)
      || /SELECT body FROM kt_run_.*page (?:<|=)/.test(query) || /SELECT value FROM kt_meta WHERE key = \?/.test(query))) return cursor;
    return new Proxy(cursor, { get(target, key) {
      if (key === 'toArray') return () => { throw new Error('catalog result was materialized'); };
      const value = Reflect.get(target, key, target);
      return typeof value === 'function' ? value.bind(target) : value;
    } });
  };
  const space = keptRuns(host.sql, { transaction: host.transaction, prefix: 'kt', ...small });
  for (let index = 0; index < 100; index += 1) space.put(`key-${index}`, { index });
  space.flush({ covered: 42 });
  const reopened = keptRuns(host.sql, { transaction: host.transaction, prefix: 'kt', ...small, filter_bytes: 0 });
  reopened.reloadCatalog();
  assert.equal(reopened.covered(), 42, 'the keyed metadata read does not materialize its SQL cursor');
  assert.deepEqual(reopened.get('key-99'), { index: 99 });
  assert.equal(reopened.get('absent'), undefined);
});

test('catalog reload restores an omitted filter when another run leaves', () => {
  const host = sqliteHost(':memory:');
  const space = keptRuns(host.sql, { transaction: host.transaction, prefix: 'kt', ...small, filter_bytes: 64 });
  space.put('a', 1);
  space.put('z', 2);
  space.flush();
  space.put('b', 3);
  space.put('y', 4);
  space.flush();
  space.reloadCatalog();
  const [newer, older] = space.held().runs;
  let pageReads = 0, filterProbes = 0;
  const exec = host.sql.exec.bind(host.sql);
  host.sql.exec = (query, ...params) => {
    if (/SELECT body FROM kt_run_\d+ WHERE page = \?/.test(query)) pageReads += 1;
    if (/WITH filter_chunks AS MATERIALIZED/.test(query) && /LEFT JOIN kt_run_\d+ AS filter/.test(query)) filterProbes += 1;
    return exec(query, ...params);
  };
  assert.equal(space.get('m'), undefined);
  assert.equal(filterProbes, 1, 'an omitted resident filter probes its persisted membership bytes');
  assert.equal(pageReads, 0, 'a negative membership probe does not read a data page');
  host.transaction(() => {
    host.sql.exec('DELETE FROM kt_runs WHERE run = ?', newer.run);
    host.sql.exec(`DROP TABLE kt_run_${newer.run}`);
  });
  space.reloadCatalog();
  pageReads = 0;
  filterProbes = 0;
  assert.equal(space.get('m'), undefined);
  assert.equal(pageReads, 0, 'reload uses the newly available filter budget');
  assert.equal(filterProbes, 0, 'the restored resident filter needs no sparse SQL probe');
  assert.equal(space.get('a'), 1);
  assert.equal(space.held().runs[0].run, older.run);
});

test('a write is one log row, an unchanged write appends nothing, and reads come back fresh', () => {
  const host = sqliteHost(':memory:');
  const written = counted(host);
  const store = recordLogStore(host.sql, { transaction: host.transaction, indexes: INDEXES, runs: small });
  const before = written();
  store.write([{ id: 'n1', type: 'note', value: { at: '2026-10-05T10:00:00Z', room: 'a', text: 'hello', tags: ['x'] } }, { id: 'n2', type: 'note', value: { at: '2026-10-05T10:01:00Z', room: 'b', text: 'two' } }]);
  assert.equal(written() - before, 1, 'two records, one row written');
  const mid = written();
  store.write([{ id: 'n1', type: 'note', value: { at: '2026-10-05T10:00:00Z', room: 'a', text: 'hello', tags: ['x'] } }]);
  assert.equal(written(), mid, 'nothing changed, nothing written');
  const copy = store.read('n1');
  copy.tags.push('y');
  assert.deepEqual(store.read('n1').tags, ['x'], 'a copy handed out never changes what is kept');
  store.write([{ id: 'n1', type: 'note', value: null }]);
  assert.equal(store.read('n1'), null);
  assert.equal(store.typeOf('n2'), 'note');
});

test('a restart and a rolled-back transaction rebuild the projection from the log', () => {
  const host = sqliteHost(':memory:');
  let store = recordLogStore(host.sql, { transaction: host.transaction, indexes: INDEXES, runs: small });
  for (let n = 0; n < 200; n += 1) store.write([{ id: `n${n}`, type: 'note', value: { at: `t${String(n).padStart(4, '0')}`, room: `r${n % 3}`, text: 'w'.repeat(40) } }]);
  store = recordLogStore(host.sql, { transaction: host.transaction, indexes: INDEXES, runs: small });
  for (let n = 0; n < 200; n += 1) assert.equal(store.read(`n${n}`).at, `t${String(n).padStart(4, '0')}`);
  // A rollback reported through forgetCached.
  assert.throws(() => host.transaction(() => { store.write([{ id: 'gone', type: 'note', value: { at: 'z' } }]); throw new Error('boom'); }));
  store.forgetCached();
  assert.equal(store.read('gone'), null);
  // A rollback nobody reported: the next write finds the log shorter than the projection and rebuilds it first.
  assert.throws(() => host.transaction(() => { store.write([{ id: 'ghost', type: 'note', value: { at: 'z' } }]); throw new Error('boom'); }));
  store.write([{ id: 'real', type: 'note', value: { at: 'y' } }]);
  assert.equal(store.read('ghost'), null, 'the unreported rollback is not kept');
  assert.equal(store.read('real').at, 'y');
  assert.deepEqual(store.ids('note').filter(id => id === 'ghost'), []);
});

test('cold replay batches prior records across fragmented runs without point-reading their pages', t => {
  const host = sqliteHost(':memory:');
  const runs = { ...small, memtable_bytes: 1 << 20, filter_bytes: 0 };
  const method = { name: 'shared-method' };
  const source = { name: 'shared-source' };
  const open = () => recordLogStore(host.sql, {
    transaction: host.transaction, runs,
    indexes: [...INDEXES, { type: 'note', name: 'method_name', paths: [['method', 'name']] },
      { type: 'clip', name: 'source_name', paths: [['source', 'name']] }],
    contentId: type => type === 'note/method' ? 'method:shared' : type === 'clip/source' ? 'source:shared' : null,
  });
  let store = open();
  // Each run spans nearly the same id range, so an absent-key lookup probes
  // many run pages when the persisted filters are outside the memory budget.
  for (let round = 0; round < 12; round += 1) {
    const rows = Array.from({ length: 32 }, (_, index) => {
      const n = index * 12 + round;
      return { id: `n${String(n).padStart(4, '0')}`, type: 'note', value: { at: `t${n}`, room: 'before', method } };
    });
    if (round === 0) rows.push({ id: 'source:shared', type: 'clip/source', value: source });
    store.write(rows);
    store.checkpoint();
  }
  for (let n = 0; n < 256; n += 1) {
    store.write([{ id: `n${String(n).padStart(4, '0')}`, type: 'note', value: { at: `changed-${n}`, room: 'after', method } }]);
  }
  store.write([{ id: 'n0001', type: 'note', value: null }]);
  store.write([{ id: 'n0002', type: 'note', value: { at: 'changed-again', room: 'after', method } }]);
  store.write([{ id: 'n0003', type: 'clip', value: { source } }]);
  const exec = host.sql.exec.bind(host.sql);
  let pointReads = 0;
  let groupedReads = 0;
  host.sql.exec = (query, ...params) => {
    if (/SELECT body FROM record_keys_run_\d+ WHERE page = \?/.test(query)) pointReads += 1;
    if (/SELECT page, body FROM record_keys_run_\d+ WHERE page IN/.test(query)) groupedReads += 1;
    return exec(query, ...params);
  };
  store = open();
  t.diagnostic(`cold replay used ${pointReads} point reads and ${groupedReads} grouped statements`);
  assert.equal(pointReads, 0, 'replay does not ask SQLite for one run page per prior record');
  assert.ok(groupedReads > 0 && groupedReads <= 48, `replay grouped run pages in ${groupedReads} statements`);
  assert.deepEqual(store.read('n0001'), null, 'the removed record stays removed');
  assert.deepEqual(store.read('n0002'), { at: 'changed-again', room: 'after', method });
  assert.deepEqual(store.read('n0255'), { at: 'changed-255', room: 'after', method });
  assert.deepEqual(store.read('n0300'), { at: 't300', room: 'before', method });
  assert.deepEqual(store.fields.idsWhere('note', 'room', 'after').length, 254);
  assert.deepEqual(store.scan('clip', 'source_name', { equal: ['shared-source'] }).map(row => row.id), ['n0003']);
});

test('a fragmented record bucket walk streams run pages without one SQL statement per page', () => {
  const host = sqliteHost(':memory:');
  const runs = { ...small, cache_bytes: 512, filter_bytes: 0, memtable_bytes: 1 << 20 };
  const open = () => recordLogStore(host.sql, { transaction: host.transaction, runs });
  let store = open();
  for (let round = 0; round < 12; round += 1) {
    store.write(Array.from({ length: 32 }, (_, index) => {
      const number = index * 12 + round;
      return { id: `n${String(number).padStart(4, '0')}`, type: 'note', value: { title: `note ${number}`, text: 'x'.repeat(50) } };
    }));
    store.checkpoint();
  }
  store = open();
  const exec = host.sql.exec.bind(host.sql);
  let pointReads = 0;
  let streamedReads = 0;
  host.sql.exec = (query, ...params) => {
    if (/SELECT body FROM record_keys_run_\d+ WHERE page = \?/.test(query)) pointReads += 1;
    if (/SELECT page, body FROM record_keys_run_\d+ WHERE page >= \? AND page <= \? ORDER BY page/.test(query)) streamedReads += 1;
    return exec(query, ...params);
  };
  const page = store.recordsInBucketsPage(Array.from({ length: 256 }, (_, index) => index), { limit: 500, examine: 2000 });
  assert.equal(page.records.length, 384);
  assert.equal(page.next, null);
  assert.deepEqual(page.records.map(record => record.id), [...page.records.map(record => record.id)].sort());
  assert.equal(page.records[0].value.title, 'note 0');
  assert.equal(page.records.at(-1).value.title, 'note 383');
  assert.equal(pointReads, 0, 'current inline records need no per-page SQL lookup during a scan');
  assert.ok(streamedReads > 0 && streamedReads <= 12, `each of 12 runs needs at most one ordered SQL cursor (${streamedReads})`);
  pointReads = 0;
  streamedReads = 0;
  assert.deepEqual(store.ids('note'), Array.from({ length: 384 }, (_, index) => `n${String(index).padStart(4, '0')}`));
  assert.equal(pointReads, 0, 'listing a record type does not reopen every run page');
  assert.ok(streamedReads > 0 && streamedReads <= 12, `listing uses at most one cursor per run (${streamedReads})`);
});

test('a bucket page skips unwanted spilled values before reading their bytes', () => {
  const host = sqliteHost(':memory:');
  const open = () => recordLogStore(host.sql, { transaction: host.transaction, runs: small });
  const wantedId = 'z-wanted';
  let unwantedId = 'a-unwanted';
  while (bucketOf(unwantedId) === bucketOf(wantedId)) unwantedId += 'x';
  let store = open();
  store.write([
    { id: unwantedId, type: 'note', value: { text: 'x'.repeat(128_000) } },
    { id: wantedId, type: 'note', value: { text: 'wanted' } },
  ]);
  store.checkpoint();
  assert.ok(host.db.prepare('SELECT count(*) AS n FROM record_keys_big').get().n > 0,
    'the unwanted record is stored in the spilled-value table');
  store = open(); // Cold cache: opening the unwanted value now has to query the spilled bytes.
  const exec = host.sql.exec.bind(host.sql);
  let bigReads = 0;
  host.sql.exec = (query, ...params) => {
    if (/SELECT body FROM record_keys_big WHERE ref = \? ORDER BY part/.test(query)) bigReads += 1;
    return exec(query, ...params);
  };
  const first = store.recordsInBucketsPage([bucketOf(wantedId)], { examine: 1 });
  assert.deepEqual(first.records.map(record => [record.id, record.value.text]), [[wantedId, 'wanted']], 'ready directory seeks the matching head directly');
  assert.equal(first.next, wantedId);
  assert.equal(bigReads, 0, 'a filtered record never reads its spilled value');
  const second = store.recordsInBucketsPage([bucketOf(wantedId)], { after: first.next, examine: 1 });
  assert.deepEqual(second, { records: [], next: null }, 'strict matching-head cursor terminates without repeating the record');
  assert.equal(bigReads, 0);
});

test('ordered walks stream uncached spans and reuse resident run pages', () => {
  const host = sqliteHost(':memory:');
  const open = () => keptRuns(host.sql, { transaction: host.transaction, prefix: 'cached_walk', ...small, page_bytes: 256, cache_bytes: 1 << 20 });
  let space = open();
  for (let index = 0; index < 64; index += 1) space.put(`k${String(index).padStart(4, '0')}`, index);
  space.flush();
  space = open();
  assert.equal(space.get('k0032'), 32, 'a point read leaves one page resident');
  const exec = host.sql.exec.bind(host.sql);
  let streams = 0;
  host.sql.exec = (query, ...params) => {
    if (/^SELECT page, body FROM cached_walk_run_\d+ WHERE page >= \? AND page <= \? ORDER BY page$/.test(query)) streams += 1;
    return exec(query, ...params);
  };
  const expected = Array.from({ length: 64 }, (_, index) => [`k${String(index).padStart(4, '0')}`, index]);
  assert.deepEqual([...space.walk('k', 'l')], expected);
  assert.equal(streams, 2, 'the resident page splits the cold run into two streamed spans');
  assert.deepEqual([...space.walk('k', 'l')], expected);
  assert.equal(streams, 2, 'a warm walk rereads no run pages from SQLite');
});

test('ordered walks preserve newest values and close lazy SQL cursors on early exit and open failure', () => {
  const host = sqliteHost(':memory:');
  const space = keptRuns(host.sql, { transaction: host.transaction, prefix: 'walk_cursor', ...small, page_bytes: 128, memtable_bytes: 1 << 20 });
  for (let run = 0; run < 3; run += 1) {
    for (let index = 0; index < 20; index += 1) space.put(`k${String(index).padStart(4, '0')}`, { run, text: 'x'.repeat(40) });
    space.flush();
  }
  space.remove('k0003');
  space.put('k0007', { run: 'memory' });
  const pages = space.held().runs.reduce((count, run) => count + run.pages, 0);
  const exec = host.sql.exec.bind(host.sql);
  let calls = 0;
  let active = 0;
  let read = 0;
  let failAt = -1;
  host.sql.exec = (query, ...params) => {
    if (!/^SELECT page, body FROM walk_cursor_run_\d+ WHERE page >= \? AND page <= \? ORDER BY page$/.test(query)) return exec(query, ...params);
    calls += 1;
    if (calls === failAt) throw new Error('stream open failed');
    const iterator = host.db.prepare(query).iterate(...params);
    active += 1;
    return {
      [Symbol.iterator]() {
        return {
          next() { read += 1; return iterator.next(); },
          return() { active -= 1; iterator.return(); return { done: true }; },
        };
      },
    };
  };
  const early = space.walk('k', 'l');
  assert.equal(early.next().value[0], 'k0000');
  assert.ok(active > 0 && active <= 3, `the uncached runs opened ${active} cursors`);
  assert.ok(read < pages, `early exit read ${read} of ${pages} run pages`);
  early.return();
  assert.equal(active, 0, 'all live SQL cursors close when the caller stops early');
  const walked = [...space.walk('k', 'l')];
  assert.deepEqual(walked, space.range('k', 'l'), 'duplicates, a tombstone and a memtable override match the established range');
  assert.equal(walked.length, 19);
  assert.equal(walked.find(([key]) => key === 'k0007')[1].run, 'memory');
  assert.equal(walked.find(([key]) => key === 'k0008')[1].run, 2);
  assert.deepEqual([...space.walk('k0005', 'k0013')], space.range('k0005', 'k0013'), 'a bounded walk starts and ends at the same keys');
  assert.equal(active, 0, 'full and bounded walks release their cursors');
  failAt = calls + 2;
  assert.throws(() => space.walk('k', 'l').next(), /stream open failed/);
  assert.equal(active, 0, 'a later source failing to open closes the sources already opened');
});

test('filtered ordered walks keep winner and tombstone semantics without opening skipped values', () => {
  const host = sqliteHost(':memory:');
  const open = () => keptRuns(host.sql, { transaction: host.transaction, prefix: 'filtered_walk', ...small, cache_bytes: 512 });
  let space = open();
  space.put('a', { text: 'a'.repeat(128_000) });
  space.put('b', { text: 'b'.repeat(128_000) });
  space.put('c', { text: 'c'.repeat(128_000) });
  space.flush();
  space.put('b', { text: 'new winner' });
  space.remove('c');
  space.flush();
  space = open();
  const exec = host.sql.exec.bind(host.sql);
  let bigReads = 0;
  host.sql.exec = (query, ...params) => {
    if (/SELECT body FROM filtered_walk_big WHERE ref = \? ORDER BY part/.test(query)) bigReads += 1;
    return exec(query, ...params);
  };
  assert.deepEqual([...space.walk('a', 'd', { readValue: key => key === 'b' })],
    [['a', undefined], ['b', { text: 'new winner' }]],
    'a skipped live key remains visible, a replaced value stays hidden, and a tombstone remains absent');
  assert.equal(bigReads, 0, 'the rejected large values and older overwritten values are never opened');
});

test('large prior values split replay, and a failed grouped page read retries across the multipart boundary', () => {
  const host = sqliteHost(':memory:');
  const runs = { ...small, memtable_bytes: 32 * 1024 * 1024, filter_bytes: 0 };
  const method = { name: 'large-method' };
  const open = () => recordLogStore(host.sql, {
    transaction: host.transaction, runs,
    indexes: [{ type: 'note', name: 'method_name', paths: [['method', 'name']] }],
    contentId: type => type === 'note/method' ? 'method:large' : null,
  });
  const large = 'x'.repeat(4 * 1024 * 1024);
  const changedLarge = 'y'.repeat(4 * 1024 * 1024);
  let store = open();
  store.write([{ id: 'large', type: 'note', value: { method, text: large, version: 1 } }]);
  store.checkpoint();
  for (let n = 0; n < 15; n += 1) store.write([{ id: `small-${n}`, type: 'note', value: { version: n } }]);
  store.write([{ id: 'large', type: 'note', value: { method, text: changedLarge, version: 2 } }]);
  assert.ok(host.sql.exec('SELECT parts FROM record_log ORDER BY rowid DESC LIMIT 1').one().parts > 16,
    'the changed large value spans the next 16-row replay page');

  const exec = host.sql.exec.bind(host.sql);
  let failed = false;
  let fetchedPage = null;
  host.sql.exec = (query, ...params) => {
    const cursor = exec(query, ...params);
    if (!failed && /SELECT page, body FROM record_keys_run_\d+ WHERE page IN \(SELECT value FROM json_each\(\?\)\)/.test(query)) {
      const rows = cursor[Symbol.iterator]();
      let yielded = false;
      return {
        [Symbol.iterator]() { return this; },
        next() {
          if (yielded) { failed = true; throw new Error('injected linked-record read failure'); }
          const row = rows.next();
          if (!row.done) { yielded = true; fetchedPage = row.value.page; }
          return row;
        },
        return() { rows.return?.(); return { done: true }; },
      };
    }
    return cursor;
  };
  assert.throws(() => store.forgetCached(), /injected linked-record read failure/);
  assert.equal(failed, true, 'the replay failed only after receiving its first grouped page');
  assert.ok(Number.isSafeInteger(fetchedPage), 'the grouped page reader delivered one page before failing');
  host.sql.exec = exec;
  assert.equal(store.read('large').version, 2, 'the same store replays again after failure');
  assert.equal(store.read('large').text, changedLarge);
  assert.equal(store.read('small-14').version, 14);
  store = open();
  assert.equal(store.read('large').version, 2, 'a second cold open crosses the split log row too');
  assert.deepEqual(store.scan('note', 'method_name', { equal: ['large-method'] }).map(row => row.id), ['large']);
});

test('declared indexes answer ranges, equal values, groups and field reads; undeclared ones are refused', () => {
  const host = sqliteHost(':memory:');
  const store = recordLogStore(host.sql, { transaction: host.transaction, indexes: INDEXES, runs: small });
  const notes = Array.from({ length: 60 }, (_, n) => ({ id: `n${String(n).padStart(2, '0')}`, type: 'note', value: { at: `2026-10-05T10:${String(n).padStart(2, '0')}:00Z`, room: `r${n % 4}`, text: `note ${n}`, input: { goal: n % 2 ? 'odd goal' : 'even goal' } } }));
  for (const note of notes) store.write([note]);
  store.write([{ id: 'n10', type: 'note', value: { ...notes[10].value, room: 'moved' } }]);
  assert.deepEqual(store.fields.after('note', 'at', '2026-10-05T10:57:00Z', ['room']).map(r => r.id), ['n58', 'n59']);
  assert.deepEqual(store.fields.idsWhere('note', 'room', 'moved'), ['n10']);
  assert.equal(store.fields.idsWhere('note', 'room', 'r2').length, 14, 'n10 moved out of r2');
  const groups = store.fields.newestPerGroup('note', { group: 'room', order: 'at', fields: ['text'] });
  assert.deepEqual(groups.map(g => [g.room, g.id]).sort(), [['moved', 'n10'], ['r0', 'n56'], ['r1', 'n57'], ['r2', 'n58'], ['r3', 'n59']]);
  assert.equal(store.scan('note', 'goal', { equal: ['odd goal'] }).length, 30);
  assert.deepEqual(store.scan('note', 'at', { reverse: true, limit: 2 }).map(e => e.id), ['n59', 'n58']);
  assert.equal(store.scan('note', 'at', { from: '2026-10-05T10:10:00Z', to: '2026-10-05T10:19:00Z' }).length, 10);
  assert.deepEqual(store.ids('note', { limit: 3 }), ['n59', 'n58', 'n57']);
  assert.deepEqual(store.fields.fieldsOf('note', ['n01', 'nope'], ['text', 'input']).get('n01'), { id: 'n01', text: 'note 1' });
  assert.throws(() => store.fields.idsWhere('note', 'text', 'x'), /No index on text/);
  assert.deepEqual(store.find({ words: ['note', '5'], fields: [['text']], limit: 3 }).map(r => r.id), ['n59', 'n58', 'n57']);
  assert.deepEqual(store.find({ words: ['note 1'], fields: [['input', 'goal'], ['text']], types: ['note'], limit: 2 }).map(r => [r.id, r.title]), [['n19', 'odd goal'], ['n18', 'even goal']], 'the first named field holding words is the title');
});

test('generated edits and deletes keep declared indexes equal to the current records across reopen and maintenance', () => {
  const host = sqliteHost(':memory:');
  const open = () => recordLogStore(host.sql, { transaction: host.transaction, indexes: INDEXES, runs: small });
  let store = open();
  const model = new Map();
  let seed = 0x83a3;
  const pick = bound => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return Math.floor(seed / 2 ** 32 * bound); };
  const ids = Array.from({ length: 24 }, (_, n) => `generated-${n}`);
  const rooms = ['north', 'south', 'east', 'west'];
  const goals = ['draft', 'review', 'send'];

  const check = step => {
    for (const id of ids) assert.deepEqual(store.read(id), model.get(id) ?? null, `record ${id} after edit ${step}`);
    for (const room of rooms) {
      const expected = [...model].filter(([, value]) => value.room === room).map(([id]) => id).sort();
      assert.deepEqual(store.fields.idsWhere('note', 'room', room).sort(), expected, `room index ${room} after edit ${step}`);
      assert.deepEqual(store.scan('note', 'room', { equal: [room] }).map(row => row.id).sort(), expected, `room scan ${room} after edit ${step}`);
    }
    for (const at of ['t00', 't07', 't15']) {
      const expected = [...model].filter(([, value]) => value.at === at).map(([id]) => id).sort();
      assert.deepEqual(store.fields.idsWhere('note', 'at', at).sort(), expected, `time index ${at} after edit ${step}`);
    }
    for (const goal of goals) {
      const expected = [...model].filter(([, value]) => value.input?.goal === goal).map(([id]) => id).sort();
      assert.deepEqual(store.scan('note', 'goal', { equal: [goal] }).map(row => row.id).sort(), expected, `nested goal index ${goal} after edit ${step}`);
    }
  };

  for (let step = 0; step < 240; step += 1) {
    const id = ids[pick(ids.length)];
    if (pick(5) === 0) {
      store.write([{ id, type: 'note', value: null }]);
      model.delete(id);
    } else {
      const value = { text: `edit ${step}` };
      if (pick(6) !== 0) value.room = rooms[pick(rooms.length)];
      if (pick(6) !== 0) value.at = `t${String(pick(16)).padStart(2, '0')}`;
      if (pick(6) !== 0) value.input = { goal: goals[pick(goals.length)] };
      store.write([{ id, type: 'note', value }]);
      model.set(id, value);
    }
    if (step % 29 === 0) { check(step); store = open(); check(step); }
    if (step % 37 === 0) { while (store.maintain({ max_pages: 3 }).more) { /* finish bounded maintenance */ } check(step); }
  }
  store = open();
  check('final reopen');
});

test('content-addressed objects are kept once, big values survive merges, and list parts read and write in place', () => {
  const host = sqliteHost(':memory:');
  const store = recordLogStore(host.sql, { transaction: host.transaction, indexes: INDEXES, runs: small, contentId: (type, value) => (type === 'note/method' ? `method:${value.name}` : null) });
  const method = { name: 'm1', steps: Array.from({ length: 30 }, (_, n) => ({ n, say: 'step' })) };
  for (let n = 0; n < 40; n += 1) store.write([{ id: `n${n}`, type: 'note', value: { at: `t${n}`, method, big: 'B'.repeat(n === 7 ? 9000 : 10) } }]);
  assert.equal(store.typeOf('method:m1'), 'note/method');
  assert.deepEqual(store.read('n3').method, method);
  for (let round = 0; round < 30; round += 1) store.write([{ id: `x${round}`, type: 'note', value: { at: `u${round}`, text: 'y'.repeat(300) } }]);
  while (store.maintain({ max_pages: 3 }).more) { /* merge everything due */ }
  assert.equal(store.read('n7').big.length, 9000, 'a value bigger than a page is read back after merges');
  store.write([{ id: 'list', type: 'note', value: { at: 'v', guidance: [{ step_id: 'a', said: 1 }] } }]);
  store.writeMember('list', 'note', 'guidance', 1, { step_id: 'b', said: 2 });
  assert.equal(store.memberCount('list', 'guidance'), 2);
  assert.deepEqual(store.readMember('list', 'guidance', 1), { step_id: 'b', said: 2 });
  assert.deepEqual(store.memberFields('list', 'guidance', ['said'], [1]), [{ ordinal: 1, said: 2 }]);
  assert.deepEqual(store.membersWhere('list', 'guidance', 'step_id', 'a'), [0]);
  store.writeOwn('list', 'note', { at: 'w', guidance: [] }, ['guidance']);
  assert.equal(store.read('list').at, 'w');
  assert.equal(store.read('list').guidance.length, 2, 'fields left out of writeOwn are kept');
  assert.deepEqual(store.readOwn('list', ['guidance']), { at: 'w' });
});

test('the log seals a generation once it is written out, and its pages read back in order', () => {
  const host = sqliteHost(':memory:');
  const store = recordLogStore(host.sql, { transaction: host.transaction, indexes: INDEXES, runs: small });
  for (let n = 0; n < 20; n += 1) store.write([{ id: `n${n}`, type: 'note', value: { at: `t${n}` } }]);
  const sealed = store.sealLog();
  assert.deepEqual(store.sealedLogs(), [sealed]);
  const { rows } = store.sealedLogPage(sealed, 0, 100);
  assert.equal(rows.length, 20);
  store.keepSealedLogThrough(sealed, 20);
  store.dropSealedLog(sealed);
  const again = recordLogStore(host.sql, { transaction: host.transaction, indexes: INDEXES, runs: small });
  for (let n = 0; n < 20; n += 1) assert.equal(again.read(`n${n}`).at, `t${n}`, 'every record survives its log generation leaving');
});

test('unchanged sealed generations do not rescan SQLite tables; seal, drop and rollback refresh the list', () => {
  const host = sqliteHost(':memory:');
  const store = recordLogStore(host.sql, { transaction: host.transaction, indexes: INDEXES, runs: small });
  const exec = host.sql.exec.bind(host.sql);
  let scans = 0;
  host.sql.exec = (query, ...params) => {
    if (query.includes('FROM sqlite_master') && query.includes('name GLOB')) scans += 1;
    return exec(query, ...params);
  };
  assert.deepEqual(store.sealedLogs(), []);
  assert.deepEqual(store.sealedLogs(), []);
  assert.equal(scans, 1, 'repeated due checks inspect the catalog once');
  store.write([{ id: 'n1', type: 'note', value: { at: 't1' } }]);
  const sealed = store.sealLog();
  assert.deepEqual(store.sealedLogs(), [sealed]);
  assert.equal(scans, 2, 'a committed seal refreshes the list');
  store.sealedLogs().push('not-a-table');
  assert.deepEqual(store.sealedLogs(), [sealed], 'a caller cannot change remembered names');
  store.dropSealedLog(sealed);
  assert.deepEqual(store.sealedLogs(), []);
  assert.equal(scans, 3, 'a committed drop refreshes the list');
  store.write([{ id: 'n2', type: 'note', value: { at: 't2' } }]);
  assert.throws(() => host.transaction(() => { store.sealLog(); assert.equal(store.sealedLogs().length, 1); throw new Error('roll back'); }), /roll back/);
  store.forgetCached();
  assert.deepEqual(store.sealedLogs(), [], 'the rolled-back generation is absent after cache invalidation');
  assert.equal(scans, 5, 'rollback also refreshes the catalog');
});

test('small quiet writes stay batched with durable replay bounded by log rows', () => {
  const host = sqliteHost(':memory:');
  const runs = { ...small, memtable_bytes: 1 << 20, tail_rows: 4 };
  const store = recordLogStore(host.sql, { transaction: host.transaction, runs });
  assert.equal(store.maintenanceAt(), null, 'nothing to do in an empty store');
  for (let i = 1; i <= 3; i += 1) store.write([{ id: `n${i}`, type: 'note', value: { text: `note ${i}` } }]);
  store.maintain({ max_pages: 256 }, Date.now() + 60_000);
  assert.ok(store.held().keys.memtable_bytes > 0, 'quiet time alone creates no small run');
  assert.equal(store.maintenanceAt(), null);
  const reads = [];
  const exec = host.sql.exec.bind(host.sql);
  host.sql.exec = (query, ...params) => { if (/FROM record_log WHERE rowid >/.test(query)) reads.push(...exec(query, ...params).toArray()); return exec(query, ...params); };
  const reopened = recordLogStore(host.sql, { transaction: host.transaction, runs });
  for (let i = 1; i <= 3; i += 1) assert.deepEqual(reopened.read(`n${i}`), { text: `note ${i}` });
  assert.equal(reads.length, 3, 'the durable tail replays within its row bound');
  reopened.write([{ id: 'n4', type: 'note', value: { text: 'note 4' } }]);
  assert.equal(reopened.held().keys.memtable_bytes, 0, 'the next write flushes at the tail-row bound');
  assert.deepEqual(reopened.read('n4'), { text: 'note 4' });
});

test('a store without a kept checksum builds it a page at a time across writes and a restart, never in one call', () => {
  const host = sqliteHost(':memory:');
  const note = n => ({ at: `t${n}`, room: `r${n % 3}`, text: 'w'.repeat(30) });
  const model = new Map();
  const put = (store, id, value) => { store.write([{ id, type: 'note', value }]); if (value === null) model.delete(id); else model.set(id, value); };
  let store = recordLogStore(host.sql, { transaction: host.transaction, runs: small });
  for (let n = 0; n < 1200; n += 1) put(store, `n${String(n).padStart(4, '0')}`, note(n));
  store.checkpoint();
  // Pages written before the checksum was kept: the write-out holds only how far the log it covers.
  const meta = keptRuns(host.sql, { transaction: host.transaction, prefix: 'record_keys', ...small }).meta;
  meta.set('covered', meta.get('covered').at);
  const open = () => recordLogStore(host.sql, { transaction: host.transaction, runs: small, checksum_page: 100 });
  store = open();
  assert.deepEqual(store.checksum({ build: false }), { root: null, buckets: null });
  assert.equal(meta.get('sums_build'), undefined, 'the side a copy settles against walks nothing');
  assert.deepEqual(store.checksum(), { root: null, buckets: null }, 'one call walks one page and answers no checksum yet');
  assert.ok(store.maintenanceAt() !== null, 'the rest of the build is idle work');
  store.maintain({ max_pages: 256 });
  // Writes to records already walked and not yet walked, kept with the next page, then more after it, then a restart.
  put(store, 'n0005', { ...note(5), text: 'changed' });
  put(store, 'n1100', { ...note(1100), text: 'changed too' });
  put(store, 'a-new', note(9999));
  store.maintain({ max_pages: 256 });
  put(store, 'n0010', null);
  put(store, 'n0150', { ...note(150), text: 'after the kept page' });
  store = open();
  let calls = 0;
  while (store.checksum().root === null) { store.maintain({ max_pages: 256 }); calls += 1; assert.ok(calls < 30); }
  assert.ok(calls >= 5, `the build took ${calls} more pages`);
  const built = store.checksum().root;
  assert.equal(open().checksum().root, built, 'kept with the pages once built');
  for (const [id, value] of model) assert.deepEqual(store.read(id), value);
  // The same store walked whole in one call: the paged build with writes and a restart between pages agrees.
  meta.set('covered', meta.get('covered').at);
  const whole = recordLogStore(host.sql, { transaction: host.transaction, runs: small, checksum_page: Infinity });
  assert.equal(whole.checksum().root, built, 'the built checksum is the checksum of what the store holds');
});

test('idle work merges runs before it walks records for the checksum', () => {
  const host = sqliteHost(':memory:');
  let store = recordLogStore(host.sql, { transaction: host.transaction, runs: small });
  // Many small runs, as a move that wrote out a run per batch left them.
  for (let n = 0; n < 40; n += 1) { store.write([{ id: `n${String(n).padStart(4, '0')}`, type: 'note', value: { text: 'w'.repeat(30) } }]); store.checkpoint(); }
  const meta = keptRuns(host.sql, { transaction: host.transaction, prefix: 'record_keys', ...small }).meta;
  meta.set('covered', meta.get('covered').at);
  store = recordLogStore(host.sql, { transaction: host.transaction, runs: small, checksum_page: 10 });
  const runs = () => store.held().keys.runs.length;
  assert.ok(runs() > 16, `${runs()} runs`);
  let merging = 0;
  while (store.maintain({ max_pages: 1 }).more) {
    if (meta.get('merge') !== undefined || runs() > 16) { assert.equal(meta.get('sums_build'), undefined, 'no record walked while runs wait to merge'); merging += 1; }
    assert.ok(merging < 500);
  }
  assert.ok(merging > 0);
  assert.ok(store.checksum({ build: false }).root !== null, 'built once the merges were done');
  assert.ok(runs() <= 16, `${runs()} runs left`);
});

test('one idle wake merges several small runs, writing no more pages than its budget', () => {
  const host = sqliteHost(':memory:');
  const store = recordLogStore(host.sql, { transaction: host.transaction, runs: small });
  for (let n = 0; n < 60; n += 1) { store.write([{ id: `n${String(n).padStart(4, '0')}`, type: 'note', value: { text: 'w'.repeat(30) } }]); store.checkpoint(); }
  let pagesWritten = 0;
  const exec = host.sql.exec.bind(host.sql);
  host.sql.exec = (query, ...params) => { if (/^INSERT INTO record_keys_run_\d+ \(page,/.test(query)) pagesWritten += 1; return exec(query, ...params); };
  store.maintain({ max_pages: 3 });
  // A merge that ends within the budget writes its last, partial page too: one page past it at most.
  assert.ok(pagesWritten > 0 && pagesWritten <= 4, `${pagesWritten} pages written on a budget of 3`);
  pagesWritten = 0;
  const before = store.held().keys.runs.length;
  store.maintain({ max_pages: 256 });
  const after = store.held().keys.runs.length;
  assert.ok(before - after > 3, `${before} runs became ${after}: more than one merge`);
  assert.ok(pagesWritten <= 257, `${pagesWritten} pages`);
});

test('a scheduler deadline stops between merge transactions and resumes without losing records', () => {
  const host = sqliteHost(':memory:');
  const options = { transaction: host.transaction, runs: small };
  let store = recordLogStore(host.sql, options);
  for (let n = 0; n < 60; n += 1) {
    store.write([{ id: `n${String(n).padStart(4, '0')}`, type: 'note', value: { text: `entry ${n}` } }]);
    store.checkpoint();
  }
  const first = store.maintain({ max_pages: 256, left: () => 0 });
  assert.equal(first.diagnostics.steps, 0, 'no merge transaction starts after the deadline');
  assert.equal(first.more, true, 'unfinished work remains due');
  assert.equal(first.diagnostics.pages, 0);
  store = recordLogStore(host.sql, options);
  let wakes = 0;
  while (store.maintain({ max_pages: 256 }).more) {
    wakes += 1;
    assert.ok(wakes < 100, 'the repeated bounded wakes drain the backlog');
  }
  for (let n = 0; n < 60; n += 1) assert.deepEqual(store.read(`n${String(n).padStart(4, '0')}`), { text: `entry ${n}` });
});

test('small write-outs beside two large runs never copy the younger one again', async t => {
  // UUID sequence keys affect compressed run bytes. Fix this workload's clock and isolate the UUID counter from
  // earlier tests, so its run-count bound does not depend on millisecond boundaries while the test is running.
  t.mock.timers.enable({ apis: ['Date'], now: Date.UTC(2026, 9, 8) });
  const { recordLogStore } = await import('../parts/record-log/do-work/record-log-store.mjs?two-large-runs-fixed-clock');
  const host = sqliteHost(':memory:');
  // A memtable large enough that each checkpoint writes one run, so the two bases are one run each (its tail of log
  // rows is not what this is about: a write would otherwise write the run out at 512 rows).
  const store = recordLogStore(host.sql, { transaction: host.transaction, runs: { ...small, memtable_bytes: 1 << 20, tail_rows: Infinity } });
  const write = (prefix, count, size) => { for (let n = 0; n < count; n += 1) store.write([{ id: `${prefix}${String(n).padStart(5, '0')}`, type: 'note', value: { text: 'w'.repeat(size) } }]); };
  const settle = () => { while (store.maintain({ max_pages: 100000 }).more); };
  write('a', 2000, 200); store.checkpoint(); settle();
  write('b', 500, 200); store.checkpoint(); settle();
  const runs = store.held().keys.runs;
  assert.equal(runs.length, 2, 'two large runs of their own');
  const younger = Math.min(...runs.map(run => run.pages));
  let pagesWritten = 0;
  const exec = host.sql.exec.bind(host.sql);
  host.sql.exec = (query, ...params) => { if (/^INSERT INTO record_keys_run_\d+ \(page,/.test(query)) pagesWritten += 1; return exec(query, ...params); };
  for (let round = 0; round < 30; round += 1) { write(`c${round}-`, 4, 30); store.checkpoint(); settle(); }
  // Copying the younger run at each write-out past one fan-in wrote 1,340 pages here; the small runs merging in their
  // own tiers write about 300.
  assert.ok(pagesWritten < 10 * younger, `${pagesWritten} pages written for 30 small write-outs beside a ${younger}-page run`);
  assert.ok(store.held().keys.runs.length <= Math.floor(24 / 3) - 1, `${store.held().keys.runs.length} runs`);
});


test('exact type counts survive replay, rollback and a bounded old-projection upgrade', () => {
  const host = sqliteHost(':memory:');
  const options = { transaction: host.transaction, runs: small };
  let store = recordLogStore(host.sql, options);
  store.write(Array.from({ length: 600 }, (_, n) => ({ id: `n${String(n).padStart(4, '0')}`, type: 'note', value: { text: `Note ${n}` } })));
  assert.equal(store.count('note'), 600);
  assert.deepEqual(store.countMany(['note', 'message', 'absent', 'note']), new Map([['note', 600], ['message', 0], ['absent', 0]]));
  store.checkpoint();
  store = recordLogStore(host.sql, options);
  store.write([{ id: 'n0000', type: 'message', value: { text: 'Moved' } }, { id: 'n0001', value: null }]);
  assert.equal(store.count('note'), 598);
  assert.equal(store.count('message'), 1);
  assert.deepEqual(store.countMany(['note', 'message']), new Map([['note', 598], ['message', 1]]));
  assert.throws(() => host.transaction(() => { store.write([{ id: 'rollback', type: 'note', value: { text: 'No' } }]); throw new Error('rollback'); }), /rollback/);
  store.forgetCached();
  assert.equal(store.count('note'), 598);
  assert.deepEqual(store.countMany(['note', 'message']), new Map([['note', 598], ['message', 1]]), 'batch counts discard a rolled-back write');
  store.checkpoint();
  const position = JSON.parse(host.sql.exec("SELECT value FROM record_keys_meta WHERE key = 'covered'").toArray()[0].value);
  delete position.counts;
  host.sql.exec("UPDATE record_keys_meta SET value = ? WHERE key = 'covered'", JSON.stringify(position));
  store = recordLogStore(host.sql, options);
  assert.equal(store.count('note'), null, 'an old projection never guesses its count');
  assert.deepEqual(store.countMany(['note', 'absent']), new Map([['note', null], ['absent', null]]), 'a batch never turns an unfinished upgrade into an empty count');
  store.maintain({ max_pages: 1 });
  store.write([{ id: 'n0002', value: null }, { id: 'n0599', type: 'message', value: { text: 'Later moved' } }]);
  store.checkpoint();
  store = recordLogStore(host.sql, options);
  for (let step = 0; step < 100 && store.maintain({ max_pages: 1 }).more; step += 1);
  assert.equal(store.count('note'), 596);
  assert.equal(store.count('message'), 2);
  assert.equal(store.count('absent'), 0);
  const exec = host.sql.exec.bind(host.sql);
  let currentReads = 0;
  host.sql.exec = (query, ...params) => { if (query === 'SELECT max(rowid) AS n FROM record_log') currentReads += 1; return exec(query, ...params); };
  assert.deepEqual(store.countMany(['note', 'message', 'absent']), new Map([['note', 596], ['message', 2], ['absent', 0]]));
  assert.equal(currentReads, 1, 'selected counts check their current log once');
});


test('exact-empty kinds skip unrelated cold packed pages and never guess during upgrade', () => {
  const host = sqliteHost(':memory:');
  const options = { transaction: host.transaction, runs: small };
  let store = recordLogStore(host.sql, options);
  store.write(Array.from({ length: 500 }, (_, n) => ({ id: `other:${n}`, type: 'other', value: { n } })));
  store.checkpoint();
  store = recordLogStore(host.sql, options);
  const exec = host.sql.exec.bind(host.sql);
  let pageReads = 0;
  host.sql.exec = (query, ...params) => { if (/FROM record_keys_run_/.test(query)) pageReads += 1; return exec(query, ...params); };
  assert.deepEqual(store.ids('absent', { all: true }), []);
  assert.equal(pageReads, 0, 'a known empty kind walks no unrelated packed page');
  store.write([{ id: 'present', type: 'absent', value: { yes: true } }]);
  assert.deepEqual(store.ids('absent', { all: true }), ['present'], 'absence is not cached past writes');
  store.checkpoint();
  const position = JSON.parse(exec("SELECT value FROM record_keys_meta WHERE key = 'covered'").toArray()[0].value);
  delete position.counts;
  exec("UPDATE record_keys_meta SET value = ? WHERE key = 'covered'", JSON.stringify(position));
  store = recordLogStore(host.sql, options);
  assert.equal(store.count('absent'), null);
  assert.deepEqual(store.ids('absent', { all: true }), ['present'], 'unknown counts preserve the authoritative read');
});


test('maintenance admission reads selected index progress together without caching rollback or changed signatures', () => {
  const host = sqliteHost(':memory:');
  try {
    const reads = [];
    const sql = { exec(query, ...params) {
      if (/^SELECT (?:key, )?value FROM record_keys_meta/.test(query) && params.some(key => String(key).startsWith('index-build:')))
        reads.push({ query, params });
      return host.sql.exec(query, ...params);
    } };
    const indexes = Array.from({ length: 17 }, (_, n) => ({ type: 'note', name: `at-${n}`, paths: [['at']], backfill: `at-${n}-v1` }));
    const store = recordLogStore(sql, { transaction: host.transaction, indexes });
    for (let n = 0; n < 40 && store.maintenanceAt(100) !== null; n++) store.maintain({ max_pages: 16 });
    reads.length = 0;
    assert.equal(store.maintenanceAt(100), null);
    assert.equal(reads.length, 1, 'completed progress is selected in one bounded metadata page');
    assert.equal(reads[0].params.length, 17);
    const key = 'index-build:note:at-16-v1';
    assert.throws(() => host.transaction(() => {
      host.sql.exec('DELETE FROM record_keys_meta WHERE key = ?', key);
      assert.equal(store.maintenanceAt(100), 100, 'the last missing group is still due');
      throw Error('rolled back progress removal');
    }), /rolled back progress removal/);
    assert.equal(store.maintenanceAt(100), null, 'rollback restores the original progress without cache invalidation');
    host.sql.exec('UPDATE record_keys_meta SET value = ? WHERE key = ?', JSON.stringify({ signature: 'older', ready: true }), key);
    assert.equal(store.maintenanceAt(100), 100, 'an earlier signature cannot certify current indexes');
  } finally { host.db.close(); }
});
