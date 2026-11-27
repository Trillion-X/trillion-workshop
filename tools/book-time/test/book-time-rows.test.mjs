// The rows run as the container runs them, handed no records door. The calendar
// rows are called directly with a stand-in account and transport (nothing reaches a network). Every record, name and
// address here is made up.
import test from 'node:test';
import assert from 'node:assert/strict';
import { changeABookingStatus, checkWhenIAmBusy, findOpenTimes, makeACalendarInvite, moveABookingOnMyCalendar, putABookingOnMyCalendar, requestABooking } from '../do-work/book-time.mjs';
import rows from '../what-this-tool-does-and-how-to-run-it.json' with { type: 'json' };

// The tools are called as the runner calls them: fn(input, { credential?, fetch? }), handed no records door.
const attempt = fn => input => { try { return { status: 0, result: fn(input) }; } catch (error) { return { status: 1, error: error.message }; } };
const find = attempt(findOpenTimes);
const request = attempt(requestABooking);
const change = attempt(changeABookingStatus);
const invite = attempt(makeACalendarInvite);

// Monday 2026-08-10, nine to eleven in Chicago (UTC-5): starts at 14:00Z, 14:30Z and 15:00Z for a 45 minute booking.
const WEEK = { timezone: 'America/Chicago', windows: [{ weekday: 1, start: '09:00', end: '11:00' }], duration_minutes: 45, step_minutes: 30 };
const ask = (key, start, extra = {}) => ({ ...WEEK, idempotency_key: key, start, host_ref: 'host:bakery', ...extra });
const run = (tool, input) => tool(input);
const ok = (tool, input) => {
  const answer = tool(input);
  assert.equal(answer.status, 0, answer.error);
  return answer;
};

test('no tool row declares a records door or asks for a records right', () => {
  for (const { payload } of rows.records) {
    assert.equal(payload.invoke.records, undefined, payload.id);
    assert.equal(payload.record_model, undefined, payload.id);
  }
  assert.doesNotMatch(JSON.stringify(rows), /records:(read|list|write)|booking-book/);
});
const booking = (id, start, status = 'confirmed') => ({ id, host_ref: 'host:bakery', status, scheduled_start: start });

test('open times are the weekly windows, minus bookings given; a cancelled booking frees its time', () => {
  const plain = ok(find, { ...WEEK, from_date: '2026-08-10' });
  assert.deepEqual(plain.result.slots.map(slot => slot.time), ['09:00', '09:30', '10:00']);
  assert.equal(plain.result.slots[0].start, '2026-08-10T14:00:00.000Z');
  const bookings = [booking('booking:a', '2026-08-10T14:30:00.000Z'), booking('booking:b', '2026-08-10T15:00:00.000Z', 'cancelled'), { ...booking('booking:c', '2026-08-10T14:00:00.000Z'), host_ref: 'host:someone-else' }];
  const booked = ok(find, { ...WEEK, from_date: '2026-08-10', bookings, host_ref: 'host:bakery' });
  assert.deepEqual(booked.result.slots.map(slot => slot.time), ['09:00', '10:00']);
  const over = ok(find, { ...WEEK, from_date: '2026-08-10', days: 8, taken: ['2026-08-10T14:00:00Z'], busy: [{ start: '2026-08-17T14:00:00Z', end: '2026-08-17T16:00:00Z' }] });
  assert.deepEqual(over.result.slots.map(slot => `${slot.date} ${slot.time}`), ['2026-08-10 09:30', '2026-08-10 10:00']);
});

test('nothing is assumed: a missing window length or a bad date is refused in words', () => {
  const noLength = run(find, { timezone: 'America/Chicago', windows: [], from_date: '2026-08-10' });
  assert.match(noLength.error, /duration_minutes must be a whole number/);
  const badDate = run(find, { ...WEEK, from_date: 'next monday' });
  assert.match(badDate.error, /from_date must look like/);
  const tooLong = run(find, { ...WEEK, from_date: '2026-08-10', days: 63 });
  assert.match(tooLong.error, /at most 62/);
});

test('a booking is answered once per key, starts where the request says, refuses a time that is not open, and keeps nothing', () => {
  const first = ok(request, ask('k1', '2026-08-10T14:00:00Z', { attendees: [{ name: 'Jane Rivera', email: 'guest@example.test' }], needs_confirmation: true }));
  assert.equal(first.result.booking.status, 'pending_confirmation');
  assert.equal(first.result.booking.scheduled_end, '2026-08-10T14:45:00.000Z');
  assert.equal(first.result.booking.attendees[0].email, 'guest@example.test');
  const bookings = [first.result.booking];
  const again = ok(request, ask('k1', '2026-08-10T14:00:00Z', { bookings }));
  assert.equal(again.result.already_requested, true);
  // The booking at 09:00 to 09:45 holds its own start and every start it overlaps: 09:30 is gone, 10:00 is open.
  const taken = run(request, ask('k2', '2026-08-10T14:00:00Z', { bookings }));
  assert.match(taken.error, /That time is not open\. Open times on 2026-08-10: 10:00\./);
  const overlapping = run(request, ask('k2', '2026-08-10T14:30:00Z', { bookings }));
  assert.match(overlapping.error, /not open/);
  const offHours = run(request, ask('k3', '2026-08-10T20:00:00Z', { bookings }));
  assert.match(offHours.error, /not open/);
  const paid = ok(request, ask('k4', '2026-08-10T15:00:00Z', { needs_payment: true, bookings }));
  assert.equal(paid.result.booking.status, 'pending_payment');
  const instant = ok(request, ask('k5', '2026-08-17T14:00:00Z', { bookings: [...bookings, paid.result.booking] }));
  assert.equal(instant.result.booking.status, 'confirmed');
});

