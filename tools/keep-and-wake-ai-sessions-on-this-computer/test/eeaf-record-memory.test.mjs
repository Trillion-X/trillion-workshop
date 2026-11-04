// test/eeaf-record-memory.test.mjs
// A person's store answers one request at a time, and every request read the same small records (settings, payment
// effects, sign-in reach) again from SQLite: about five statements per record. The store now keeps each record it read
// whole (parts/eeaf/do-work/eeaf-sqlite-store.mjs `recordMemory`) and answers the next read of an unchanged record with
// no statement at all. These tests hold what makes that safe: a write is always read back fresh, a rollback leaves no
// remembered value behind, a copy handed out cannot change what is kept, and the memory stays bounded.
import test from 'node:test';
import assert from 'node:assert/strict';
import { sqliteHost } from '../src/local-store.mjs';
import { eeafStore } from '../parts/eeaf/do-work/eeaf-sqlite-store.mjs';

function counted() {
  const host = sqliteHost(':memory:');
  let statements = 0;
  const exec = host.sql.exec.bind(host.sql);
  host.sql.exec = (...args) => { statements += 1; return exec(...args); };
  return { ...host, statements: () => statements };
}

test('an unchanged record is read again with no statement, and a write makes the next read fresh', () => {
  const { sql, transaction, statements } = counted();
  const store = eeafStore(sql, { transaction, hash: text => `h:${text}` });
  store.write([{ id: 'setting:plan', type: 'setting', value: { value: { name: 'free', seats: [1, 2] } } }]);
  assert.deepEqual(store.read('setting:plan'), { value: { name: 'free', seats: [1, 2] } });
  const before = statements();
  for (let index = 0; index < 10; index += 1) store.read('setting:plan');
  assert.equal(statements(), before, 'reads of an unchanged record run no statement');

  store.write([{ id: 'setting:plan', type: 'setting', value: { value: { name: 'paid', seats: [1] } } }]);
  assert.deepEqual(store.read('setting:plan'), { value: { name: 'paid', seats: [1] } }, 'a write is read back fresh');
  store.write([{ id: 'setting:plan', type: 'setting', value: null }]);
  assert.equal(store.read('setting:plan'), null, 'a removal is read back as absent');
  store.write([{ id: 'setting:plan', type: 'setting', value: { value: 'back' } }]);
  assert.deepEqual(store.read('setting:plan'), { value: 'back' }, 'a record written after it was read as absent is read back');
});

test('a copy handed out never changes what the store remembers', () => {
  const { sql, transaction } = counted();
  const store = eeafStore(sql, { transaction, hash: text => `h:${text}` });
  store.write([{ id: 'pursuit:a', type: 'pursuit', value: { title: 'Ship', steps: [{ say: 'one' }] } }]);
  const first = store.read('pursuit:a');
  first.title = 'changed by a caller';
  first.steps[0].say = 'changed too';
  assert.deepEqual(store.read('pursuit:a'), { title: 'Ship', steps: [{ say: 'one' }] });
});

test('a write rolled back by the host leaves no remembered value behind', () => {
  const { sql, transaction } = counted();
  const store = eeafStore(sql, { transaction, hash: text => `h:${text}` });
  store.write([{ id: 'setting:x', type: 'setting', value: { value: 1 } }]);
  assert.deepEqual(store.read('setting:x'), { value: 1 });
  // The host's own transaction writes and reads inside it, then fails: the host forgets what the store remembered.
  assert.throws(() => transaction(() => {
    store.write([{ id: 'setting:x', type: 'setting', value: { value: 2 } }]);
    assert.deepEqual(store.read('setting:x'), { value: 2 });
    throw new Error('rolled back');
  }));
  store.forgetCached();
  assert.deepEqual(store.read('setting:x'), { value: 1 }, 'the committed value is read, not the rolled-back one');
});

test('a member written into a list makes its record read fresh, and a second store over the same database shares the memory', () => {
  const { sql, transaction } = counted();
  const store = eeafStore(sql, { transaction, hash: text => `h:${text}` });
  store.write([{ id: 'decision:d', type: 'decision', value: { goal: 'g', calls: [] } }]);
  assert.deepEqual(store.read('decision:d'), { goal: 'g', calls: [] });
  store.writeMember('decision:d', 'decision', 'calls', 0, { tool: 't' });
  assert.deepEqual(store.read('decision:d').calls, [{ tool: 't' }]);

  const again = eeafStore(sql, { transaction, hash: text => `h:${text}` });
  assert.deepEqual(store.read('decision:d').goal, 'g');
  again.write([{ id: 'decision:d', type: 'decision', value: { goal: 'changed', calls: [] } }]);
  assert.equal(store.read('decision:d').goal, 'changed', 'a write through the other store is seen');
});

test('the remembered records stay bounded in count and bytes, and a record too big to keep is read every time', () => {
  const { sql, transaction, statements } = counted();
  const store = eeafStore(sql, { transaction, hash: text => `h:${text}` });
  for (let index = 0; index < 5000; index += 1) {
    store.write([{ id: `note:${index}`, type: 'note', value: { text: `note ${index}` } }]);
    store.read(`note:${index}`);
  }
  const held = store.held().records;
  assert.ok(held.records <= 4000, `kept ${held.records} records`);
  assert.ok(held.bytes <= 4 * 1024 * 1024, `kept ${held.bytes} bytes`);
  store.write([{ id: 'note:big', type: 'note', value: { text: 'x'.repeat(100 * 1024) } }]);
  store.read('note:big');
  const before = statements();
  store.read('note:big');
  assert.ok(statements() > before, 'a record past the per-record bound is read again');
});

// 2026-10-04: Sam Example's store read ~2 400 whole records a minute (a count, then entities, values and links over each
// record's id range), because every write read the record it was about to change and then forgot it, so the next read
// and the next write read it all again. A record this store wrote is kept as the rows it was written as.
test('a record written is neither read again by the next read nor by the next write', () => {
  const host = sqliteHost(':memory:');
  const ranges = [];
  const exec = host.sql.exec.bind(host.sql);
  host.sql.exec = (query, ...params) => { if (/>= \? AND/.test(query)) ranges.push(query); return exec(query, ...params); };
  const store = eeafStore(host.sql, { transaction: host.transaction, hash: text => `h:${text}` });
  store.write([{ id: 'handoff:a', type: 'handoff', value: { state: 'open', steps: [{ say: 'one' }], about: { kind: 'file' } } }]);
  const first = ranges.length;
  for (let index = 0; index < 5; index += 1) {
    store.write([{ id: 'handoff:a', type: 'handoff', value: { state: `taken ${index}`, steps: [{ say: 'one' }, { say: `${index}` }], about: { kind: 'file' } } }]);
    assert.deepEqual(store.read('handoff:a'), { state: `taken ${index}`, steps: [{ say: 'one' }, { say: `${index}` }], about: { kind: 'file' } });
  }
  assert.equal(ranges.length, first, 'no whole-record read after the record was written');
  const fresh = eeafStore(host.sql, { transaction: host.transaction, hash: text => `h:${text}` });
  fresh.forgetCached();
  assert.deepEqual(fresh.read('handoff:a'), { state: 'taken 4', steps: [{ say: 'one' }, { say: '4' }], about: { kind: 'file' } }, 'the database holds what was kept');
});
