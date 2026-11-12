// test/keep-lists-of-rows-done-settles.test.mjs
// A choice field that declares `settles` decides which of its values mean done: the values a row keeps once it holds
// them (the store's own definition, as lists.mjs keeps it). A field that declares none keeps the word and tone rule of
// views-offered-to-every-list.json `done`. Both rules are read through the same functions the views use.
import test from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';

const root = new URL('../tools/keep-lists-of-rows/', import.meta.url).pathname;
const { outputFiles } = await build({
  absWorkingDir: root, entryPoints: ['read-data/visual-database-input-from-list.ts'], bundle: true, write: false, format: 'esm', platform: 'node', logLevel: 'error',
});
// The bundle holds every file it imports, so it loads from its own text (tools/keep-lists-of-rows/test/list-keeper.test.mjs does the same).
const { doneValuesOf, listFieldRoles } = await import(`data:text/javascript;base64,${Buffer.from(outputFiles[0].text).toString('base64')}`);

const done = { done_tones: ['success', 'good'], done_values: ['done', 'complete', 'completed', 'finished'] };

test('a field that declares settles is done on exactly those values, with no word rule applied', () => {
  const field = { id: 'status', label: 'Status', kind: 'choice', values: { Open: { label: 'Open' }, Shipped: { label: 'Shipped' } }, settles: ['Shipped'] };
  assert.deepEqual(doneValuesOf(field, done), ['Shipped']);
  const named = { id: 'status', label: 'Status', kind: 'choice', values: { Open: { label: 'Open', tone: 'success' }, Shipped: { label: 'Shipped' } }, settles: ['Shipped'] };
  assert.deepEqual(doneValuesOf(named, done), ['Shipped'], 'a value that carries a done tone is not done when the field settles on another value');
});

test('a field that settles on a value named Done keeps that value done', () => {
  const field = { id: 'status', label: 'Status', kind: 'choice', values: { 'To do': { label: 'To do' }, Done: { label: 'Done' } }, settles: ['Done'] };
  assert.deepEqual(doneValuesOf(field, done), ['Done']);
});

test('a field that declares no settles keeps the word and tone rule', () => {
  const field = { id: 'status', label: 'Status', kind: 'choice', values: { Todo: { label: 'Todo' }, Finished: { label: 'Finished', tone: 'good' }, Complete: { label: 'Yes' } } };
  assert.deepEqual(doneValuesOf(field, done), ['Finished', 'Complete']);
});

test('listFieldRoles puts a field that declares settles into roles.done', () => {
  const title = { id: 'name', label: 'Task', kind: 'text' };
  const status = { id: 'status', label: 'Status', kind: 'choice', values: { Open: { label: 'Open' }, Shipped: { label: 'Shipped' } }, settles: ['Shipped'] };
  const roles = listFieldRoles([title, status], done);
  assert.equal(roles.done.field, status);
  assert.deepEqual(roles.done.values, ['Shipped']);
});
