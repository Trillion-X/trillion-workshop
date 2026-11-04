import test from 'node:test';
import assert from 'node:assert/strict';
import { findSpaceTimes, memberCalendar } from '../src/space-calendars.mjs';

const input = { space_id: 'space', from: '2036-10-06T13:00:00Z', to: '2036-10-06T17:00:00Z', time_zone: 'UTC' };
const members = [{ name: 'Recipient', you: true, person_ref: 'self' }, { name: 'Asker', person_ref: 'asker' }];
const search = askToConnect => findSpaceTimes(input, { members: [members[0]], askBusy: async () => ({ shares: true, connected: false }), askToConnect,
  spaceTitle: 'Space', now: () => Date.parse('2036-10-01T00:00:00Z') });

test('availability reads await and expose only the known connection-request record result', async () => {
  let resolve, ended = false;
  const saved = new Promise(done => { resolve = done; });
  const running = search(() => saved).then(value => { ended = true; return value; });
  await new Promise(done => setImmediate(done));
  assert.equal(ended, false);
  resolve({ request_recorded: true, delivery: { state: 'pending', delivery_accepted: false, awareness: 'unknown' } });
  const result = await running;
  assert.equal(result.members[0].connection_request.request_recorded, true);
  assert.equal(result.members[0].connection_request.delivery.delivery_accepted, false);
  assert.doesNotMatch(result.members[0].said, /asked them|put a step/);
  assert.match(result.members[0].said, /ordinary invitations/);
});

test('failed request creation is returned instead of being swallowed behind claimed outreach', async () => {
  const result = await search(async () => { throw new Error('Space write refused'); });
  assert.deepEqual(result.members[0].connection_request, { request_recorded: false, state: 'failed', error: 'Space write refused' });
  assert.equal(result.everyone_known, false);
  assert.equal(result.members[0].read, false);
});

test('concurrent connection requests create one task and do not equate that record with an asked person', async () => {
  const kept = new Map(), given = []; let writes = 0;
  const calendar = memberCalendar({
    records: { read: key => kept.get(key), write: rows => { for (const row of rows) kept.set(row.id, row.value); } },
    run: async () => ({ connected: false }), membersAsMe: async () => members, connected: async () => [], openGiven: async () => given,
    give: async (_space, item) => { writes += 1; given.push({ ...item, item_id: 'task' }); return 'task'; },
  });
  const request = { space_id: 'space', space_title: 'Space', asker_ref: 'asker' };
  const [a, b] = await Promise.all([calendar.askToConnect(request), calendar.askToConnect(request)]);
  assert.equal(writes, 1);
  assert.deepEqual([a.request_created, b.request_created], [true, false]);
  assert.deepEqual([a.asked, b.asked], [false, false]);
  assert.equal(a.delivery.awareness, 'unknown');
  given[0].delivery = { state: 'accepted', delivery_accepted: true, awareness: 'unknown' };
  const accepted = await calendar.askToConnect(request);
  assert.equal(accepted.asked, true);
  assert.equal(accepted.delivery.awareness, 'unknown');
});
