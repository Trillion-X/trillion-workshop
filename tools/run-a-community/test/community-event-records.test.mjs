import test from 'node:test';
import assert from 'node:assert/strict';
import { eventRowsFor, moveEventRow, cancelEventWrites, rsvpWrites, spaceEventsView } from '../read-data/community-event-records.mjs';

const community = { id: 'c1', config: { title: 'Ledger club', spaces: { events: 'members' } } };
const now = '2026-11-18T09:00:00.000Z';

test('a repeating event is one row per time, all new, sharing one series id', () => {
  const writes = eventRowsFor({ communityId: 'c1', relay: 'owner', title: 'Weekly', times: [{ starts_at: 'a', ends_at: null }, { starts_at: 'b', ends_at: null }], ids: ['e1', 'e2'], seriesId: 's1', now });
  assert.deepEqual(writes.map(write => [write.id, write.expected]), [['e1', null], ['e2', null]]);
  assert.deepEqual(writes.map(write => write.value.series_id), ['s1', 's1']);
  assert.deepEqual(writes.map(write => write.value.revision), [1, 1]);
});

test('a move with a new start and no new end keeps the length, and bumps the revision it was read at', () => {
  const event = { id: 'e1', label: 'event', title: 'Club', about: null, starts_at: '2026-11-20T10:00:00.000Z', ends_at: '2026-11-20T11:00:00.000Z', revision: 3, parent_id: 'c1' };
  const { write, starts_at, ends_at } = moveEventRow({ event, input: { starts_at: '2026-11-20T12:00:00.000Z' } });
  assert.equal(starts_at, '2026-11-20T12:00:00.000Z');
  assert.equal(ends_at, '2026-11-20T13:00:00.000Z');
  assert.deepEqual(write.expected, { revision: 3 });
  assert.equal(write.value.revision, 4);
  assert.throws(() => moveEventRow({ event, input: { ends_at: '2026-11-20T09:00:00.000Z' } }), /ends after it starts/);
});

test('cancelling removes the event and its RSVPs in one batch, and refuses before writing a batch that is too large', () => {
  const event = { id: 'e1', revision: 2 };
  const members = [{ id: 'e1:m1', revision: 1 }];
  assert.deepEqual(cancelEventWrites({ event, members, maxWrites: 10 }).map(write => [write.id, write.value]), [['e1', null], ['e1:m1', null]]);
  assert.throws(() => cancelEventWrites({ event, members, maxWrites: 1 }), /more than one batch/);
});

test('an RSVP is a member row, leaves a row marked left, bumps the event revision in the same batch, and a full event refuses a new going', () => {
  const event = { id: 'e1', revision: 5, size_limit: 1 };
  const full = [{ id: 'e1:m1', membership_id: 'e1', relay: 'm1', state: 'member', revision: 1 }];
  assert.throws(() => rsvpWrites({ event, member: null, members: full, relay: 'm2', going: true, now }), /This event is full/);
  const again = rsvpWrites({ event, member: full[0], members: full, relay: 'm1', going: true, now });
  assert.equal(again[1].value.state, 'member', 'a member already in is not refused by a full event');
  const left = rsvpWrites({ event, member: full[0], members: full, relay: 'm1', going: false, now });
  assert.equal(left[0].value.revision, 6);
  assert.equal(left[1].value.state, 'left');
  assert.deepEqual(left[1].expected, { revision: 1 });
});

test('the space read gives overlapping events in start order, to a member only, with going and move rights', () => {
  const events = [
    { id: 'late', label: 'event', parent_id: 'c1', title: 'Late', about: null, starts_at: '2026-11-25T10:00:00.000Z', ends_at: null, created_by: 'x' },
    { id: 'early', label: 'event', parent_id: 'c1', title: 'Early', about: null, starts_at: '2026-11-20T10:00:00.000Z', ends_at: '2026-11-20T11:00:00.000Z', created_by: 'owner' },
    { id: 'other', label: 'event', parent_id: 'c2', title: 'Elsewhere', about: null, starts_at: '2026-11-21T10:00:00.000Z', ends_at: null, created_by: 'owner' },
  ];
  const view = spaceEventsView({ community, events, from: '2026-11-01', to: '2026-11-26', member: true, relay: 'm1', seesMeetings: true, mayPutOn: false, goingIds: new Set(['early']) });
  assert.deepEqual(view.events.map(event => [event.event_id, event.you_are_going, event.may_move]), [['early', true, false], ['late', false, false]]);
  assert.deepEqual(spaceEventsView({ community, events, member: false, relay: null, seesMeetings: false, goingIds: new Set() }).events, []);
});
