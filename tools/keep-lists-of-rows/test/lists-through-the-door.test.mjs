// The person's lists (lists.mjs makeLists, unchanged) with every read and write through the records door
// (lists-over-the-records-door.mjs listsThroughTheDoor), over a record book a test holds
// (test-support/door-over-a-record-book.mjs, the real door client underneath). Every record here is made up.
import test from 'node:test';
import assert from 'node:assert/strict';
import { recordsFake } from '../../records-door/test-support/records-fake.mjs';
import { listsThroughTheDoor, overTheRecordsDoor, kindOfId, listRecordKinds } from '../lists-over-the-records-door.mjs';
import { doorOverARecordBook } from '../test-support/door-over-a-record-book.mjs';
import { handleListsRequest } from '../lists.mjs';

const fresh = () => {
  const book = recordsFake();
  const { door, calls } = doorOverARecordBook(book);
  let n = 0;
  return { book, door, calls, lists: listsThroughTheDoor(door, { newId: () => `row-${++n}` }) };
};

test('a list saved and rows put through the door are kept as the person\'s records and read back', async () => {
  const { book, lists, calls } = fresh();
  await lists.save({ id: 'ferns', label: 'Ferns', fields: [{ id: 'name', label: 'Name' }, { id: 'water', label: 'Water every', kind: 'number' }] });
  assert.equal(book.read('list:ferns').label, 'Ferns');
  const put = await lists.putRows('ferns', { rows: [{ values: { name: 'Maidenhair', water: 3 } }, { id: 'boston', values: { name: 'Boston', water: 5 } }] });
  assert.deepEqual(put.kept.map(row => row.id), ['row-1', 'boston'], 'a new row takes the id the caller mints, once, whatever the passes');
  assert.deepEqual(book.read('record:ferns:boston'), { name: 'Boston', water: 5 });
  assert.equal((await lists.row('ferns', 'boston')).values.water, 5);
  assert.deepEqual((await lists.read('ferns')).rows.map(row => row.id).sort(), ['boston', 'row-1']);
  assert.ok(calls.includes('records:write') && calls.includes('records:read'), 'everything went through the door');
});

test('a write is conditional on what its call read: a record changed in between refuses the whole write', async () => {
  const { book, door } = fresh();
  const lists = listsThroughTheDoor(door);
  await lists.save({ id: 'ferns', label: 'Ferns', fields: [{ id: 'name', label: 'Name' }] });
  await lists.putRows('ferns', { rows: [{ id: 'a', values: { name: 'One' } }] });
  // Someone else changes the row after this call has read it and before it writes.
  let once = true;
  const racing = doorOverARecordBook(book).door;
  const sneaky = { ...racing, async write(records, options) {
    if (once) { once = false; book.write([{ id: 'record:ferns:a', type: 'record:ferns', value: { name: 'Changed elsewhere' } }]); }
    return racing.write(records, options);
  } };
  await assert.rejects(() => listsThroughTheDoor(sneaky).putRows('ferns', { rows: [{ id: 'a', values: { name: 'Mine' } }] }), error => error.code === 'original_command_conflict');
  assert.deepEqual(book.read('record:ferns:a'), { name: 'Changed elsewhere' }, 'nothing of the refused write was kept');
});

test('the lists\' own HTTP answers run unchanged over the door', async () => {
  const { lists } = fresh();
  const ask = async (path, body) => {
    const response = await handleListsRequest(lists, new Request(`https://person${path}`, body ? { method: 'POST', body: JSON.stringify(body) } : {}));
    return { status: response.status, body: await response.json() };
  };
  assert.equal((await ask('/lists', { id: 'ferns', label: 'Ferns', fields: [{ id: 'name', label: 'Name' }] })).status, 200);
  assert.equal((await ask('/lists/ferns/rows', { rows: [{ id: 'a', values: { name: 'One' } }] })).status, 200);
  const read = await ask('/lists/ferns');
  assert.deepEqual(read.body.rows.map(row => [row.id, row.values.name]), [['a', 'One']]);
  assert.equal((await ask('/lists/nobody')).body.refused.code, 'no_list', 'a refusal keeps the lists\' own words');
});

test('a kind asked of a record not read yet is a read of it: the next pass reads it and the work sees it', async () => {
  const book = recordsFake({ records: [{ id: 'record:ferns:a', type: 'record:ferns', value: { name: 'One' } }] });
  const { door } = doorOverARecordBook(book);
  const { result } = await overTheRecordsDoor(door, eeaf => eeaf.typeOf('record:ferns:a'), { typeOf: kindOfId(listRecordKinds()) });
  assert.equal(result, 'record:ferns');
});

test('each record kind the lists keep is named from its id', () => {
  const typeOf = kindOfId(listRecordKinds());
  assert.equal(typeOf('list:ferns'), 'list');
  assert.equal(typeOf('record:ferns:a'), 'record:ferns');
  assert.equal(typeOf('list-view:ferns:by-name'), 'list-view');
  assert.equal(typeOf('list-key:ferns:name:one'), 'list-key');
});

test('one field of many rows is read as it was at a moment through the door\'s records:read with `at`', async () => {
  let clock = Date.parse('2026-03-02T10:00:00.000Z');
  const book = recordsFake({ now: () => (clock += 1000) });
  const { door, calls } = doorOverARecordBook(book);
  const lists = listsThroughTheDoor(door);
  await lists.save({ id: 'deals', label: 'Deals', fields: [{ id: 'name', label: 'Name' }, { id: 'stage', label: 'Stage' }] });
  await lists.putRows('deals', { rows: [{ id: 'd1', values: { name: 'One', stage: 'Lead' } }, { id: 'd2', values: { name: 'Two', stage: 'Lead' } }] });
  const at = new Date((clock += 500)).toISOString();
  await lists.putRows('deals', { rows: [{ id: 'd1', values: { stage: 'Won' } }, { id: 'd3', values: { name: 'Three', stage: 'Lead' } }] });
  const then = await lists.fieldAt('deals', { field_id: 'stage', at, row_ids: ['d1', 'd2', 'd3'] });
  assert.deepEqual(then.values.map(row => [row.row_id, row.value, row.existed, row.complete]), [['d1', 'Lead', true, true], ['d2', 'Lead', true, true], ['d3', null, false, true]]);
  assert.equal((await lists.row('deals', 'd1')).values.stage, 'Won', 'the present is unchanged');
  assert.ok(calls.filter(call => call === 'records:read').length > 0);
});
