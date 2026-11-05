// One field of many rows as it was at a moment (lists.mjs fieldAt), over records reached as the door gives them:
// tools/records-door/test-support/records-fake.mjs, which keeps each version a write saved, stands in for
// records:read { id, at } (the engine's record_at, trillion-rust src/storage/record_store/history.rs). What this proves
// is the lists' own logic over those answers: which rows are asked, how a moment is refused, how a column pages. The
// store's history itself is the engine's test (history_tests.rs).
import test from 'node:test';
import assert from 'node:assert/strict';
import { recordsFake } from '../../records-door/test-support/records-fake.mjs';
import { handleListsRequest, makeLists } from '../lists.mjs';

const fresh = () => {
  let clock = Date.parse('2026-03-02T10:00:00.000Z');
  const records = recordsFake({ now: () => (clock += 1000) });
  let n = 0;
  const lists = makeLists({ eeaf: records, newId: () => `row-${++n}` });
  const ask = async path => {
    const response = await handleListsRequest(lists, new Request(`https://person${path}`));
    return { status: response.status, body: await response.json() };
  };
  // A moment between two writes: the clock moves a second per write.
  const moment = () => new Date((clock += 500)).toISOString();
  return { records, lists, ask, moment };
};

test('one field of many rows is read as it was at a moment', async () => {
  const { lists, ask, moment } = fresh();
  await lists.save({ id: 'deals', label: 'Deals', fields: [{ id: 'name', label: 'Name' }, { id: 'stage', label: 'Stage' }] });
  await lists.putRows('deals', { rows: [{ id: 'd1', values: { name: 'One', stage: 'Lead' } }, { id: 'd2', values: { name: 'Two', stage: 'Lead' } }] });
  const at = moment();
  await lists.putRows('deals', { rows: [{ id: 'd1', values: { stage: 'Won' } }, { id: 'd3', values: { name: 'Three', stage: 'Lead' } }] });
  await lists.putRows('deals', { remove: ['d2'] });
  const then = (await ask(`/lists/deals/field-at?field_id=stage&at=${encodeURIComponent(at)}&row_ids=${encodeURIComponent(JSON.stringify(['d1', 'd2', 'd3']))}`)).body;
  assert.deepEqual(then.values.map(row => [row.row_id, row.value, row.existed, row.complete]), [['d1', 'Lead', true, true], ['d2', 'Lead', true, true], ['d3', null, false, true]]);
  assert.equal((await ask('/lists/deals/field-at?field_id=nope&at=x&row_ids=%5B%5D')).body.refused.code, 'bad_field_at');
  assert.equal((await ask(`/lists/deals/field-at?field_id=stage&at=yesterday&row_ids=${encodeURIComponent('["d1"]')}`)).body.refused.code, 'bad_field_at');
});

test('a whole column is read as it was at a moment, a page at a time, with no ids named', async () => {
  const { lists, ask, moment } = fresh();
  await lists.save({ id: 'deals', label: 'Deals', fields: [{ id: 'name', label: 'Name' }, { id: 'stage', label: 'Stage' }] });
  await lists.putRows('deals', { rows: ['d1', 'd2', 'd3', 'd4', 'd5'].map(id => ({ id, values: { name: id, stage: 'Lead' } })) });
  const at = moment();
  await lists.putRows('deals', { rows: [{ id: 'd2', values: { stage: 'Won' } }, { id: 'd6', values: { name: 'd6', stage: 'Lead' } }] });
  const seen = [];
  let cursor = null;
  do {
    const page = (await ask(`/lists/deals/field-at?field_id=stage&at=${encodeURIComponent(at)}&limit=2${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`)).body;
    assert.ok(page.values.length <= 2);
    seen.push(...page.values.map(row => [row.row_id, row.value, row.existed]));
    cursor = page.next_cursor ?? null;
  } while (cursor);
  assert.deepEqual(seen.filter(([id]) => id !== 'd6').sort().map(row => row.join()), ['d1,Lead,true', 'd2,Lead,true', 'd3,Lead,true', 'd4,Lead,true', 'd5,Lead,true'], 'each row held what it held at that moment');
  assert.deepEqual(seen.find(([id]) => id === 'd6'), ['d6', null, false], 'a row added since did not exist then');
});

test('records that keep no history refuse a read of the past in words, not a crash', async () => {
  const records = recordsFake();
  delete records.readAt;
  const lists = makeLists({ eeaf: records });
  await lists.save({ id: 'deals', label: 'Deals', fields: [{ id: 'stage', label: 'Stage' }] });
  await lists.putRows('deals', { rows: [{ id: 'd1', values: { stage: 'Lead' } }] });
  const response = await handleListsRequest(lists, new Request(`https://person/lists/deals/field-at?field_id=stage&at=${encodeURIComponent(new Date().toISOString())}&row_ids=${encodeURIComponent('["d1"]')}`));
  assert.equal((await response.json()).refused.code, 'history_unavailable');
});
