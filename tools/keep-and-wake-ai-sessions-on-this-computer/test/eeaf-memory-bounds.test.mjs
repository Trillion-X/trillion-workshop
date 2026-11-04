// test/eeaf-memory-bounds.test.mjs
// A person's record store lives as long as their Durable Object and every write used to add to what it remembers
// (parts/eeaf/do-work/eeaf-sqlite-store.mjs `known`, `sharedCache`), with nothing ever let go: measured at about eleven
// entries per request on the person store, so a busy store's isolate only grew. Both are bounded now, and a store that
// forgot a row still writes and reads correctly.
import test from 'node:test';
import assert from 'node:assert/strict';
import { sqliteHost } from '../src/local-store.mjs';
import { eeafStore } from '../parts/eeaf/do-work/eeaf-sqlite-store.mjs';

test('what a store remembers stays bounded however many records are written, and writes stay correct', () => {
  const { sql, transaction } = sqliteHost(':memory:');
  const store = eeafStore(sql, { transaction, hash: text => `h:${text}` });
  let most = 0;
  for (let index = 0; index < 4000; index += 1) {
    store.write([{ id: `note:${index}`, type: 'note', value: { text: `note ${index}`, n: index, tags: [`t${index % 7}`], from: { app: `app-${index % 5}`, at: `2026-09-30T00:00:${String(index % 60).padStart(2, '0')}Z` } } }]);
    most = Math.max(most, store.held().known);
  }
  assert.ok(most <= 20000, `known peaked at ${most}`);
  assert.ok(most > 1000, 'the memo is in use');
  // A row forgotten by the reset is checked again, not inserted twice: rewriting and reading still work.
  store.write([{ id: 'note:3', type: 'note', value: { text: 'changed', n: 3, tags: ['t3'], from: { app: 'app-3', at: '2026-09-30T00:00:03Z' } } }]);
  assert.equal(store.read('note:3').text, 'changed');
  assert.equal(store.read('note:3999').n, 3999);
});

const sharedId = (_type, value) => typeof value.shared_id === 'string' ? `shared:${value.shared_id}` : null;
const sharedRecord = (id, payload = 'small') => ({ shared_id: id, payload });

test('shared values use a byte-bounded LRU and remain readable after eviction', () => {
  const { sql, transaction } = sqliteHost(':memory:');
  const store = eeafStore(sql, { transaction, hash: text => `h:${text}`, contentId: sharedId, sharedCacheBytes: 700 });
  for (const id of ['one', 'two']) store.write([{ id: `root:${id}`, type: 'root', value: { child: sharedRecord(id, 'x'.repeat(100)) } }]);

  assert.equal(store.read('root:one').child.payload.length, 100);
  assert.equal(store.read('root:two').child.payload.length, 100);
  const held = store.held();
  assert.ok(held.shared_bytes <= 700, `shared cache used ${held.shared_bytes} bytes`);
  assert.equal(held.shared, 1, 'the least recently used shared object was evicted to stay under the byte cap');

  assert.equal(store.read('root:one').child.shared_id, 'one', 'an evicted value is loaded from SQLite on demand');
  assert.ok(store.held().shared_bytes <= 700);
});

test('shared values larger than one read expansion budget fail before clone and can be read with a larger budget', () => {
  const { sql, transaction } = sqliteHost(':memory:');
  const writeStore = eeafStore(sql, { transaction, hash: text => `h:${text}`, contentId: sharedId });
  writeStore.write([{ id: 'root:large', type: 'root', value: { child: sharedRecord('large', 'x'.repeat(350)) } }]);

  const bounded = eeafStore(sql, { transaction, hash: text => `h:${text}`, contentId: sharedId,
    bounds: { rows: 1000, bytes: 1000 }, sharedExpansionBytes: 300 });
  assert.throws(() => bounded.read('root:large'), error => error.code === 'record_too_large' && error.record_id === 'shared:large');

  const readable = eeafStore(sql, { transaction, hash: text => `h:${text}`, contentId: sharedId,
    bounds: { rows: 1000, bytes: 1000 }, sharedExpansionBytes: 2000 });
  assert.equal(readable.read('root:large').child.payload.length, 350, 'the source rows remain readable after refusal');
});

test('a legal near-limit shared string reads the same while cold and warm', () => {
  const { sql, transaction } = sqliteHost(':memory:');
  const store = eeafStore(sql, { transaction, hash: text => `h:${text}`, contentId: sharedId, sharedCacheBytes: 9 * 1024 * 1024 });
  const payload = 'x'.repeat(4 * 1024 * 1024);
  store.write([{ id: 'root:near-limit', type: 'root', value: { child: sharedRecord('near-limit', payload) } }]);

  const cold = store.read('root:near-limit');
  const warm = store.read('root:near-limit');
  assert.deepEqual(warm, cold, 'cache warmth does not change admission or the returned value');
  assert.equal(warm.child.payload.length, 4 * 1024 * 1024);
  assert.ok(store.held().shared_bytes > 0, 'the warm read uses the retained shared value');
});

