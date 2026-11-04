// do-work/settle-over-records.mjs: the person's lists over their records door as the settlement module reaches them.
import test from 'node:test';
import assert from 'node:assert/strict';
import { memoryDoor } from '../../watch-my-sources/test/memory-door.mjs';
import { settle, settlementListsOverDoor } from '../do-work/settle-over-records.mjs';

const door = () => memoryDoor([
  { id: 'list:lines', type: 'list', value: { label: 'Lines', row_type: 'sample-line', indexes: [], fields: [{ id: 'amount', label: 'Amount', kind: 'number' }] } },
  { id: 'record:sample-line:a', type: 'record:sample-line', value: { amount: 1, closed: 'r-1' } },
  { id: 'record:sample-line:b', type: 'record:sample-line', value: { amount: 2 } },
]);

test('a row named with if_values is written only when the field still holds that value; the others are written', async () => {
  const records = door();
  const lists = await settlementListsOverDoor(records);
  const answer = await lists.putRows('lines', { rows: [
    { id: 'a', values: { closed: 'r-2' }, if_values: { closed: null } },
    { id: 'b', values: { closed: 'r-2' }, if_values: { closed: null } },
  ] });
  assert.deepEqual(answer.conflicts, [{ row_id: 'a' }]);
  assert.equal(records.kept.get('record:sample-line:a').value.closed, 'r-1');
  assert.equal(records.kept.get('record:sample-line:b').value.closed, 'r-2');
});

test('remove takes the row away, a null value takes a field out, and find answers at once', async () => {
  const records = door();
  const lists = await settlementListsOverDoor(records);
  assert.equal(lists.find('lines').row_type, 'sample-line');
  assert.equal(lists.find('list:lines').id, 'lines');
  assert.equal(lists.find('missing'), null);
  await lists.putRows('lines', { rows: [{ id: 'a', values: { closed: null } }], remove: ['b', 'never-there'] });
  assert.deepEqual(records.kept.get('record:sample-line:a').value, { amount: 1 });
  assert.equal(records.kept.has('record:sample-line:b'), false);
  const made = lists.ensure({ id: 'made', label: 'Made', row_type: 'sample-made', fields: [] });
  assert.equal(lists.find('made').row_type, 'sample-made', 'a list this run makes is found at once');
  await made;
  assert.equal(records.kept.get('list:made').type, 'list');
});

test('a refusal comes back as an error in its words, and record kinds for the rights are not passed on', async () => {
  const records = door();
  await assert.rejects(() => settle({ action: 'nope', list_id: 'lines' }, { door: records }), /no settlement action nope/);
  await assert.rejects(() => settle({ action: 'balance', list_id: 'lines', lines_kind: 'record:sample-line', lines: { amount_field: 'amount' } }, { door: records }), /group_field/);
  const answer = await settle({ action: 'totals', list_id: 'lines', lines_kind: 'record:sample-line', lines: { kind_field: 'amount' }, row_ids: [] }, { door: records });
  assert.deepEqual(answer, { list_id: 'lines', lines: [], total: 0 });
});
