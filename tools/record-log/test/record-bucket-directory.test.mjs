import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join, posix, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { sqliteHost } from '../../keep-and-wake-ai-sessions-on-this-computer/src/local-store.mjs';
import { recordLogStore } from '../../keep-and-wake-ai-sessions-on-this-computer/parts/record-log/do-work/record-log-store.mjs';
import { recordLogStore as beforeOwner } from './fixtures/record-log-store-before-bucket-directory.mjs';
import { keptRuns } from '../../keep-and-wake-ai-sessions-on-this-computer/parts/record-log/do-work/kept-runs.mjs';
import { bucketOf, BUCKETS } from '../do-work/record-digest.mjs';

const ALL = Array.from({ length: BUCKETS }, (_, n) => n);
const runs = { page_bytes: 2048, memtable_bytes: 1 << 20, big_bytes: 8192, cache_bytes: 8192, tail_rows: Infinity };
const row = n => ({ id: `n:${String(n).padStart(6, '0')}`, type: 'unmodeled', value: { n, text: 'w'.repeat(40) }, seq: `00${String(n).padStart(12, '0')}` });
const proof = host => JSON.parse(host.sql.exec('SELECT value FROM record_keys_meta WHERE key = ?', 'covered').one().value).bucket_directory;
const space = host => keptRuns(host.sql, { transaction: host.transaction, prefix: 'record_keys', ...runs });
const directoryKeys = host => [...space(host).walkKeys('z\0', 'z\u0001')];
function finish(store, host) {
  let wakes = 0;
  while (!proof(host)?.ready || proof(host)?.retiring) {
    store.maintain({ max_pages: 128 });
    assert.ok(++wakes < 80, 'bounded directory migration and prior-epoch retirement finish');
  }
  return wakes;
}
function paged(store, buckets, opts = {}) {
  let after = opts.after ?? null;
  const out = [];
  for (let calls = 0; calls < 2000; calls++) {
    const page = store.recordsInBucketsPage(buckets, { ...opts, after });
    assert.ok(page.records.length <= (opts.limit ?? 500));
    assert.deepEqual(page.records.map(row => row.id), page.records.map(row => row.id).sort());
    for (const row of page.records) {
      assert.ok(after === null || row.id > after, 'the opaque ID cursor is strict');
      assert.ok(buckets.includes(bucketOf(row.id)), 'only requested buckets are opened');
    }
    out.push(...page.records);
    if (page.next === null) return out;
    assert.ok(after === null || page.next > after, 'even empty legacy pages advance');
    after = page.next;
  }
  assert.fail('page cursor did not terminate');
}
function seed(host, source = recordLogStore, count = 1200, opts = {}) {
  const options = { transaction: host.transaction, runs, ...opts };
  const store = source(host.sql, options);
  store.load(Array.from({ length: count }, (_, n) => row(n)), { imported: count });
  store.loadDone({ imported: count });
  return { store, options };
}
function originalRead(host, opts = {}) {
  return beforeOwner(host.sql, { transaction: host.transaction, runs, ...opts });
}

// Each relative import of the fixture is written back as the source wrote it, from the source's own folder
// (parts/record-log/do-work), to the old path its target's move receipt (moved-from.json) names; what is left must be
// the 577d3b687 source byte for byte.
function oldPaths() {
  const repo = fileURLToPath(new URL('../../../', import.meta.url));
  const receipts = execFileSync('git', ['-C', repo, 'ls-files', '-z', '--', 'moved-from.json', '*/moved-from.json'], { encoding: 'utf8' }).split('\0').filter(Boolean);
  const old = new Map();
  for (const file of receipts) {
    let receipt;
    try { receipt = JSON.parse(readFileSync(join(repo, file), 'utf8')); } catch { continue; }
    for (const row of Array.isArray(receipt.files) ? receipt.files : []) if (row?.to && row?.from) old.set(row.to, row.from);
  }
  return { repo, old };
}

test('baseline fixture is exactly 577d3b687 source with only relative import relocation', () => {
  const fixture = new URL('./fixtures/record-log-store-before-bucket-directory.mjs', import.meta.url);
  const { repo, old } = oldPaths();
  const here = posix.dirname(relative(repo, fileURLToPath(fixture)));
  const original = readFileSync(fixture, 'utf8').replace(/from '(\.[^']+)'/g, (_, specifier) => {
    const target = posix.normalize(posix.join(here, specifier));
    assert.ok(old.has(target), `${target} names no source path in a move receipt`);
    const back = posix.relative('parts/record-log/do-work', old.get(target));
    return `from '${back.startsWith('.') ? back : `./${back}`}'`;
  });
  assert.equal(createHash('sha256').update(original).digest('hex'), '4b039d64ea2850718524d5c9f27ce8099578017ce2859e1d1bd7a19e994a80fa');
});

