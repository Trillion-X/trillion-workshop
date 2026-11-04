import test from 'node:test';
import assert from 'node:assert/strict';
import { blake3 } from '@noble/hashes/blake3.js';
import { bytesToHex } from '@noble/hashes/utils.js';
import { sqliteHost } from '../src/local-store.mjs';
import { recordLogStore } from '../parts/record-log/do-work/record-log-store.mjs';
import { openRecords, setRecordEngine, RECORD_INDEXES } from '../src/record-engine.mjs';
import { messages } from '../src/messages.mjs';

const indexes = [{ type: 'note', name: 'at', paths: [['at']], backfill: 'at-v1' }];
const key = 'index-build:note:at-v1';
const id = n => `note:${String(n).padStart(5, '0')}`;
const row = n => ({ id: id(n), type: 'note', value: { at: n } });
const meta = host => JSON.parse(host.sql.exec('SELECT value FROM record_keys_meta WHERE key = ?', key).one().value);

test('partial coverage is exact across cursor, old frontier, current writes and cold restart', () => {
  const host = sqliteHost(':memory:');
  try {
    let store = recordLogStore(host.sql, { transaction: host.transaction });
    store.write(Array.from({ length: 96 }, (_, n) => row(n))); store.checkpoint();
    const reopen = () => recordLogStore(host.sql, { transaction: host.transaction, indexes });
    store = reopen();
    assert.deepEqual([...store.indexCovered('note', 'at', [id(0), id(95), id(100)])], [], 'unstarted build proves no absence');
    store.maintain();
    assert.equal(meta(host).after, id(31)); assert.equal(meta(host).through, id(95));
    assert.equal(store.indexReady('note', 'at'), false);
    store.write([row(100), { id: id(1), value: null }, { ...row(2), value: { at: 1002 } }]); store.checkpoint();
    store = reopen();
    const selection = [id(0), id(31), id(32), id(95), id(100), id(100), 'note:\u{10000}', 'note:\ue000'];
    assert.deepEqual([...store.indexCovered('note', 'at', selection)], [id(0), id(31), id(100), 'note:\u{10000}', 'note:\ue000']);
    assert.ok(!store.scan('note', 'at').some(entry => entry.id === id(1)));
    assert.ok(store.scan('note', 'at').some(entry => entry.id === id(2) && entry.values[0] === 1002));
    store.write([row(1)]); store.checkpoint(); store = reopen();
    assert.ok(store.indexCovered('note', 'at', [id(1)]).has(id(1)), 'delete/recreate behind cursor uses current keys');
    const saved = meta(host), exec = host.sql.exec.bind(host.sql);
    host.sql.exec = (query, ...params) => {
      assert.ok(!/^\s*(INSERT|UPDATE|DELETE)/i.test(query), 'coverage never advances or writes a projection');
      return exec(query, ...params);
    };
    assert.deepEqual([...store.indexCovered('note', 'at', [id(31), id(32), id(100)])], [id(31), id(100)]);
    host.sql.exec = exec; assert.deepEqual(meta(host), saved);
  } finally { host.db.close(); }
});

test('legacy cursors and changed declarations cannot certify an unknown suffix', () => {
  const host = sqliteHost(':memory:');
  try {
    let store = recordLogStore(host.sql, { transaction: host.transaction });
    store.write(Array.from({ length: 96 }, (_, n) => row(n))); store.checkpoint();
    store = recordLogStore(host.sql, { transaction: host.transaction, indexes }); store.maintain();
    const { through, ...legacy } = meta(host);
    host.sql.exec('UPDATE record_keys_meta SET value = ? WHERE key = ?', JSON.stringify(legacy), key);
    store = recordLogStore(host.sql, { transaction: host.transaction, indexes });
    assert.deepEqual([...store.indexCovered('note', 'at', [id(31), id(32), id(100)])], [id(31)]);
    const changed = indexes.map(index => ({ ...index, paths: [['different']] }));
    store = recordLogStore(host.sql, { transaction: host.transaction, indexes: changed });
    assert.deepEqual([...store.indexCovered('note', 'at', [id(0), id(100)])], [], 'old-signature progress proves nothing');
    assert.throws(() => store.indexCovered('note', 'missing', []), /No index/);
    assert.throws(() => store.indexCovered('note', 'at', [null]), /array of record ids/);
    assert.throws(() => store.indexCovered('note', 'at', ['bad\0id']), /array of record ids/);
  } finally { host.db.close(); }
});

