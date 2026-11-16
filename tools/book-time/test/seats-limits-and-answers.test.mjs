// Seats, day limits, the horizon, overlap and the host's one answer, with the cases of the booking-link owner these rules
// came from. The tools keep nothing: each answer is a booking record and the next call is handed the bookings so far, as
// the person's AI hands them. Every record, name and address here is made up.
import test from 'node:test';
import assert from 'node:assert/strict';
import { changeABookingStatus, findOpenTimes, requestABooking } from '../do-work/book-time.mjs';

// Thursday 2036-08-14 and Friday 2036-08-15, nine to ten in Chicago (UTC-5): starts at 14:00Z and 14:30Z for 30 minutes.
const HOURS = { timezone: 'America/Chicago', windows: [{ weekday: 4, start: '09:00', end: '10:00' }, { weekday: 5, start: '09:00', end: '10:00' }], duration_minutes: 30, step_minutes: 30, host_ref: 'host:studio' };
const NINE = '2036-08-14T14:00:00Z';
const person = name => [{ name, email: `${name.toLowerCase()}@example.test` }];
const openOn = (bookings, input = {}) => findOpenTimes({ ...HOURS, bookings, from_date: '2036-08-14', ...input }).slots;
const withBooking = (bookings, answer) => [...bookings.filter(item => item.id !== answer.booking.id), answer.booking];

test('a day limit closes the rest of a day once that many bookings start on it', () => {
  const booked = [requestABooking({ ...HOURS, idempotency_key: 'day-1', start: NINE, per_day_max: 1 }).booking];
  assert.deepEqual(openOn(booked, { days: 2, per_day_max: 1 }).map(slot => slot.date), ['2036-08-15', '2036-08-15']);
  assert.throws(() => requestABooking({ ...HOURS, bookings: booked, idempotency_key: 'day-2', start: '2036-08-14T14:30:00Z', per_day_max: 1 }), /not open\. Open times on 2036-08-14: none\./);
});

test('nothing past the horizon is offered or booked', () => {
  assert.equal(openOn([], { horizon_days: 365 * 20 }).length, 2);
  assert.deepEqual(openOn([], { horizon_days: 1 }), []);
  assert.throws(() => requestABooking({ ...HOURS, idempotency_key: 'far', start: NINE, horizon_days: 1 }), /not open/);
});

test('a time with seats lets several people hold it, counts the seats left and refuses the one after the last', () => {
  const seats = { seats_per_slot: 2 };
  assert.deepEqual(openOn([], seats).map(slot => [slot.time, slot.seats_left]), [['09:00', 2], ['09:30', 2]]);
  let held = withBooking([], requestABooking({ ...HOURS, ...seats, idempotency_key: 'seat-a', start: NINE, attendees: person('Ada') }));
  assert.deepEqual(openOn(held, seats).map(slot => [slot.time, slot.seats_left]), [['09:00', 1], ['09:30', 2]]);
  assert.throws(() => requestABooking({ ...HOURS, ...seats, bookings: held, idempotency_key: 'seat-a-again', start: NINE, attendees: person('Ada') }), /already holds a seat at that time/);
  held = withBooking(held, requestABooking({ ...HOURS, ...seats, bookings: held, idempotency_key: 'seat-b', start: NINE, attendees: person('Bo') }));
  assert.deepEqual(openOn(held, seats).map(slot => slot.time), ['09:30'], 'a full time leaves the offer while the next time stays open');
  assert.throws(() => requestABooking({ ...HOURS, ...seats, bookings: held, idempotency_key: 'seat-c', start: NINE, attendees: person('Cy') }), /not open/);
  assert.equal(held.length, 2);
});

test('a different time that overlaps a seated time stays blocked', () => {
  const seated = { ...HOURS, seats_per_slot: 2, step_minutes: 15 };
  const held = [requestABooking({ ...seated, idempotency_key: 'first', start: NINE, attendees: person('Ada') }).booking];
  const open = findOpenTimes({ ...seated, bookings: held, from_date: '2036-08-14' });
  assert.ok(!open.slots.some(slot => slot.start === '2036-08-14T14:15:00.000Z'), 'an overlapping start is not offered');
  assert.throws(() => requestABooking({ ...seated, bookings: held, idempotency_key: 'overlap', start: '2036-08-14T14:15:00Z' }), /not open/);
});

test('a booking that waits for the host leaves its time open by choice, is confirmed only while the time is still free, and frees it on decline', () => {
  const waiting = { ...HOURS, needs_confirmation: true, pending_blocks_slot: false };
  const asked = requestABooking({ ...waiting, idempotency_key: 'ask-a', start: NINE, attendees: person('Ada') });
  assert.equal(asked.booking.status, 'pending_confirmation');
  let held = withBooking([], asked);
  assert.equal(requestABooking({ ...waiting, bookings: held, idempotency_key: 'ask-a', start: NINE }).already_requested, true, 'a retried request is the same request');
  assert.equal(openOn(held, { pending_blocks_slot: false }).length, 2, 'a waiting request leaves its time open to others');
  held = withBooking(held, requestABooking({ ...waiting, bookings: held, idempotency_key: 'ask-b', start: NINE, attendees: person('Bo') }));
  const [a, b] = held;
  const confirmed = changeABookingStatus({ booking: a, to: 'confirmed', bookings: held });
  assert.equal(confirmed.booking.status, 'confirmed');
  assert.equal(changeABookingStatus({ booking: confirmed.booking, to: 'confirmed' }).changed, false, 'confirming again changes nothing');
  assert.throws(() => changeABookingStatus({ booking: b, to: 'confirmed', bookings: [confirmed.booking, b] }), /taken while the booking waited/);
  const declined = changeABookingStatus({ booking: b, to: 'cancelled', reason: 'declined' });
  assert.deepEqual([declined.booking.status, declined.booking.cancellation_reason], ['cancelled', 'declined']);
  assert.throws(() => changeABookingStatus({ booking: declined.booking, to: 'confirmed' }), /It is finished\./);
});

test('a waiting booking that holds its time blocks a rival, and the person can withdraw it', () => {
  const holding = { ...HOURS, needs_confirmation: true, pending_blocks_slot: true };
  const asked = requestABooking({ ...holding, idempotency_key: 'hold', start: NINE });
  const held = [asked.booking];
  assert.deepEqual(openOn(held).map(slot => slot.time), ['09:30'], 'the waiting request holds 09:00');
  assert.throws(() => requestABooking({ ...holding, bookings: held, idempotency_key: 'rival', start: NINE }), /not open/);
  const withdrawn = changeABookingStatus({ booking: asked.booking, to: 'cancelled' });
  assert.deepEqual(openOn([withdrawn.booking]).map(slot => slot.time), ['09:00', '09:30'], 'withdrawing frees the time');
});

test('a request for a time that has passed cannot be confirmed, only cancelled', () => {
  const past = { ...HOURS, windows: [{ weekday: 1, start: '09:00', end: '10:00' }] };
  const asked = requestABooking({ ...past, idempotency_key: 'late', start: '2026-08-10T14:00:00Z', needs_confirmation: true });
  assert.throws(() => changeABookingStatus({ booking: asked.booking, to: 'confirmed' }), /has passed cannot be confirmed, only cancelled/);
  assert.equal(changeABookingStatus({ booking: asked.booking, to: 'cancelled' }).booking.status, 'cancelled');
});

test('a booking to move is required', () => {
  assert.throws(() => changeABookingStatus({ to: 'confirmed' }), /booking is required/);
});
