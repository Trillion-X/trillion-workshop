// Who points at a row (src/list-row-operations.mjs over src/lists.mjs linkHolders): answered from the store's own record
// of what holds what, kept on every write, so it reads no rows of the linking lists; a field whose record is still being
// built is read the old bounded way. A removal says which links still point at what it removed; and a file field that names
// a file by where it is follows the file to its new name. Runs against the real record store.
import test from 'node:test';
import assert from 'node:assert/strict';
import { localStore } from '../../keep-and-wake-ai-sessions-on-this-computer/src/local-store.mjs';
import { handleListsRequest, makeLists } from '../../keep-lists-of-rows/lists.mjs';
import { backlinks } from '../src/list-row-operations.mjs';

const fresh = t => {
  const store = localStore(':memory:');
  t.after(() => store.close?.());
  let n = 0;
  const lists = makeLists({ eeaf: store.eeaf, newId: () => `row-${++n}` });
  const ask = async (path, body) => {
    const response = await handleListsRequest(lists, new Request(`https://person${path}`, body ? { method: 'POST', body: JSON.stringify(body) } : {}));
    return { status: response.status, body: await response.json() };
  };
  return { store, lists, ask };
};
const setUp = async lists => {
  await lists.save({ id: 'companies', label: 'Companies', fields: [{ id: 'name', label: 'Name' }] });
  await lists.save({ id: 'people', label: 'People', fields: [{ id: 'name', label: 'Name' }, { id: 'company', label: 'Company', kind: 'link', links_to: 'companies' }] });
  await lists.save({ id: 'deals', label: 'Deals', fields: [{ id: 'name', label: 'Name' }, { id: 'buyer', label: 'Buyer', kind: 'link', links_to: 'companies', on_target_remove: 'detach' }] });
  await lists.putRows('companies', { rows: [{ id: 'acme', values: { name: 'Acme' } }, { id: 'zeta', values: { name: 'Zeta' } }] });
  await lists.putRows('people', { rows: Array.from({ length: 120 }, (_, index) => ({ id: `p${index}`, values: { name: `P${index}`, company: index % 40 === 0 ? ['acme'] : ['zeta'] } })) });
  await lists.putRows('deals', { rows: [{ id: 'd1', values: { name: 'Renewal', buyer: ['acme', 'zeta'] } }] });
};

test('backlinks come from the store\'s record of what holds what and read no rows of the linking lists', async t => {
  const { lists, store } = fresh(t);
  await setUp(lists);
  const pagedReads = [];
  const read = lists.read.bind(lists);
  lists.read = (id, options = {}) => { if (!options.row_ids) pagedReads.push(id); return read(id, options); };
  const expected = [['deals', 'buyer', 'd1', 'Renewal'], ['people', 'company', 'p0', 'P0'], ['people', 'company', 'p40', 'P40'], ['people', 'company', 'p80', 'P80']];
  // Lists just declared: the store is still walking their links into its record, so the rows are read meanwhile.
  const building = await backlinks(lists, 'companies', 'acme');
  assert.deepEqual(building.backlinks.map(link => [link.list_id, link.field_id, link.row_id, link.title]).sort(), expected);
  assert.ok(pagedReads.length > 0);
  for (let step = 0; step < 10; step += 1) store.eeaf.maintain();
  pagedReads.length = 0;
  const answer = await backlinks(lists, 'companies', 'acme');
  assert.equal(answer.complete, true);
  assert.deepEqual(answer.backlinks.map(link => [link.list_id, link.field_id, link.row_id, link.title]).sort(), expected);
  assert.deepEqual(pagedReads, [], 'no linking list was read a page at a time');
  // The record follows every write: a link taken away is gone from the answer at once.
  await lists.putRows('people', { rows: [{ id: 'p40', values: { company: ['zeta'] } }] });
  assert.deepEqual((await backlinks(lists, 'companies', 'acme')).backlinks.map(link => link.row_id).sort(), ['d1', 'p0', 'p80']);
  assert.deepEqual(pagedReads, [], 'still no page reads after a write');
});

test('while the record of what holds what is being built, backlinks read the rows the old bounded way', async t => {
  const { lists } = fresh(t);
  await setUp(lists);
  lists.linkHolders = () => ({ complete: false, holders: [] });
  const answer = await backlinks(lists, 'companies', 'acme');
  assert.equal(answer.complete, true);
  assert.deepEqual(answer.backlinks.map(link => link.row_id).sort(), ['d1', 'p0', 'p40', 'p80']);
});

