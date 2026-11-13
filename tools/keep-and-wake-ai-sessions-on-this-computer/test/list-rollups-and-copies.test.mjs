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
  await lists.save({ id: 'deals', label: 'Deals', fields: [{ id: 'name', label: 'Name' }, { id: 'amount', label: 'Amount', kind: 'number' }, { id: 'stage', label: 'Stage', kind: 'choice', choices: ['Lead', 'Won'] }] });
  await lists.save({ id: 'companies', label: 'Companies', fields: [{ id: 'name', label: 'Name' }, { id: 'deals', label: 'Deals', kind: 'link', links_to: 'deals' },
    { id: 'total', label: 'Deal value', kind: 'rollup', rollup: { through: 'deals', field: 'amount', op: 'sum' } },
    { id: 'how_many', label: 'Deals', kind: 'rollup', rollup: { through: 'deals', op: 'count' } },
    { id: 'stages', label: 'Stages', kind: 'rollup', rollup: { through: 'deals', field: 'stage', op: 'values' } }],
    views: [{ id: 'big', label: 'Big', rules: { kind: 'group', combinator: 'and', negate: false, rules: [{ kind: 'rule', field: 'total', operator: 'greater_than', params: { value: 100 } }] } }] });
  await lists.putRows('deals', { rows: [{ id: 'd1', values: { name: 'One', amount: 120, stage: 'Lead' } }, { id: 'd2', values: { name: 'Two', amount: 30.5, stage: 'Won' } }, { id: 'd3', values: { name: 'Three', amount: 5, stage: 'Lead' } }] });
  await lists.putRows('companies', { rows: [{ id: 'acme', values: { name: 'Acme', deals: ['d1', 'd2', 'missing'] } }, { id: 'zeta', values: { name: 'Zeta', deals: ['d3'] } }] });
  const read = (await ask('/lists/companies')).body;
  const acme = read.rows.find(row => row.id === 'acme').values;
  assert.equal(acme.total, 150.5);
  assert.equal(acme.how_many, 2, 'a link to a row that is not kept is not counted');
  assert.deepEqual([...acme.stages].sort(), ['Lead', 'Won']);
  assert.equal((await lists.row('companies', 'acme')).values.total, undefined, 'the value is never kept in the row');
  await lists.putRows('deals', { rows: [{ id: 'd3', values: { amount: 500 } }] });
  const big = (await ask('/lists/companies/views/big')).body;
  assert.ok(big.rows, JSON.stringify(big));
  assert.deepEqual(big.rows.map(row => row.id).sort(), ['acme', 'zeta'], 'a view filters on a rollup as on any field, worked out now');
  await assert.rejects(async () => await lists.putRows('companies', { rows: [{ id: 'acme', values: { total: 3 } }] }), ListsError, 'a rollup takes no value');
  const refused = (await ask('/lists', { id: 'companies', fields: [{ id: 'name', label: 'Name' }, { id: 'deals', label: 'Deals', kind: 'link', links_to: 'deals' },
    { id: 'bad', label: 'Bad', kind: 'rollup', rollup: { through: 'deals', field: 'name', op: 'sum' } }] })).body;
  assert.equal(refused.refused.code, 'bad_rollup', 'a sum of a text field is refused when the list is saved');
  assert.equal((await ask('/lists/deals/aggregate', { measures: [{ op: 'values', field: 'name' }] })).body.refused.code, 'bad_aggregate', 'a per-row lookup is not a total over a list');
});

test('rows copy into another list field by field, as a map says, and the copy says what did not travel', async t => {
  const { lists, ask } = fresh(t);
  await lists.save({ id: 'companies', label: 'Companies', fields: [{ id: 'name', label: 'Name' }] });
  await lists.save({ id: 'leads', label: 'Leads', fields: [{ id: 'name', label: 'Name' }, { id: 'mail', label: 'Mail', kind: 'email' }, { id: 'score', label: 'Score', kind: 'number' },
    { id: 'company', label: 'Company', kind: 'link', links_to: 'companies' }, { id: 'notes', label: 'Notes' }] });
  await lists.save({ id: 'customers', label: 'Customers', fields: [{ id: 'name', label: 'Name' }, { id: 'email', label: 'Email', kind: 'email' }, { id: 'score', label: 'Score' },
    { id: 'company', label: 'Company', kind: 'link', links_to: 'companies' }, { id: 'stage', label: 'Stage', kind: 'choice', choices: ['New', 'Paying'], starts: 'New' }] });
  await lists.putRows('companies', { rows: [{ id: 'acme', values: { name: 'Acme' } }] });
  await lists.putRows('leads', { rows: [{ id: 'l1', values: { name: 'Ana', mail: 'user-da4bb152@example.com', score: 9, company: ['acme'], notes: 'warm' } }] });
  const copied = (await ask('/lists/leads/duplicate', { row_ids: ['l1'], to_list: 'customers', map: { email: 'mail' }, values: { stage: 'Paying' } })).body;
  assert.equal(copied.to_list, 'customers');
  const copy = (await lists.row('customers', copied.copies[0].id)).values;
  assert.deepEqual({ name: copy.name, email: copy.email, company: copy.company, stage: copy.stage, from: copy._copied_from },
    { name: 'Ana', email: 'user-da4bb152@example.com', company: ['acme'], stage: 'Paying', from: 'leads:l1' });
  assert.equal(copy.score, undefined, 'a number does not travel into a text field');
  assert.deepEqual(copied.dropped.sort(), ['notes', 'score']);
  assert.ok(await lists.row('leads', 'l1'), 'the source row stays');
  assert.equal((await ask('/lists/leads/duplicate', { row_ids: ['l1'], to_list: 'customers', map: { email: 'nope' } })).body.refused.code, 'bad_copy');
});

