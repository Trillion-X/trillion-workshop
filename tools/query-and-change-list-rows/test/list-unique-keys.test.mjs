// Identity keys (src/list-keys.mjs through src/lists.mjs and src/list-row-operations.mjs): a unique field refuses a second
// row holding the same value in its shared form, by one point read; rows kept before a field became unique gain their keys
// a page at a time and a write waits for them by name; match_mode says what a matched row may do; the shared form is a
// field a saved view can name. Runs against the real record store and the real rule evaluator.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { localStore } from '../../keep-and-wake-ai-sessions-on-this-computer/src/local-store.mjs';
import { handleListsRequest, makeLists, ListsError } from '../../keep-lists-of-rows/lists.mjs';
import { keyRecordId, keysMarkId } from '../src/list-keys.mjs';
import { makeRowFilter } from '../../formula-engine/rules/filter-rows-by-rules.mjs';
import operators from '../../formula-engine/rules/rule-operators.json' with { type: 'json' };
import settings from '../../keep-and-wake-ai-sessions-on-this-computer/src/lists.json' with { type: 'json' };

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
const refusal = async run => { try { await run(); } catch (error) { assert.ok(error instanceof ListsError, error.message); return error; } assert.fail('expected a refusal'); };

test('a unique field refuses a second row holding the same value in its shared form, and lets it go when the first changes', async t => {
  const { lists, store } = fresh(t);
  await lists.save({ id: 'people', label: 'People', fields: [{ id: 'name', label: 'Name' }, { id: 'emails', label: 'Emails', kind: 'tags', normalize: 'email', unique: true }] });
  assert.equal(await lists.keysReady('people'), true, 'a list with no rows has every key at once');
  await lists.putRows('people', { rows: [{ id: 'ana', values: { name: 'Ana', emails: ['Ana@Example.com ', 'ana@work.io'] } }] });
  const held = store.eeaf.read(keyRecordId('people', 'emails', 'ana@example.com'));
  assert.deepEqual(held, { list_id: 'people', field_id: 'emails', row_id: 'ana' }, 'each form is its own record naming the row');
  assert.ok(!keyRecordId('people', 'emails', 'ana@example.com').includes('example'), 'the form itself is never in the key id');
  const taken = await refusal(async () => await lists.putRows('people', { rows: [{ id: 'ana2', values: { name: 'Ana', emails: ['ANA@example.com'] } }] }));
  assert.equal(taken.detail.code, 'not_unique');
  assert.equal(taken.detail.holder, 'ana');
  assert.equal(await lists.row('people', 'ana2'), null, 'the refused row was not kept');
  assert.equal((await refusal(async () => await lists.putRows('people', { rows: [{ id: 'x', values: { emails: ['b@x.io'] } }, { id: 'y', values: { emails: ['B@X.IO'] } }] }))).detail.code, 'not_unique', 'two rows of one write cannot share a form either');
  // Ana lets go of one address; another row may then hold it.
  await lists.putRows('people', { rows: [{ id: 'ana', values: { emails: ['ana@work.io'] } }] });
  assert.equal(store.eeaf.read(keyRecordId('people', 'emails', 'ana@example.com')), null);
  await lists.putRows('people', { rows: [{ id: 'ana2', values: { name: 'Ana Two', emails: ['ana@example.com'] } }] });
  await lists.putRows('people', { remove: ['ana2'] });
  assert.equal(store.eeaf.read(keyRecordId('people', 'emails', 'ana@example.com')), null, 'a removed row takes its keys with it');
  assert.equal((await refusal(async () => await lists.save({ id: 'people', fields: [{ id: 'name', label: 'Name' }, { id: 'score', label: 'Score', kind: 'number', unique: true }] }))).detail.code, 'bad_unique');
});

test('rows kept before a field became unique gain their keys a page at a time; until then a write that adds a value waits, by name', async t => {
  const { lists, store } = fresh(t);
  await lists.save({ id: 'companies', label: 'Companies', fields: [{ id: 'name', label: 'Name' }, { id: 'site', label: 'Site', kind: 'link-address' }] });
  const rows = Array.from({ length: settings.open_rows.fill_page + 20 }, (_, index) => ({ id: `c${String(index).padStart(4, '0')}`, values: { name: `C${index}`, site: `https://www.c${index}.com/about` } }));
  rows.push({ id: 'dup', values: { name: 'Copy of C1', site: 'c1.com' } });
  for (let at = 0; at < rows.length; at += settings.limits.rows_per_write) await lists.putRows('companies', { rows: rows.slice(at, at + settings.limits.rows_per_write) });
  await lists.save({ id: 'companies', fields: [{ id: 'name', label: 'Name' }, { id: 'site', label: 'Site', kind: 'link-address', unique: true }] });
  assert.equal(await lists.keysReady('companies'), false, 'one page was filled when the field became unique; more rows remain');
  assert.equal((await refusal(async () => await lists.putRows('companies', { rows: [{ values: { name: 'New', site: 'new.com' } }] }))).detail.code, 'unique_index_building');
  await lists.putRows('companies', { rows: [{ id: 'c0001', values: { name: 'Renamed' } }] });
  assert.ok(await lists.orderingFillAt('companies') !== null, 'the idle step that fills a list\'s order also fills its keys');
  while (!await lists.fillOrdering('companies'));
  assert.equal(await lists.keysReady('companies'), true);
  const mark = store.eeaf.read(keysMarkId('companies'));
  assert.deepEqual(mark.shared.map(entry => [...entry.row_ids].sort()), [['c0001', 'dup']], 'rows that shared a form before are named for a person to merge, never refused or dropped');
  assert.equal((await refusal(async () => await lists.putRows('companies', { rows: [{ values: { name: 'Again', site: 'HTTP://c5.com' } }] }))).detail.holder, 'c0005');
});

