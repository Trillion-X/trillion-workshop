// Paired link fields (src/list-pairs.mjs through src/lists.mjs): one relationship seen from both sides, kept in step by
// every write, a removal and a merge; each side's max_links; both sides refused unless they mirror each other; a write
// that touches a list its writer may not change is refused on the one write road. Runs against the real record store.
import test from 'node:test';
import assert from 'node:assert/strict';
import { localStore } from '../src/local-store.mjs';
import { handleListsRequest, makeLists, ListsError } from '../../keep-lists-of-rows/lists.mjs';

const fresh = (t, options = {}) => {
  const store = localStore(':memory:');
  t.after(() => store.close?.());
  let n = 0;
  const lists = makeLists({ eeaf: store.eeaf, newId: () => `row-${++n}`, ...options });
  const ask = async (path, body) => {
    const response = await handleListsRequest(lists, new Request(`https://person${path}`, body ? { method: 'POST', body: JSON.stringify(body) } : {}));
    return { status: response.status, body: await response.json() };
  };
  return { store, lists, ask };
};
const refusal = async run => { try { await run(); } catch (error) { assert.ok(error instanceof ListsError, error.message); return error; } assert.fail('expected a refusal'); };
const row = async (lists, list, id) => (await lists.row(list, id))?.values;

const companiesAndPeople = async lists => {
  await lists.save({ id: 'companies', label: 'Companies', fields: [{ id: 'name', label: 'Name' }] });
  await lists.save({ id: 'people', label: 'People', fields: [{ id: 'name', label: 'Name' },
    { id: 'company', label: 'Company', kind: 'link', links_to: 'companies', link_constraints: { max_links: 1 } }] });
  // The company side is added after both lists exist and names its partner; saving it names it back in the same write.
  return await lists.save({ id: 'companies', fields: [{ id: 'name', label: 'Name' }, { id: 'employees', label: 'Employees', kind: 'link', links_to: 'people', pairs_with: 'company' }] });
};

test('saving one side of a pair names it back on the other side in the same write; a pair that does not mirror is refused', async t => {
  const { lists } = fresh(t);
  const saved = await companiesAndPeople(lists);
  assert.deepEqual(saved.paired, ['people']);
  assert.equal((await lists.find('people')).fields.find(field => field.id === 'company').pairs_with, 'employees', 'the partner names the field back');
  await lists.save({ id: 'deals', label: 'Deals', fields: [{ id: 'name', label: 'Name' }, { id: 'who', label: 'Who', kind: 'link', links_to: 'people' }] });
  assert.equal((await refusal(async () => await lists.save({ id: 'deals', fields: [{ id: 'name', label: 'Name' }, { id: 'who', label: 'Who', kind: 'link', links_to: 'people', pairs_with: 'company' }] }))).detail.code, 'bad_pair',
    'company already pairs with employees, so another field cannot pair with it');
  assert.equal((await refusal(async () => await lists.save({ id: 'deals', fields: [{ id: 'name', label: 'Name' }, { id: 'who', label: 'Who', kind: 'link', links_to: 'people', pairs_with: 'name' }] }))).detail.code, 'bad_pair',
    'a text field is not a link back');
  // Unpairing one side lets the other go.
  await lists.save({ id: 'companies', fields: [{ id: 'name', label: 'Name' }, { id: 'employees', label: 'Employees', kind: 'link', links_to: 'people' }] });
  assert.equal((await lists.find('people')).fields.find(field => field.id === 'company').pairs_with, undefined);
});

test('a write to either side changes the other in the same write, and a removed row leaves both sides', async t => {
  const { lists, store } = fresh(t);
  await companiesAndPeople(lists);
  await lists.putRows('companies', { rows: [{ id: 'acme', values: { name: 'Acme' } }, { id: 'zeta', values: { name: 'Zeta' } }] });
  const sequence = store.eeaf.changeSeq();
  const put = await lists.putRows('people', { rows: [{ id: 'ana', values: { name: 'Ana', company: 'acme' } }, { id: 'ben', values: { name: 'Ben', company: ['acme'] } }] });
  assert.deepEqual(put.paired, [{ list_id: 'companies', row_id: 'acme' }]);
  assert.deepEqual((await row(lists, 'companies', 'acme')).employees, ['ana', 'ben']);
  assert.ok(store.eeaf.changeSeq() > sequence);
  // The other direction: Zeta takes Ben, so Ben's single company moves only if his side can hold it.
  assert.equal((await refusal(async () => await lists.putRows('companies', { rows: [{ id: 'zeta', values: { employees: ['ben'] } }] }))).detail.code, 'link_too_many',
    'Ben holds at most one company, so Zeta cannot take him while Acme has him');
  assert.deepEqual((await row(lists, 'companies', 'zeta')).employees, undefined, 'the refused write changed nothing on either side');
  await lists.putRows('people', { rows: [{ id: 'ben', values: { company: 'zeta' } }] });
  assert.deepEqual((await row(lists, 'companies', 'acme')).employees, ['ana']);
  assert.deepEqual((await row(lists, 'companies', 'zeta')).employees, ['ben']);
  await lists.putRows('companies', { rows: [{ id: 'acme', values: { employees: ['ana', 'cal'] } }] });
  assert.deepEqual((await row(lists, 'companies', 'acme')).employees, ['ana', 'cal'], 'a link to a row not kept has no other side to change');
  await lists.putRows('people', { remove: ['ana'] });
  assert.deepEqual((await row(lists, 'companies', 'acme')).employees, ['cal'], 'a removed person leaves the company side');
  await lists.putRows('companies', { remove: ['zeta'] });
  assert.equal((await row(lists, 'people', 'ben')).company, undefined, 'a removed company leaves the person side');
});

