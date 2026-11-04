// The booking-link tool's own logic (tools/booking-slots-and-invitations/do-work/availability-link-eeaf-store.mjs) over the
// records a tool reaches through the door: interval probes, collisions, paging, counts and rollback. The records are the
// Workshop's in-memory stand-in (tools/records-door/test-support/records-fake.mjs), not a store: what these tests prove
// is the tool's logic over the answers the door gives. Moved from old trillion test/availability-link-eeaf-store.test.mjs
// (tag old-trillion-before-worker-retire); the cases that proved the old JS record engine itself (cold reopen, strict
// model admission, erasure cascade, the EEAF backend refusing erase) are the engine's and are named with their Rust
// owners in tools/booking-slots-and-invitations/README.md, Tests.
import assert from 'node:assert/strict';
import test from 'node:test';
import { availabilityLinkEeafStore } from '../do-work/availability-link-eeaf-store.mjs';
import { identityOf } from '../../shared-code/src/typed-operation-contract.mjs';
import { createAvailabilityLinkOwner } from '../do-work/availability-link-owner.ts';
import { recordsFake } from '../../records-door/test-support/records-fake.mjs';

// The tool's declared indexes, as old trillion src/record-indexes.json declared them.
const INDEXES = [
  { type: 'availability-reservation-hold', name: 'calendar-end', where: [{ path: ['state'], not: ['released'] }], paths: [['calendar_identity'], ['occupied_end_sort_key']] },
  { type: 'availability-reservation', name: 'by-link', paths: [['link_id']] },
  { type: 'availability-reservation', name: 'link-grant-held', where: [{ path: ['state'], not: ['cancelled', 'failed'] }], paths: [['link_id'], ['grant_ref']] },
];

const identity = value => identityOf(value);
const calendar = (overrides = {}) => ({ source_id: 'google-calendar', connection_id: 'connection:a', calendar_id: 'primary', connected_at: '2026-10-01T00:00:00.000Z', ...overrides });
const cohostCalendar = (overrides = {}) => calendar({ connection_id: 'connection:cohost', calendar_id: 'team', ...overrides });
const link = (id, selectedCalendar = calendar()) => ({ id, title: id, state: 'active', revision: 1, created_at: '2026-10-14T00:00:00.000Z', updated_at: '2026-10-14T00:00:00.000Z', calendar: selectedCalendar });
const reservation = (id, linkId, selectedCalendar, start, end, extra = {}) => ({
  id: `availability-reservation:${id}`, link_id: linkId, recipient_identity: `recipient:${id}`, calendar: selectedCalendar,
  state: 'booked', start_ms: start, end_ms: end, occupied_start_ms: start, occupied_end_ms: end,
  created_at: '2026-10-14T00:00:00.000Z', updated_at: '2026-10-14T00:00:00.000Z', ...extra,
});

function fixture(t, { identityFor = identity } = {}) {
  const records = recordsFake({ indexes: INDEXES });
  const idsCalls = [];
  const observed = Object.create(records);
  observed.ids = (type, options) => { idsCalls.push({ type, options }); return records.ids(type, options); };
  const store = availabilityLinkEeafStore({ records: observed, transaction: records.transaction, identity: identityFor });
  return { records, store, idsCalls };
}

test('reservations collide across links on the exact same calendar incarnation and honor half-open interval edges', t => {
  const { store } = fixture(t);
  const selected = calendar();
  store.writeLink(link('link:a', selected));
  store.writeLink(link('link:b', selected));
  store.writeReservation(reservation('one', 'link:a', selected, 100, 200));
  store.writeReservation(reservation('two', 'link:b', selected, 300, 400));
  store.writeReservation(reservation('other-incarnation', 'link:b', calendar({ connected_at: '2026-10-02T00:00:00.000Z' }), 100, 400));
  store.writeReservation(reservation('cancelled', 'link:a', selected, 100, 400, { state: 'cancelled' }));

  assert.deepEqual(store.queryReservations({ calendar: selected, from_ms: 200, to_ms: 300, limit: 10 }), { reservations: [], complete: true },
    'touching interval edges do not overlap');
  const collision = store.queryReservations({ calendar: selected, from_ms: 150, to_ms: 350, limit: 10 });
  assert.equal(collision.complete, true);
  assert.deepEqual(collision.reservations.map(row => row.id).sort(), ['availability-reservation:one', 'availability-reservation:two']);
  assert.equal(collision.reservations.some(row => row.id.endsWith('other-incarnation')), false,
    'a different connected_at incarnation is not part of this calendar reservation invariant');
  assert.equal(collision.reservations.some(row => row.id.endsWith('cancelled')), false);
});

