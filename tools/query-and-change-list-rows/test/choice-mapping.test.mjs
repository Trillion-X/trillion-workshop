// src/choice-mapping.mjs + src/list-row-transfer.mjs (DATA: src/choice-kinds.json): a row that moves to a list with other
// choices keeps its meaning, matched by kind and then name, never by id or position.
import test from 'node:test';
import assert from 'node:assert/strict';
import { localStore } from '../../keep-and-wake-ai-sessions-on-this-computer/src/local-store.mjs';
import { makeLists } from '../../keep-lists-of-rows/lists.mjs';
import { kindOfChoice, mapChoice } from '../src/choice-mapping.mjs';
import { ListTransferError, transferRows } from '../src/list-row-transfer.mjs';

const design = { id: 'status', label: 'Status', kind: 'choice', choices: ['Backlog', 'Doing', 'Shipped', 'Won\'t do'], starts: 'Backlog' };
const support = { id: 'status', label: 'Status', kind: 'choice', choices: ['New', 'Triage', 'Working', 'Resolved', 'Closed'], starts: 'New' };

test('a choice is classified by what the field says, else by its name', () => {
  assert.equal(kindOfChoice(design, 'Shipped'), 'done');
  assert.equal(kindOfChoice(design, 'doing'), 'active');
  assert.equal(kindOfChoice(design, 'Won\'t do'), 'cancelled');
  assert.equal(kindOfChoice(design, 'Purple'), null);
  assert.equal(kindOfChoice({ kinds: { Purple: 'done' } }, 'Purple'), 'done', 'the field\'s own kind wins');
  assert.equal(kindOfChoice({ kinds: { Done: 'active' } }, 'Done'), 'active', 'even over the naming words');
});

test('a value goes to the target choice of the same kind: the same name first, else the first of that kind', () => {
  assert.deepEqual(mapChoice(design, support, 'Shipped'), { value: 'Resolved', matched: 'kind' });
  assert.deepEqual(mapChoice(design, support, 'Backlog'), { value: 'New', matched: 'kind' });
  assert.deepEqual(mapChoice(design, support, 'Doing'), { value: 'Working', matched: 'kind' });
  assert.deepEqual(mapChoice(support, design, 'Closed'), { value: 'Shipped', matched: 'kind' });
  const twoDone = { ...support, choices: ['New', 'Resolved', 'Closed'] };
  assert.deepEqual(mapChoice({ choices: ['Closed'] }, twoDone, 'Closed'), { value: 'Closed', matched: 'name' }, 'two choices of the kind: the same name wins');
  assert.deepEqual(mapChoice(design, support, null), { value: null, matched: 'none' });
});

test('a value with no match is never turned into another state: it starts over or is left empty, in words', () => {
  const noDropped = { ...support, choices: ['New', 'Working', 'Resolved'] };
  const result = mapChoice(design, noDropped, 'Won\'t do');
  assert.equal(result.value, 'New');
  assert.equal(result.matched, 'start');
  assert.match(result.said, /Won't do has no match in Status; it starts at New\./);
  assert.deepEqual({ ...mapChoice(design, { ...noDropped, starts: undefined }, 'Won\'t do'), said: 'x' }, { value: null, matched: 'none', said: 'x' });
  assert.equal(mapChoice({ choices: ['Purple'] }, { choices: ['purple', 'Green'] }, 'Purple').value, 'purple', 'an unclassified choice moves by its own word');
});

test('rows copied between real lists keep their meaning; links and unmatched fields are named; move removes the sources', async () => {
  const store = localStore(':memory:');
  try {
    let n = 0;
    const lists = makeLists({ eeaf: store.eeaf, newId: () => `row-${++n}` });
    await lists.save({ id: 'design', label: 'Design', fields: [{ id: 'name', label: 'Name' }, design, { id: 'owner', label: 'Owner' }] });
    await lists.save({ id: 'support', label: 'Support', fields: [{ id: 'name', label: 'Name' }, support] });
    await lists.putRows('design', { rows: [
      { id: 'a', values: { name: 'Logo', status: 'Shipped', owner: 'Ana' } },
      { id: 'b', values: { name: 'Icons', status: 'Doing', owner: 'Bo' } },
      { id: 'c', values: { name: 'Banner', status: 'Backlog' } },
    ] });
    const copied = await transferRows(lists, 'design', 'support', { row_ids: ['a', 'b'] });
    assert.deepEqual(copied.left_behind, ['owner']);
    assert.equal(copied.moved_away, false);
    assert.deepEqual(copied.mapped.map(item => [item.row_id, item.from, item.to, item.matched]), [['a', 'Shipped', 'Resolved', 'kind'], ['b', 'Doing', 'Working', 'kind']]);
    const read = await lists.read('support', {});
    assert.deepEqual(read.rows.map(row => [row.values.name, row.values.status]).sort(), [['Icons', 'Working'], ['Logo', 'Resolved']]);
    assert.equal((await lists.read('design', {})).rows.length, 3, 'a copy leaves the source');

    const moved = await transferRows(lists, 'design', 'support', { row_ids: ['c'], move: true });
    assert.equal(moved.moved_away, true);
    assert.deepEqual((await lists.read('design', {})).rows.map(row => row.id).sort(), ['a', 'b']);
    assert.ok((await lists.read('support', {})).rows.some(row => row.values.name === 'Banner' && row.values.status === 'New'));

    await assert.rejects(async () => transferRows(lists, 'design', 'design', {}), ListTransferError);
    await assert.rejects(async () => transferRows(lists, 'design', 'nowhere', {}), /There is no list nowhere/);
  } finally { store.close?.(); }
});

test('the lists route copies rows between lists and the tool calls that route', async () => {
  const { handleListsRequest } = await import('../../keep-lists-of-rows/lists.mjs');
  const { listTools } = await import('../src/list-tools.mjs');
  const store = localStore(':memory:');
  try {
    const lists = makeLists({ eeaf: store.eeaf });
    await lists.save({ id: 'design', label: 'Design', fields: [{ id: 'name', label: 'Name' }, design] });
    await lists.save({ id: 'support', label: 'Support', fields: [{ id: 'name', label: 'Name' }, support] });
    await lists.putRows('design', { rows: [{ id: 'a', values: { name: 'Logo', status: 'Shipped' } }] });
    const post = (path, body) => handleListsRequest(lists, new Request(`https://person${path}`, { method: 'POST', body: JSON.stringify(body) }));
    const copied = await (await post('/lists/design/rows/copy', { to_list_id: 'support', row_ids: ['a'] })).json();
    assert.equal(copied.mapped[0].to, 'Resolved');
    assert.equal((await post('/lists/design/rows/copy', { to_list_id: 'design' })).status, 400);
    const tool = listTools(async () => ({})).find(item => item.name === 'copy_list_rows');
    assert.ok(tool && tool.inputSchema.required.includes('to_list_id'));
  } finally { store.close?.(); }
});