test('a booking moves only where the lifecycle allows, and the answer holds the moved record; a cancel frees its time', () => {
  // A Monday far ahead, so a waiting booking's time has not passed when it is confirmed.
  const asked = ok(request, ask('k1', '2036-08-11T14:00:00Z', { needs_confirmation: true }));
  let record = asked.result.booking;
  const refused = run(change, { booking: record, to: 'completed' });
  assert.match(refused.error, /"pending_confirmation" cannot become "completed"\. It can become: confirmed, cancelled\./);
  const confirmed = ok(change, { booking: record, to: 'confirmed' });
  assert.equal(confirmed.result.changed, true);
  assert.equal(confirmed.result.booking.status, 'confirmed');
  record = confirmed.result.booking;
  const same = ok(change, { booking: record, to: 'confirmed' });
  assert.equal(same.result.changed, false);
  const cancelled = ok(change, { booking: record, to: 'cancelled', reason: 'asked to move' });
  assert.equal(cancelled.result.booking.cancellation_reason, 'asked to move');
  assert.ok(cancelled.result.booking.cancelled_at);
  const done = run(change, { booking: cancelled.result.booking, to: 'confirmed' });
  assert.match(done.error, /It is finished\./);
  const freed = ok(request, ask('k2', '2036-08-11T14:00:00Z', { bookings: [cancelled.result.booking] }));
  assert.equal(freed.result.booking.status, 'confirmed');
});

// A stand-in for the person's calendar account and the provider.
const account = { provider: 'google', client_id: 'client-id-aaaa', client_secret: 'client-secret-bbbb', refresh_token: 'refresh-token-cccc', calendar_id: 'owner@example.test' };
function provider(answer) {
  const calls = [];
  const fn = async (url, init) => {
    calls.push({ url, method: init.method, body: init.body });
    const data = url.includes('oauth2.googleapis.com') ? { access_token: 'access-dddd' } : answer(url, init);
    const ok = data !== null && !data.failed;
    return { ok, status: ok ? 200 : (data?.status ?? 500), json: () => data, text: () => JSON.stringify(data) };
  };
  return { fn, calls };
}

test('the calendar account reaches the provider and never an answer: provider text is scrubbed of it', async () => {
  const { fn } = provider(() => ({ calendars: { x: { busy: [{ start: '2026-08-10T15:00:00Z', end: '2026-08-10T16:00:00Z' }] } } }));
  const read = await checkWhenIAmBusy({ from: '2026-08-10T00:00:00Z', to: '2026-08-11T00:00:00Z' }, { credential: account, fetch: fn });
  assert.deepEqual(read, { status: 'read', busy: [{ start: '2026-08-10T15:00:00.000Z', end: '2026-08-10T16:00:00.000Z' }] });
  const leaky = provider(() => ({ failed: true, status: 403, echo: 'rejected client-secret-bbbb and refresh-token-cccc' }));
  const refused = await putABookingOnMyCalendar({ title: 'Intro', start_local: '2026-08-10T09:00', end_local: '2026-08-10T09:45', timezone: 'America/Chicago' }, { credential: account, fetch: leaky.fn });
  assert.equal(refused.status, 'error');
  assert.match(refused.error, /insert-403/);
  assert.doesNotMatch(JSON.stringify(refused), /client-secret-bbbb|refresh-token-cccc|client-id-aaaa/);
  assert.match(refused.error, /\[hidden\]/);
});

test('an event made for a booking answers its id and call link and keeps nothing; a move sends the new times', async () => {
  const { fn } = provider(() => ({ id: 'evt-1', htmlLink: 'https://calendar.example.test/evt-1', hangoutLink: 'https://meet.example.test/abc' }));
  const made = await putABookingOnMyCalendar({ title: 'Intro', start_local: '2026-08-10T09:00', end_local: '2026-08-10T09:45', timezone: 'America/Chicago', attendees: [{ email: 'guest@example.test' }], video_call_request_id: 'booking:k1' }, { credential: account, fetch: fn });
  assert.deepEqual([made.status, made.external_event_id, made.video_link], ['created', 'evt-1', 'https://meet.example.test/abc']);
});

test('without a calendar account the run says so, and a request for it names nothing secret', async () => {
  await assert.rejects(checkWhenIAmBusy({ from: '2026-08-10T00:00:00Z', to: '2026-08-11T00:00:00Z' }, { credentialFd: 99 }), /handed no calendar account/);
  const moved = await moveABookingOnMyCalendar({ event_id: 'evt-1', start: '2026-08-11T15:00:00Z', end: '2026-08-11T15:45:00Z' }, { credential: account, fetch: provider(() => ({})).fn });
  assert.equal(moved.status, 'changed');
});

test('an invitation file is made from instants, and needs a host to be the organizer', () => {
  const made = ok(invite, { uid: 'booking:k1@example.test', start: '2026-08-12T15:00:00Z', end: '2026-08-12T15:30:00Z', summary: 'Intro call', organizer: { email: 'host@example.test' }, attendees: [{ email: 'guest@example.test' }], sequence: 1 });
  assert.equal(made.result.filename, 'booking-k1-example.test.ics');
  assert.match(made.result.text, /DTSTART:20260812T150000Z/);
  assert.match(made.result.text, /SEQUENCE:1/);
  const noHost = run(invite, { uid: 'u', start: '2026-08-12T15:00:00Z', end: '2026-08-12T15:30:00Z', summary: 'Intro call' });
  assert.match(noHost.error, /organizer\.email is required/);
});