test('a pair on its own list (parent and children, or a symmetric link) is kept in step inside one write', async t => {
  const { lists } = fresh(t);
  await lists.save({ id: 'tasks', label: 'Tasks', fields: [{ id: 'name', label: 'Name' }, { id: 'parent', label: 'Parent', kind: 'link', links_to: 'tasks', link_constraints: { max_links: 1 } },
    { id: 'children', label: 'Children', kind: 'link', links_to: 'tasks', pairs_with: 'parent' }, { id: 'related', label: 'Related', kind: 'link', links_to: 'tasks', pairs_with: 'related' }] });
  assert.equal((await lists.find('tasks')).fields.find(field => field.id === 'parent').pairs_with, 'children');
  await lists.putRows('tasks', { rows: [{ id: 'p', values: { name: 'Plan' } }, { id: 'a', values: { name: 'A', parent: 'p', related: ['b'] } }, { id: 'b', values: { name: 'B', parent: 'p' } }] });
  assert.deepEqual((await row(lists, 'tasks', 'p')).children, ['a', 'b']);
  assert.deepEqual((await row(lists, 'tasks', 'b')).related, ['a'], 'a symmetric link names both rows');
  await lists.putRows('tasks', { rows: [{ id: 'a', values: { related: null } }] });
  assert.equal((await row(lists, 'tasks', 'b')).related, undefined);
});

test('entries of a list point at a parent through a required link and the parent reads its entries off its own row', async t => {
  const { lists, ask } = fresh(t);
  await lists.save({ id: 'people', label: 'People', fields: [{ id: 'name', label: 'Name' }] });
  await lists.save({ id: 'pipeline', label: 'Pipeline', fields: [{ id: 'stage', label: 'Stage', kind: 'choice', choices: ['Lead', 'Won'] },
    { id: 'person', label: 'Person', kind: 'link', links_to: 'people', required: true, link_constraints: { max_links: 1, require_target: true } }] });
  await lists.save({ id: 'people', fields: [{ id: 'name', label: 'Name' }, { id: 'entries', label: 'In pipeline', kind: 'link', links_to: 'pipeline', pairs_with: 'person' }] });
  await lists.putRows('people', { rows: [{ id: 'ana', values: { name: 'Ana' } }] });
  assert.equal((await refusal(async () => await lists.putRows('pipeline', { rows: [{ values: { stage: 'Lead' } }] }))).detail.code, 'missing_required', 'an entry always names its parent');
  await lists.putRows('pipeline', { rows: [{ id: 'e1', values: { stage: 'Lead', person: 'ana' } }, { id: 'e2', values: { stage: 'Won', person: 'ana' } }] });
  const parent = (await ask('/lists/people?row_ids=%5B%22ana%22%5D')).body.rows[0];
  assert.deepEqual(parent.links.entries.map(entry => entry.id), ['e1', 'e2'], 'the parent row lists its entries with their names');
});

test('merging two rows moves the paired links to the survivor without passing either side its limit', async t => {
  const { lists, ask } = fresh(t);
  await companiesAndPeople(lists);
  await lists.putRows('companies', { rows: [{ id: 'acme', values: { name: 'Acme' } }, { id: 'acme-2', values: { name: 'Acme Inc' } }] });
  await lists.putRows('people', { rows: [{ id: 'ana', values: { name: 'Ana', company: 'acme' } }, { id: 'ben', values: { name: 'Ben', company: 'acme-2' } }] });
  const merged = await ask('/lists/companies/merge', { base_id: 'acme-2', target_id: 'acme', prefer: 'target' });
  assert.equal(merged.status, 200, JSON.stringify(merged.body));
  assert.deepEqual((await row(lists, 'companies', 'acme')).employees, ['ana', 'ben']);
  assert.deepEqual((await row(lists, 'people', 'ben')).company, ['acme']);
  assert.equal(await row(lists, 'companies', 'acme-2'), undefined);
});

test('a write that changes a list its writer may not change is refused, the other side of a pair included', async t => {
  const { lists } = fresh(t, { mayWrite: (listId, actor) => actor?.by !== 'guest' || listId === 'people' });
  await companiesAndPeople(lists);
  await lists.putRows('companies', { rows: [{ id: 'acme', values: { name: 'Acme' } }] });
  await lists.putRows('people', { rows: [{ id: 'ana', values: { name: 'Ana' } }] });
  const refused = await refusal(async () => await lists.putRows('people', { rows: [{ id: 'ana', values: { company: 'acme' } }] }, { actor: { by: 'guest' } }));
  assert.equal(refused.detail.code, 'no_write_right');
  assert.equal(refused.detail.list_id, 'companies');
  assert.equal((await row(lists, 'people', 'ana')).company, undefined, 'nothing of the write was kept');
  await lists.putRows('people', { rows: [{ id: 'ana', values: { name: 'Ana B' } }] }, { actor: { by: 'guest' } });
  assert.equal((await row(lists, 'people', 'ana')).name, 'Ana B', 'a write that touches only a list it may change is kept');
});