test('interval query includes both occupied intervals while a move is pending', t => {
  const { store } = fixture(t);
  const selected = calendar();
  store.writeLink(link('move-link', selected));
  store.writeReservation(reservation('moving', 'move-link', selected, 100, 200, {
    pending_operation_id: 'availability-operation:move', pending_start_ms: 500, pending_end_ms: 600,
    pending_occupied_start_ms: 480, pending_occupied_end_ms: 620,
  }));

  assert.deepEqual(store.queryReservations({ calendar: selected, from_ms: 150, to_ms: 160, limit: 10 }).reservations.map(row => row.id), ['availability-reservation:moving']);
  assert.deepEqual(store.queryReservations({ calendar: selected, from_ms: 610, to_ms: 615, limit: 10 }).reservations.map(row => row.id), ['availability-reservation:moving']);
  assert.deepEqual(store.queryReservations({ calendar: selected, from_ms: 300, to_ms: 400, limit: 10 }).reservations, []);
});

test('the interval index finds pending holds through every exact co-host incarnation', t => {
  const { store } = fixture(t);
  const primary = calendar(), cohost = cohostCalendar();
  store.writeReservation(reservation('cohost-pending', 'link:a', primary, 100, 200, {
    host_calendars: [primary, cohost], pending_host_calendars: [primary, cohost],
    pending_operation_id: 'availability-operation:cohost-move', pending_start_ms: 500, pending_end_ms: 600,
    pending_occupied_start_ms: 480, pending_occupied_end_ms: 620,
  }));
  const old = store.queryReservations({ calendar: cohost, calendars: [cohost], from_ms: 150, to_ms: 160, limit: 10 });
  const requested = store.queryReservations({ calendar: cohost, calendars: [cohost], from_ms: 610, to_ms: 615, limit: 10 });
  assert.deepEqual(old.reservations.map(row => row.id), ['availability-reservation:cohost-pending']);
  assert.deepEqual(requested.reservations.map(row => row.id), ['availability-reservation:cohost-pending']);
  assert.equal(requested.reservations[0].host_calendars.length, 2);
});

test('holds keep original and pending host sets independently indexed during a move', t => {
  const { store } = fixture(t);
  const primary = calendar(), oldCohost = cohostCalendar(), nextCohost = cohostCalendar({ connection_id: 'connection:next' });
  store.writeReservation(reservation('host-set-move', 'link:a', primary, 100, 200, {
    host_calendars: [primary, oldCohost], pending_host_calendars: [primary, nextCohost],
    pending_operation_id: 'availability-operation:host-set-move', pending_start_ms: 500, pending_end_ms: 600,
    pending_occupied_start_ms: 480, pending_occupied_end_ms: 620,
  }));
  const original = store.queryReservations({ calendar: oldCohost, calendars: [oldCohost], from_ms: 150, to_ms: 160, limit: 10 });
  const requested = store.queryReservations({ calendar: nextCohost, calendars: [nextCohost], from_ms: 610, to_ms: 615, limit: 10 });
  assert.deepEqual(original.reservations.map(row => row.id), ['availability-reservation:host-set-move']);
  assert.deepEqual(requested.reservations.map(row => row.id), ['availability-reservation:host-set-move']);
  assert.deepEqual(requested.reservations[0].pending_host_calendars, [primary, nextCohost]);
});

test('identity collisions are checked against the complete calendar incarnation', t => {
  const { store } = fixture(t, { identityFor: () => 'forced-collision' });
  const selected = calendar();
  const colliding = calendar({ connection_id: 'connection:b' });
  store.writeReservation(reservation('same', 'link:a', selected, 100, 200));
  store.writeReservation(reservation('collision', 'link:b', colliding, 100, 200));

  const answer = store.queryReservations({ calendar: selected, from_ms: 120, to_ms: 130, limit: 10 });
  assert.equal(answer.complete, true);
  assert.deepEqual(answer.reservations.map(row => row.id), ['availability-reservation:same']);
});