const step = (id, values) => ({ id, values: { name: id, ...values } });
const stepsList = {
  id: 'steps', label: 'Steps', fields: [{ id: 'name', label: 'Name' },
    { id: 'status', label: 'Status', kind: 'choice', choices: ['Open', 'Finished', 'Dropped'], starts: 'Open', settles: ['Finished', 'Dropped'] },
    { id: 'parent', label: 'Parent', kind: 'link', links_to: 'steps', pairs_with: 'kids', link_constraints: { max_links: 1 } },
    { id: 'kids', label: 'Kids', kind: 'link', links_to: 'steps', pairs_with: 'parent' },
    { id: 'settled', label: 'Settled', kind: 'rollup', rollup: { op: 'count', where: { kind: 'group', combinator: 'and', negate: false, rules: [{ kind: 'rule', field: 'status', operator: 'is_any_of', params: { values: { settles_of: 'status' } } }] } } },
    { id: 'kid_count', label: 'Kid count', kind: 'rollup', rollup: { through: 'kids', op: 'count' } },
    { id: 'kids_settled', label: 'Kids settled', kind: 'rollup', rollup: { through: 'kids', field: 'status', op: 'count', where: { kind: 'group', combinator: 'and', negate: false, rules: [{ kind: 'rule', field: 'status', operator: 'is_any_of', params: { values: { settles_of: 'status' } } }] } } }],
};

test('a rollup counts only the rows its rule keeps, and the settling values are the field\'s own, never a word in the rule', async t => {
  const { lists, ask } = fresh(t);
  await lists.save(stepsList);
  await lists.putRows('steps', { rows: [step('top', {}), step('a', { parent: 'top' }), step('b', { parent: 'top', status: 'Finished' }), step('c', { parent: 'top', status: 'Dropped' }), step('d', { parent: 'top' })] });
  const read = Object.fromEntries((await ask('/lists/steps')).body.rows.map(row => [row.id, row.values]));
  assert.equal(read.top.kid_count, 4);
  assert.equal(read.top.kids_settled, 2, 'Finished and Dropped are what the Status field settles on');
  assert.equal(read.b.settled, 1, 'a rollup with no link reaches the row itself');
  assert.equal(read.a.settled, 0);
  await lists.save({ ...stepsList, fields: stepsList.fields.map(field => (field.id === 'status' ? { ...field, settles: ['Finished'] } : field)) });
  assert.equal((await ask('/lists/steps')).body.rows.find(row => row.id === 'top').values.kids_settled, 1, 'changing what the field settles on changes the count with no other edit');
});

test('a formula field is worked out on every read by the one formula engine, and a failing formula leaves the field empty', async t => {
  const { lists, ask } = fresh(t);
  const ref = path => ({ $kind: 'binding', select: { from: 'context', path: [path] } });
  await lists.save({ id: 'sums', label: 'Sums', fields: [{ id: 'name', label: 'Name' }, { id: 'a', label: 'A', kind: 'number' }, { id: 'b', label: 'B', kind: 'number' },
    { id: 'share', label: 'Share', kind: 'formula', derive: { request: { binding: { $kind: 'binding', select: { from: 'self', path: ['a'] }, transform: [{ op: 'op:core.mul', args: { value: 100 } }, { op: 'op:core.div', args: { value: ref('b') } }, { op: 'op:core.round', args: { digits: 0 } }, { op: 'op:core.to_number' }] } } } }] });
  await lists.putRows('sums', { rows: [step('x', { a: 10, b: 36 }), step('y', { a: 1, b: 0 })] });
  const read = Object.fromEntries((await ask('/lists/sums')).body.rows.map(row => [row.id, row.values]));
  assert.equal(read.x.share, 28);
  assert.equal(read.y.share, undefined, 'division by zero is no value, not a failed read');
  assert.equal((await lists.row('sums', 'x')).values.share, undefined, 'the value is never kept');
});

