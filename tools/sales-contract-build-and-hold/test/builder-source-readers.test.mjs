import test from 'node:test';
import assert from 'node:assert/strict';
import { listsReaderAnswer, toolReaderAnswer } from '../read-data/builder-source-readers.mjs';

const lists = [
  { id: 'list-a', row_type: 'customer', label: 'Customers', fields: [{ id: 'mail', kind: 'email' }] },
  { id: 'list-b', row_type: 'event', label: 'Events', fields: [] },
  { id: 'list-c', row_type: 'other', label: 'Named', fields: [] },
];
const rowsOf = {
  'list-a': { rows: [{ id: 'r1', title: 'Ana', values: { mail: 'ana@example.test' } }, { id: 'r2', values: {} }] },
  'list-b': { rows: [{ id: 'e1', values: {} }] },
  'list-c': { rows: [{ id: 'n1', title: 'Named row', values: {} }] },
};
const readList = id => rowsOf[id];

test('the lists reader takes lists by row type or by id, with the email field and a title fallback', () => {
  const answer = listsReaderAnswer({ lists, readList, row_types: ['customer'], list_ids: ['list-c'] });
  assert.deepEqual(answer.rows, [
    { id: 'list-a:r1', title: 'Ana', email: 'ana@example.test', list: 'Customers' },
    { id: 'list-a:r2', title: 'r2', email: undefined, list: 'Customers' },
    { id: 'list-c:n1', title: 'Named row', email: undefined, list: 'Named' },
  ]);
});

test('a list with no asked-for row type or id is not read', () => {
  const asked = [];
  const answer = listsReaderAnswer({ lists, readList: id => { asked.push(id); return rowsOf[id]; }, row_types: ['event'] });
  assert.deepEqual(asked, ['list-b']);
  assert.deepEqual(answer.rows.map(row => row.id), ['list-b:e1']);
});

test('no row types or ids asked for gives no rows', () => {
  assert.deepEqual(listsReaderAnswer({ lists, readList }), { rows: [] });
});

test('a completed tool run gives its output', () => {
  assert.deepEqual(toolReaderAnswer({ state: 'completed', output: { data: [1] } }), { data: [1] });
});

test('a run that did not complete says why, or that it took too long', () => {
  assert.throws(() => toolReaderAnswer({ state: 'failed', error: 'The key was refused.' }), { message: 'The key was refused.' });
  assert.throws(() => toolReaderAnswer({ state: 'working' }), { message: 'It took too long to answer.' });
});
