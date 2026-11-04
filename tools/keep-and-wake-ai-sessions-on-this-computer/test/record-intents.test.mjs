// test/record-intents.test.mjs
// One store asks another for a change: the intent is kept with the asking change, applied exactly once in the order
// asked, refused by the receiver's own rule, and answered from the receipt when delivered again.
import test from 'node:test';
import assert from 'node:assert/strict';
import { sqliteHost } from '../src/local-store.mjs';
import { recordLogStore } from '../parts/record-log/do-work/record-log-store.mjs';
import { intentRecords, receiveIntent, deliverIntents, waitingIntents } from '../../record-log/do-work/record-intents.mjs';

const opened = () => { const host = sqliteHost(':memory:'); return recordLogStore(host.sql, { transaction: host.transaction }); };
const ask = (store, k, target = 'space') => store.write([
  { id: `note:${k}`, type: 'note', value: { k } },
  ...intentRecords(store, { source: 'person', target, request_id: `r${k}`, records: [{ id: `shared:${k}`, type: 'note', value: { k } }] }),
]);

test('an intent kept with its change is applied once, and its result replaces it', async () => {
  const person = opened();
  const space = opened();
  ask(person, 1);
  assert.equal(waitingIntents(person).length, 1);
  const report = await deliverIntents(person, (target, intent) => receiveIntent(space, intent));
  assert.equal(report.delivered, 1);
  assert.equal(space.read('shared:1').k, 1);
  assert.equal(waitingIntents(person).length, 0);
  assert.equal(person.read('intent-result:r1').result, 'applied');
});

test('the same intent delivered again is answered from its receipt and writes nothing', () => {
  const person = opened();
  const space = opened();
  ask(person, 1);
  const [intent] = waitingIntents(person);
  receiveIntent(space, intent);
  const rows = space.logAfter(null, { limit: 100 }).rows.length;
  space.write([{ id: 'shared:1', type: 'note', value: { k: 'changed since' } }]);
  const again = receiveIntent(space, intent);
  assert.equal(again.result, 'applied');
  assert.equal(space.read('shared:1').k, 'changed since', 'a repeat never applies the records again');
  assert.equal(space.logAfter(null, { limit: 100 }).rows.length, rows + 1);
});

test('intents arriving out of order are taken in the order they were asked', async () => {
  const person = opened();
  const space = opened();
  ask(person, 1);
  ask(person, 2);
  const [first, second] = waitingIntents(person);
  assert.equal(receiveIntent(space, second).result, 'later');
  assert.equal(space.read('shared:2'), null);
  assert.equal(receiveIntent(space, first).result, 'applied');
  assert.equal(receiveIntent(space, second).result, 'applied');
  await deliverIntents(person, (target, intent) => receiveIntent(space, intent));
  assert.equal(waitingIntents(person).length, 0);
});

test('a receiver refuses what its own rule does not allow, and the refusal is kept and final', async () => {
  const person = opened();
  const space = opened();
  ask(person, 1);
  const allows = records => (records.every(record => record.type === 'message') ? true : 'This space takes only messages.');
  await deliverIntents(person, (target, intent) => receiveIntent(space, intent, { allows }));
  assert.equal(space.read('shared:1'), null);
  assert.deepEqual(person.read('intent-result:r1').reason, 'This space takes only messages.');
  assert.equal(person.read('intent-result:r1').result, 'refused');
});

test('a delivery that fails leaves the intent waiting, and the next round delivers it', async () => {
  const person = opened();
  const space = opened();
  ask(person, 1);
  const down = await deliverIntents(person, async () => { throw new Error('unreachable'); });
  assert.deepEqual([down.delivered, down.failed_deliveries, down.waiting], [0, 1, 1]);
  assert.equal(waitingIntents(person).length, 1);
  await deliverIntents(person, (target, intent) => receiveIntent(space, intent));
  assert.equal(space.read('shared:1').k, 1);
});

test('an asking change that rolls back leaves no intent', () => {
  const host = sqliteHost(':memory:');
  const person = recordLogStore(host.sql, { transaction: host.transaction });
  assert.throws(() => host.transaction(() => { ask(person, 1); throw new Error('roll back'); }), /roll back/);
  person.forgetCached();
  assert.equal(waitingIntents(person).length, 0);
  assert.equal(person.read('note:1'), null);
});
