// test/kept-list.test.mjs
// A short list kept one record per item (src/kept-list.mjs): adding an item writes that item and the head, never the
// whole list; the same list again writes nothing; a list an earlier version kept whole reads as it was and becomes
// item records on its next write.
import assert from 'node:assert/strict';
import test from 'node:test';
import { keptList } from '../src/kept-list.mjs';

function store(initial = {}) {
  const rows = new Map(Object.entries(initial));
  const written = [];
  return {
    rows, written,
    read: id => rows.get(id) ?? null,
    write: envelopes => { for (const envelope of envelopes) { written.push(envelope); if (envelope.value === null) rows.delete(envelope.id); else rows.set(envelope.id, envelope.value); } },
  };
}
const item = (seq, words = `notice ${seq}`) => ({ seq, words });

test('adding one item to a long list writes that item and the head, nothing else', () => {
  const eeaf = store();
  const list = keptList(eeaf, { id: 'news', type: 'news' });
  const items = Array.from({ length: 50 }, (_, n) => item(n + 1));
  list.put(items);
  eeaf.written.length = 0;
  list.put([...items.slice(1), item(51)]);
  assert.deepEqual(eeaf.written.map(envelope => envelope.id).sort(), ['news', 'news:1', 'news:51'], 'the new item, the dropped one and the head');
  assert.equal(eeaf.written.find(envelope => envelope.id === 'news:1').value, null);
  assert.deepEqual(list.items().map(one => one.seq), [...items.slice(1).map(one => one.seq), 51]);
  assert.equal(list.lastSeq(), 51);
  eeaf.written.length = 0;
  list.put(list.items());
  assert.equal(eeaf.written.length, 0, 'the same list again writes nothing');
});

test('an item changed in place is written alone, and every record carries the list type', () => {
  const eeaf = store();
  const list = keptList(eeaf, { id: 'news', type: 'news' });
  list.put([item(1), item(2)]);
  eeaf.written.length = 0;
  list.put([item(1), item(2, 'changed')]);
  assert.deepEqual(eeaf.written.map(envelope => envelope.id), ['news:2']);
  assert.ok([...eeaf.rows.keys()].length === 3);
  assert.equal(list.items()[1].words, 'changed');
});

test('a list an earlier version kept whole reads as it was and becomes item records on its next write', () => {
  const eeaf = store({ news: { items: [item(1), item(2)] } });
  const list = keptList(eeaf, { id: 'news', type: 'news' });
  assert.deepEqual(list.items().map(one => one.seq), [1, 2]);
  assert.equal(list.lastSeq(), 2);
  list.put([...list.items(), item(3)]);
  assert.deepEqual(eeaf.read('news'), { seqs: [1, 2, 3] });
  assert.deepEqual(list.items().map(one => one.seq), [1, 2, 3]);
  assert.equal(eeaf.written.filter(envelope => envelope.type === 'news').length, 4);
});

test('an empty list has no newest item', () => {
  const list = keptList(store(), { id: 'news', type: 'news' });
  assert.deepEqual(list.items(), []);
  assert.equal(list.lastSeq(), null);
});

test('asking for what is new since the last seq seen reads the head alone when nothing was added', () => {
  const eeaf = store();
  const reads = [];
  const list = keptList(eeaf, { id: 'news', type: 'news', read: id => { reads.push(id); return eeaf.read(id); } });
  list.put(Array.from({ length: 200 }, (_, n) => item(n + 1)));
  reads.length = 0;
  assert.deepEqual(list.items({ after: 200 }), []);
  assert.deepEqual(reads, ['news'], 'one read: the head');
  reads.length = 0;
  list.put([...list.items(), item(201)]);
  reads.length = 0;
  assert.deepEqual(list.items({ after: 199 }).map(one => one.seq), [200, 201]);
  assert.deepEqual(reads, ['news', 'news:200', 'news:201']);
  const whole = keptList(store({ old: { items: [item(1), item(2), item(3)] } }), { id: 'old', type: 'old' });
  assert.deepEqual(whole.items({ after: 2 }).map(one => one.seq), [3], 'a list kept whole by an earlier version reads the same way');
});

