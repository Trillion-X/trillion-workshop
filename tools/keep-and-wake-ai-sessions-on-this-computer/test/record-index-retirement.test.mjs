import test from 'node:test';
import assert from 'node:assert/strict';
import { blake3 } from '@noble/hashes/blake3.js';
import { bytesToHex } from '@noble/hashes/utils.js';
import { sqliteHost } from '../src/local-store.mjs';
import { recordLogStore } from '../parts/record-log/do-work/record-log-store.mjs';
import { keptRuns } from '../parts/record-log/do-work/kept-runs.mjs';
import { decomposedRecords } from '../src/record-engine.mjs';

const runs = { page_bytes: 512, memtable_bytes: 1 << 20, cache_bytes: 8192, big_bytes: 32_768,
  compaction_debt_min_bytes: 1, compaction_debt_ratio: 0 };
const hash = value => bytesToHex(blake3(new TextEncoder().encode(JSON.stringify(value))));
const id = n => `note:${String(n).padStart(4, '0')}`;
const row = (n, extra = {}) => ({ id: id(n), type: 'note', value: { at: String(n).padStart(4, '0'), room: 'room', road: `road-${n}`, ...extra } });
const state = (host, key) => JSON.parse(host.sql.exec('SELECT value FROM record_keys_meta WHERE key = ?', key).one().value);
const indexKeys = (host, name, type = 'note') => {
  const prefix = `f\0${type}\0${name}\0`;
  return keptRuns(host.sql, { transaction: host.transaction, prefix: 'record_keys', ...runs }).range(prefix, `f\0${type}\0${name}\u0001`, { limit: 1000 });
};
const settle = store => { for (let n = 0; store.maintain({ max_pages: 1 }).more; n += 1) assert.ok(n < 1000, 'bounded idle work finishes'); };

test('current and retired names conflict even without a retirement backfill', () => {
  const host = sqliteHost(':memory:');
  const index = { type: 'note', name: 'at', paths: [['at']] };
  try {
    assert.throws(() => recordLogStore(host.sql, { transaction: host.transaction,
      indexes: [index, { ...index, retired: true }] }), /cannot be current and retired/);
  } finally { host.db.close(); }
});

test('changed carry restarts a ready backfill and keeps current writes fresh through reopening', () => {
  const host = sqliteHost(':memory:');
  const old = [{ type: 'note', name: 'room_at', paths: [['room'], ['at']], backfill: 'room-metadata' }];
  const next = old.map(index => ({ ...index, carry: [['road']] }));
  const reopen = indexes => recordLogStore(host.sql, { transaction: host.transaction, indexes, runs });
  try {
    let store = reopen(old);
    store.write(Array.from({ length: 96 }, (_, n) => row(n))); store.checkpoint();
    assert.equal(store.indexReady('note', 'room_at'), true);
    store = reopen(next);
    assert.equal(store.indexReady('note', 'room_at'), false, 'an unchanged backfill name cannot certify changed carried fields');
    assert.deepEqual([...store.indexCovered('note', 'room_at', [id(0), id(95), id(130)])], []);
    store.maintain({ max_pages: 1 });
    assert.equal(state(host, 'index-build:note:room-metadata').after, id(31));
    store.write([row(0, { road: 'changed behind cursor' }), row(60, { road: 'changed ahead' }), row(130), { id: id(80), value: null }]);
    store.checkpoint(); store = reopen(next);
    assert.deepEqual([...store.indexCovered('note', 'room_at', [id(0), id(31), id(32), id(130)])], [id(0), id(31), id(130)]);
    const checksum = store.checksum();
    settle(store); store = reopen(next);
    assert.equal(store.indexReady('note', 'room_at'), true);
    assert.deepEqual(store.checksum(), checksum);
    const found = store.scan('note', 'room_at', { equal: ['room'], limit: 200, carried: true });
    assert.equal(found.length, 96);
    assert.equal(found.find(entry => entry.id === id(0)).carried.road, 'changed behind cursor');
    assert.equal(found.find(entry => entry.id === id(60)).carried.road, 'changed ahead');
    assert.equal(found.find(entry => entry.id === id(130)).carried.road, 'road-130');
    assert.ok(!found.some(entry => entry.id === id(80)));
    assert.ok(!Object.hasOwn(store.scan('note', 'room_at', { limit: 1 })[0], 'carried'), 'default scans retain their shape');
    store = reopen(old);
    assert.equal(store.indexReady('note', 'room_at'), false, 'removing carry also invalidates the signature');
    settle(store);
    assert.equal(store.indexReady('note', 'room_at'), true);
  } finally { host.db.close(); }
});

