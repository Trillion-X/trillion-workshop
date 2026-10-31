import test from 'node:test';
import assert from 'node:assert/strict';
import { compareValues, foldItems, identityOf } from '../read-data/fold.mjs';

const chat = { key: ['/id'], signature: ['/author', '/at', '/text'], order: ['/id', '/at'], conflict: { newer: { by: ['/edited'], strict: true } } };
const m = (id, text, extra = {}) => ({ id, text, at: `2026-01-01T00:00:${String(id).padStart(2, '0')}Z`, ...extra });

test('a message pulled twice is kept once, and the pile does not grow', () => {
  const first = foldItems([], [m('2', 'b'), m('1', 'a')], chat);
  const again = foldItems(first.items, [m('1', 'a'), m('2', 'b')], chat);
  assert.deepEqual(again.items, first.items);
  assert.equal(again.added, 0);
  assert.equal(again.changed, 0);
});

test('messages come out in id order whatever order they arrived in, including ids past 2^53', () => {
  const big = ['1100000000000000003', '1100000000000000001', '1100000000000000002'].map(id => ({ id, text: id }));
  assert.deepEqual(foldItems([], big, chat).items.map(item => item.id), ['1100000000000000001', '1100000000000000002', '1100000000000000003']);
  assert.equal(compareValues('1100000000000000002', '1100000000000000001'), 1);
  assert.equal(compareValues('1700000000.000200', '1700000000.000100'), 1);
  assert.equal(compareValues('9', '10'), -1);
  assert.equal(compareValues('-2', '-10'), 1);
  assert.equal(compareValues('-1', '1'), -1);
  assert.equal(compareValues('b', 'a'), 1);
});

test('earlier history is never lost when a later pull brings only newer messages', () => {
  const held = foldItems([], [m('1', 'a'), m('2', 'b')], chat).items;
  assert.deepEqual(foldItems(held, [m('3', 'c')], chat).items.map(item => item.id), ['1', '2', '3']);
});

test('a strictly later edit replaces the held copy; the same stamp and an older one do not', () => {
  const held = foldItems([], [m('1', 'old', { edited: '2026-02-01' })], chat).items;
  assert.equal(foldItems(held, [m('1', 'new', { edited: '2026-03-01' })], chat).items[0].text, 'new');
  assert.equal(foldItems(held, [m('1', 'same', { edited: '2026-02-01' })], chat).items[0].text, 'old');
  assert.equal(foldItems(held, [m('1', 'older', { edited: '2026-01-01' })], chat).items[0].text, 'old');
  assert.equal(foldItems(held, [m('1', 'no stamp')], chat).items[0].text, 'old');
});

test('a tie goes to the arriving copy when the policy is not strict, and an edit is never downgraded', () => {
  const loose = { ...chat, conflict: { newer: { by: ['/edited'], strict: false } } };
  const held = [m('1', 'old', { edited: 5 })];
  assert.equal(foldItems(held, [m('1', 'tie', { edited: 5 })], loose).items[0].text, 'tie');
  assert.equal(foldItems(held, [m('1', 'older', { edited: 4 })], loose).items[0].text, 'old');
  assert.equal(foldItems([m('1', 'orig')], [m('1', 'edited', { edited: 1 })], loose).items[0].text, 'edited');
});

test('the keep policy keeps the held copy and the merge policy takes the fields of both with the arriving ones winning', () => {
  const held = [{ id: 'p', title: 'a', pins: 1 }];
  assert.deepEqual(foldItems(held, [{ id: 'p', title: 'b' }], { key: ['/id'], conflict: { keep: 'held' } }).items, held);
  assert.deepEqual(foldItems(held, [{ id: 'p', title: 'b' }], { key: ['/id'], conflict: { merge: true } }).items, [{ id: 'p', title: 'b', pins: 1 }]);
});

test('items without an order keep the order they arrived in', () => {
  const items = foldItems([{ id: 'z' }], [{ id: 'b' }, { id: 'a' }], { key: ['/id'] }).items;
  assert.deepEqual(items.map(item => item.id), ['z', 'b', 'a']);
});

test('an entry with no identity or that is not an object is skipped, never a crash', () => {
  const done = foldItems([], [null, 'text', 7, [], { text: 'no id' }, m('1', 'a')], { key: ['/id'] });
  assert.deepEqual(done.items.map(item => item.id), ['1']);
});

test('an entry with no key is identified by its author, time and first 120 words, so it is still kept once', () => {
  const keyless = { author: 'u1', at: '2026-01-01', text: 'x'.repeat(300) };
  assert.equal(identityOf(keyless, chat), `sig:u1|2026-01-01|${'x'.repeat(120)}`);
  const once = foldItems([], [keyless, { ...keyless }], chat);
  assert.equal(once.items.length, 1);
});

test('an item that has none of the order pointers sorts after those that have one, and a second pointer is used when the first is missing', () => {
  const items = foldItems([], [{ id: 'x', text: 'no order' }, { id: 'b', at: '2026-01-02' }, { id: 'a', at: '2026-01-01' }, { id: '5', text: 'five' }], { key: ['/id'], order: ['/n', '/at'] }).items;
  assert.deepEqual(items.map(item => item.id), ['a', 'b', 'x', '5']);
});

test('folding changes neither the held list nor the arriving list', () => {
  const held = [m('1', 'a')];
  const arriving = [m('1', 'b', { edited: 'z' }), m('2', 'c')];
  const heldBefore = JSON.stringify(held);
  const arrivingBefore = JSON.stringify(arriving);
  const done = foldItems(held, arriving, chat);
  done.items[0].text = 'changed afterwards';
  assert.equal(JSON.stringify(held), heldBefore);
  assert.equal(JSON.stringify(arriving), arrivingBefore);
});

test('an arriving object with no identity is left out and counted, and what is not an object is ignored', () => {
  const done = foldItems([], [m('1', 'a'), { text: 'no key, no signature' }, 'not an object', null], { key: ['/id'] });
  assert.equal(done.added, 1);
  assert.equal(done.skipped, 1);
  assert.deepEqual(done.items.map(item => item.id), ['1']);
});
