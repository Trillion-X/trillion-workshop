// A list's row address (keep-lists-of-rows row-record-address.mjs), read and refreshed through the reader: a declared
// native address reads its rows, pages within its prefix and keeps local ids; an invalid declaration fails visibly.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readListView, refreshRowSources } from '../read-data/list-view.mjs';
import { NAMES, choresList, recipe, recipesFolder, storedOf } from './support/stored.mjs';

async function bakery(declared) {
  const folder = await recipesFolder({ 'one.md': recipe('one', 3) });
  const list = choresList([{ source: 'documents', of: '/', root: folder.root }], declared);
  return storedOf([['list:chores', 'list', list],
    ['account:library/sweep', 'record:physical', { chore: 'sweep', minutes: 1 }],
    ['record:chore:other', 'record:chore', { chore: 'other', minutes: 2 }]]);
}

test('a declared native address reads real rows, pages within its prefix and keeps local ids', async () => {
  const stored = await bakery({ row_records: { type: 'record:physical', prefix: 'account:library/' } });
  const first = readListView({ list: 'chores', names: NAMES, stored, limit: 1 });
  assert.deepEqual(first.rows.map(row => row.id), ['sweep']);
  assert.equal(first.next, null);
});

test('a refresh writes only the declared physical address', async () => {
  const stored = await bakery({ row_records: { type: 'record:physical', prefix: 'account:library/' } });
  const answer = await refreshRowSources({ names: NAMES, list: 'chores', stored });
  assert.equal(answer.keep.length, 1);
  assert.equal(answer.keep[0].id, 'account:library/documents~%2Fone.md');
  assert.equal(answer.keep[0].type, 'record:physical');
});

test('an invalid declaration fails visibly instead of reading an empty list', async () => {
  const stored = await bakery({ row_records: { type: 'record:physical', prefix: '' } });
  assert.throws(() => readListView({ list: 'chores', names: NAMES, stored }), /row_records.prefix/);
});