test('shared read admission is stable across cold, warm and cleared caches near the expansion budget', () => {
  for (const [sharedExpansionBytes, accepted] of [[346, true], [300, false]]) {
    const { sql, transaction } = sqliteHost(':memory:');
    const store = eeafStore(sql, { transaction, hash: text => 'h:' + text, contentId: sharedId, sharedExpansionBytes });
    const child = sharedRecord('edge', 'y'.repeat(10));
    const expected = { prefix: '', child };
    store.write([
      { id: 'root:target', type: 'root', value: expected },
      { id: 'root:warmer', type: 'root', value: { child } },
    ]);
    const readTarget = () => {
      try { return { accepted: true, value: store.read('root:target') }; }
      catch (error) { assert.equal(error.code, 'record_too_large'); return { accepted: false }; }
    };

    const cold = readTarget();
    assert.deepEqual(store.read('root:warmer'), { child });
    assert.ok(store.held().shared_bytes > 0, 'the second root warms the same retained shared value');
    const warm = readTarget();
    store.forgetCached();
    assert.equal(store.held().shared_bytes, 0);
    const coldAgain = readTarget();

    assert.deepEqual([cold.accepted, warm.accepted, coldAgain.accepted], [accepted, accepted, accepted],
      'cache state must not change read admission at budget ' + sharedExpansionBytes);
    for (const answer of [cold, warm, coldAgain]) if (accepted) assert.deepEqual(answer.value, expected);
  }
});

test('JSON array expansion is rejected before JSON.parse allocates the expanded value', () => {
  const { sql, transaction } = sqliteHost(':memory:');
  const values = Array(100).fill(null);
  const encoded = JSON.stringify(values);
  const store = eeafStore(sql, { transaction, hash: text => `h:${text}`, sharedExpansionBytes: 1000 });
  store.write([{ id: 'root:array-expansion', type: 'root', value: { values } }]);

  const parse = JSON.parse;
  let attempted = false;
  JSON.parse = function (source, ...args) {
    if (source === encoded) attempted = true;
    return parse.call(this, source, ...args);
  };
  try {
    assert.throws(() => store.read('root:array-expansion'), error => error.code === 'record_too_large');
  } finally { JSON.parse = parse; }
  assert.equal(attempted, false, 'the preflight rejects the 100 array slots before parsing');
});

test('cold nested assembly checks the caller remaining budget before parsing nested JSON', () => {
  const { sql, transaction } = sqliteHost(':memory:');
  const nested = sharedRecord('cold-budget', 'y'.repeat(600));
  const store = eeafStore(sql, { transaction, hash: text => `h:${text}`, contentId: sharedId, sharedExpansionBytes: 2500 });
  store.write([{ id: 'root:cold-budget', type: 'root', value: { prefix: 'x'.repeat(800), child: nested } }]);

  const parse = JSON.parse;
  let attempted = false;
  JSON.parse = function (source, ...args) {
    if (typeof source === 'string' && source.includes('cold-budget')) attempted = true;
    return parse.call(this, source, ...args);
  };
  try {
    assert.throws(() => store.read('root:cold-budget'), error => error.code === 'record_too_large');
  } finally { JSON.parse = parse; }
  assert.equal(attempted, false, 'cold nested assembly observes the caller budget before parsing child facts');
});

test('nested shared references count their clone expansion and preserve the full value', () => {
  const { sql, transaction } = sqliteHost(':memory:');
  const store = eeafStore(sql, { transaction, hash: text => `h:${text}`, contentId: sharedId, sharedExpansionBytes: 3000 });
  store.write([{ id: 'root:nested', type: 'root', value: { child: {
    shared_id: 'outer', payload: 'outer data', nested: sharedRecord('inner', 'inner data'),
  } } }]);

  assert.deepEqual(store.read('root:nested'), { child: {
    shared_id: 'outer', payload: 'outer data', nested: { shared_id: 'inner', payload: 'inner data' },
  } });
  assert.ok(store.held().shared_bytes > 0, 'nested values can be cached within the aggregate byte cap');
});

test('nested shared fan-out is refused at the expansion budget and remains readable with more headroom', () => {
  const { sql, transaction } = sqliteHost(':memory:');
  const fanout = Object.fromEntries(Array.from({ length: 8 }, (_, index) => [`child_${index}`, sharedRecord('fanout', 'x'.repeat(1000))]));
  const writer = eeafStore(sql, { transaction, hash: text => `h:${text}`, contentId: sharedId });
  writer.write([{ id: 'root:fanout', type: 'root', value: fanout }]);

  const bounded = eeafStore(sql, { transaction, hash: text => `h:${text}`, contentId: sharedId, sharedExpansionBytes: 5000 });
  assert.throws(() => bounded.read('root:fanout'), error => error.code === 'record_too_large' && error.record_id === 'shared:fanout');

  const readable = eeafStore(sql, { transaction, hash: text => `h:${text}`, contentId: sharedId, sharedExpansionBytes: 30000 });
  const value = readable.read('root:fanout');
  assert.equal(Object.keys(value).length, 8);
  assert.ok(Object.values(value).every(child => child.shared_id === 'fanout' && child.payload.length === 1000));
});

test('a rolled-back shared-reference change clears cached values and reads the committed graph', () => {
  const { sql, transaction } = sqliteHost(':memory:');
  const store = eeafStore(sql, { transaction, hash: text => `h:${text}`, contentId: sharedId });
  store.write([{ id: 'root:rollback', type: 'root', value: { child: sharedRecord('committed', 'before') } }]);
  assert.equal(store.read('root:rollback').child.payload, 'before');
  assert.ok(store.held().shared_bytes > 0);

  const rollback = new Error('rollback shared ref');
  assert.throws(() => transaction(() => {
    store.write([{ id: 'root:rollback', type: 'root', value: { child: sharedRecord('uncommitted', 'after') } }]);
    throw rollback;
  }), error => error === rollback);
  store.forgetCached();

  assert.equal(store.held().shared_bytes, 0, 'rollback invalidation releases the byte counter and cached values');
  assert.equal(store.read('root:rollback').child.payload, 'before');
});