test('new stores immediately select globally ordered mixed heads across duplicate/invalid bucket requests', () => {
  const host = sqliteHost(':memory:');
  try {
    let { store, options } = seed(host, recordLogStore, 0);
    const ids = ['a', 'aa', 'a\u0001', 'a🙂', 'é', '𐐀', 'z', 'unknown:kind'];
    store.load(ids.map((id, n) => ({ id, type: n % 2 ? 'unknown-kind' : 'other-kind', value: { n }, seq: `00${n}` })));
    store.write([{ id: 'removed:stamp', type: 'other-kind', value: { n: 9 } }]);
    store.write([{ id: 'removed:stamp', value: null }]);
    store.takeRecords([{ id: 'removed:never-live', type: null, value: null, meta: { at: 'z1', k: 'removed' } }]);
    store.checkpoint();
    assert.equal(proof(host).ready, true, 'empty stores need no backfill');
    const baseline = originalRead(host).recordsInBuckets(ALL);
    const buckets = [...ALL, 0, 1, -1, 256, 1.5, '3', null];
    assert.deepEqual(store.recordsInBuckets(buckets), baseline);
    assert.ok(baseline.some(item => item.id === 'removed:never-live' && item.value === null && item.meta.k === 'removed'));
    assert.deepEqual(store.recordsInBuckets([-1, 256, null, '0']), []);
    for (const after of [null, 'a', 'ab', 'é', 'zz', '𐐀']) {
      const wanted = baseline.filter(row => after === null || row.id > after);
      for (const limit of [1, 2, 5]) assert.deepEqual(paged(store, ALL, { after, limit, examine: 2 }), wanted);
    }
    store = recordLogStore(host.sql, options);
    assert.deepEqual(store.recordsInBuckets(buckets), baseline, 'cold reopen preserves all heads and ordering');
    assert.equal(directoryKeys(host).length, baseline.length, 'one tiny entry per retained ID head');
  } finally { host.db.close(); }
});

test('limit, character and examine stops preserve exact records and strict resumable after semantics', () => {
  const host = sqliteHost(':memory:');
  try {
    const { store } = seed(host, recordLogStore, 600);
    const buckets = [bucketOf(row(250).id), bucketOf(row(300).id)];
    const baseline = originalRead(host).recordsInBuckets(buckets);
    for (const opts of [{ limit: 1 }, { chars: 1 }, { examine: 1 }, { limit: 2, chars: 80, examine: 3 }]) {
      assert.deepEqual(paged(store, buckets, opts), baseline, 'same full ordered stream despite old empty-page boundaries');
    }
    const first = store.recordsInBucketsPage(ALL, { limit: 2, examine: 100 });
    assert.deepEqual(first.records.map(row => row.id), [row(0).id, row(1).id]);
    assert.equal(first.next, row(1).id);
    const large = store.recordsInBucketsPage(ALL, { chars: 1 });
    assert.equal(large.records.length, 1, 'one whole record may cross the character budget');
    assert.equal(large.next, row(0).id);
    assert.deepEqual(paged(store, buckets, { after: row(250).id, limit: 1 }), baseline.filter(item => item.id > row(250).id));
  } finally { host.db.close(); }
});

test('all mutation roads maintain removed, resurrected, changed-kind, purged and shared-member ID heads', () => {
  const host = sqliteHost(':memory:');
  const peer = sqliteHost(':memory:');
  try {
    let { store, options } = seed(host, recordLogStore, 20);
    store.write([{ id: row(1).id, type: 'new-kind', value: { changed: 1 } }, { id: row(2).id, value: null }]);
    store.takeRecords([{ id: 'only:removed', type: null, value: null, meta: { at: 'z9', k: 'removed' } }]);
    store.takeRecords([{ id: row(3).id, type: null, value: null }]);
    store.load([{ id: 'imported:later', type: 'new-kind', value: { source: 'load' }, seq: '0001' }]);
    const source = beforeOwner(peer.sql, { transaction: peer.transaction, runs });
    source.write([{ id: 'from:peer', type: 'unmodeled-peer', value: { received: 1 } }]);
    source.write([{ id: 'from:peer', value: null }]);
    store.applyChanges(source.logAfter(null).rows);
    store.shareFields('shared-kind');
    store.write([{ id: 'shared:root', type: 'shared-kind', value: { collection: { nested: 'payload' } } }]);
    store.checkpoint();
    let baseline = originalRead(host).recordsInBuckets(ALL);
    assert.deepEqual(store.recordsInBuckets(ALL), baseline);
    assert.ok(baseline.some(row => row.id.startsWith('shared:1f:')));
    assert.ok(baseline.some(item => item.id === 'from:peer' && item.value === null));
    assert.ok(!baseline.some(item => item.id === row(3).id), 'purged non-key head is absent');
    store.write([{ id: row(2).id, type: 'resurrected', value: { live: true } }]);
    store.takeRecords([{ id: 'only:removed', type: null, value: null }]);
    store.checkpoint();
    baseline = originalRead(host).recordsInBuckets(ALL);
    store = recordLogStore(host.sql, options);
    assert.deepEqual(store.recordsInBuckets(ALL), baseline);
    assert.deepEqual(paged(store, ALL, { limit: 3 }), baseline);
    assert.equal(directoryKeys(host).length, baseline.length, 'purge removes its directory head; resurrection reuses one');
  } finally { host.db.close(); peer.db.close(); }
});

