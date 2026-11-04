// Seats, day limits, the horizon, overlap and the host's one answer, with the cases of the booking-link owner these rules
// came from. Rows run as the container runs them against the fake records door; the races call the exports directly
// against an in-memory door whose conditional writes behave like the records door's. Every record, name and address
// here is made up.
import test from 'node:test';
import assert from 'node:assert/strict';
import { isDeepStrictEqual } from 'node:util';
import { answerOf, rowOf } from '../../../test-helpers/run-a-row.mjs';
import { changeABookingStatus, findOpenTimes, requestABooking } from '../do-work/book-time.mjs';
import rows from '../tool-rows.json' with { type: 'json' };

const find = rowOf(rows, 'tool:find-open-times');
const request = rowOf(rows, 'tool:request-a-booking');
const change = rowOf(rows, 'tool:change-a-booking-status');

// Thursday 2036-08-14 and Friday 2036-08-15, nine to ten in Chicago (UTC-5): starts at 14:00Z and 14:30Z for 30 minutes.
const HOURS = { timezone: 'America/Chicago', windows: [{ weekday: 4, start: '09:00', end: '10:00' }, { weekday: 5, start: '09:00', end: '10:00' }], duration_minutes: 30, step_minutes: 30, host_ref: 'host:studio' };
const NINE = '2036-08-14T14:00:00Z';
const person = name => [{ name, email: `${name.toLowerCase()}@example.test` }];
const run = (row, input, previous) => answerOf(row, input, { records: previous?.kept ?? [] });
const ok = async (row, input, previous) => {
  const answer = await run(row, input, previous);
  assert.equal(answer.status, 0, answer.error);
  return answer;
};
const openOn = async (input, previous) => (await ok(find, { ...HOURS, use_my_bookings: true, from_date: '2036-08-14', ...input }, previous)).result.slots;

test('a day limit closes the rest of a day once that many bookings start on it', async () => {
  const booked = await ok(request, { ...HOURS, idempotency_key: 'day-1', start: NINE, per_day_max: 1 });
  const after = await openOn({ days: 2, per_day_max: 1 }, booked);
  assert.deepEqual(after.map(slot => slot.date), ['2036-08-15', '2036-08-15']);
  const refused = await run(request, { ...HOURS, idempotency_key: 'day-2', start: '2036-08-14T14:30:00Z', per_day_max: 1 }, booked);
  assert.match(refused.error, /not open\. Open times on 2036-08-14: none\./);
});

test('nothing past the horizon is offered or booked', async () => {
  const inside = await openOn({ horizon_days: 365 * 20 });
  assert.equal(inside.length, 2);
  assert.deepEqual(await openOn({ horizon_days: 1 }), []);
  const refused = await run(request, { ...HOURS, idempotency_key: 'far', start: NINE, horizon_days: 1 });
  assert.match(refused.error, /not open/);
});

test('a time with seats lets several people hold it, counts the seats left and refuses the one after the last', async () => {
  const seats = { seats_per_slot: 2 };
  assert.deepEqual((await openOn(seats)).map(slot => [slot.time, slot.seats_left]), [['09:00', 2], ['09:30', 2]]);
  const first = await ok(request, { ...HOURS, ...seats, idempotency_key: 'seat-a', start: NINE, attendees: person('Ada') });
  assert.deepEqual((await openOn(seats, first)).map(slot => [slot.time, slot.seats_left]), [['09:00', 1], ['09:30', 2]]);
  const twice = await run(request, { ...HOURS, ...seats, idempotency_key: 'seat-a-again', start: NINE, attendees: person('Ada') }, first);
  assert.match(twice.error, /already holds a seat at that time/);
  const second = await ok(request, { ...HOURS, ...seats, idempotency_key: 'seat-b', start: NINE, attendees: person('Bo') }, first);
  assert.deepEqual((await openOn(seats, second)).map(slot => slot.time), ['09:30'], 'a full time leaves the offer while the next time stays open');
  const third = await run(request, { ...HOURS, ...seats, idempotency_key: 'seat-c', start: NINE, attendees: person('Cy') }, second);
  assert.match(third.error, /not open/);
  assert.equal(second.kept.filter(item => item.type === 'booking').length, 2);
});

