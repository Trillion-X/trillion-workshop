// A column worked out from linked rows (src/list-rollups.mjs) and rows copied into another list field by field
// (src/list-row-operations.mjs duplicateRows with to_list). The rollup's arithmetic is the formula engine's and its value is
// never kept; a copy says what did not travel. Runs against the real record store and the real formula engine.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { localStore } from '../src/local-store.mjs';
import { handleListsRequest, makeLists, ListsError } from '../../keep-lists-of-rows/lists.mjs';
import { makeRowFilter } from '../../formula-engine/rules/filter-rows-by-rules.mjs';
import operators from '../../formula-engine/rules/rule-operators.json' with { type: 'json' };
import settings from '../src/lists.json' with { type: 'json' };

const evaluator = makeRowFilter({ operators, wasm: () => readFileSync(new URL('../../formula-engine/built-stored-bytes/evaluate-over-rows/evaluate-over-rows_bg.wasm', import.meta.url)) });
const ruleKinds = new Map(settings.field_kinds.map(kind => [kind.id, kind.ruleKind]));
const views = { filterRows: input => evaluator.filterRowsByRules(input), ruleKindOf: kind => ruleKinds.get(kind) ?? kind,
  evaluateBinding: async (binding, input) => (await evaluator.evaluateBinding({ binding, input })).value };
const fresh = t => {
  const store = localStore(':memory:');
  t.after(() => store.close?.());
  let n = 0;
  const lists = makeLists({ eeaf: store.eeaf, newId: () => `row-${++n}` });
  const ask = async (path, body) => {
    const response = await handleListsRequest(lists, new Request(`https://person${path}`, body ? { method: 'POST', body: JSON.stringify(body) } : {}), views);
    return { status: response.status, body: await response.json() };
  };
  return { store, lists, ask };
};

test('a rollup column works out its value from the linked rows on every read and keeps nothing', async t => {
  const { lists, ask } = fresh(t);
  lists.save({ id: 'deals', label: 'Deals', fields: [{ id: 'name', label: 'Name' }, { id: 'amount', label: 'Amount', kind: 'number' }, { id: 'stage', label: 'Stage', kind: 'choice', choices: ['Lead', 'Won'] }] });
  lists.save({ id: 'companies', label: 'Companies', fields: [{ id: 'name', label: 'Name' }, { id: 'deals', label: 'Deals', kind: 'link', links_to: 'deals' },
    { id: 'total', label: 'Deal value', kind: 'rollup', rollup: { through: 'deals', field: 'amount', op: 'sum' } },
    { id: 'how_many', label: 'Deals', kind: 'rollup', rollup: { through: 'deals', op: 'count' } },
    { id: 'stages', label: 'Stages', kind: 'rollup', rollup: { through: 'deals', field: 'stage', op: 'values' } }],
    views: [{ id: 'big', label: 'Big', rules: { kind: 'group', combinator: 'and', negate: false, rules: [{ kind: 'rule', field: 'total', operator: 'greater_than', params: { value: 100 } }] } }] });
  lists.putRows('deals', { rows: [{ id: 'd1', values: { name: 'One', amount: 120, stage: 'Lead' } }, { id: 'd2', values: { name: 'Two', amount: 30.5, stage: 'Won' } }, { id: 'd3', values: { name: 'Three', amount: 5, stage: 'Lead' } }] });
  lists.putRows('companies', { rows: [{ id: 'acme', values: { name: 'Acme', deals: ['d1', 'd2', 'missing'] } }, { id: 'zeta', values: { name: 'Zeta', deals: ['d3'] } }] });
  const read = (await ask('/lists/companies')).body;
  const acme = read.rows.find(row => row.id === 'acme').values;
  assert.equal(acme.total, 150.5);
  assert.equal(acme.how_many, 2, 'a link to a row that is not kept is not counted');
  assert.deepEqual([...acme.stages].sort(), ['Lead', 'Won']);
  assert.equal(lists.row('companies', 'acme').values.total, undefined, 'the value is never kept in the row');
  lists.putRows('deals', { rows: [{ id: 'd3', values: { amount: 500 } }] });
  const big = (await ask('/lists/companies/views/big')).body;
  assert.ok(big.rows, JSON.stringify(big));
  assert.deepEqual(big.rows.map(row => row.id).sort(), ['acme', 'zeta'], 'a view filters on a rollup as on any field, worked out now');
  assert.throws(() => lists.putRows('companies', { rows: [{ id: 'acme', values: { total: 3 } }] }), ListsError, 'a rollup takes no value');
  const refused = (await ask('/lists', { id: 'companies', fields: [{ id: 'name', label: 'Name' }, { id: 'deals', label: 'Deals', kind: 'link', links_to: 'deals' },
    { id: 'bad', label: 'Bad', kind: 'rollup', rollup: { through: 'deals', field: 'name', op: 'sum' } }] })).body;
  assert.equal(refused.refused.code, 'bad_rollup', 'a sum of a text field is refused when the list is saved');
  assert.equal((await ask('/lists/deals/aggregate', { measures: [{ op: 'values', field: 'name' }] })).body.refused.code, 'bad_aggregate', 'a per-row lookup is not a total over a list');
});

test('rows copy into another list field by field, as a map says, and the copy says what did not travel', async t => {
  const { lists, ask } = fresh(t);
  lists.save({ id: 'companies', label: 'Companies', fields: [{ id: 'name', label: 'Name' }] });
  lists.save({ id: 'leads', label: 'Leads', fields: [{ id: 'name', label: 'Name' }, { id: 'mail', label: 'Mail', kind: 'email' }, { id: 'score', label: 'Score', kind: 'number' },
    { id: 'company', label: 'Company', kind: 'link', links_to: 'companies' }, { id: 'notes', label: 'Notes' }] });
  lists.save({ id: 'customers', label: 'Customers', fields: [{ id: 'name', label: 'Name' }, { id: 'email', label: 'Email', kind: 'email' }, { id: 'score', label: 'Score' },
    { id: 'company', label: 'Company', kind: 'link', links_to: 'companies' }, { id: 'stage', label: 'Stage', kind: 'choice', choices: ['New', 'Paying'], starts: 'New' }] });
  lists.putRows('companies', { rows: [{ id: 'acme', values: { name: 'Acme' } }] });
  lists.putRows('leads', { rows: [{ id: 'l1', values: { name: 'Ana', mail: 'ana@x.io', score: 9, company: ['acme'], notes: 'warm' } }] });
  const copied = (await ask('/lists/leads/duplicate', { row_ids: ['l1'], to_list: 'customers', map: { email: 'mail' }, values: { stage: 'Paying' } })).body;
  assert.equal(copied.to_list, 'customers');
  const copy = lists.row('customers', copied.copies[0].id).values;
  assert.deepEqual({ name: copy.name, email: copy.email, company: copy.company, stage: copy.stage, from: copy._copied_from },
    { name: 'Ana', email: 'ana@x.io', company: ['acme'], stage: 'Paying', from: 'leads:l1' });
  assert.equal(copy.score, undefined, 'a number does not travel into a text field');
  assert.deepEqual(copied.dropped.sort(), ['notes', 'score']);
  assert.ok(lists.row('leads', 'l1'), 'the source row stays');
  assert.equal((await ask('/lists/leads/duplicate', { row_ids: ['l1'], to_list: 'customers', map: { email: 'nope' } })).body.refused.code, 'bad_copy');
});
