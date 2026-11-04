// test/starting-lists.test.mjs
//
// src/lists.mjs invariant 24: a starting list a part of Trillion holds in a store (holdStartingList; here the account's
// Waiting on you, src/waiting-on-you.json) reads as its DATA, shaped as `save` keeps it, and stores nothing until the first
// write that keeps something in it; that write keeps the list first, and from then on the DATA never alters it.
import test from 'node:test';
import assert from 'node:assert/strict';
import { localStore } from '../src/local-store.mjs';
import { holdStartingList, makeLists } from '../../keep-lists-of-rows/lists.mjs';
import waiting from '../src/waiting-on-you.json' with { type: 'json' };

const own = waiting.list;
const open = () => {
  const store = localStore(':memory:');
  let n = 0;
  return { store, lists: makeLists({ eeaf: store.eeaf, newId: () => `row-${++n}` }) };
};
const held = () => { const opened = open(); holdStartingList(opened.store.eeaf, own); return opened; };
const listed = async lists => (await lists.all()).lists.map(list => [list.id, list.rows]);

test('a starting list reads as its DATA, shaped as save keeps it, and stores nothing', async () => {
  const { store, lists } = held();
  const saved = open();
  await saved.lists.save({ ...own });
  assert.deepEqual(await lists.find(own.id), await saved.lists.find(own.id), 'the same list a save of the DATA keeps');
  assert.equal(store.eeaf.read(`list:${own.id}`), null, 'no list record is kept');
  assert.equal(store.eeaf.lastLogId(), null, 'nothing at all is written');
  assert.ok(await lists.has(own.id));
  assert.deepEqual(await listed(lists), [[own.id, 0]]);
  assert.deepEqual((await lists.read(own.id, { open: true })).rows, []);
  assert.equal(await lists.openFillAt(own.id), null, 'no rows, so no fill is due');
  assert.equal(await lists.fillOpen(own.id), true);
  assert.equal(store.eeaf.lastLogId(), null, 'reads and the idle fill wrote nothing');
});

test('the first row kept in it keeps the list first, then the row', async () => {
  const { store, lists } = held();
  const before = await lists.find(own.id);
  await lists.putRows(own.id, { rows: [{ id: 'sign-in', values: { what: 'Sign in to the bank' } }] });
  const kept = store.eeaf.read(`list:${own.id}`);
  assert.ok(kept, 'the list is kept');
  assert.deepEqual({ ...await lists.find(own.id) }, { ...before }, 'kept as it read');
  assert.ok(store.eeaf.read(`entity-list:${own.id}`), 'kept as a save keeps it, with its index state');
  const rows = (await lists.read(own.id, { open: true })).rows;
  assert.deepEqual(rows.map(row => [row.id, row.values.what, row.values.status]), [['sign-in', 'Sign in to the bank', 'Waiting']]);
});

test('once kept, a change to the DATA never alters it; a store that holds no starting list lists none', async () => {
  const { store, lists } = held();
  await lists.putRows(own.id, { rows: [{ id: 'a', values: { what: 'Approve the payment' } }] });
  holdStartingList(store.eeaf, { ...own, label: 'Something else', fields: [...own.fields, { id: 'added_later', label: 'Added later', kind: 'text' }] });
  assert.equal((await lists.find(own.id)).label, own.label);
  assert.ok(!(await lists.find(own.id)).fields.some(field => field.id === 'added_later'));
  const other = open();
  assert.equal(await other.lists.find(own.id), null);
  assert.deepEqual(await listed(other.lists), []);
});
