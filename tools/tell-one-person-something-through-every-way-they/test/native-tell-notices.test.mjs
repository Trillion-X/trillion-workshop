import test from 'node:test';
import assert from 'node:assert/strict';
import {sqliteHost} from '../../keep-and-wake-ai-sessions-on-this-computer/src/local-store.mjs';
import {openRecords} from '../../keep-and-wake-ai-sessions-on-this-computer/src/record-engine.mjs';
import {keptList} from '../../keep-a-short-list/src/kept-list.mjs';
import {handleTellRequest, makeTellThePerson} from '../read-data/tell-the-person.mjs';
import rows from '../read-data/tell-the-person.json' with {type: 'json'};

// The native own-records resource keeps the told list in its own records (src/kept-list.mjs over the account's records),
// and GET /tell/notices reads it through the tell owner. A device asks for the notices its channel carried after the
// last one it has; a notice told once is read once by that device, and an empty answer keeps the same shape.
// 2026-10-17: GET /tell/notices (146k calls a week) had handler tests only, none over a native records store.
const now = () => new Date('2026-10-17T09:00:00.000Z');

function nativeTell(t) {
  const host = sqliteHost(':memory:');
  const records = openRecords(host.sql, {transaction: host.transaction});
  const kept = keptList(records, {id: 'told-the-person', type: 'told-the-person', indexFields: ['kind']});
  const values = new Map();
  const senders = Object.fromEntries([...new Set(rows.channels.map(row => row.sender))].map(name => [name, {
    state: () => ({ready: true}),
    send: () => ({sent: true, said: `sent by ${name}`}),
  }]));
  const tell = makeTellThePerson({rows, senders, roads: {}, presence: () => [], now,
    store: {choices: () => values.get('choices') ?? null, putChoices: value => values.set('choices', structuredClone(value)),
      notices: query => kept.items(query), putNotices: items => kept.put(items),
      delivery: key => values.get(`delivery:${key}`) ?? null, putDelivery: (key, row) => values.set(`delivery:${key}`, structuredClone(row))}});
  t.after(() => host.db.close());
  return tell;
}

const channel = rows.channels.find(row => !row.while_running).id;

test('native account: a device reads the notices its channel carried, once, and nothing it has already read', async t => {
  const tell = nativeTell(t);
  const told = await tell.tell({kind: 'needs-you-request', key: 'native-notices-1', title: 'Connect the account',
    open: 'https://app.gettrillion.ai/connections', refs: {card: 'asks:connect-account'}});
  assert.equal(told.told, true);

  const first = await handleTellRequest({tell}, new Request(`https://native/tell/notices?channel=${channel}&after=0`));
  assert.equal(first.status, 200);
  const shown = await first.json();
  assert.ok(Array.isArray(shown.notices), 'the answer is a list of notices');
  assert.equal(shown.notices.length, 1, 'the device gets the notice its channel carried');
  const seq = shown.notices[0].seq ?? shown.notices[0].id;

  const after = await handleTellRequest({tell}, new Request(`https://native/tell/notices?channel=${channel}&after=${seq}`));
  assert.deepEqual(await after.json(), {notices: []}, 'after the newest one it has, a device reads nothing');
});

test('native account: GET /tell/notices with no channel lists the page\'s notices, newest first', async t => {
  const tell = nativeTell(t);
  await tell.tell({kind: 'needs-you-request', key: 'native-notices-2', title: 'First', open: 'https://app.gettrillion.ai/connections', refs: {card: 'asks:first'}});
  await tell.tell({kind: 'needs-you-request', key: 'native-notices-3', title: 'Second', open: 'https://app.gettrillion.ai/connections', refs: {card: 'asks:second'}});
  const page = await (await handleTellRequest({tell}, new Request('https://native/tell/notices'))).json();
  assert.ok(Array.isArray(page.notices));
  assert.equal(page.notices.length, 2);
});