test('reading what is new since a seq reads the head alone when nothing was added', () => {
  const eeaf = store();
  const reads = [];
  const list = keptList(eeaf, { id: 'news', type: 'news', read: id => { reads.push(id); return eeaf.read(id); } });
  list.put(Array.from({ length: 200 }, (_, n) => item(n + 1)));
  reads.length = 0;
  assert.deepEqual(list.items({ after: 200 }), []);
  assert.deepEqual(reads, ['news'], 'one record read when nothing is new');
  reads.length = 0;
  assert.deepEqual(list.items({ after: 198 }).map(one => one.seq), [199, 200]);
  assert.deepEqual(reads, ['news', 'news:199', 'news:200']);
});

test('an indexed existence read of a large list reads only its head and unchanged puts write nothing', () => {
  const eeaf = store();
  const reads = [];
  const list = keptList(eeaf, { id: 'news', type: 'news', indexFields: ['kind'], read: id => { reads.push(id); return eeaf.read(id); } });
  const items = Array.from({ length: 250 }, (_, n) => ({ ...item(n + 1), kind: n === 3 ? 'ai-reply' : 'other' }));
  list.put(items);
  reads.length = 0;
  assert.equal(list.hasValue('kind', 'ai-reply'), true);
  assert.equal(list.hasValue('kind', 'missing'), false);
  assert.deepEqual(reads, ['news', 'news'], 'present and absent indexed values each read the head only');
  eeaf.written.length = 0;
  list.put(items);
  assert.equal(eeaf.written.length, 0, 'an unchanged list and summary write nothing');
});

test('legacy whole-list and split-head forms discover safely, then indexed heads answer in one read', () => {
  const wholeReads = [];
  const wholeStore = store({ old: { items: [{ ...item(1), kind: 'other' }, { ...item(2), kind: 'ai-reply' }] } });
  const whole = keptList(wholeStore, { id: 'old', type: 'old', indexFields: ['kind'], read: id => { wholeReads.push(id); return wholeStore.read(id); } });
  assert.equal(whole.hasValue('kind', 'ai-reply'), true);
  assert.deepEqual(wholeReads, ['old'], 'legacy whole-list discovery uses the existing head payload');
  whole.put(whole.items());
  wholeReads.length = 0;
  assert.equal(whole.hasValue('kind', 'ai-reply'), true);
  assert.deepEqual(wholeReads, ['old'], 'the migrated summary answers from the head');

  const splitReads = [];
  const splitStore = store({ split: { seqs: [1, 2, 3] }, 'split:1': { item: { ...item(1), kind: 'other' } },
    'split:2': { item: { ...item(2), kind: 'ai-reply' } }, 'split:3': { item: { ...item(3), kind: 'other' } } });
  const split = keptList(splitStore, { id: 'split', type: 'split', indexFields: ['kind'], read: id => { splitReads.push(id); return splitStore.read(id); } });
  assert.equal(split.hasValue('kind', 'ai-reply'), true);
  assert.deepEqual(splitReads, ['split', 'split:1', 'split:2'], 'legacy discovery stops at the first match');
  split.put(split.items());
  splitReads.length = 0;
  assert.equal(split.hasValue('kind', 'ai-reply'), true);
  assert.deepEqual(splitReads, ['split'], 'the upgraded summary answers from the head');
});

test('indexed field counts follow edits and removals and safely count prototype-named values', () => {
  const eeaf = store();
  const list = keptList(eeaf, { id: 'news', type: 'news', indexFields: ['kind'] });
  list.put([{ ...item(1), kind: '__proto__' }, { ...item(2), kind: 'constructor' }, { ...item(3), kind: 'ai-reply' }]);
  assert.equal(list.hasValue('kind', '__proto__'), true);
  assert.equal(list.hasValue('kind', 'constructor'), true);
  assert.equal(list.hasValue('kind', 'ai-reply'), true);
  list.put([{ ...item(1), kind: '__proto__' }, { ...item(2), kind: 'updated' }]);
  assert.equal(list.hasValue('kind', 'ai-reply'), false, 'removing the last matching item removes its count');
  assert.equal(list.hasValue('kind', 'constructor'), false, 'changing an item updates its old count');
  assert.equal(list.hasValue('kind', 'updated'), true, 'changing an item adds its new count');
});
