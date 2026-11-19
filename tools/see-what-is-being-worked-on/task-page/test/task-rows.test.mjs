// test/task-rows.test.mjs
//
// The task page's pure fold (read-data/task-rows.ts): changes grouped into moments, every task as it stood at a moment,
// the tree in its fixed order, the work items a goal counts, and a status's word.
import test from 'node:test';
import assert from 'node:assert/strict';
import { goalComplete, momentsOf, standing, statusWord, tally, treeOf } from '../read-data/task-rows.ts';

const data = {
  tasks: [
    { id: 'goal', title: 'Goal', parent: null, status: 'To do' },
    { id: 'a', title: 'A', parent: 'goal', status: 'Done' },
    { id: 'b', title: 'B', parent: 'goal', status: 'In progress' },
    { id: 'c', title: 'C', parent: null, status: 'To do' },
  ],
  statuses: [
    { name: 'Done', mark: 'done', tone: null, counts_as_done: true, closed: true, place: 1 },
    { name: 'In progress', mark: 'checking', tone: '#2563eb', counts_as_done: false, closed: false, place: 3 },
    { name: 'To do', mark: 'todo', tone: null, counts_as_done: false, closed: false, place: 7 },
    { name: 'Not needed', mark: 'todo', tone: '#94a3b8', counts_as_done: false, closed: true, place: 9 },
  ],
  changes: [
    { task: 'a', at: '2026-11-18T10:00:00.000Z', kind: 'made', status: 'To do', title: null },
    { task: 'b', at: '2026-11-18T10:00:30.000Z', kind: 'made', status: 'To do', title: null },
    { task: 'c', at: '2026-11-18T11:00:00.000Z', kind: 'made', status: 'To do', title: null },
    { task: 'a', at: '2026-11-18T12:00:00.000Z', kind: 'status', status: 'Done', title: null },
    { task: 'b', at: '2026-11-18T13:00:00.000Z', kind: 'status', status: 'In progress', title: null },
  ],
};

const looks = new Map(data.statuses.map(s => [s.name, s]));
const lookOf = id => looks.get(standing(momentsOf(data), 4).status.get(id) ?? '');

test('changes in the same minute are one moment; the label counts new tasks and updates', () => {
  const moments = momentsOf(data);
  assert.equal(moments.length, 4);
  assert.equal(moments[0].label, '2 new tasks');
  assert.equal(moments[0].title, 'A, and 1 more');
  assert.equal(moments[1].label, '1 new task');
  assert.equal(moments[2].label, '1 update');
});

test('standing shows each task as it stood at a moment', () => {
  const moments = momentsOf(data);
  const early = standing(moments, 0);
  assert.deepEqual([...early.made].sort(), ['a', 'b']);
  assert.equal(early.status.get('a'), 'To do');
  const last = standing(moments, 4);
  assert.equal(last.status.get('a'), 'Done');
  assert.equal(last.status.get('b'), 'In progress');
  assert.equal(last.made.has('c'), true);
});

test('the tree puts done work first and lists each goal\'s work items under it', () => {
  const tree = treeOf(data, looks);
  assert.deepEqual(tree.kids.get(null).map(task => task.id), ['goal', 'c']);
  assert.deepEqual(tree.items.get('goal'), ['a', 'b']);
  assert.deepEqual(tree.allItems, ['a', 'b', 'c']);
});

test('a work item counts when done; a closed item that is not done leaves the total', () => {
  assert.deepEqual(tally(['a', 'b', 'c'], lookOf), { done: 1, total: 3 });
  const ruledOut = id => (id === 'c' ? looks.get('Not needed') : lookOf(id));
  assert.deepEqual(tally(['a', 'b', 'c'], ruledOut), { done: 1, total: 2 });
  assert.equal(goalComplete(undefined, { done: 2, total: 2 }), true);
  assert.equal(goalComplete(looks.get('To do'), { done: 2, total: 2 }), false);
  assert.equal(goalComplete(undefined, { done: 0, total: 0 }), false);
});

test('a status word shows only when the status is not done and has a colour of its own', () => {
  assert.equal(statusWord(looks.get('Done')), undefined);
  assert.equal(statusWord(looks.get('In progress'))?.name, 'In progress');
  assert.equal(statusWord(looks.get('To do')), undefined);
  assert.equal(statusWord(looks.get('To do'), true)?.name, 'To do');
});

test('a task\'s shows are kept in the order they were made, and History draws only those made by the moment', async () => {
  const { showsOf, shownBy } = await import('../read-data/task-rows.ts');
  const withShows = {
    ...data,
    shows: [
      { task: 'a', ref: 'https://example.com/late', label: 'Late', made_at: '2026-11-18T14:00:00.000Z' },
      { task: 'a', ref: 'https://example.com/early', label: 'Early', made_at: '2026-11-18T11:00:00.000Z' },
      { task: 'c', ref: 'https://example.com/c', label: 'C', made_at: '2026-11-18T11:00:00.000Z' },
    ],
  };
  const byTask = showsOf(withShows);
  assert.deepEqual(byTask.get('a').map(show => show.label), ['Late', 'Early'], 'the map keeps the rows\' order');
  assert.equal(byTask.get('b'), undefined);
  assert.deepEqual(shownBy(byTask.get('a'), '2026-11-18T12:00:00.000Z').map(show => show.label), ['Early'], 'only shows made by the moment');
  assert.deepEqual(shownBy(undefined, '2026-11-18T12:00:00.000Z'), []);
});