test('a removal says which links still point at the rows it removed; a link that detaches has already let go', async t => {
  const context = fresh(t);
  await setUp(context.lists);
  // With the store's record complete, the removal finds the links to detach from it too, a same-request edit included.
  for (let step = 0; step < 10; step += 1) context.store.eeaf.maintain();
  const read = context.lists.read.bind(context.lists);
  const pagedReads = [];
  context.lists.read = (id, options = {}) => { if (!options.row_ids) pagedReads.push(id); return read(id, options); };
  const removed = (await context.ask('/lists/companies/rows', { rows: [{ id: 'zeta', values: { name: 'Zeta Ltd' } }], remove: ['acme'] })).body;
  assert.deepEqual(pagedReads, [], 'neither the detaching nor the reporting read a linking list a page at a time');
  context.lists.read = read;
  assert.deepEqual(removed.removed, ['acme']);
  assert.deepEqual(removed.dangling.map(link => [link.list_id, link.field_id, link.row_id, link.target]).sort(),
    [['people', 'company', 'p0', 'acme'], ['people', 'company', 'p40', 'acme'], ['people', 'company', 'p80', 'acme']]);
  assert.deepEqual(context.lists.row('deals', 'd1').values.buyer, ['zeta'], 'the detaching link was taken away and is not reported');
  context.lists.putRows('companies', { rows: [{ id: 'gone', values: { name: 'Gone' } }] });
  const same = (await context.ask('/lists/deals/rows', { rows: [{ id: 'd2', values: { name: 'New deal', buyer: ['gone', 'zeta'] } }] })).body;
  assert.equal(same.kept[0].id, 'd2');
  await context.ask('/lists/companies/rows', { remove: ['gone'] });
  assert.deepEqual(context.lists.row('deals', 'd2').values.buyer, ['zeta'], 'a link written just before is found and detached');
  const plain = (await context.ask('/lists/companies/rows', { rows: [{ id: 'new', values: { name: 'New' } }] })).body;
  assert.equal(plain.dangling, undefined, 'a write that removes nothing reports nothing');
});

test('a file field that names a file by where it is follows the file to its new name, row by row, and says what it changed', async t => {
  const { lists, ask } = fresh(t);
  await lists.save({ id: 'shots', label: 'Shots', fields: [{ id: 'name', label: 'Name' }, { id: 'clip', label: 'Clip', kind: 'file' }] });
  await lists.save({ id: 'posts', label: 'Posts', fields: [{ id: 'name', label: 'Name' }, { id: 'cover', label: 'Cover', kind: 'file' }] });
  await lists.putRows('shots', { rows: [{ id: 's1', values: { name: 'Opening', clip: '/Media/clip.mp4' } }, { id: 's2', values: { name: 'Other', clip: '/Media/other.mp4' } }, { id: 's3', values: { name: 'By identity', clip: `1f:${'a'.repeat(64)}` } }] });
  await lists.putRows('posts', { rows: [{ id: 'p1', values: { name: 'Launch', cover: '/Media/clip.mp4' } }] });
  const found = (await ask('/lists/file-names?name=%2FMedia%2Fclip.mp4')).body;
  assert.deepEqual(found.references.sort((a, b) => a.list_id.localeCompare(b.list_id)), [{ list_id: 'posts', field_id: 'cover', row_ids: ['p1'] }, { list_id: 'shots', field_id: 'clip', row_ids: ['s1'] }]);
  assert.equal((await lists.row('shots', 's1')).values.clip, '/Media/clip.mp4', 'asking which rows name it changes nothing');
  const moved = (await ask('/lists/file-names', { from: '/Media/clip.mp4', to: '/Archive/2026/clip.mp4' })).body;
  assert.equal(moved.complete, true);
  assert.deepEqual(moved.rewritten.map(entry => [entry.list_id, entry.rows]).sort(), [['posts', 1], ['shots', 1]]);
  assert.equal((await lists.row('shots', 's1')).values.clip, '/Archive/2026/clip.mp4');
  assert.equal((await lists.row('posts', 'p1')).values.cover, '/Archive/2026/clip.mp4');
  assert.equal((await lists.row('shots', 's2')).values.clip, '/Media/other.mp4');
  assert.equal((await ask('/lists/file-names', { from: 'clip.mp4', to: '/x' })).body.refused.code, 'bad_file_name');
});