test('a live purge with an erasable key retains the same key-only removal head as the original owner', () => {
  const host = sqliteHost(':memory:');
  const model = { kinds: [{ type: 'secret', properties: { text: 'text' }, erasable: ['text'] }] };
  try {
    let { store, options } = seed(host, recordLogStore, 0, { model });
    store.write([{ id: 'secret:kept-key', type: 'secret', value: { text: 'retained history' } }]);
    store.takeRecords([{ id: 'secret:kept-key', type: null, value: null }]);
    store.checkpoint();
    const baseline = originalRead(host, { model }).recordsInBuckets(ALL);
    assert.equal(baseline.length, 1);
    assert.equal(baseline[0].value, null);
    assert.equal(baseline[0].meta, undefined, 'purge retains its key rather than a removal stamp');
    assert.deepEqual(store.recordsInBuckets(ALL), baseline);
    store = recordLogStore(host.sql, options);
    assert.deepEqual(store.recordsInBuckets(ALL), baseline);
    assert.equal(directoryKeys(host).length, 1, 'all retained heads includes key-only removals');
  } finally { host.db.close(); }
});

test('old-store migration is metadata-only, bounded, durable and keeps mutations on both sides of its fixed frontier', () => {
  const host = sqliteHost(':memory:');
  try {
    const { options } = seed(host, beforeOwner, 1200);
    const exec = host.sql.exec.bind(host.sql);
    let pageReads = 0;
    host.sql.exec = (query, ...params) => {
      if (query.includes('FROM record_keys_run_')) pageReads++;
      return exec(query, ...params);
    };
    let store = recordLogStore(host.sql, options);
    assert.equal(proof(host), undefined, 'constructor has not published a directory or performed migration');
    assert.ok(pageReads < 16, `${pageReads} constructor packed-page queries; no whole-ID walk`);
    const fallback = store.recordsInBucketsPage([bucketOf(row(800).id)], { examine: 1 });
    assert.equal(fallback.next, row(0).id, 'old reader remains active before ready');
    store.maintain({ max_pages: 0 });
    const first = proof(host);
    assert.equal(first.ready, false);
    assert.equal(first.through, row(1199).id);
    assert.equal(first.after, row(255).id, 'only 256 old ID metadata entries per slice');
    assert.equal(directoryKeys(host).length, 256);
    store.load([{ id: 'a:behind-frontier', type: 'arrival', value: { before: true }, seq: '0001' },
      { id: 'z:beyond-frontier', type: 'arrival', value: { after: true }, seq: '0001' }]);
    store.write([{ id: row(5).id, type: 'changed', value: { current: true } }, { id: row(600).id, value: null }]);
    store.takeRecords([{ id: row(700).id, type: null, value: null }]);
    store.checkpoint();
    store = recordLogStore(host.sql, options);
    assert.equal(proof(host).after, first.after, 'cold open resumes durable cursor');
    store.maintain({ max_pages: 0 });
    assert.equal(proof(host).through, first.through, 'later arrivals never extend old frontier');
    assert.equal(proof(host).after, row(511).id);
    finish(store, host);
    store = recordLogStore(host.sql, options);
    const baseline = originalRead(host).recordsInBuckets(ALL);
    assert.deepEqual(store.recordsInBuckets(ALL), baseline);
    assert.equal(directoryKeys(host).length, baseline.length);
    assert.ok(baseline.some(item => item.id === row(600).id && item.value === null));
    assert.ok(!baseline.some(item => item.id === row(700).id));
    assert.deepEqual(paged(store, ALL, { limit: 7 }), baseline);
  } finally { host.db.close(); }
});

