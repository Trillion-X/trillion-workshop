// A tool input left out by the caller is filled with the account's own records (src/workshop.mjs yourRecords over
// src/your-records.mjs). An account may keep any number of records; one tool input is handed at most a bounded count,
// and above it the run is refused with the step that works (send the records it means), never a silently cut list.
import test from 'node:test';
import assert from 'node:assert/strict';
import { yourRecords } from '../src/workshop.mjs';
import { localStore } from '../src/local-store.mjs';
import { yourRecordsStore } from '../src/your-records.mjs';

const schema = { type: 'object', properties: { customers: { type: 'array', 'x-your-records': ['customer'] } } };

function keep(records, count) {
  for (let start = 0; start < count; start += 200) {
    records.write(Array.from({ length: Math.min(200, count - start) }, (_, index) => ({ type: 'customer', id: `c${start + index}`, value: { n: start + index } })));
  }
}

test('a tool input is filled with every record of its type up to the bound', async () => {
  const records = yourRecordsStore(localStore(':memory:').eeaf);
  keep(records, 1000);
  const filled = await yourRecords({}, schema, records);
  assert.equal(filled.customers.length, 1000);
});

test('above the bound the run is refused before any record is read, naming the step that works', async () => {
  const { eeaf } = localStore(':memory:');
  const records = yourRecordsStore(eeaf);
  keep(records, 1500);
  let reads = 0;
  let listed = 0;
  const counted = { ...eeaf, ids: (...args) => { const ids = eeaf.ids(...args); listed += ids.length; return ids; }, read: id => { reads += 1; return eeaf.read(id); } };
  await assert.rejects(() => yourRecords({}, schema, yourRecordsStore(counted)), /more than 1000 customer records.*Send customers yourself/);
  assert.equal(reads, 0, 'no record was read');
  assert.equal(listed, 1001, 'no more ids were listed than one past the bound');
  const sent = await yourRecords({ customers: [{ n: 1 }] }, schema, records);
  assert.deepEqual(sent.customers, [{ n: 1 }], 'a caller who sends the field is never refused');
});
