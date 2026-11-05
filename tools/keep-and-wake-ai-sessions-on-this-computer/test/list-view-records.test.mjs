// Saved views (src/lists.mjs): each kept as a record of its own, so adding, changing, ordering or removing one never
// rewrites the list or its other views; a view whose rule values are given when it is read (src/list-view-parameters.mjs);
// and a view's rows held still as a snapshot read by range and totalled by its id (src/list-snapshots.mjs). Runs against
// the real record store and the real rule evaluator.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { localStore } from '../src/local-store.mjs';
import { handleListsRequest, makeLists } from '../../keep-lists-of-rows/lists.mjs';
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
  const lists = makeLists({ eeaf: store.eeaf, newId: () => `id-${++n}` });
  const ask = async (path, body) => {
    const response = await handleListsRequest(lists, new Request(`https://person${path}`, body ? { method: 'POST', body: JSON.stringify(body) } : {}), views);
    return { status: response.status, body: await response.json() };
  };
  return { store, lists, ask };
};
const group = (...rules) => ({ kind: 'group', combinator: 'and', negate: false, rules });
const choice = (field, values) => ({ kind: 'rule', field, operator: 'is_any_of', params: { values } });

test('a saved view is a record of its own: adding, changing, ordering and removing one never rewrites the list', async t => {
  const { lists, ask, store } = fresh(t);
  await lists.save({ id: 'deals', label: 'Deals', fields: [{ id: 'name', label: 'Name' }, { id: 'stage', label: 'Stage', kind: 'choice', choices: ['Lead', 'Won'] }],
    views: [{ id: 'leads', label: 'Leads', rules: group(choice('stage', ['Lead'])) }] });
  assert.equal(store.eeaf.read('list:deals').views, undefined, 'views given with the list are kept as records of their own');
  assert.ok(store.eeaf.read('list-view:deals:leads'));
  const definition = JSON.stringify(store.eeaf.read('list:deals'));
  await ask('/lists/deals/views', { id: 'won', label: 'Won', rules: group(choice('stage', ['Won'])) });
  await ask('/lists/deals/views', { id: 'all', label: 'Everything', sort: [{ field: 'stage', direction: 'asc' }] });
  await ask('/lists/deals/views/leads', { label: 'Open leads' });
  assert.equal(JSON.stringify(store.eeaf.read('list:deals')), definition, 'the list itself was never rewritten');
  assert.deepEqual((await ask('/lists/deals/views')).body.views.map(view => [view.id, view.label]), [['leads', 'Open leads'], ['won', 'Won'], ['all', 'Everything']]);
  const moved = (await ask('/lists/deals/views/all/move', { anchor_id: 'leads', placement: 'before' })).body;
  assert.deepEqual(moved.views, ['all', 'leads', 'won']);
  assert.equal((await ask('/lists/deals/views/won/move', { anchor_id: 'won', placement: 'after' })).body.refused.code, 'bad_view_move');
  await ask('/lists/deals/views/won', { remove: true });
  assert.deepEqual((await lists.find('deals')).views.map(view => view.id), ['all', 'leads']);
  assert.equal(store.eeaf.read('list-view:deals:won'), null);
  assert.equal(JSON.stringify(store.eeaf.read('list:deals')), definition);
  // A view kept as its own record is checked against the fields like any: the field it sorts by cannot be taken from under it.
  await assert.rejects(async () => await lists.save({ id: 'deals', fields: [{ id: 'name', label: 'Name' }] }), /saved view/);
});

test('views a list kept inside itself are read as before and move to records of their own when ordered', async t => {
  const { lists, ask, store } = fresh(t);
  await lists.save({ id: 'deals', label: 'Deals', fields: [{ id: 'name', label: 'Name' }] });
  // A list kept before views had records of their own: its views live inside it.
  store.eeaf.write([{ id: 'list:deals', type: 'list', value: { ...store.eeaf.read('list:deals'), views: [{ id: 'a', label: 'A', search: '', time_zone: 'UTC', sort: [], groups: [], columns: { order: [], hidden: [] } }, { id: 'b', label: 'B', search: '', time_zone: 'UTC', sort: [], groups: [], columns: { order: [], hidden: [] } }] } }], { actor: { by: 'test' } });
  await ask('/lists/deals/views', { id: 'c', label: 'C' });
  assert.deepEqual((await lists.find('deals')).views.map(view => view.id), ['a', 'b', 'c']);
  assert.deepEqual((await ask('/lists/deals/views/a/move', { anchor_id: 'c', placement: 'after' })).body.views, ['b', 'c', 'a']);
  assert.equal(store.eeaf.read('list:deals').views, undefined, 'ordering gave every view a record of its own');
});

