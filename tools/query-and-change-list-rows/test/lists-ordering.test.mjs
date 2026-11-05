import test from 'node:test';
import assert from 'node:assert/strict';
import { localStore } from '../../keep-and-wake-ai-sessions-on-this-computer/src/local-store.mjs';
import { makeLists, handleListsRequest } from '../../keep-lists-of-rows/lists.mjs';
import { spreadKeys } from '../../keep-lists-of-rows/do-work/fractional-order.ts';
import { listTools } from '../src/list-tools.mjs';

async function fresh() {
  const store = localStore(':memory:');
  const lists = makeLists({ eeaf: store.eeaf });
  await lists.save({
    id: 'tasks', label: 'Tasks', row_type: 'ordered-task', title_field: 'name',
    fields: [{ id: 'name', label: 'Name' }, { id: 'order', label: 'Order' }],
    indexes: [{ name: 'manual_order', fields: ['order'] }],
  });
  await lists.putRows('tasks', { rows: ['a', 'b', 'c'].map((id, index) => ({
    id, values: { name: id.toUpperCase(), order: spreadKeys(3)[index] },
  })) });
  for (let page = 0; page < 100 && !store.eeaf.indexReady('record:ordered-task', 'manual_order'); page++) {
    store.eeaf.backfillTables({ limit: 2 });
  }
  assert.equal(store.eeaf.indexReady('record:ordered-task', 'manual_order'), true);
  return { store, lists };
}

const ordered = (store, direction = {}) => store.eeaf.scan('record:ordered-task', 'manual_order', direction)
  .map(entry => entry.id.slice('record:ordered-task:'.length));

test('AI list actions declare, read, move and clear manual order through the same HTTP owner', async () => {
  const { store, lists } = await fresh();
  const tools = listTools(async (path, body) => {
    const response = await handleListsRequest(lists, new Request(`https://person${path}`, body === undefined ? {} : {
      method: 'POST', headers: { 'content-type': 'application/json', 'x-trillion-app': 'ai' }, body: JSON.stringify(body),
    }));
    assert.equal(response.status, 200);
    return response.json();
  });
  const action = name => tools.find(tool => tool.name === name);
  await action('save_list').run({ id: 'tasks', ordering: { index: 'manual_order' } });
  const read = () => action('read_list').run({ list_id: 'list:tasks', order: true, limit: 2 });
  const before = await read();
  assert.equal(before.ordering.ready, true);
  assert.deepEqual(before.rows.map(row => row.id), ['a', 'b']);
  const tail = await action('read_list').run({ list_id: 'tasks', order: true, limit: 2, cursor: before.page.next_cursor });
  assert.deepEqual(tail.rows.map(row => row.id), ['c']);
  const move = { list_id: 'tasks', row_id: 'c', index: 'manual_order', anchor_id: 'a', placement: 'before' };
  assert.equal((await action('move_list_row').run(move)).moved, true);
  assert.equal((await action('move_list_row').run(move)).moved, false);
  assert.deepEqual((await read()).rows.map(row => row.id), ['c', 'a']);
  await action('save_list').run({ id: 'tasks', ordering: null });
  assert.equal((await lists.find('tasks')).ordering, undefined);
  const refused = await handleListsRequest(lists, new Request('https://person/lists/tasks?order=true'));
  assert.equal(refused.status, 400, 'removed ordering is not silently approximated');
  assert.deepEqual(ordered(store), ['c', 'a', 'b'], 'removing the declaration keeps the rows and their saved keys');
});

test('moveRow changes one indexed row between current neighbours and retry is idempotent', async () => {
  const { store, lists } = await fresh();
  const before = store.eeaf.read('record:ordered-task:c').order;
  const moved = await lists.moveRow('tasks', { row_id: 'c', index: 'manual_order', before_id: 'b', after_id: 'a' });
  assert.equal(moved.moved, true);
  assert.deepEqual(ordered(store), ['a', 'c', 'b']);
  const current = store.eeaf.read('record:ordered-task:c').order;
  assert.notEqual(current, before);
  assert.deepEqual(await lists.moveRow('tasks', { row_id: 'c', index: 'manual_order', before_id: 'b', after_id: 'a' }), {
    list_id: 'tasks', row_id: 'c', order: current, moved: false,
  });
  assert.deepEqual(ordered(store), ['a', 'c', 'b']);
});