test('named multi-index retirement checkpoints 32 exact keys and preserves mutation, other prefixes and record checksums', () => {
  const host = sqliteHost(':memory:');
  const old = [
    { type: 'note', name: 'old', paths: [['at']], carry: [['road']] },
    { type: 'note', name: 'second', paths: [['room'], ['at']] },
    { type: 'note', name: 'old-extra', paths: [['at']] },
    { type: 'note', name: 'passive', paths: [['at']] },
    { type: 'other', name: 'old', paths: [['at']] },
  ];
  const next = old.map(index => ['old', 'second'].includes(index.name) && index.type === 'note'
    ? { ...index, retired: true, backfill: 'old-lookups' }
    : index.name === 'passive' ? { ...index, retired: true } : index);
  const reopen = indexes => recordLogStore(host.sql, { transaction: host.transaction, indexes, runs });
  try {
    let store = reopen(old);
    store.write([...Array.from({ length: 97 }, (_, n) => row(n, { road: 'r'.repeat(512) })), { id: 'other:one', type: 'other', value: { at: '0000' } }]);
    store.checkpoint(); store = reopen(next);
    assert.throws(() => store.scan('note', 'old', { limit: 1 }), /No index/);
    store.maintain({ max_pages: 1 });
    const saved = state(host, 'index-retire:note:old-lookups');
    assert.equal(saved.index, 0); assert.equal(saved.ready, false);
    assert.equal(indexKeys(host, 'old').length, 65, 'one idle slice removes exactly 32 live keys');
    assert.equal(indexKeys(host, 'second').length, 97);
    assert.ok(store.held().keys.compaction_debt >= 32 * 512 * 2, 'retirement charges the old carried values too');
    store = reopen(next);
    assert.deepEqual(state(host, 'index-retire:note:old-lookups'), saved);
    store.write([row(0, { road: 'changed' }), row(50, { at: 'changed', road: 'changed' }), row(130), { id: id(70), value: null }]);
    store.checkpoint();
    const checksum = store.checksum();
    settle(store); store = reopen(next);
    assert.equal(state(host, 'index-retire:note:old-lookups').ready, true);
    assert.deepEqual(indexKeys(host, 'old'), []); assert.deepEqual(indexKeys(host, 'second'), []);
    assert.equal(indexKeys(host, 'old-extra').length, 97, 'a similar prefix remains current');
    assert.equal(indexKeys(host, 'passive').length, 97, 'legacy retirement without a named backfill is unchanged');
    assert.equal(indexKeys(host, 'old', 'other').length, 1, 'another type with the same index name is untouched');
    assert.deepEqual(store.checksum(), checksum);
    assert.equal(store.read(id(0)).road, 'changed'); assert.equal(store.read(id(50)).at, 'changed');
    assert.equal(store.read(id(70)), null); assert.equal(store.read(id(130)).road, 'road-130');
    assert.equal(store.maintenanceAt(), null);
  } finally { host.db.close(); }
});

test('a refused retirement cursor commit rolls back keys and debt on the same instance and after restart', () => {
  const host = sqliteHost(':memory:');
  const old = [{ type: 'note', name: 'old', paths: [['at']], carry: [['road']] }];
  const next = old.map(index => ({ ...index, retired: true, backfill: 'retire-old' }));
  const key = 'index-retire:note:retire-old';
  const exec = host.sql.exec.bind(host.sql);
  let fail = false;
  host.sql.exec = (query, ...params) => {
    if (fail && /^INSERT INTO record_keys_meta/.test(query) && params[0] === key) throw Error('retirement cursor refused');
    return exec(query, ...params);
  };
  const reopen = indexes => recordLogStore(host.sql, { transaction: host.transaction, indexes, runs: { ...runs, compaction_debt_min_bytes: 1 << 30 } });
  try {
    let store = reopen(old); store.write(Array.from({ length: 70 }, (_, n) => row(n))); store.checkpoint();
    store = reopen(next); store.maintain({ max_pages: 1 });
    const saved = state(host, key), keys = indexKeys(host, 'old');
    // This fixture defers compaction, isolating the bounded retirement transaction from independent merge work.
    const debt = store.held().keys.compaction_debt;
    fail = true; assert.throws(() => store.maintain({ max_pages: 0 }), /retirement cursor refused/); fail = false;
    assert.deepEqual(state(host, key), saved); assert.deepEqual(indexKeys(host, 'old'), keys);
    assert.equal(store.held().keys.compaction_debt, debt, 'the same instance cannot retain uncommitted debt');
    store = reopen(next); assert.deepEqual(state(host, key), saved); assert.deepEqual(indexKeys(host, 'old'), keys);
    settle(store); assert.deepEqual(indexKeys(host, 'old'), []);
  } finally { host.db.close(); }
});