test('over-limit interval reads fail closed without returning a partial free-time set', t => {
  const { store } = fixture(t);
  const selected = calendar();
  for (let index = 0; index < 3; index += 1) store.writeReservation(reservation(`over-${index}`, `link:${index}`, selected, 100 + index * 10, 200 + index * 10));
  assert.deepEqual(store.queryReservations({ calendar: selected, from_ms: 100, to_ms: 300, limit: 2 }), { reservations: [], complete: false });
});

test('link paging uses before cursors and a change is one write', t => {
  const { store, idsCalls, records } = fixture(t);
  for (const id of ['a', 'b', 'c']) store.writeLink(link(id));
  const first = store.listLinks({ limit: 2 });
  assert.deepEqual(first.links.map(row => row.id), ['c', 'b']);
  assert.equal(first.next_cursor, 'b');
  const second = store.listLinks({ after: first.next_cursor, limit: 2 });
  assert.deepEqual(second.links.map(row => row.id), ['a']);
  assert.equal(second.next_cursor, null);
  assert.deepEqual(idsCalls.map(call => call.options.before), [undefined, 'availability-link:b']);

  const prior = records.changes();
  store.writeLink({ ...link('b'), title: 'updated' });
  assert.equal(records.changes(), prior + 1, 'a changed link is one write to the shared records (its history is the engine\'s)');
  assert.equal(store.readLink('b').title, 'updated');
});

test('one-millisecond interval boundaries remain exact at current dates', t => {
  const { store } = fixture(t);
  const start = Date.parse('2026-10-15T09:00:00Z');
  store.writeReservation(reservation('precise', 'link:a', calendar(), start, start + 1));
  assert.equal(store.queryReservations({ calendar: calendar(), from_ms: start, to_ms: start + 1, limit: 5 }).reservations.length, 1);
  assert.equal(store.queryReservations({ calendar: calendar(), from_ms: start + 1, to_ms: start + 2, limit: 5 }).reservations.length, 0);
});

test('a multi-record write that rolls back leaves no link, reservation or hold', t => {
  const { store, records } = fixture(t);
  assert.throws(() => store.transaction(() => {
    store.writeLink(link('rolled-back'));
    store.writeReservation(reservation('rolled-back', 'rolled-back', calendar(), 100, 200));
    throw new Error('commit refused');
  }), /commit refused/);
  assert.equal(store.readLink('rolled-back'), null);
  assert.equal(store.readReservation('availability-reservation:rolled-back'), null);
  assert.deepEqual(records.ids('availability-link'), []);
  assert.deepEqual(records.ids('availability-reservation-hold'), []);
});

test('two link owners serialize competing holds through their shared records', async t => {
  const { store } = fixture(t); let next = 0;
  const make = () => createAvailabilityLinkOwner({ store, transaction: store.transaction,
    current: () => {}, assertCurrentCommit: () => {}, authorizeRecipient: () => ({ identity: 'recipient:a' }), assertRecipientCommit: () => {},
    readBusy: async () => ({ status: 'read', busy: [] }),
    effects: { ensure: async () => ({ state: 'pending' }), reconcile: async () => ({ state: 'unknown' }) },
    now: () => Date.parse('2026-10-14T00:00:00Z'), opaqueId: () => `actual-${++next}`, identity });
  const a = make(), b = make();
  const shared = cohostCalendar();
  const input = { title: 'Meet', calendar: calendar(), cohosts: [{ calendar: shared }], timezone: 'UTC', windows: [{ weekday: 4, start: '09:00', end: '10:00' }], duration_min: 30, step_min: 30, horizon_days: 30, repeat: true };
  const left = await a.create(input), right = await b.create({ ...input, calendar: calendar({ connection_id: 'connection:b' }) });
  const results = await Promise.allSettled([
    a.reserve({ link_id: left.id, recipient: {}, request_key: 'left', start_ms: Date.parse('2026-10-15T09:00:00Z') }),
    b.reserve({ link_id: right.id, recipient: {}, request_key: 'right', start_ms: Date.parse('2026-10-15T09:00:00Z') }),
  ]);
  assert.equal(results.filter(result => result.status === 'fulfilled').length, 1);
  assert.equal(results.filter(result => result.status === 'rejected' && result.reason.code === 'slot-taken').length, 1);
});


