// test/slot-table.test.mjs
// The interned-slot current view (parts/slot-table) and how the record store reads through it: a key is hashed once,
// handles go stale instead of naming another key, memory stays inside its bytes, declared columns follow their field,
// and the record store's pages (prefix-compressed keys, values parsed one at a time, the value kept at the id key) read
// exactly what was written, including pages and records written in the layout before this one.
import test from 'node:test';
import assert from 'node:assert/strict';
import { slotTable, SLOT_SPACE } from '../do-work/slot-table.mjs';
import { sqliteHost } from '../../keep-and-wake-ai-sessions-on-this-computer/src/local-store.mjs';
import { recordLogStore } from '../../keep-and-wake-ai-sessions-on-this-computer/parts/record-log/do-work/record-log-store.mjs';
import { keptRuns } from '../../keep-and-wake-ai-sessions-on-this-computer/parts/record-log/do-work/kept-runs.mjs';

test('a slot answers its value, kind, version and declared columns, and a stale handle answers nothing', () => {
  const table = slotTable({ columns: [{ kind: 'note', field: 'at', as: 'number' }, { kind: 'note', field: 'room', as: 'text' }] });
  const slot = table.set('n1', 'note', { at: 5, room: 'kitchen' }, null, 100);
  const handle = table.handleOf(slot);
  assert.equal(table.find('n1'), slot);
  assert.equal(table.at(handle).room, 'kitchen');
  assert.equal(table.kindOf(slot), 'note');
  const at = table.column('note', 'at');
  const room = table.column('note', 'room');
  assert.equal(at.get(slot), 5);
  assert.equal(table.words.text(room.get(slot)), 'kitchen');
  const before = table.versionAt(handle);
  at.setAt(handle, 9);
  assert.equal(at.getAt(handle), 9);
  assert.ok(table.versionAt(handle) > before);
  table.set('n1', 'note', { at: 'not a number' }, null, 100);
  assert.ok(Number.isNaN(at.get(slot)), 'a value of another shape is absent, never coerced');
  assert.equal(room.get(slot), -1);
  table.drop('n1');
  assert.equal(table.find('n1'), -1);
  assert.equal(table.at(handle), undefined);
  assert.ok(Number.isNaN(at.getAt(handle)));
  const reused = table.set('n2', 'note', { at: 1 }, null, 100);
  assert.equal(reused, slot, 'the slot number is reused');
  assert.equal(table.at(handle), undefined, 'the old handle never names the new key');
  assert.equal(table.at(table.handleOf(reused)).at, 1);
  assert.ok(table.handleOf(reused) < 2 ** 53 && table.handleOf(reused) % SLOT_SPACE === slot);
  assert.throws(() => table.column('note', 'nothing'), /No column/);
});

test('resident bytes stay inside capacity, the most recently read survive, and growing keeps every slot', () => {
  const table = slotTable({ capacity_bytes: 50 * 100 });
  for (let index = 0; index < 5000; index += 1) {
    table.set(`k${index}`, 'thing', { index }, null, 100);
    if (index > 10) table.value(table.find('k3'));
  }
  const held = table.held();
  assert.ok(held.bytes <= 50 * 100, `holds ${held.bytes}`);
  assert.ok(held.evictions >= 4950);
  assert.equal(table.value(table.find('k3')).index, 3, 'a slot read since the hand passed is kept');
  const big = slotTable({ capacity_bytes: 1e9 });
  for (let index = 0; index < 5000; index += 1) big.set(`k${index}`, 'thing', { index }, null, 1);
  for (let index = 0; index < 5000; index += 1) assert.equal(big.value(big.find(`k${index}`)).index, index);
  assert.equal(big.slotsOfKind('thing').length, 5000);
  big.clear();
  assert.equal(big.held().slots, 0);
  assert.equal(big.find('k1'), -1);
});

const small = { page_bytes: 512, memtable_bytes: 4096, cache_bytes: 8192, big_bytes: 2048 };

