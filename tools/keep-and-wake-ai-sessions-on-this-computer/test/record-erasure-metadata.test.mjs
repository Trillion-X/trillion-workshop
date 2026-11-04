import test from 'node:test';
import assert from 'node:assert/strict';
import { sqliteHost } from '../src/local-store.mjs';
import { RECORD_MODEL, RECORD_INDEXES } from '../src/record-engine.mjs';
import { recordLogStore } from '../parts/record-log/do-work/record-log-store.mjs';

const marker = 'PRIVATE_INDEXED_SOURCE_20261014';
const oldModel = { ...RECORD_MODEL, kinds: RECORD_MODEL.kinds.map(({ erase_fields, ...kind }) => kind) };
const open = (host, model = RECORD_MODEL) => recordLogStore(host.sql, { transaction: host.transaction, model, indexes: RECORD_INDEXES });
const drive = store => { for (let wake = 0; wake < 200 && store.maintenanceAt() !== null; wake++) store.maintain({ max_pages: 512 }); };
const holding = sql => sql.exec("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").toArray().filter(({ name }) =>
  sql.exec(`SELECT * FROM "${name.replaceAll('"', '""')}"`).toArray().some(row => Object.values(row).some(value => {
    const text = typeof value === 'string' ? value : value instanceof ArrayBuffer ? Buffer.from(value).toString()
      : ArrayBuffer.isView(value) ? Buffer.from(value.buffer, value.byteOffset, value.byteLength).toString() : '';
    return text.includes(marker);
  }))).map(({ name }) => name);
const message = { id: 'message:original-private-source', type: 'message', value: {
  app: 'Notes', conversation_id: `${marker}:conversation`, source_ref: `${marker}:source`, text: 'Words to erase',
} };

test('indexed metadata stays queryable while live and is scrubbed from historical index keys after erasure', () => {
  const host = sqliteHost(':memory:');
  const store = open(host);
  store.write([message]);
  store.checkpoint();
  assert.deepEqual(store.scan('message', 'conversation_id', { equal: [message.value.conversation_id], limit: 10 }).map(row => row.id), [message.id]);
  assert.equal(store.read(message.id).source_ref, message.value.source_ref);
  store.sealLog();
  store.erase(message.id); drive(store);
  assert.equal(store.erasure(message.id), 'done');
  assert.deepEqual(holding(host.sql), []);
  assert.deepEqual(store.scan('message', 'conversation_id', { equal: [message.value.conversation_id], limit: 10 }), []);
  assert.equal(store.read(message.id), null);
  host.db.close();
});

test('bounded forward maintenance widens an already completed original erasure without changing its time', () => {
  const host = sqliteHost(':memory:');
  const old = open(host, oldModel);
  old.write([message]); old.checkpoint(); old.sealLog(); old.erase(message.id); drive(old);
  assert.equal(old.erasure(message.id), 'done');
  assert.ok(holding(host.sql).length, 'the old declaration actually retained private metadata');
  const original = host.sql.exec('SELECT erased_at FROM record_erasable_keys WHERE record_id=?', message.id).toArray()[0].erased_at;
  const current = open(host);
  assert.notEqual(current.maintenanceAt(), null);
  drive(current);
  assert.equal(current.erasure(message.id), 'done');
  assert.deepEqual(holding(host.sql), []);
  assert.equal(host.sql.exec('SELECT erased_at FROM record_erasable_keys WHERE record_id=?', message.id).toArray()[0].erased_at, original);
  const cold = open(host); drive(cold);
  assert.equal(cold.read(message.id), null);
  assert.deepEqual(holding(host.sql), []);
  host.db.close();
});

test('a copy with a completed older erasure takes wider fields and cannot restore private metadata', () => {
  const leaderHost = sqliteHost(':memory:'), copyHost = sqliteHost(':memory:');
  const leader = open(leaderHost), follower = open(copyHost, oldModel);
  follower.write([message]); follower.erase(message.id); drive(follower);
  assert.ok(holding(copyHost.sql).length);
  leader.write([message]); leader.erase(message.id); drive(leader);
  const original = copyHost.sql.exec('SELECT erased_at FROM record_erasable_keys WHERE record_id=?', message.id).toArray()[0].erased_at;
  assert.deepEqual(follower.takeErasureKeys(leader.erasureKeys([message.id])), [message.id]);
  drive(follower);
  assert.deepEqual(holding(copyHost.sql), []);
  assert.equal(copyHost.sql.exec('SELECT erased_at FROM record_erasable_keys WHERE record_id=?', message.id).toArray()[0].erased_at, original);
  assert.deepEqual(follower.takeErasureKeys(leader.erasureKeys([message.id])), []);
  assert.equal(follower.read(message.id), null);
  leaderHost.db.close(); copyHost.db.close();
});