test('one reservation across multiple hosts uses a distinct-reservation bound, rather than counting each host as another meeting',t=>{
 const {store}=fixture(t),primary=calendar(),cohost=cohostCalendar();
 store.writeReservation(reservation('one-with-cohost','link:a',primary,100,200,{host_calendars:[primary,cohost]}));
 const found=store.queryReservations({calendar:primary,calendars:[primary,cohost],from_ms:100,to_ms:200,limit:1});
 assert.equal(found.complete,true);assert.equal(found.reservations.length,1);
});

test('a share grant\'s held bookings on one link are counted through their declared index, never by a scan', t => {
  const { store, records } = fixture(t);
  const selected = calendar();
  store.writeLink(link('link:a', selected));
  store.writeLink(link('link:b', selected));
  const mine = { grant_ref: 'grant:purchase-1' };
  store.writeReservation(reservation('booked', 'link:a', selected, 100, 200, mine));
  store.writeReservation(reservation('pending', 'link:a', selected, 300, 400, { ...mine, state: 'pending' }));
  store.writeReservation(reservation('cancelled', 'link:a', selected, 500, 600, { ...mine, state: 'cancelled' }));
  store.writeReservation(reservation('elsewhere', 'link:b', selected, 700, 800, mine));
  store.writeReservation(reservation('another-grant', 'link:a', selected, 900, 1000, { grant_ref: 'grant:purchase-2' }));
  assert.equal(records.indexReady('availability-reservation', 'link-grant-held'), true);
  assert.equal(store.countGrantReservations({ link_id: 'link:a', grant_ref: 'grant:purchase-1', limit: 10 }), 2);
  assert.equal(store.countGrantReservations({ link_id: 'link:a', grant_ref: 'grant:purchase-1', limit: 1 }), 1, 'the count stops at its limit');
  store.writeReservation(reservation('booked', 'link:a', selected, 100, 200, { ...mine, state: 'cancelled' }));
  assert.equal(store.countGrantReservations({ link_id: 'link:a', grant_ref: 'grant:purchase-1', limit: 10 }), 1, 'a cancelled booking no longer counts');
  assert.throws(() => store.countGrantReservations({ link_id: 'link:a', grant_ref: 'grant:purchase-1', limit: 0 }), /bounded limit/);
});

test('a request holds its time in the interval index only while its link says so, and releases it when it ends', t => {
  const { store } = fixture(t);
  const selected = calendar();
  store.writeLink(link('link:a', selected));
  store.writeReservation(reservation('holds', 'link:a', selected, 100, 200, { state: 'requested', holds_slot: true }));
  store.writeReservation(reservation('open', 'link:a', selected, 100, 200, { state: 'requested', holds_slot: false }));
  store.writeReservation(reservation('silent', 'link:a', selected, 100, 200, { state: 'requested' }));
  const held = store.queryReservations({ calendar: selected, from_ms: 100, to_ms: 200, limit: 10 });
  assert.deepEqual(held.reservations.map(row => row.id), ['availability-reservation:holds'], 'only a request that holds its time is found by a time probe');
  assert.equal(store.readReservation('availability-reservation:open').state, 'requested', 'a request that holds nothing is still stored and readable');
  store.writeReservation(reservation('holds', 'link:a', selected, 100, 200, { state: 'cancelled', ended_by: 'organizer', ended_reason: 'declined' }));
  assert.deepEqual(store.queryReservations({ calendar: selected, from_ms: 100, to_ms: 200, limit: 10 }).reservations, [], 'ending the request releases its hold');
  store.writeReservation(reservation('holds', 'link:a', selected, 100, 200, { state: 'pending' }));
  assert.equal(store.queryReservations({ calendar: selected, from_ms: 100, to_ms: 200, limit: 10 }).reservations.length, 1, 'confirming (pending) holds the time again');
  assert.equal(store.reservationsOfLink({ link_id: 'link:a', limit: 10 }).rows.length, 3);
});
