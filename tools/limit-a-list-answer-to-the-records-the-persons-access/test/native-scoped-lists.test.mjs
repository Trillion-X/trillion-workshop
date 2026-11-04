import test from 'node:test';
import assert from 'node:assert/strict';
import { nativeScopedListAddress, narrowNativeScopedList, readNativeScopedList } from '../src/native-scoped-lists.mjs';

test('native scoped list address matches declared paths and captures path values', () => {
  assert.equal(nativeScopedListAddress('/work/api/decisions').list.rows.length, 2);
  assert.deepEqual(nativeScopedListAddress('/work/api/spaces/pursuit%3Aone/items').params, { space_id: 'pursuit:one' });
  assert.equal(nativeScopedListAddress('/work/api/workshop/tools'), null);
});

test('native scoped list narrows every declared collection through the real owner ABI', async () => {
  const calls = [];
  const answer = { summaries: [{ case_id: 'decision:1' }, { case_id: 'decision:2' }],
    pursuits: [{ id: 'pursuit:1' }, { id: 'pursuit:2' }], before: 'next' };
  const result = await narrowNativeScopedList(answer, { pathname: '/work/api/decisions', scope: { pursuits: ['pursuit:one'] } }, async input => {
    calls.push(input);
    return { scope: { pursuits: ['pursuit:one'] }, keep: [true, false, false, true] };
  });
  assert.deepEqual(calls[0].rows, [
    { ref: 'decision:1', in_space: null }, { ref: 'decision:2', in_space: null },
    { ref: 'pursuit:1', in_space: null }, { ref: 'pursuit:2', in_space: null },
  ]);
  assert.deepEqual(result.summaries, [{ case_id: 'decision:1' }]);
  assert.deepEqual(result.pursuits, [{ id: 'pursuit:2' }]);
  assert.equal(result.before, 'next');
  assert.deepEqual(answer.summaries, [{ case_id: 'decision:1' }, { case_id: 'decision:2' }]);
});

test('native scoped list uses configured room membership and does not match absent scope', async () => {
  let calls = 0;
  const match = async input => { calls++; assert.deepEqual(input.rows, [{ ref: null, in_space: 'pursuit:one' }]); return { scope: null, keep: [false] }; };
  const filtered = await readNativeScopedList({ pathname: '/work/api/spaces/pursuit%3Aone/items', scope: { pursuits: ['pursuit:one'] },
    read: async () => ({ items: [{ item_id: 'space-item-1' }] }) }, match);
  assert.deepEqual(filtered.items, []);
  assert.equal(calls, 1);
  const unchanged = await readNativeScopedList({ pathname: '/work/api/calendar', scope: null, read: async () => ({ items: [{ ref: 'task:one' }] }) }, match);
  assert.deepEqual(unchanged.items, [{ ref: 'task:one' }]);
  assert.equal(calls, 1);
});

test('scoped list refuses an incomplete canonical row answer',async()=>{
 await assert.rejects(()=>narrowNativeScopedList({items:[{seq:1},{seq:2}]},{pathname:'/work/api/activity',scope:{pursuits:['pursuit:a']}},async()=>({keep:[true],scope:{}})),/every list row/);
});
