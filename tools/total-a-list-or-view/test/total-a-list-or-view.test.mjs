// Totals over a made-up bakery's list of orders, run as the container runs the row: against the fake records door
// holding exactly the rights the row asks for. Every list, row and amount here is made up.
import test from 'node:test';
import assert from 'node:assert/strict';
import { answerOf, rowOf } from '../../../test-helpers/run-a-row.mjs';
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
const ask = (input, records = bakery()) => answerOf(total, { list_id: 'list:orders', type: 'record:order', ...input }, { records });
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

test('it reads only the one list and its rows: the run is granted no other kind', async () => {
  const answer = await ask({ measures: [{ op: 'count' }] });
  assert.equal(answer.status, 0, answer.error);
  const touched = answer.calls.map(call => JSON.stringify(call));
  assert.ok(touched.length > 0);
  assert.ok(touched.every(call => !call.includes('secret')), 'no call names the other list');
  const wrongKind = await ask({ type: 'record:secret', measures: [{ op: 'sum', field: 'amount' }] });
  assert.notEqual(wrongKind.status, 0, 'a row type that is not the list\'s row type is refused');
});

test('the row grants only reads of one list record and its row kind', () => {
  const rights = total.invoke.records.rights;
  assert.ok(rights.length > 0);
  for (const right of rights) assert.ok(right.operations.every(operation => ['records:read', 'records:list'].includes(operation)), JSON.stringify(right));
});
