// Totals over a made-up bakery's list of orders: the records come in the request, the function is handed no records door
// and the row declares none. Every list, row and amount here is made up.
import test from 'node:test';
import assert from 'node:assert/strict';
import { rowOf } from '../../../test-helpers/run-a-row.mjs';
import { totalAList } from '../do-work/total-a-list.mjs';
import rows from '../tool-rows.json' with { type: 'json' };

const total = rowOf(rows, 'tool:total-a-list-or-view');

const order = (id, kind, amount, extra = {}) => ({ id: `record:order:${id}`, type: 'record:order', value: { item: id, kind, amount, ...extra } });
const bakery = () => [
  {
    id: 'list:orders',
    type: 'list',
    value: {
      id: 'orders', label: 'Orders', row_type: 'order', title_field: 'item',
      fields: [{ id: 'item', kind: 'text' }, { id: 'kind', kind: 'choice', choices: ['bread', 'cake', 'tart'] }, { id: 'amount', kind: 'number' }],
      views: [{ id: 'bread-only', label: 'Bread only', rules: { kind: 'group', combinator: 'and', negate: false, rules: [{ kind: 'rule', field: 'kind', operator: 'is_any_of', params: { values: ['bread'] } }] } }],
    },
  },
  order('a', 'bread', 4), order('b', 'bread', 6.5), order('c', 'cake', 30), order('d', 'cake', 12), order('e', 'tart', 8),
  { id: 'list:secret', type: 'list', value: { id: 'secret', label: 'Secret', type: 'record:secret', fields: [{ id: 'amount', kind: 'number' }] } },
  { id: 'record:secret:x', type: 'record:secret', value: { amount: 999 } },
];
const ask = async (input, records = bakery()) => {
  try { return { status: 0, result: await totalAList({ list_id: 'list:orders', type: 'record:order', records, ...input }) }; }
  catch (error) { return { status: 1, error: error.message }; }
};
const measure = (answer, op, field) => answer.result.measures.find(item => item.op === op && item.field === (field ?? null)).value;

test('a count and a sum of the whole list, with the rows counted and whether it is complete', async () => {
  const answer = await ask({ measures: [{ op: 'count' }, { op: 'sum', field: 'amount' }] });
  assert.equal(answer.status, 0, answer.error);
  assert.equal(answer.result.rows_counted, 5);
  assert.equal(answer.result.complete, true);
  assert.equal(measure(answer, 'count'), 5);
  assert.equal(measure(answer, 'sum', 'amount'), 60.5);
});

test('grouped by a field, each group has its own rows and totals', async () => {
  const answer = await ask({ group_by: 'kind', measures: [{ op: 'count' }, { op: 'sum', field: 'amount' }] });
  assert.equal(answer.status, 0, answer.error);
  const groups = Object.fromEntries(answer.result.groups.map(group => [group.key, [group.rows, group.measures.find(item => item.op === 'sum').value]]));
  assert.deepEqual(groups, { bread: [2, 10.5], cake: [2, 42], tart: [1, 8] });
});

test('over a saved view, only the rows the view keeps are totalled', async () => {
  const answer = await ask({ view_id: 'bread-only', measures: [{ op: 'sum', field: 'amount' }] });
  assert.equal(answer.status, 0, answer.error);
  assert.equal(answer.result.view_id, 'bread-only');
  assert.equal(answer.result.rows_counted, 2);
  assert.equal(measure(answer, 'sum', 'amount'), 10.5);
});

test('a measure that cannot be worked out is refused in words that say what to ask instead', async () => {
  const answer = await ask({ measures: [{ op: 'sum', field: 'item' }] });
  assert.notEqual(answer.status, 0);
  assert.match(answer.error, /sum/);
});

test('it reads only the records in the request and hands the run no records door', async () => {
  assert.equal(total.invoke.records, undefined, 'the row declares no records door');
  const answer = await ask({ measures: [{ op: 'count' }, { op: 'sum', field: 'amount' }] });
  assert.equal(answer.status, 0, answer.error);
  assert.equal(totalAList.length, 1, 'the function takes its request alone: it is handed no door');
  assert.equal(measure(answer, 'sum', 'amount'), 60.5, 'the answer holds the total');
  const wrongKind = await ask({ type: 'record:secret', measures: [{ op: 'sum', field: 'amount' }] });
  assert.notEqual(wrongKind.status, 0, 'a row type that is not the list\'s row type is refused');
});

test('a request without its records is refused in words that say what to hand in', async () => {
  const answer = await ask({ measures: [{ op: 'count' }], records: undefined });
  assert.notEqual(answer.status, 0);
  assert.match(answer.error, /records is the list record/);
});