test('failed migration commit rolls back keys and proof; same owner retries from durable state', () => {
  const host = sqliteHost(':memory:');
  try {
    seed(host, beforeOwner, 800);
    let armed = false, checkpointed = false;
    const exec = host.sql.exec.bind(host.sql);
    host.sql.exec = (query, ...params) => {
      if (/^INSERT INTO record_keys_meta/.test(query) && params[0] === 'covered') checkpointed = true;
      return exec(query, ...params);
    };
    const transaction = fn => host.transaction(() => {
      checkpointed = false;
      const result = fn();
      if (armed && checkpointed) throw Error('directory commit refused');
      return result;
    });
    const store = recordLogStore(host.sql, { transaction, runs });
    armed = true;
    assert.throws(() => store.maintain({ max_pages: 0 }), /directory commit refused/);
    assert.equal(proof(host), undefined);
    assert.deepEqual(directoryKeys(host), [], 'failed run inserts are gone with the transaction');
    armed = false;
    assert.deepEqual(store.recordsInBuckets(ALL), originalRead(host).recordsInBuckets(ALL), 'failed memory cursor never serves a partial directory');
    store.maintain({ max_pages: 0 });
    assert.equal(proof(host).after, row(255).id);
    finish(store, host);
    assert.deepEqual(store.recordsInBuckets(ALL), originalRead(host).recordsInBuckets(ALL));
  } finally { host.db.close(); }
});

test('an older writer drops proof, forcing a new epoch and bounded reclamation without stale answers', () => {
  const host = sqliteHost(':memory:');
  try {
    const { store: initial, options } = seed(host, recordLogStore, 700);
    const oldEpoch = proof(host).epoch;
    assert.equal(directoryKeys(host).length, 700);
    const older = originalRead(host);
    older.load([{ id: 'a:older-insert', type: 'older-writer', value: { inserted: true }, seq: '0001' }]);
    older.takeRecords([{ id: row(20).id, type: null, value: null }]);
    older.checkpoint();
    assert.equal(proof(host), undefined, 'authentic previous writer checkpoint does not claim this directory');
    let store = recordLogStore(host.sql, options);
    assert.deepEqual(store.recordsInBuckets(ALL), originalRead(host).recordsInBuckets(ALL), 'fallback excludes stale removed directory entry');
    store.maintain({ max_pages: 0 });
    assert.notEqual(proof(host).epoch, oldEpoch);
    let wakes = 0;
    while (!proof(host).ready) { store.maintain({ max_pages: 0 }); assert.ok(++wakes < 20); }
    assert.equal(proof(host).retiring, true);
    const activeEpoch = proof(host).epoch;
    let previous = directoryKeys(host).filter(key => key.includes(oldEpoch)).length;
    while (proof(host).retiring) {
      store.maintain({ max_pages: 0 });
      const remaining = directoryKeys(host).filter(key => key.includes(oldEpoch)).length;
      assert.ok(previous - remaining <= 256, 'retirement removes at most one bounded page');
      previous = remaining;
      store = recordLogStore(host.sql, options);
      assert.ok(++wakes < 30);
    }
    const entries = directoryKeys(host);
    assert.equal(entries.length, 700);
    assert.ok(entries.every(key => key.startsWith(`z\0${activeEpoch}\0`)));
    assert.deepEqual(store.recordsInBuckets(ALL), originalRead(host).recordsInBuckets(ALL));
    void initial;
  } finally { host.db.close(); }
});

test('ready read pages write nothing; updating an already covered head adds no directory rewrite', () => {
  const host = sqliteHost(':memory:');
  try {
    let { store, options } = seed(host, recordLogStore, 300);
    store = recordLogStore(host.sql, options);
    const exec = host.sql.exec.bind(host.sql);
    let writes = 0;
    host.sql.exec = (query, ...params) => {
      if (/^(INSERT|UPDATE|DELETE|CREATE|DROP|ALTER)\b/.test(query)) writes++;
      return exec(query, ...params);
    };
    const buckets = [bucketOf(row(100).id)];
    assert.deepEqual(paged(store, buckets, { limit: 1 }), originalRead(host).recordsInBuckets(buckets));
    // Reopening the original owner above may run idempotent CREATE statements; reset after it.
    writes = 0;
    for (let repeat = 0; repeat < 3; repeat++) paged(store, buckets, { limit: 1 });
    assert.equal(writes, 0, 'warm directory reads do not manufacture migration/checkpoint writes');
    store.write([{ ...row(100), value: { n: 100, changed: true } }]);
    assert.equal(store.held().keys.memtable_keys > 0, true);
    // Inspect the new persisted run's raw key ownership, not just the deduplicated whole directory.
    store.checkpoint();
    const newest = store.held().keys.runs[0];
    const keys = space(host);
    const allEntries = [...keys.walkKeys('z\0', 'z\u0001')];
    assert.equal(allEntries.length, 300);
    const last = host.sql.exec('SELECT last FROM record_keys_runs WHERE run = ?', newest.run).one();
    assert.ok(JSON.parse(last.last) < 'z\0', 'any directory key would sort last in this update-only run');
    assert.deepEqual(store.recordsInBuckets(ALL), originalRead(host).recordsInBuckets(ALL));
  } finally { host.db.close(); }
});