test('match_mode says what a matched row may do, and a unique field matches by one point read per value', async t => {
  const { lists, ask } = fresh(t);
  await lists.save({ id: 'people', label: 'People', fields: [{ id: 'name', label: 'Name' }, { id: 'email', label: 'Email', kind: 'email', unique: true }] });
  await lists.putRows('people', { rows: [{ id: 'ana', values: { name: 'Ana', email: 'ana@example.com' } }] });
  let reads = 0;
  const read = lists.read.bind(lists);
  lists.read = (...args) => { reads += 1; return read(...args); };
  const updated = await ask('/lists/people/rows', { match_mode: 'update', rows: [{ values: { email: 'ANA@example.com', name: 'Ana B' } }] });
  assert.equal(updated.status, 200, JSON.stringify(updated.body));
  assert.deepEqual(updated.body.matches, [{ index: 0, field_id: 'email', matched: 'ANA@example.com', form: 'ana@example.com', row_id: 'ana', created: false }], 'without match_on the unique field is the key');
  assert.equal(reads, 0, 'the match walked no rows of the list');
  assert.equal((await lists.row('people', 'ana')).values.name, 'Ana B');
  assert.equal((await lists.row('people', 'ana')).values.email, 'ana@example.com', 'the spelling already kept stays');
  const none = await ask('/lists/people/rows', { match_mode: 'update', rows: [{ values: { email: 'cal@example.com', name: 'Cal' } }] });
  assert.equal(none.body.refused.code, 'match_none');
  const exists = await ask('/lists/people/rows', { match_mode: 'create', rows: [{ values: { email: 'ana@EXAMPLE.com', name: 'Again' } }] });
  assert.equal(exists.body.refused.code, 'match_exists');
  assert.equal(exists.body.refused.row_id, 'ana');
  const made = await ask('/lists/people/rows', { match_mode: 'create', rows: [{ values: { email: 'cal@example.com', name: 'Cal' } }] });
  assert.equal(made.body.matches[0].created, true);
  assert.equal((await ask('/lists/people/rows', { match_mode: 'sometimes', rows: [] })).body.refused.code, 'bad_match_mode');
});

test('a saved view names a field\'s shared form, so the same company by its domain is one rule', async t => {
  const { lists, ask } = fresh(t);
  await lists.save({ id: 'leads', label: 'Leads', fields: [{ id: 'name', label: 'Name' }, { id: 'site', label: 'Site', kind: 'link-address' }] });
  await lists.putRows('leads', { rows: [{ id: 'a', values: { name: 'A', site: 'https://www.acme.com/pricing' } }, { id: 'b', values: { name: 'B', site: 'acme.com' } }, { id: 'c', values: { name: 'C', site: 'zeta.io' } }] });
  const saved = await ask('/lists/leads/views', { label: 'Acme', rules: { kind: 'group', combinator: 'and', negate: false, rules: [{ kind: 'rule', field: 'site~key', operator: 'is_text', params: { text: 'acme.com' } }] } });
  assert.equal(saved.status, 200, JSON.stringify(saved.body));
  const read = await ask('/lists/leads/views/acme');
  assert.deepEqual(read.body.rows.map(row => row.id).sort(), ['a', 'b']);
  assert.equal(read.body.rows.find(row => row.id === 'a').values['site~key'], 'acme.com');
  assert.equal((await lists.row('leads', 'a')).values['site~key'], undefined, 'the shared form is never kept in the row');
});

test('a merge hands the keys of the row that goes to the row that stays', async t => {
  const { lists, ask, store } = fresh(t);
  await lists.save({ id: 'people', label: 'People', fields: [{ id: 'name', label: 'Name' }, { id: 'emails', label: 'Emails', kind: 'tags', normalize: 'email', unique: true }] });
  await lists.putRows('people', { rows: [{ id: 'a', values: { name: 'Ana', emails: ['ana@x.io'] } }, { id: 'b', values: { name: 'Ana', emails: ['ana@y.io'] } }] });
  const merged = await ask('/lists/people/merge', { base_id: 'b', target_id: 'a' });
  assert.equal(merged.status, 200, JSON.stringify(merged.body));
  assert.deepEqual((await lists.row('people', 'a')).values.emails, ['ana@x.io', 'ana@y.io']);
  assert.equal(store.eeaf.read(keyRecordId('people', 'emails', 'ana@y.io')).row_id, 'a');
});
