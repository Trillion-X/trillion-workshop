// read-a-list-view's declarations and bounds, checked through its public reader: a source declaration that is not what the
// reader takes is refused before any folder is read or any record written, a list declares at most the bounded number of
// row sources, and a sort orders values by the bytes of their canonical JSON.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readListView, refreshRowSources } from '../read-data/list-view.mjs';
import data from '../read-data/list-view.json' with { type: 'json' };
import { NAMES, choresList, storedOf } from './support/stored.mjs';

const { limits } = data;
const storedWith = list => storedOf([['list:chores', 'list', list]]);

test('a source declaration that is not what the reader takes is refused before any folder is read or record written', async () => {
  for (const paths of [null, 'one.md', {}, [1], [''], ['one.md', null]]) {
    const stored = storedWith(choresList([{ source: 'documents', of: '/', root: '/no-such-folder-for-declarations', paths }]));
    await assert.rejects(refreshRowSources({ names: NAMES, list: 'chores', stored }), /Source paths must be an array/);
  }
  for (const text_extensions of [null, 'py', {}, [1], [null]]) {
    const stored = storedWith(choresList([{ source: 'documents', of: '/', root: '/no-such-folder-for-declarations', text_extensions }]));
    await assert.rejects(refreshRowSources({ names: NAMES, list: 'chores', stored }), /Source text_extensions must be an array/);
  }
  for (const paths_file of ['', null, 42, {}]) {
    const stored = storedWith(choresList([{ source: 'documents', of: '/', root: '/no-such-folder-for-declarations', paths_file }]));
    await assert.rejects(refreshRowSources({ names: NAMES, list: 'chores', stored }), /Source paths_file must name a nonempty catalogue path/);
  }
});

test('a list declares at most its bounded number of row sources, and the reader refuses more', () => {
  const sources = Array.from({ length: limits.row_sources_per_list + 1 }, (_, index) => ({ source: 'documents', id: `source-${index}`, of: `/document-${index}` }));
  assert.throws(() => readListView({ list: 'chores', names: NAMES, stored: storedWith(choresList(sources)) }),
    new RegExp(`at most ${limits.row_sources_per_list} row sources`));
});

test('a sort orders values by their canonical JSON bytes, as the view publish did, and a view says how many rows it read', () => {
  const tin = (id, value) => ({ id: `record:tin:${id}`, type: 'record:tin', value });
  const stored = storedOf([
    ['list:tins', 'list', { label: 'Tins', row_type: 'tin', title_field: 'size', fields: [], row_sources: [] }],
    ['list-view:by-size', 'list-view', { list_id: 'tins', view: { sort: [{ field: 'size' }] } }],
  ]);
  stored.records.push(tin('a', { size: 9 }), tin('b', { size: 10 }), tin('c', {}), tin('d', { size: 'ￚ' }), tin('e', { size: '\u{1F600}' }));
  const page = readListView({ view: 'list-view:by-size', names: NAMES, stored });
  // By UTF-8 bytes U+FFDA (EF BF 9A) comes before U+1F600 (F0 9F 98 80), though a string comparison puts it after; a
  // text's quote (22) comes before a digit, "10" before "9", and the empty value last.
  assert.deepEqual(page.rows.map(row => row.id), ['d', 'e', 'b', 'a', 'c']);
  assert.equal(page.of, 5);
});