// The records door's conditional write in memory: a batch lands whole or not at all, and a record's `expected` must match.
function memoryDoor(records = []) {
  const kept = new Map(records.map(record => [record.id, record]));
  let gate = null;
  const door = {
    kept,
    holdLists: count => {
      let arrived = 0, open;
      const opened = new Promise(resolve => { open = resolve; });
      gate = async () => { arrived += 1; if (arrived === count) { open(); gate = null; } await opened; };
    },
    async read(type, id) { const found = kept.get(id); return found && found.type === type ? structuredClone(found.value) : null; },
    async readRecord(type, id) {
      const found = kept.get(id);
      const answer = found && found.type === type ? { type, value: structuredClone(found.value) } : null;
      if (gate && type === 'booking') await gate();
      return answer;
    },
    async *list({ type }) {
      const page = [...kept.values()].filter(record => record.type === type).map(record => structuredClone(record));
      if (gate) await gate();
      yield* page;
    },
    async write(items) {
      for (const item of items) {
        if (!Object.hasOwn(item, 'expected')) continue;
        const current = kept.get(item.id) ?? null;
        const matches = item.expected === null ? current === null : current !== null && current.type === item.expected.type && isDeepStrictEqual(current.value, item.expected.value);
        if (!matches) throw Object.assign(new Error('changed'), { code: 'original_command_conflict' });
      }
      for (const { expected: _expected, ...record } of items) record.value === null ? kept.delete(record.id) : kept.set(record.id, structuredClone(record));
      return { changed: items.length };
    },
  };
  return door;
}

test('a different time that overlaps a seated time stays blocked, and the last seat goes to only one of two simultaneous bookers', async () => {
  const door = memoryDoor();
  const seated = { ...HOURS, seats_per_slot: 2, step_minutes: 15 };
  await requestABooking({ ...seated, idempotency_key: 'first', start: NINE, attendees: person('Ada') }, { door });
  const open = await findOpenTimes({ ...seated, use_my_bookings: true, from_date: '2036-08-14' }, { door });
  assert.ok(!open.slots.some(slot => slot.start === '2036-08-14T14:15:00.000Z'), 'an overlapping start is not offered');
  await assert.rejects(requestABooking({ ...seated, idempotency_key: 'overlap', start: '2036-08-14T14:15:00Z' }, { door }), /not open/);
  door.holdLists(2);
  const results = await Promise.allSettled(['Bo', 'Cy'].map(name => requestABooking({ ...seated, idempotency_key: `gate-${name}`, start: NINE, attendees: person(name) }, { door })));
  assert.equal(results.filter(result => result.status === 'fulfilled').length, 1, 'one seat was left');
  assert.match(results.find(result => result.status === 'rejected').reason.message, /not open/);
  assert.equal([...door.kept.values()].filter(record => record.type === 'booking' && record.value.scheduled_start === '2036-08-14T14:00:00.000Z').length, 2);
});