test('a rollup reads the computed values of the rows it links, to any depth, so a parent\'s total is built from its children\'s totals', async t => {
  const { lists, ask } = fresh(t);
  const ref = path => ({ $kind: 'binding', select: { from: 'context', path: [path] } });
  const whenNoKids = otherwise => ({ $kind: 'binding', select: { from: 'self', path: ['kid_count'] }, transform: [{ op: 'op:core.eq', args: { value: 0 } }, { op: 'op:core.if', args: { then: otherwise.leaf, else: ref(otherwise.below) } }] });
  await lists.save({ ...stepsList, fields: [...stepsList.fields,
    { id: 'below_total', label: 'Below total', kind: 'rollup', rollup: { through: 'kids', field: 'total', op: 'sum' } },
    { id: 'below_settled', label: 'Below settled', kind: 'rollup', rollup: { through: 'kids', field: 'done', op: 'sum' } },
    { id: 'total', label: 'Total', kind: 'formula', derive: { request: { binding: whenNoKids({ leaf: 1, below: 'below_total' }) } } },
    { id: 'done', label: 'Done', kind: 'formula', derive: { request: { binding: { $kind: 'binding', select: { from: 'self', path: ['kid_count'] }, transform: [{ op: 'op:core.eq', args: { value: 0 } }, { op: 'op:core.if', args: { then: ref('settled'), else: ref('below_settled') } }] } } } },
    { id: 'progress', label: 'Progress', kind: 'formula', derive: { request: { binding: { $kind: 'binding', select: { from: 'self', path: ['done'] }, transform: [{ op: 'op:core.mul', args: { value: 100 } }, { op: 'op:core.div', args: { value: ref('total') } }, { op: 'op:core.round', args: { digits: 0 } }, { op: 'op:core.to_number' }] } } } }] });
  await lists.putRows('steps', { rows: [step('top', {}), step('a', { parent: 'top' }), step('b', { parent: 'top', status: 'Finished' }), step('a1', { parent: 'a', status: 'Finished' }), step('a2', { parent: 'a', status: 'Dropped' }), step('a3', { parent: 'a' })] });
  const progress = async () => Object.fromEntries((await ask('/lists/steps')).body.rows.map(row => [row.id, row.values.progress]));
  let read = await progress();
  assert.equal(read.top, 75, 'b, a1, a2 and a3 are the end rows; three are settled');
  assert.equal(read.a, 67);
  assert.equal(read.b, 100, 'a row with no steps is done or not by its own status');
  assert.equal(read.a3, 0);
  await lists.putRows('steps', { rows: [{ id: 'a3', values: { status: 'Finished' } }] });
  read = await progress();
  assert.equal(read.top, 100);
});

test('links that return to a row cost the rows read once: a ring is cut where it returns to a row being worked out, and nothing loops', async t => {
  const { lists, ask } = fresh(t);
  const ref = path => ({ $kind: 'binding', select: { from: 'context', path: [path] } });
  const plus = path => ({ $kind: 'binding', select: { from: 'self', path: ['one'] }, transform: [{ op: 'op:core.add', args: { value: { ...ref(path), transform: [{ op: 'op:core.if_null', args: { fallback: 0 } }] } } }] });
  await lists.save({ id: 'ring', label: 'Ring', fields: [{ id: 'name', label: 'Name' }, { id: 'one', label: 'One', kind: 'number' },
    { id: 'next', label: 'Next', kind: 'link', links_to: 'ring' },
    { id: 'after', label: 'After', kind: 'rollup', rollup: { through: 'next', field: 'sum', op: 'sum' } },
    { id: 'sum', label: 'Sum', kind: 'formula', derive: { request: { binding: plus('after') } } }] });
  await lists.putRows('ring', { rows: [step('a', { one: 1, next: 'b' }), step('b', { one: 2, next: 'c' }), step('c', { one: 4 }), step('x', { one: 1, next: 'y' }), step('y', { one: 1, next: 'x' })] });
  const read = Object.fromEntries((await ask('/lists/ring')).body.rows.map(row => [row.id, row.values]));
  assert.equal(read.a.sum, 7, 'a chain adds up to its end');
  assert.deepEqual([read.x.sum, read.y.sum], [2, 2], 'a ring counts each row once and stops where it returns to the row being worked out');
});