test('a view whose rule values are given when it is read is one view for many readers', async t => {
  const { lists, ask } = fresh(t);
  await lists.save({ id: 'deals', label: 'Deals', fields: [{ id: 'name', label: 'Name' }, { id: 'owner', label: 'Owner', kind: 'choice', choices: ['Ana', 'Ben'] }] });
  await lists.putRows('deals', { rows: [{ id: 'd1', values: { name: 'One', owner: 'Ana' } }, { id: 'd2', values: { name: 'Two', owner: 'Ben' } }, { id: 'd3', values: { name: 'Three', owner: 'Ana' } }] });
  await ask('/lists/deals/views', { id: 'mine', label: 'Mine', rules: group(choice('owner', [{ parameter: 'owner' }])) });
  await ask('/lists/deals/views', { id: 'bens', label: 'Ben unless said', rules: group(choice('owner', [{ parameter: 'owner', default: 'Ben' }])) });
  const listed = (await ask('/lists/deals/views')).body.views;
  assert.deepEqual(listed.find(view => view.id === 'mine').parameters, ['owner'], 'list_list_views says what a view asks for');
  const ana = (await ask(`/lists/deals/views/mine?parameters=${encodeURIComponent(JSON.stringify({ owner: 'Ana' }))}`)).body;
  assert.deepEqual(ana.rows.map(row => row.id).sort(), ['d1', 'd3']);
  const ben = (await ask(`/lists/deals/views/mine?parameters=${encodeURIComponent(JSON.stringify({ owner: 'Ben' }))}`)).body;
  assert.deepEqual(ben.rows.map(row => row.id), ['d2']);
  assert.equal((await ask('/lists/deals/views/mine')).body.refused.code, 'missing_parameter', 'a value not given is never read as no rule');
  assert.deepEqual((await ask('/lists/deals/views/bens')).body.rows.map(row => row.id), ['d2'], 'a default stands in when no value is given');
  assert.deepEqual((await lists.find('deals')).views.find(view => view.id === 'mine').rules.rules[0].params.values, [{ parameter: 'owner' }], 'the saved view keeps the parameter');
});

test('a snapshot holds a view\'s rows still: ranges and totals read the rows it held while the list changes', async t => {
  const { lists, ask } = fresh(t);
  await lists.save({ id: 'deals', label: 'Deals', fields: [{ id: 'name', label: 'Name' }, { id: 'stage', label: 'Stage', kind: 'choice', choices: ['Lead', 'Won'] }, { id: 'amount', label: 'Amount', kind: 'number' }],
    views: [{ id: 'leads', label: 'Leads', rules: group(choice('stage', ['Lead'])) }] });
  await lists.putRows('deals', { rows: Array.from({ length: 120 }, (_, index) => ({ id: `d${String(index).padStart(3, '0')}`, values: { name: `Deal ${index}`, stage: index < 90 ? 'Lead' : 'Won', amount: 10 } })) });
  const taken = (await ask('/lists/deals/snapshots', { view_id: 'leads' })).body;
  assert.equal(taken.total, 90);
  assert.equal(taken.complete, true);
  // The list changes after the snapshot: a lead is won, one is removed, a new lead arrives.
  await lists.putRows('deals', { rows: [{ id: 'd000', values: { stage: 'Won' } }, { id: 'new', values: { name: 'New', stage: 'Lead', amount: 99 } }], remove: ['d001'] });
  const first = (await ask(`/lists/deals/snapshots/${taken.snapshot_id}?from=0&count=50`)).body;
  assert.equal(first.total, 90);
  assert.equal(first.rows.length + first.gone.length, 50);
  const second = (await ask(`/lists/deals/snapshots/${taken.snapshot_id}?from=${first.next_cursor}&count=50`)).body;
  assert.equal(second.rows.length + second.gone.length, 40);
  assert.equal(second.next_cursor, null);
  assert.deepEqual([...first.gone, ...second.gone], ['d001'], 'a row removed since is named, not shown empty');
  assert.ok([...first.rows, ...second.rows].some(row => row.id === 'd000' && row.values.stage === 'Won'), 'values are read now');
  assert.ok(![...first.rows, ...second.rows].some(row => row.id === 'new'), 'a row added since is not in the snapshot');
  const totals = (await ask('/lists/deals/aggregate', { snapshot_id: taken.snapshot_id, measures: [{ op: 'count' }, { op: 'sum', field: 'amount' }] })).body;
  assert.deepEqual(totals.measures.map(measure => measure.value), [89, 890], 'totals over the rows the snapshot held that are still kept');
  assert.equal((await ask('/lists/deals/snapshots/nope')).body.refused.code, 'no_snapshot');
  for (let index = 0; index < settings.limits.snapshots_kept + 2; index += 1) await ask('/lists/deals/snapshots', {});
  assert.equal((await ask(`/lists/deals/snapshots/${taken.snapshot_id}`)).body.refused.code, 'no_snapshot', 'a list keeps at most snapshots_kept; the oldest goes first');
});
