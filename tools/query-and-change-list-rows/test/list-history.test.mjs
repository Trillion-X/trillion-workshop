// What a list keeps about its past (src/lists.mjs): a removed row is listed as recently removed and put back exactly as it
// was, from the log; a row merged away leaves a tombstone, so reading its old id answers where it went and a link written
// later to the old id lands on the row it became; and a list that
// keeps stamps says who wrote each value and which values a machine wrote. Runs against the real record store.
import test from 'node:test';
import assert from 'node:assert/strict';
import { localStore } from '../../keep-and-wake-ai-sessions-on-this-computer/src/local-store.mjs';
import { handleListsRequest, makeLists, ListsError } from '../../keep-lists-of-rows/lists.mjs';
import { actorClass } from '../src/list-stamps.mjs';

const fresh = t => {
  const store = localStore(':memory:');
  t.after(() => store.close?.());
  let n = 0;
  const lists = makeLists({ eeaf: store.eeaf, newId: () => `row-${++n}` });
  const ask = async (path, body, app) => {
    const headers = app ? { 'x-trillion-app': app } : {};
    const response = await handleListsRequest(lists, new Request(`https://person${path}`, body ? { method: 'POST', body: JSON.stringify(body), headers } : { headers }));
    return { status: response.status, body: await response.json() };
  };
  return { store, lists, ask };
};
const pause = () => new Promise(resolve => setTimeout(resolve, 5));

test('a removed row is listed as recently removed, newest first, and put back exactly as it was', async t => {
  const { lists, ask } = fresh(t);
  lists.save({ id: 'people', label: 'People', fields: [{ id: 'name', label: 'Name' }, { id: 'email', label: 'Email', kind: 'email', unique: true }, { id: 'notes', label: 'Notes' }] });
  lists.putRows('people', { rows: [{ id: 'ana', values: { name: 'Ana', email: 'ana@x.io', notes: 'met at the fair' }, basis: { notes: { confidence: 'high', reasoning: 'She said so' } } },
    { id: 'ben', values: { name: 'Ben' } }, { id: 'cal', values: { name: 'Cal' } }] });
  const before = lists.row('people', 'ana').values;
  await ask('/lists/people/rows', { remove: ['ben'] });
  await pause();
  await ask('/lists/people/rows', { remove: ['ana'] });
  const removed = (await ask('/lists/people/removed')).body;
  assert.deepEqual(removed.rows.map(row => [row.id, row.title]), [['ana', 'Ana'], ['ben', 'Ben']], 'newest first, with each row\'s name from before');
  const paged = (await ask('/lists/people/removed?limit=1')).body;
  assert.deepEqual(paged.rows.map(row => row.id), ['ana']);
  assert.deepEqual((await ask(`/lists/people/removed?limit=1&cursor=${encodeURIComponent(paged.next_cursor)}`)).body.rows.map(row => row.id), ['ben']);
  // Someone takes Ana's email meanwhile, so she cannot come back holding it.
  lists.putRows('people', { rows: [{ id: 'dee', values: { name: 'Dee', email: 'ANA@x.io' } }] });
  assert.equal((await ask('/lists/people/rows/restore', { row_ids: ['ana'] })).body.refused.code, 'not_unique');
  lists.putRows('people', { remove: ['dee'] });
  const restored = (await ask('/lists/people/rows/restore', { row_ids: ['ana', 'cal', 'nobody'] })).body;
  assert.deepEqual(restored.restored, ['ana']);
  assert.deepEqual(restored.not_restored, [{ row_id: 'cal', reason: 'kept' }, { row_id: 'nobody', reason: 'history_gone' }]);
  assert.deepEqual(lists.row('people', 'ana').values, before, 'every value, the basis included, is as it was');
  assert.deepEqual((await ask('/lists/people/removed')).body.rows.map(row => row.id), ['dee', 'ben'], 'a row put back is no longer listed; the newest removal leads');
  const again = (await ask('/lists/people/rows', { rows: [{ values: { name: 'Eve', email: 'ana@x.io' } }] })).body;
  assert.equal(again.refused.code, 'not_unique', 'the restored row holds its key again');
});