test('a booking that waits for the host leaves its time open by choice, is confirmed only while the time is still free, and frees it on decline', async () => {
  const waiting = { ...HOURS, needs_confirmation: true, pending_blocks_slot: false };
  const asked = await ok(request, { ...waiting, idempotency_key: 'ask-a', start: NINE, attendees: person('Ada') });
  assert.equal(asked.result.booking.status, 'pending_confirmation');
  const retried = await ok(request, { ...waiting, idempotency_key: 'ask-a', start: NINE }, asked);
  assert.equal(retried.result.already_requested, true, 'a retried request is the same request');
  assert.equal((await openOn({ pending_blocks_slot: false }, asked)).length, 2, 'a waiting request leaves its time open to others');
  const rival = await ok(request, { ...waiting, idempotency_key: 'ask-b', start: NINE, attendees: person('Bo') }, asked);
  const confirmed = await ok(change, { booking_id: 'booking:ask-a', to: 'confirmed' }, rival);
  assert.equal(confirmed.result.booking.status, 'confirmed');
  const again = await ok(change, { booking_id: 'booking:ask-a', to: 'confirmed' }, confirmed);
  assert.equal(again.result.changed, false, 'confirming again changes nothing');
  const taken = await run(change, { booking_id: 'booking:ask-b', to: 'confirmed' }, confirmed);
  assert.match(taken.error, /taken while the booking waited/);
  const declined = await ok(change, { booking_id: 'booking:ask-b', to: 'cancelled', reason: 'declined' }, confirmed);
  assert.deepEqual([declined.result.booking.status, declined.result.booking.cancellation_reason], ['cancelled', 'declined']);
  const late = await run(change, { booking_id: 'booking:ask-b', to: 'confirmed' }, declined);
  assert.match(late.error, /It is finished\./);
});

test('a waiting booking that holds its time blocks a rival, and the person can withdraw it', async () => {
  const holding = { ...HOURS, needs_confirmation: true, pending_blocks_slot: true };
  const asked = await ok(request, { ...holding, idempotency_key: 'hold', start: NINE });
  assert.deepEqual((await openOn({}, asked)).map(slot => slot.time), ['09:30'], 'the waiting request holds 09:00');
  const rival = await run(request, { ...holding, idempotency_key: 'rival', start: NINE }, asked);
  assert.match(rival.error, /not open/);
  const withdrawn = await ok(change, { booking_id: 'booking:hold', to: 'cancelled' }, asked);
  assert.deepEqual((await openOn({}, withdrawn)).map(slot => slot.time), ['09:00', '09:30'], 'withdrawing frees the time');
});

test('a request for a time that has passed cannot be confirmed, only cancelled', async () => {
  const past = { ...HOURS, windows: [{ weekday: 1, start: '09:00', end: '10:00' }] };
  const asked = await ok(request, { ...past, idempotency_key: 'late', start: '2026-08-10T14:00:00Z', needs_confirmation: true });
  const refused = await run(change, { booking_id: 'booking:late', to: 'confirmed' }, asked);
  assert.match(refused.error, /has passed cannot be confirmed, only cancelled/);
  assert.equal((await ok(change, { booking_id: 'booking:late', to: 'cancelled' }, asked)).result.booking.status, 'cancelled');
});

test('two answers to one waiting booking at once: one lands, the other meets the booking as the first left it', async () => {
  const door = memoryDoor();
  await requestABooking({ ...HOURS, idempotency_key: 'one', start: NINE, needs_confirmation: true }, { door });
  door.holdLists(2);
  const confirms = await Promise.all([1, 2].map(() => changeABookingStatus({ booking_id: 'booking:one', to: 'confirmed' }, { door })));
  assert.deepEqual(confirms.map(answer => answer.changed).sort(), [false, true], 'both read it waiting; only one answer is kept');

  await requestABooking({ ...HOURS, idempotency_key: 'two', start: '2036-08-15T14:00:00Z', needs_confirmation: true }, { door });
  door.holdLists(2);
  const answers = await Promise.allSettled([
    changeABookingStatus({ booking_id: 'booking:two', to: 'cancelled', reason: 'declined' }, { door }),
    changeABookingStatus({ booking_id: 'booking:two', to: 'confirmed' }, { door }),
  ]);
  const final = await door.read('booking', 'booking:two');
  if (final.status === 'cancelled' && answers[1].status === 'rejected') {
    assert.match(answers[1].reason.message, /It is finished\./, 'the confirm met the declined booking');
  } else {
    assert.equal(final.status, 'cancelled', 'the confirm landed first and the decline cancelled it after');
    assert.equal(final.cancellation_reason, 'declined');
  }
});
