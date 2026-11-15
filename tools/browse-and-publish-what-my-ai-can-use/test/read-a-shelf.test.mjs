// readAShelf over the toolkit kind: its rows are the person's own record:toolkit list rows as records:list returns them, so a
// toolkit shows with its title, what it holds and its tools, whoever made it, and the kind reads no page route.
import test from 'node:test';
import assert from 'node:assert/strict';
import kinds from '../marketplace-kinds.json' with { type: 'json' };
import { readAShelf } from '../do-work/read-a-shelf.mjs';

const kind = kinds.kinds.find(one => one.id === 'configuration');
const rows = [
  { id: 'toolkit:sample-writer', type: 'record:toolkit', value: { title: 'Sample writer', description: 'Tools for drafting.', made_by: 'Trillion', tools: ['tool:sample-draft', 'tool:sample-edit'] } },
  { id: 'toolkit:sample-own', type: 'record:toolkit', value: { title: 'My own set', tools: ['tool:sample-cut'] } },
];

test('the toolkit kind is read with records:list of type record:toolkit at the person\'s own records', () => {
  assert.equal(kind.label, 'Toolkits');
  assert.deepEqual(kind.rows, { from: 'records', address: '@own-records', method: 'records:list', type: 'record:toolkit', list: ['records'] });
  assert.ok(!kinds.kinds.some(one => one.rows.path === '/work/api/marketplace/configurations'), 'no kind reads the old configurations route');
});

test('toolkit rows show as shelf items with their tools, and a row nobody signed has no maker', () => {
  const { items } = readAShelf({ kind: 'configuration', rows });
  assert.deepEqual(items.map(item => [item.id, item.title, item.job, item.made_by]), [
    ['toolkit:sample-writer', 'Sample writer', 'Tools for drafting.', 'Trillion'],
    ['toolkit:sample-own', 'My own set', '', null],
  ]);
  assert.deepEqual(items[0].facts, [{ label: 'Tools', icon: 'Wrench', value: 'tool:sample-draft, tool:sample-edit' }]);
  assert.equal(items[0].link, undefined);
});