test('retirement measures large carried values without decoding them', () => {
  const host = sqliteHost(':memory:');
  const old = [{ type: 'note', name: 'old', paths: [['at']], carry: [['road']] }];
  const reopen = indexes => recordLogStore(host.sql, { transaction: host.transaction, indexes, runs });
  const parse = JSON.parse;
  try {
    let store = reopen(old);
    store.write([row(0, { road: 'large '.repeat(8000) }), row(1, { road: 'another '.repeat(8000) })]); store.checkpoint();
    store = reopen(old.map(index => ({ ...index, retired: true, backfill: 'retire-large' })));
    JSON.parse = function(text, ...rest) {
      assert.ok(!String(text).startsWith('{"carry":['), 'retirement does not decode a carried value');
      return parse.call(this, text, ...rest);
    };
    store.maintain({ max_pages: 1 });
    assert.equal(state(host, 'index-retire:note:retire-large').ready, true);
    assert.ok(store.held().keys.compaction_debt >= (48_000 + 64_000) * 2);
    JSON.parse = parse;
    assert.deepEqual(indexKeys(host, 'old'), []);
  } finally { JSON.parse = parse; host.db.close(); }
});

test('fresh and genuinely empty retired prefixes do not manufacture idle retirement work', () => {
  const host = sqliteHost(':memory:');
  const indexes = [
    { type: 'note', name: 'at', paths: [['at']], backfill: 'metadata', carry: [['road']] },
    { type: 'note', name: 'old', paths: [['at']], retired: true, backfill: 'retire-old' },
    { type: 'note', name: 'passive', paths: [['at']], retired: true },
  ];
  const reopen = () => recordLogStore(host.sql, { transaction: host.transaction, indexes, runs });
  try {
    let store = reopen();
    assert.equal(store.indexReady('note', 'at'), true); assert.equal(store.maintenanceAt(), null);
    assert.equal(state(host, 'index-retire:note:retire-old').ready, true);
    store.write([row(0)]); store.checkpoint(); store = reopen();
    assert.equal(store.maintenanceAt(), null); assert.deepEqual(indexKeys(host, 'old'), []);
    assert.equal(host.sql.exec('SELECT value FROM record_keys_meta WHERE key = ?', 'index-retire:note:passive').toArray().length, 0);
  } finally { host.db.close(); }
});

test('decomposed carried scans match log values using only selected metadata and named child fields', () => {
  const indexes = [{ type: 'note', name: 'at', paths: [['at']], carry: [['road'], ['meta', 'label'], ['meta', 'tags'], ['details'], ['children']] }];
  const hosts = [sqliteHost(':memory:'), sqliteHost(':memory:')];
  try {
    const plain = decomposedRecords(hosts[0].sql, { transaction: hosts[0].transaction, hash, indexes });
    const log = recordLogStore(hosts[1].sql, { transaction: hosts[1].transaction, indexes, runs });
    const rows = Array.from({ length: 40 }, (_, n) => row(n, { text: 'unselected private body '.repeat(400),
      ...(n % 2 ? { road: undefined, meta: { label: `label-${n}`, tags: ['a', 'b'] } } : { meta: null }),
      details: { title: `details-${n}` }, children: [{ label: `child-${n}` }] }));
    plain.write(rows); log.write(rows); log.checkpoint();
    const exec = hosts[0].sql.exec.bind(hosts[0].sql);
    const selectedGroups = [];
    hosts[0].sql.exec = (query, ...params) => {
      const answer = exec(query, ...params);
      for (const result of answer) for (const value of Object.values(result)) {
        assert.ok(typeof value !== 'string' || !value.includes('unselected private body'), 'no root message body is returned by metadata reads');
      }
      if (query.includes('CROSS JOIN attribute_fact facts')) selectedGroups.push(JSON.parse(params[0]));
      return answer;
    };
    const options = { from: '0005', limit: 7, carried: true };
    assert.deepEqual(plain.scan('note', 'at', options), log.scan('note', 'at', options));
    assert.ok(selectedGroups.length > 0); assert.ok(selectedGroups.every(ids => ids.length <= 7), 'field reads stay inside the selected page');
    assert.ok(!Object.hasOwn(plain.scan('note', 'at', { limit: 1 })[0], 'carried'));
    hosts[0].sql.exec = exec;
    const changed = row(6, { text: 'unselected private body', road: 'new road', meta: { label: 'new label', tags: [] }, details: {}, children: [] });
    plain.write([changed]); log.write([changed]); log.checkpoint();
    const fresh = decomposedRecords(hosts[0].sql, { transaction: hosts[0].transaction, hash, indexes });
    assert.deepEqual(fresh.scan('note', 'at', options), log.scan('note', 'at', options));
    assert.equal(fresh.scan('note', 'at', { equal: ['0006'], limit: 1, carried: true })[0].carried.road, 'new road');
    assert.throws(() => decomposedRecords(hosts[0].sql, { transaction: hosts[0].transaction, hash, indexes: indexes.map(index => ({ ...index, retired: true })) }).scan('note', 'at', { limit: 1 }), /No index/);
  } finally { for (const host of hosts) host.db.close(); }
});