test('the record store reads the same through slots, evictions, flushes, merges, restarts and rollbacks', () => {
  const host = sqliteHost(':memory:');
  const open = () => recordLogStore(host.sql, { transaction: host.transaction, runs: small, slot_bytes: 4000, indexes: [{ type: 'note', name: 'room', paths: [['room']] }] });
  let store = open();
  const model = new Map();
  let seed = 11;
  const random = () => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483648; };
  for (let round = 0; round < 2500; round += 1) {
    const id = `n${Math.floor(random() * 300)}`;
    const roll = random();
    if (roll < 0.15) { store.write([{ id, type: 'note', value: null }]); model.delete(id); }
    else if (roll < 0.25) {
      const value = { room: `r${round % 7}`, text: 'y'.repeat(Math.floor(random() * 200)) };
      // The host takes back what the store remembered of a transaction that rolled back, as the person store does.
      try { host.transaction(() => { store.write([{ id, type: 'note', value }]); throw new Error('roll back'); }); } catch { store.forgetCached(); }
    } else { const value = { room: `r${round % 7}`, round, text: 'x'.repeat(Math.floor(random() * (random() < 0.02 ? 3000 : 120))) }; store.write([{ id, type: 'note', value }]); model.set(id, value); }
    if (round % 97 === 0) store.maintain({ max_pages: 3 });
    if (round % 401 === 0) store = open();
    const probe = `n${Math.floor(random() * 300)}`;
    assert.deepEqual(store.read(probe), model.get(probe) ?? null, `round ${round} ${probe}`);
    assert.equal(store.typeOf(probe), model.has(probe) ? 'note' : null);
  }
  for (const [id, value] of model) assert.deepEqual(store.read(id), value);
  const rooms = new Map();
  for (const [id, value] of model) { if (!rooms.has(value.room)) rooms.set(value.room, []); rooms.get(value.room).push(id); }
  for (const [room, ids] of rooms) assert.deepEqual(store.fields.idsWhere('note', 'room', room).sort(), ids.sort());
  assert.ok(store.held().slots.bytes <= 4000 + 3000 * 2 + 1000, 'resident records stay near their bound');
  const found = store.find({ fields: [['text']], words: ['x'], limit: 200 }).map(row => row.id);
  const matching = new Set([...model].filter(([, value]) => value.text.includes('x')).map(([id]) => id));
  assert.equal(found.length, Math.min(200, matching.size));
  for (const id of found) assert.ok(matching.has(id), id);
});

test('pages and records written in the layout before this one still read, and are rewritten forward', () => {
  const host = sqliteHost(':memory:');
  // A run written the way pages were written before: body = JSON [[key, value] | [key] | [key, ref, parts]].
  const space = keptRuns(host.sql, { transaction: host.transaction, prefix: 'old', ...small });
  space.put('a', { v: 1 });
  space.flush();
  const table = host.db.prepare("SELECT name FROM sqlite_master WHERE name GLOB 'old_run_[0-9]*'").get().name;
  host.db.prepare(`UPDATE ${table} SET body = ? WHERE page = 0`).run(JSON.stringify([['a', { v: 1 }], ['b'], ['c', { v: 3 }]]));
  host.db.prepare('UPDATE old_runs SET last = ?').run(JSON.stringify('c'));
  const reopened = keptRuns(host.sql, { transaction: host.transaction, prefix: 'old', ...small });
  assert.deepEqual(reopened.get('a'), { v: 1 });
  assert.equal(reopened.get('b'), undefined);
  assert.deepEqual(reopened.range('a', 'z'), [['a', { v: 1 }], ['c', { v: 3 }]], 'tombstones are left out of a range');
  // A record kept the way records were kept before: the value at r|type|seq|id and [type, seq] at i|id.
  const store = recordLogStore(host.sql, { transaction: host.transaction, runs: small, indexes: [] });
  store.write([{ id: 'x1', type: 'note', value: { text: 'kept' } }]);
  store.checkpoint();
  const keys = keptRuns(host.sql, { transaction: host.transaction, prefix: 'record_keys', ...small });
  const at = keys.get('i\u0000x1');
  assert.equal(at.length, 4, '[type, seq, value, stamps]');
  keys.put('i\u0000x1', [at[0], at[1]]);
  keys.put(`r\u0000note\u0000${at[1]}\u0000x1`, { text: 'old layout' });
  keys.flush({ covered: keys.covered() });
  const old = recordLogStore(host.sql, { transaction: host.transaction, runs: small, indexes: [] });
  assert.deepEqual(old.read('x1'), { text: 'old layout' });
  assert.deepEqual(old.find({ fields: [['text']], words: ['layout'] }).map(row => row.id), ['x1']);
  old.write([{ id: 'x1', type: 'note', value: { text: 'new layout' } }]);
  old.checkpoint();
  const after = recordLogStore(host.sql, { transaction: host.transaction, runs: small, indexes: [] });
  assert.deepEqual(after.read('x1'), { text: 'new layout' });
  assert.deepEqual(after.find({ fields: [['text']], words: ['new'] }).map(row => row.id), ['x1']);
});