test('expired maintenance admission leaves directory proof and keys untouched', () => {
  const host = sqliteHost(':memory:');
  try {
    const { options } = seed(host, beforeOwner, 900);
    const store = recordLogStore(host.sql, options);
    const covered = host.sql.exec('SELECT value FROM record_keys_meta WHERE key = ?', 'covered').one().value;
    store.maintain({ max_pages: 1, left: () => 0 });
    assert.equal(host.sql.exec('SELECT value FROM record_keys_meta WHERE key = ?', 'covered').one().value, covered);
    assert.deepEqual(directoryKeys(host), []);
    store.maintain({ max_pages: 0 });
    assert.equal(proof(host).after, row(255).id, 'fresh nonexpired demand retries normally');
  } finally { host.db.close(); }
});


test('multiple selected buckets refill beyond 96 heads and retain exact global order through single-record pages', () => {
  const host = sqliteHost(':memory:');
  try {
    const { store, options } = seed(host, recordLogStore, 0);
    const selected = [];
    for (let n = 0; selected.filter(item => bucketOf(item.id) === 0).length < 97 || selected.filter(item => bucketOf(item.id) === 1).length < 97; n++) {
      const id = `refill:${String(n).padStart(7, '0')}`, bucket = bucketOf(id);
      if (bucket <= 1) selected.push({ id, type: 'unmodeled', value: { n }, seq: `00${String(n).padStart(12, '0')}` });
    }
    store.load(selected, { imported: true }); store.loadDone({ imported: true });
    const cold = recordLogStore(host.sql, options), expected = originalRead(host).recordsInBuckets([0, 1]);
    assert.deepEqual(cold.recordsInBuckets([0, 1]), expected, 'every 32-key refill is merged before opening the next head');
    assert.deepEqual(paged(cold, [0, 1], { limit: 1, examine: 1 }), expected);
  } finally { host.db.close(); }
});

test('selected head prefetch splits oversized groups and preserves accepted large values and tombstones', () => {
  const host = sqliteHost(':memory:');
  try {
    const { store, options } = seed(host, recordLogStore, 0);
    const selected = [];
    for (let n = 0; selected.length < 3; n++) {
      const id = `large:${String(n).padStart(7, '0')}`;
      if (bucketOf(id) === 0) selected.push({ id, type: 'unmodeled', value: { n, text: 'x'.repeat(2200000) }, seq: `00${String(n).padStart(12, '0')}` });
    }
    store.load(selected, { imported: true }); store.loadDone({ imported: true });
    const cold = recordLogStore(host.sql, options), actual = paged(cold, [0], { limit: 1, chars: 1 });
    assert.deepEqual(actual, originalRead(host).recordsInBuckets([0]), 'splitting never drops, truncates or reorders an accepted large head');
    assert.equal(actual.length, 3);
  } finally { host.db.close(); }
});

test('normal insert and purge rollback never publish directory presence beyond source truth', () => {
  const host = sqliteHost(':memory:');
  try {
    let armed = false;
    const transaction = fn => host.transaction(() => { const answer = fn(); if (armed) throw Error('normal commit refused'); return answer; });
    const { store, options } = seed(host, recordLogStore, 8, { transaction });
    armed = true;
    assert.throws(() => store.write([{ id: 'rollback:insert', type: 'unmodeled', value: { n: 1 } }]), /normal commit refused/);
    armed = false;
    assert.deepEqual(store.recordsInBuckets(ALL), originalRead(host).recordsInBuckets(ALL));
    armed = true;
    assert.throws(() => store.takeRecords([{ id: row(2).id, type: null, value: null }]), /normal commit refused/);
    armed = false;
    assert.deepEqual(store.recordsInBuckets(ALL), originalRead(host).recordsInBuckets(ALL));
    store.checkpoint();
    const cold = recordLogStore(host.sql, options);
    assert.deepEqual(cold.recordsInBuckets(ALL), originalRead(host).recordsInBuckets(ALL));
    assert.equal(directoryKeys(host).length, 8);
  } finally { host.db.close(); }
});
