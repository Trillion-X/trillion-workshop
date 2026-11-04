import test from 'node:test';
import assert from 'node:assert/strict';
import { sqliteHost } from '../src/local-store.mjs';
import { recordLogStore } from '../parts/record-log/do-work/record-log-store.mjs';

const contentId = (_type, value) => typeof value.shared_id === 'string' ? `shared:${value.shared_id}` : null;
const sharedValue = (id, payload) => ({ shared_id: id, payload });

test('shared record cache stays within its byte cap and evicts the least recently used value', () => {
  const host = sqliteHost(':memory:');
  const store = recordLogStore(host.sql, {
    transaction: host.transaction,
    contentId,
    shared_cache_bytes: 500,
  });
  store.write([
    { id: 'root:one', type: 'root', value: { child: sharedValue('one', 'x'.repeat(100)) } },
    { id: 'root:two', type: 'root', value: { child: sharedValue('two', 'x'.repeat(100)) } },
  ]);

  assert.equal(store.read('root:one').child.shared_id, 'one');
  assert.equal(store.read('root:two').child.shared_id, 'two');
  assert.equal(store.held().shared, 1);
  assert.ok(store.held().shared_bytes <= 500);
  assert.equal(store.read('root:one').child.payload.length, 100, 'an evicted value is loaded on demand');
  assert.ok(store.held().shared_bytes <= 500);
});

test('repeated shared references have the same expansion admission cold, warm and after cache reset', () => {
  const host = sqliteHost(':memory:');
  const store = recordLogStore(host.sql, {
    transaction: host.transaction,
    contentId,
    shared_expansion_bytes: 1300,
  });
  store.write([{ id: 'root:repeated', type: 'root', value: {
    child0: sharedValue('repeated', 'x'.repeat(100)),
    child1: sharedValue('repeated', 'x'.repeat(100)),
    child2: sharedValue('repeated', 'x'.repeat(100)),
  } }]);

  const cold = store.read('root:repeated');
  const warm = store.read('root:repeated');
  assert.deepEqual(warm, cold);
  store.forgetCached();
  assert.deepEqual(store.read('root:repeated'), cold);
});

test('oversized packed values are refused before JSON.parse expands them', () => {
  const host = sqliteHost(':memory:');
  const writer = recordLogStore(host.sql, { transaction: host.transaction, contentId });
  const large = sharedValue('packed-large', 'x'.repeat(400));
  writer.write([{ id: 'root:packed-large', type: 'root', value: { child: large } }]);
  writer.checkpoint();

  const bounded = recordLogStore(host.sql, {
    transaction: host.transaction,
    contentId,
    shared_expansion_bytes: 300,
  });
  const encoded = JSON.stringify(large);
  const parse = JSON.parse;
  let expanded = false;
  JSON.parse = function (source, ...args) {
    if (source === encoded) expanded = true;
    return parse.call(this, source, ...args);
  };
  try {
    assert.throws(() => bounded.read('root:packed-large'), error => error.code === 'record_too_large');
  } finally {
    JSON.parse = parse;
  }
  assert.equal(expanded, false, 'preflight rejects the decoded graph before JSON.parse allocates it');
});

for (const cacheBytes of [128, 65536]) test(`shared miss returns independent graphs with ${cacheBytes}-byte cache without copying rejected cache entries`, () => {
  const host = sqliteHost(':memory:');
  try {
    const options = { transaction: host.transaction, contentId, shared_cache_bytes: cacheBytes };
    const value = sharedValue('uncached-large', { items: Array.from({ length: 100 }, (_, n) => ({ n, word: 'original' })) });
    const store = recordLogStore(host.sql, options);
    store.write([{ id: 'root:independent', type: 'root', value: { left: value, right: value } }]);
    store.checkpoint();
    const clone = globalThis.structuredClone;
    let largeCopies = 0;
    globalThis.structuredClone = function (value, ...args) {
      if (value?.shared_id === 'uncached-large') largeCopies += 1;
      return clone(value, ...args);
    };
    try {
      const first = store.read('root:independent');
      first.left.payload.items[0].word = 'changed';
      assert.equal(first.right.payload.items[0].word, 'original', 'repeated shared IDs return independent graphs');
      const second = store.read('root:independent');
      assert.equal(second.left.payload.items[0].word, 'original', 'caller writes never alter kept or cached records');
      assert.equal(second.right.payload.items[0].word, 'original');
      assert.equal(largeCopies, cacheBytes === 128 ? 0 : 4, 'only graphs retained by cache require whole-graph isolation copies');
      assert.equal(store.held().shared, cacheBytes === 128 ? 0 : 1);
      store.forgetCached();
      assert.equal(store.read('root:independent').left.payload.items[0].word, 'original');
    } finally { globalThis.structuredClone = clone; }
    const reopened = recordLogStore(host.sql, options);
    assert.equal(reopened.read('root:independent').left.payload.items[0].word, 'original', 'durable original survives reopening');
  } finally { host.db.close(); }
});

for (const cacheBytes of [128, 65536]) test(`shared JSON reserved keys remain data with ${cacheBytes}-byte cache`, () => {
  const host = sqliteHost(':memory:');
  try {
    const store = recordLogStore(host.sql, { transaction: host.transaction, shared_cache_bytes: cacheBytes });
    const value = JSON.parse('{"__proto__":{"inherited":"never"},"constructor":"data","payload":"' + 'x'.repeat(1000) + '"}');
    store.takeRecords([{ id: 'shared:reserved', type: 'root/child', value },
      { id: 'root:reserved', type: 'root', value: { child: { '\u0000shared': 'shared:reserved' } } }]);
    for (let n = 0; n < 2; n++) {
      const read = store.read('root:reserved').child;
      assert.equal(Object.getPrototypeOf(read), Object.prototype);
      assert.equal(Object.hasOwn(read, '__proto__'), true);
      assert.deepEqual(read, value);
      assert.equal(read.inherited, undefined);
      read.__proto__.inherited = 'changed';
    }
    store.forgetCached();
    assert.deepEqual(store.read('root:reserved').child, value);
    store.checkpoint();
    const reopened = recordLogStore(host.sql, { transaction: host.transaction, shared_cache_bytes: cacheBytes });
    assert.deepEqual(reopened.read('root:reserved').child, value);
  } finally { host.db.close(); }
});