test('failed backfill commit cannot expose coverage from a discarded cursor on the same instance', () => {
  const host = sqliteHost(':memory:'); let fail = false, wrote = false;
  const exec = host.sql.exec.bind(host.sql);
  host.sql.exec = (query, ...params) => { if (/^INSERT INTO record_keys_meta/.test(query) && params[0] === key) wrote = true; return exec(query, ...params); };
  const transaction = fn => host.transaction(() => { wrote = false; const result = fn(); if (fail && wrote) throw Error('backfill commit refused'); return result; });
  try {
    let store = recordLogStore(host.sql, { transaction });
    store.write(Array.from({ length: 96 }, (_, n) => row(n))); store.checkpoint();
    store = recordLogStore(host.sql, { transaction, indexes }); store.maintain();
    fail = true; assert.throws(() => store.maintain(), /backfill commit refused/); fail = false;
    assert.equal(meta(host).after, id(31));
    assert.deepEqual([...store.indexCovered('note', 'at', [id(31), id(32), id(63)])], [id(31)]);
    store = recordLogStore(host.sql, { transaction, indexes });
    assert.deepEqual([...store.indexCovered('note', 'at', [id(31), id(32), id(63)])], [id(31)]);
    store.maintain(); assert.ok(store.indexCovered('note', 'at', [id(63)]).has(id(63)));
  } finally { host.db.close(); }
});

test('capture negatives beyond the old frontier avoid bodies, while old uncovered matches remain authoritative', () => {
  const host = sqliteHost(':memory:');
  try {
    const at = n => new Date(Date.parse('2026-10-01T00:00:00Z') + n * 1000).toISOString();
    const message = (n, extra = {}) => ({ id: `message:${String(n).padStart(5, '0')}`, type: 'message', value: { app: 'Codex', speaker: 'person', at: at(n), text: 'words '.repeat(5000), ...extra } });
    let store = recordLogStore(host.sql, { transaction: host.transaction, indexes: RECORD_INDEXES.filter(index => !index.retired).map(index => index.type === 'message' && index.name === 'speaker' ? { ...index, carry: undefined, carry_presence: undefined } : index) });
    store.write(Array.from({ length: 96 }, (_, n) => message(n, { captured_road: n === 90 ? 'carrier_door' : 'mcp' }))); store.checkpoint();
    const reopen = () => recordLogStore(host.sql, { transaction: host.transaction, indexes: RECORD_INDEXES });
    store = reopen(); store.maintain();
    store.write(Array.from({ length: 128 }, (_, n) => message(1000 + n))); store.checkpoint(); store = reopen();
    assert.equal(store.indexReady('message', 'speaker'), false);
    const fields = store.fields.fieldsOf, touched = [];
    store.fields.fieldsOf = (type, ids, names) => { touched.push(...ids); return fields(type, ids, names); };
    const options = { app: 'Codex', speaker: 'person', road: 'carrier_door', since: at(0), limit: 128 };
    assert.deepEqual(messages(store).capturedTurns(options), []); assert.deepEqual(touched, [], 'current noncaptures have proved coverage');
    assert.deepEqual(messages(store).capturedTurns({ ...options, limit: 500 }), [{ id: message(90).id, at: at(90) }]);
    assert.ok(touched.includes(message(90).id)); assert.ok(touched.every(value => value <= message(95).id && value > message(31).id));
    store.write([message(1127, { captured_road: 'carrier_door' })]); store.checkpoint(); store = reopen();
    assert.deepEqual(messages(store).capturedTurns(options), [{ id: message(1127).id, at: at(1127) }]);
    store.write([{ id: message(1127).id, value: null }]); store.checkpoint(); store = reopen();
    assert.deepEqual(messages(store).capturedTurns({ ...options, limit: 1 }), []);
  } finally { host.db.close(); }
});

test('decomposed and log record interfaces expose declared coverage consistently', () => {
  for (const engine of ['eeaf', 'log']) {
    const host = sqliteHost(':memory:');
    try {
      if (engine === 'eeaf') setRecordEngine(host.sql, engine);
      const store = openRecords(host.sql, { transaction: host.transaction, hash: value => bytesToHex(blake3(new TextEncoder().encode(JSON.stringify(value)))) });
      assert.deepEqual([...store.indexCovered('message', 'speaker', ['message:a', 'message:a', 'message:\u{10000}'])], ['message:a', 'message:\u{10000}']);
      assert.throws(() => store.indexCovered('message', 'missing', []), /No index/);
      assert.throws(() => store.indexCovered('message', 'speaker', ['']), /array of record ids/);
      if (engine === 'eeaf') {
        const log = store.logStore();
        setRecordEngine(host.sql, log.engine); store.switchTo(log);
        assert.deepEqual([...store.indexCovered('message', 'speaker', ['message:after-switch'])], ['message:after-switch']);
      }
    } finally { host.db.close(); }
  }
});
