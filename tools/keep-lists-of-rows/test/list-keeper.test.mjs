// tools/keep-lists-of-rows/test/list-keeper.test.mjs (old trillion test/list-keeper.test.mjs at 1e886c3f68, moved here)
//
// The visual-database surface's writer over a person's list (do-work/list-record-writer.ts),
// against the real lists.mjs over the computer's own store (keep-and-wake-ai-sessions-on-this-computer/src/local-store.mjs): two sub-tasks added to one task at the same moment both stay under it (each change
// is worked out against the list read again, one at a time); a task moved before a sibling lands there and leaves the
// task it sat under; a move into its own sub-task is refused and changes nothing; a deleted task leaves its parent.
import test from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { localStore } from '../../keep-and-wake-ai-sessions-on-this-computer/src/local-store.mjs';
import { makeLists } from '../lists.mjs';

const root = new URL('..', import.meta.url).pathname;
const { outputFiles } = await build({
  absWorkingDir: root, entryPoints: ['do-work/list-record-writer.ts'], bundle: true, write: false, format: 'esm', platform: 'node', logLevel: 'error',
});
// The bundle holds every file it imports, so it loads from its own text (old trillion's importSource did the same).
const { listKeeper } = await import(`data:text/javascript;base64,${Buffer.from(outputFiles[0].text).toString('base64')}`);

const fields = [{ id: 'name', label: 'Task', read: row => row.values.name }, { id: 'subtasks', label: 'Sub-tasks', editable: false, read: row => row.values.subtasks ?? null }];
function listOver(lists) {
  const read = () => {
    const { rows } = lists.read('tasks');
    const ref = id => ({ family: 'list-row', parts: { id } });
    const groups = Object.fromEntries(rows.filter(row => row.values.subtasks?.length).map(row => [row.id, {
      groupRef: ref(row.id), memberOrder: row.values.subtasks, members: Object.fromEntries(row.values.subtasks.map(id => [id, { memberId: id, nodeRef: ref(id) }])),
    }]));
    return { records: rows, nesting: { graph: { groups } } };
  };
  const context = {
    ...read(), fields, label: 'Tasks', identify: row => row.id,
    write: async changes => { lists.putRows('tasks', { rows: changes.filter(c => !c.remove).map(c => ({ id: c.id, values: { ...(c.values ?? {}), ...(c.members ? { subtasks: c.members } : {}) } })), remove: changes.filter(c => c.remove).map(c => c.id) }); },
    reread: async () => read(),
  };
  return context;
}

test('the list keeper keeps quick sub-tasks, moves across levels and refuses a move into a task\'s own sub-task', async () => {
  const store = localStore(':memory:');
  const lists = makeLists({ eeaf: store.eeaf });
  lists.save({ id: 'tasks', label: 'Tasks', fields: [{ id: 'name', label: 'Task' }, { id: 'subtasks', label: 'Sub-tasks', kind: 'link', links_to: 'tasks' }] });
  lists.putRows('tasks', { rows: [{ id: 'a', values: { name: 'Launch' } }, { id: 'b', values: { name: 'Ads' } }] });
  const context = listOver(lists);
  const keeper = listKeeper(() => context);
  const under = id => lists.read('tasks').rows.find(row => row.id === id).values.subtasks ?? [];

  // Two sub-tasks added to "Launch" at the same moment, both from the same drawn list: neither undoes the other.
  await Promise.all([
    keeper.writeRecord({ addressLabel: 'list-record::page::1', payload: { name: 'Sales page', 'nested-under': 'a' } }),
    keeper.writeRecord({ addressLabel: 'list-record::price::2', payload: { name: 'Price', 'nested-under': 'a' } }),
  ]);
  assert.deepEqual(under('a'), ['list-record::page::1', 'list-record::price::2']);
  assert.deepEqual((await keeper.writeRecord.readCurrent('list-record::price::2')).payload, { name: 'Price', subtasks: null, 'nested-under': 'a' });

  // "Price" moves before "Sales page"; then "Ads" moves under "Price" (top level to level 3).
  await keeper.place({ record: 'list-record::price::2', under: 'a', before: 'list-record::page::1' });
  assert.deepEqual(under('a'), ['list-record::price::2', 'list-record::page::1']);
  await keeper.place({ record: 'b', under: 'list-record::price::2', before: null });
  assert.deepEqual(under('list-record::price::2'), ['b']);

  // "Launch" cannot go inside "Ads", which sits under it: refused, nothing changes.
  await assert.rejects(keeper.place({ record: 'a', under: 'b', before: null }), /cannot go inside itself/);
  assert.deepEqual(under('b'), []);

  // Out to the top level, then deleted: "Price" leaves "Launch", and a deleted "Sales page" leaves it too.
  await keeper.place({ record: 'list-record::price::2', under: null, before: null });
  assert.deepEqual(under('a'), ['list-record::page::1']);
  await keeper.writeRecord({ addressLabel: 'list-record::page::1', payload: null });
  assert.deepEqual(under('a'), []);
  assert.equal(lists.read('tasks').rows.some(row => row.id === 'list-record::page::1'), false);
});
