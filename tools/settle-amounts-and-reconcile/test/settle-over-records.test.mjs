// do-work/settle-over-records.mjs: the lists handed in as the settlement module reaches them; the run keeps nothing.
import test from 'node:test';
import assert from 'node:assert/strict';
import { settle, settlementListsFromInput } from '../do-work/settle-over-records.mjs';

const given = () => [
  { id: 'lines', label: 'Lines', row_type: 'sample-line', indexes: [], fields: [{ id: 'amount', label: 'Amount', kind: 'number' }],
    rows: [{ id: 'a', values: { amount: 1, closed: 'r-1' } }, { id: 'b', values: { amount: 2 } }] },
];

test('a row named with if_values is written only when the field still holds that value; the others are written, and keep names the result', async () => {
  const lists = settlementListsFromInput(given());
  const answer = await lists.putRows('lines', { rows: [
    { id: 'a', values: { closed: 'r-2' }, if_values: { closed: null } },
    { id: 'b', values: { closed: 'r-2' }, if_values: { closed: null } },
  ] });
  assert.deepEqual(answer.conflicts, [{ row_id: 'a' }]);
  assert.deepEqual(lists.keep(), { lists: [], rows: [{ list_id: 'lines', row_type: 'sample-line', id: 'b', values: { amount: 2, closed: 'r-2' } }] });
});

test('remove takes the row away, a null value takes a field out, a made list is found at once, and a row made then taken back is not kept', async () => {
  const lists = settlementListsFromInput(given());
  assert.equal(lists.find('lines').row_type, 'sample-line');
  assert.equal(lists.find('list:lines').id, 'lines');
  assert.equal(lists.find('missing'), null);
  await lists.putRows('lines', { rows: [{ id: 'a', values: { closed: null } }, { id: 'c', values: { amount: 3 } }], remove: ['b', 'never-there', 'c'] });
  await lists.ensure({ id: 'made', label: 'Made', row_type: 'sample-made', fields: [] });
  assert.equal(lists.find('made').row_type, 'sample-made');
  const kept = lists.keep();
  assert.deepEqual(kept.lists.map(list => list.id), ['made']);
  assert.deepEqual(kept.rows.map(row => [row.id, row.values]), [['a', { amount: 1 }], ['b', null]]);
});

test('a refusal comes back as an error in its words, and record kinds for the rights are not passed on', async () => {
  await assert.rejects(() => settle({ action: 'nope', list_id: 'lines', lists: given() }), /no settlement action nope/);
  await assert.rejects(() => settle({ action: 'balance', list_id: 'lines', lines_kind: 'record:sample-line', lines: { amount_field: 'amount' }, lists: given() }), /group_field/);
  const answer = await settle({ action: 'totals', list_id: 'lines', lines_kind: 'record:sample-line', lines: { kind_field: 'amount' }, row_ids: [], lists: given() });
  assert.deepEqual(answer, { list_id: 'lines', lines: [], total: 0 });
});

test('a post answers the rows to keep and nothing else changes: the answer holds the result', async () => {
  const lists = [{ id: 'entries', label: 'Entries', row_type: 'sample-entry', indexes: [], fields: [{ id: 'amount', label: 'Amount', kind: 'number' }, { id: 'entry', label: 'Entry', kind: 'text' }], rows: [] }];
  const answer = await settle({ action: 'post', list_id: 'entries', lists, entry_id: 'e-1', lines: { amount_field: 'amount', group_field: 'entry' }, rows: [{ values: { amount: 5 } }, { values: { amount: -5 } }] });
  assert.equal(answer.keep.rows.length, 2);
  assert.ok(answer.keep.rows.every(row => row.list_id === 'entries' && row.row_type === 'sample-entry' && row.values.entry === 'e-1'));
  assert.deepEqual(lists[0].rows, [], 'the lists handed in are not changed');
});

test('an apply answers the allocations list it made and each allocation row to keep', async () => {
  const lists = [
    { id: 'payments', label: 'Payments', row_type: 'sample-payment', indexes: [], fields: [{ id: 'amount', label: 'Amount', kind: 'number' }], rows: [{ id: 'p1', values: { amount: 10 } }] },
    { id: 'invoices', label: 'Invoices', row_type: 'sample-invoice', indexes: [], fields: [{ id: 'total', label: 'Total', kind: 'number' }, { id: 'due', label: 'Due', kind: 'date' }], rows: [{ id: 'i1', values: { total: 4, due: '2026-01-01' } }] },
  ];
  const answer = await settle({ action: 'apply', list_id: 'payments', lists, request_key: 'k1', source: { row_id: 'p1', amount_field: 'amount' }, targets: { list_id: 'invoices', amount_field: 'total', order_field: 'due' } });
  assert.equal(answer.outcome.state, 'all');
  assert.equal(answer.keep.lists[0].id, answer.allocations_list);
  assert.deepEqual(answer.keep.rows.map(row => row.id), [answer.items[0].allocation_id]);
});