test('moveRow handles either end and refuses stale or malformed neighbours', async () => {
  const { store, lists } = await fresh();
  await lists.moveRow('tasks', { row_id: 'c', index: 'manual_order', before_id: 'a', after_id: null });
  assert.deepEqual(ordered(store), ['c', 'a', 'b']);
  await lists.moveRow('tasks', { row_id: 'c', index: 'manual_order', before_id: null, after_id: 'b' });
  assert.deepEqual(ordered(store), ['a', 'b', 'c']);
  await assert.rejects(async () => await lists.moveRow('tasks', { row_id: 'a', index: 'manual_order', before_id: 'c', after_id: null }), /order.*changed/i);
  await assert.rejects(async () => await lists.moveRow('tasks', { row_id: 'a', index: 'missing', before_id: 'b', after_id: null }), /cannot be moved/i);
  assert.deepEqual(ordered(store), ['a', 'b', 'c'], 'refusal leaves every row in its previous order');
});

test('POST row move uses the exact list route and retains list authorization actor', async () => {
  const { store, lists } = await fresh();
  let seenActor;
  const observed = makeLists({ eeaf: store.eeaf, transaction: store.eeaf.atomically,
    writeMutation(records, context, options) { seenActor = context.actor; return store.eeaf.write([...records, ...(options.alongside ?? [])], context); },
  });
  const response = await handleListsRequest(observed, new Request('https://person/lists/tasks/rows/move', {
    method: 'POST', headers: { 'content-type': 'application/json', 'x-trillion-app': 'calendar' },
    body: JSON.stringify({ row_id: 'c', index: 'manual_order', before_id: 'a', after_id: null }),
  }));
  assert.equal(response.status, 200);
  assert.equal((await response.json()).moved, true);
  assert.deepEqual(seenActor, { by: 'calendar', via: { app: 'calendar', basis: 'client_declared' } }, 'the actor carries the road it came by (src/write-via.mjs)');
  assert.deepEqual(ordered(store), ['c', 'a', 'b']);
});

test('list ordering fills old rows in bounded steps, pages without gaps and uses filtered anchors', async () => {
  const store = localStore(':memory:');
  try {
    const lists = makeLists({ eeaf: store.eeaf });
    const definition = { id: 'tasks', label: 'Tasks', row_type: 'ordered-task', title_field: 'name',
      fields: [{ id: 'name', label: 'Name' }, { id: 'order', label: 'Order' }],
      indexes: [{ name: 'manual_order', fields: ['order'] }] };
    await lists.save(definition);
    for (let start = 0; start < 210; start += 70) {
      await lists.putRows('tasks', { rows: Array.from({ length: 70 }, (_, offset) => {
        const id = String(start + offset).padStart(3, '0');
        return { id, values: { name: id } };
      }) });
    }
    await lists.save({ ...definition, ordering: { index: 'manual_order' } });
    assert.equal(await lists.orderingFillAt(undefined, 123), 123);
    const unready = await lists.read('tasks', { order: true, limit: 20 });
    assert.equal(unready.ordering.ready, false);
    assert.ok(unready.rows.length <= 20);
    await assert.rejects(async () => await lists.moveRow('tasks', { row_id: '209', index: 'manual_order', anchor_id: '000', placement: 'before' }), /prepared/);
    while (await lists.orderingFillAt() !== null) await lists.fillOrdering();
    assert.equal(await lists.orderingFillAt(), null);
    for (let page = 0; page < 100 && !store.eeaf.indexReady('record:ordered-task', 'manual_order'); page++) store.eeaf.backfillTables({ limit: 20 });
    const readAll = async keep => {
      const ids = []; let cursor;
      for (let page = 0; page < 30; page++) {
        const answer = await lists.read('tasks', { order: true, limit: 20, ...(keep ? { keep } : {}), ...(cursor ? { cursor } : {}) });
        assert.equal(answer.ordering.ready, true);
        ids.push(...answer.rows.map(row => row.id));
        if (answer.page.complete) return ids;
        assert.ok(answer.page.next_cursor);
        cursor = answer.page.next_cursor;
      }
      assert.fail('ordered pages never finished');
    };
    const initial = await readAll();
    assert.equal(initial.length, 210);
    assert.equal(new Set(initial).size, 210);
    assert.deepEqual(await readAll((value, id) => Number(id) % 10 === 0), initial.filter(id => Number(id) % 10 === 0));
    const anchor = initial[100], moved = initial[200];
    const request = { row_id: moved, index: 'manual_order', anchor_id: anchor, placement: 'before' };
    assert.equal((await lists.moveRow('tasks', request)).moved, true);
    const after = await readAll();
    assert.equal(after[after.indexOf(anchor) - 1], moved, 'an anchor resolves the real global neighbor even when visible rows are filtered');
    assert.equal((await lists.moveRow('tasks', request)).moved, false, 'retry preserves the exact saved rank');
    assert.deepEqual(await readAll(), after);
  } finally { store.close?.(); }
});