test('a row merged away leaves a tombstone: its old id answers where it went, and a later link to it lands on the survivor', async t => {
  const { lists, ask } = fresh(t);
  lists.save({ id: 'companies', label: 'Companies', fields: [{ id: 'name', label: 'Name' }] });
  lists.save({ id: 'deals', label: 'Deals', fields: [{ id: 'name', label: 'Name' }, { id: 'company', label: 'Company', kind: 'link', links_to: 'companies' }] });
  lists.putRows('companies', { rows: [{ id: 'a', values: { name: 'Acme' } }, { id: 'b', values: { name: 'Acme Inc' } }, { id: 'c', values: { name: 'ACME' } }] });
  await ask('/lists/companies/merge', { base_id: 'b', target_id: 'a', prefer: 'target' });
  await ask('/lists/companies/merge', { base_id: 'a', target_id: 'c', prefer: 'target' });
  const read = (await ask('/lists/companies?row_ids=%5B%22b%22%2C%22c%22%5D')).body;
  assert.deepEqual(read.rows.map(row => row.id), ['c']);
  assert.deepEqual(read.redirects, [{ id: 'b', merged_into: 'c' }], 'b went into a, which went into c');
  const deal = lists.putRows('deals', { rows: [{ id: 'd1', values: { name: 'Renewal', company: ['b'] } }] });
  assert.deepEqual(deal.kept[0].values.company, ['c'], 'a link written to the old id is written to the row it became');
});

// One field of many rows (or a whole column) as it was at a moment now runs on the records the door gives:
// tools/keep-lists-of-rows/test/field-at-on-records.test.mjs.

test('a list that keeps stamps says who wrote each value and which values a machine wrote; a list without them is unchanged', async t => {
  const { lists, ask } = fresh(t);
  lists.save({ id: 'people', label: 'People', stamps: true, fields: [{ id: 'name', label: 'Name' }, { id: 'title', label: 'Title' }, { id: 'last_contact', label: 'Last contact', kind: 'date' }] });
  await ask('/lists/people/rows', { rows: [{ id: 'ana', values: { name: 'Ana', title: 'CTO' } }] }, 'You, in Trillion');
  await ask('/lists/people/rows', { rows: [{ id: 'ana', values: { last_contact: '2026-10-01', title: 'CEO' } }] }, 'Claude');
  const values = lists.row('people', 'ana').values;
  assert.equal(values._stamps.name.class, 'person');
  assert.equal(values._stamps.title.class, 'ai');
  assert.equal(values._stamps.title.by, 'Claude');
  const read = (await ask('/lists/people')).body.rows[0];
  assert.deepEqual(read.machine_written.sort(), ['last_contact', 'title']);
  await ask('/lists/people/rows', { rows: [{ id: 'ana', values: { title: null } }] }, 'You, in Trillion');
  assert.equal(lists.row('people', 'ana').values._stamps.title, undefined, 'a cleared value loses its stamp');
  assert.equal(actorClass({ by: 'calendar' }), 'automation');
  assert.equal(actorClass({ by: 'operator-import' }), 'import');
  assert.equal(actorClass({ by: 'something new' }), 'unknown');
  lists.save({ id: 'plain', label: 'Plain', fields: [{ id: 'name', label: 'Name' }] });
  await ask('/lists/plain/rows', { rows: [{ id: 'p', values: { name: 'P' } }] }, 'Claude');
  assert.equal(lists.row('plain', 'p').values._stamps, undefined, 'stamps are kept only where a list asks for them');
  assert.equal((await ask('/lists/plain')).body.rows[0].machine_written, undefined);
  assert.throws(() => lists.save({ id: 'plain', stamps: 'yes' }), ListsError);
});

test('a removal lets go of the list\'s trash records older than the days kept, and a row they named can still be put back', async t => {
  const { store, lists } = fresh(t);
  lists.save({ id: 'notes', label: 'Notes', fields: [{ id: 'name', label: 'Name' }] });
  lists.putRows('notes', { rows: ['x', 'y', 'z'].map(id => ({ id, values: { name: id } })) });
  lists.putRows('notes', { remove: ['x'] });
  assert.ok(store.eeaf.read('list-trash:notes:x'), 'the removal left its trash record');
  t.mock.timers.enable({ apis: ['Date'], now: Date.now() + 31 * 86_400_000 });
  lists.putRows('notes', { remove: ['y'] });
  assert.equal(store.eeaf.read('list-trash:notes:x'), null, 'x\'s record is past the 30 days and was let go with the next removal');
  assert.ok(store.eeaf.read('list-trash:notes:y'), 'y\'s own record is fresh');
  assert.deepEqual(lists.removedRows('notes').rows.map(row => row.id), ['y']);
  assert.equal(lists.restoreRows('notes', { row_ids: ['x'] }).restored.length, 1, 'the log still holds x, so it comes back');
});
