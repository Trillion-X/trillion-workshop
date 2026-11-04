// test/kept-records.test.mjs
//
// A record read on every look (the notices the page shows) is answered from the copy read last until something writes
// it. On 2026-10-05 GET /tell/notices was asked 83,918 times and read 427M rows, about 5,000 rows per look, for a list
// that changes a few times a day: its rows are past what the decomposed engine keeps of one record (256 KiB), so
// every look read them all and assembled the list again. A second read of an unchanged record reaches the store not at
// all; a write to it, or a transaction that rolled back, reads it again; the kept copy cannot be changed by a caller.
// Both engines.
import test from 'node:test';
import assert from 'node:assert/strict';
import { sqliteHost } from '../src/local-store.mjs';
import { decisionStore, identityOf } from '../src/decision-store.mjs';
import { eeafStore } from '../parts/eeaf/do-work/eeaf-sqlite-store.mjs';
import { keptRecords } from '../src/record-engine.mjs';

// Opens the store on the decomposed tables when asked, and counts the reads that reach it.
function opened({ decomposed }) {
  const host = sqliteHost(':memory:');
  if (decomposed) eeafStore(host.sql, { transaction: host.transaction, hash: identityOf }).write([{ id: 'old:1', type: 'old', value: { a: 1 } }], { actor: { by: 'test' } });
  const { eeaf } = decisionStore(host.sql, { transaction: host.transaction });
  let reads = 0;
  const counted = { ...eeaf, read: (...args) => { reads += 1; return eeaf.read(...args); } };
  return { eeaf, counted, host, reads: () => { const n = reads; reads = 0; return n; } };
}
const notices = items => [{ id: 'told-the-person', type: 'told-the-person', value: { items } }];
const by = { actor: { by: 'test' } };

for (const decomposed of [true, false]) {
  const engine = decomposed ? 'decomposed tables' : 'log engine';

  test(`an unchanged record is read once, a written one again (${engine})`, () => {
    const { eeaf, counted, reads } = opened({ decomposed });
    eeaf.write(notices([{ seq: 1, title: 'Your video is ready', results: { page: { sent: true } } }]), by);
    const kept = keptRecords(counted);
    assert.equal(kept, keptRecords(counted), 'one reader per store');
    assert.equal(kept.read('told-the-person').items[0].title, 'Your video is ready');
    assert.equal(reads(), 1, 'the first look reads the record');
    for (let n = 0; n < 5; n += 1) assert.equal(kept.read('told-the-person').items.length, 1);
    assert.equal(reads(), 0, 'looking again reads nothing');
    eeaf.write([{ id: 'other', type: 'note', value: { a: 1 } }], by);
    kept.read('told-the-person');
    assert.equal(reads(), 0, 'a write to another record leaves it kept');
    eeaf.write(notices([{ seq: 1, title: 'Your video is ready', results: {} }, { seq: 2, title: 'Recording saved', results: {} }]), by);
    assert.deepEqual(kept.read('told-the-person').items.map(item => item.title), ['Your video is ready', 'Recording saved']);
    assert.equal(reads(), 1, 'a write to it reads it again');
    assert.equal(kept.read('missing'), null);
  });

  test(`a rolled-back write is never answered from the kept copy (${engine})`, () => {
    const { eeaf, host } = opened({ decomposed });
    eeaf.write(notices([{ seq: 1, title: 'before', results: {} }]), by);
    const kept = keptRecords(eeaf);
    assert.equal(kept.read('told-the-person').items[0].title, 'before');
    assert.throws(() => {
      try {
        host.transaction(() => {
          eeaf.write(notices([{ seq: 1, title: 'never kept', results: {} }]), by);
          assert.equal(kept.read('told-the-person').items[0].title, 'never kept');
          throw new Error('stopped');
        });
      } catch (error) { eeaf.forgetCached(); throw error; }
    }, /stopped/);
    assert.equal(kept.read('told-the-person').items[0].title, 'before');
  });

  test(`a kept copy cannot be changed by whoever reads it (${engine})`, () => {
    const { eeaf } = opened({ decomposed });
    eeaf.write(notices([{ seq: 1, title: 'kept', results: { page: { sent: true } } }]), by);
    const items = keptRecords(eeaf).read('told-the-person').items;
    assert.throws(() => { items[0].results.page = { sent: false }; }, TypeError);
    assert.throws(() => { items.push({}); }, TypeError);
    const changed = { ...items[0], results: { ...items[0].results, phone: { sent: true } } };
    assert.equal(changed.results.phone.sent, true, 'a copy made by the caller can be changed');
  });
}

test('at most `most` records are kept, the least recently read let go first', () => {
  const { eeaf, counted, reads } = opened({ decomposed: false });
  eeaf.write(['a', 'b', 'c'].map(id => ({ id, type: 'note', value: { id } })), by);
  const kept = keptRecords(counted, { most: 2 });
  kept.read('a'); kept.read('b'); kept.read('a'); kept.read('c');
  reads();
  kept.read('a');
  assert.equal(reads(), 0, 'a was read recently, so it is still kept');
  kept.read('b');
  assert.equal(reads(), 1, 'b was let go when c came in');
});