test('a page holds keys with shared starts and characters outside one code unit exactly', () => {
  const host = sqliteHost(':memory:');
  const space = keptRuns(host.sql, { transaction: host.transaction, prefix: 'kp', ...small });
  const keys = ['a', 'ab', 'abc', 'abd', 'b\u{1F600}x', 'b\u{1F600}y', 'b\u{1F601}', 'c\u0000d', 'c\u0000e'];
  for (const key of keys) space.put(key, { key, text: 'v'.repeat(40) });
  space.remove('abd');
  space.flush();
  const fresh = keptRuns(host.sql, { transaction: host.transaction, prefix: 'kp', ...small, cache_bytes: 1 });
  for (const key of keys) assert.deepEqual(fresh.get(key), key === 'abd' ? undefined : { key, text: 'v'.repeat(40) });
  assert.deepEqual(fresh.range('', '￿').map(([key]) => key), keys.filter(key => key !== 'abd').sort());
});

test('a fragmented store opens and writes without merging its backlog; bounded idle steps preserve every key', () => {
  const host = sqliteHost(':memory:');
  const open = max_runs => keptRuns(host.sql, { transaction: host.transaction, prefix: 'cap', ...small, max_runs });
  // Written out 40 times with no idle merge step at all, as when a store's idle work is set aside for hours.
  const space = open(100);
  const want = new Map();
  for (let round = 0; round < 40; round += 1) {
    for (let at = 0; at < 5; at += 1) {
      const key = `k${(round * 3 + at) % 37}`;
      if ((round + at) % 7 === 0) { space.remove(key); want.delete(key); } else { space.put(key, { round, at }); want.set(key, { round, at }); }
    }
    space.flush();
  }
  assert.equal(space.held().runs.length, 40, 'without a cap every write-out is its own run');
  // A cold open and foreground write must not synchronously merge all 40 runs.
  const capped = open(6);
  assert.equal(capped.held().runs.length, 40);
  assert.equal(capped.mergeDue(), true);
  assert.deepEqual(capped.get('k1'), want.get('k1'));
  for (let round = 40; round < 80; round += 1) {
    capped.put(`k${round % 37}`, { round });
    want.set(`k${round % 37}`, { round });
    capped.flush();
    assert.equal(capped.held().runs.length, round + 1, 'foreground writes leave the merge to idle work');
  }
  let steps = 0;
  while (capped.held().runs.length > 6) {
    capped.step({ max_pages: 1 });
    assert.ok(++steps < 500, 'bounded idle steps eventually drain the run backlog');
  }
  const fresh = open(6);
  for (let key = 0; key < 37; key += 1) assert.deepEqual(fresh.get(`k${key}`), want.get(`k${key}`), `k${key}`);
  assert.deepEqual(fresh.range('', '￿').map(([key]) => key), [...want.keys()].sort());
});
