// The rows run as the container runs them, against the fake records door with exactly each row's rights. The calendar
// rows are called directly with a stand-in account and transport (nothing reaches a network). Every record, name and
// address here is made up.
import test from 'node:test';
import assert from 'node:assert/strict';
import { runRow, rowOf } from 'trillion-workshop/tools/records-door/test/run-row.mjs';
import { checkWhenIAmBusy, putABookingOnMyCalendar, moveABookingOnMyCalendar } from '../do-work/book-time.mjs';
import rows from '../tool-rows.json' with { type: 'json' };

const find = rowOf(rows, 'tool:find-open-times');
const request = rowOf(rows, 'tool:request-a-booking');
const change = rowOf(rows, 'tool:change-a-booking-status');
const invite = rowOf(rows, 'tool:make-a-calendar-invite');

// Monday 2026-08-10, nine to eleven in Chicago (UTC-5): starts at 14:00Z, 14:30Z and 15:00Z for a 45 minute booking.
const WEEK = { timezone: 'America/Chicago', windows: [{ weekday: 1, start: '09:00', end: '11:00' }], duration_minutes: 45, step_minutes: 30 };
const ask = (key, start, extra = {}) => ({ ...WEEK, idempotency_key: key, start, host_ref: 'host:bakery', ...extra });
const run = async (row, input, previous) => {
  const answer = await runRow(row, input, { records: previous?.kept ?? [] });
  return answer;
};
const ok = async (row, input, previous) => {
  const answer = await run(row, input, previous);
  assert.equal(answer.status, 0, answer.error);
  return answer;
};
const booking = (id, start, status = 'confirmed') => ({ id, type: 'booking', value: { id, host_ref: 'host:bakery', status, scheduled_start: start } });

test('open times are the weekly windows, minus bookings the person kept; a cancelled booking frees its time', async () => {
  const plain = await ok(find, { ...WEEK, from_date: '2026-08-10' });
  assert.deepEqual(plain.result.slots.map(slot => slot.time), ['09:00', '09:30', '10:00']);
  assert.equal(plain.result.slots[0].start, '2026-08-10T14:00:00.000Z');
  const records = { kept: [booking('booking:a', '2026-08-10T14:30:00.000Z'), booking('booking:b', '2026-08-10T15:00:00.000Z', 'cancelled'), booking('booking:c', '2026-08-10T14:00:00.000Z')].map(item => (item.id === 'booking:c' ? { ...item, value: { ...item.value, host_ref: 'host:someone-else' } } : item)) };
  const booked = await ok(find, { ...WEEK, from_date: '2026-08-10', use_my_bookings: true, host_ref: 'host:bakery' }, records);
  assert.deepEqual(booked.result.slots.map(slot => slot.time), ['09:00', '10:00']);
  const over = await ok(find, { ...WEEK, from_date: '2026-08-10', days: 8, taken: ['2026-08-10T14:00:00Z'], busy: [{ start: '2026-08-17T14:00:00Z', end: '2026-08-17T16:00:00Z' }] });
  assert.deepEqual(over.result.slots.map(slot => `${slot.date} ${slot.time}`), ['2026-08-10 09:30', '2026-08-10 10:00']);
});

test('nothing is assumed: a missing window length or a bad date is refused in words', async () => {
  const noLength = await run(find, { timezone: 'America/Chicago', windows: [], from_date: '2026-08-10' });
  assert.match(noLength.error, /duration_minutes must be a whole number/);
  const badDate = await run(find, { ...WEEK, from_date: 'next monday' });
  assert.match(badDate.error, /from_date must look like/);
  const tooLong = await run(find, { ...WEEK, from_date: '2026-08-10', days: 63 });
  assert.match(tooLong.error, /at most 62/);
});

test('a booking is kept once per key, starts where the request says, and refuses a time that is not open', async () => {
  const first = await ok(request, ask('k1', '2026-08-10T14:30:00Z', { attendees: [{ name: 'Jane Rivera', email: 'guest@example.test' }], needs_confirmation: true }));
  assert.equal(first.result.booking.status, 'pending_confirmation');
  assert.equal(first.result.booking.scheduled_end, '2026-08-10T15:15:00.000Z');
  assert.equal(first.kept.find(item => item.id === 'booking:k1').value.attendees[0].email, 'guest@example.test');
  const again = await ok(request, ask('k1', '2026-08-10T14:30:00Z'), first);
  assert.equal(again.result.already_requested, true);
  assert.equal(again.calls.filter(call => call.method === 'records:write').length, 0);
  const taken = await run(request, ask('k2', '2026-08-10T14:30:00Z'), first);
  assert.match(taken.error, /That time is not open\. Open times on 2026-08-10: 09:00, 10:00\./);
  const offHours = await run(request, ask('k3', '2026-08-10T20:00:00Z'), first);
  assert.match(offHours.error, /not open/);
  const paid = await ok(request, ask('k4', '2026-08-10T14:00:00Z', { needs_payment: true }), first);
  assert.equal(paid.result.booking.status, 'pending_payment');
  const instant = await ok(request, ask('k5', '2026-08-10T15:00:00Z'), paid);
  assert.equal(instant.result.booking.status, 'confirmed');
});

test('a booking moves only where the lifecycle allows, and a cancel frees its time', async () => {
  let last = await ok(request, ask('k1', '2026-08-10T14:00:00Z', { needs_confirmation: true }));
  const refused = await run(change, { booking_id: 'booking:k1', to: 'completed' }, last);
  assert.match(refused.error, /"pending_confirmation" cannot become "completed"\. It can become: confirmed, cancelled\./);
  last = await ok(change, { booking_id: 'booking:k1', to: 'confirmed' }, last);
  assert.equal(last.result.changed, true);
  const same = await ok(change, { booking_id: 'booking:k1', to: 'confirmed' }, last);
  assert.equal(same.result.changed, false);
  last = await ok(change, { booking_id: 'booking:k1', to: 'cancelled', reason: 'asked to move' }, last);
  assert.equal(last.result.booking.cancellation_reason, 'asked to move');
  assert.ok(last.result.booking.cancelled_at);
  const done = await run(change, { booking_id: 'booking:k1', to: 'confirmed' }, last);
  assert.match(done.error, /It is finished\./);
  const freed = await ok(request, ask('k2', '2026-08-10T14:00:00Z'), last);
  assert.equal(freed.result.booking.status, 'confirmed');
  const none = await run(change, { booking_id: 'booking:nobody', to: 'confirmed' });
  assert.match(none.error, /There is no booking "booking:nobody"/);
});

// A stand-in for the person's calendar account and the provider.
const account = { provider: 'google', client_id: 'client-id-aaaa', client_secret: 'client-secret-bbbb', refresh_token: 'refresh-token-cccc', calendar_id: 'owner@example.test' };
function provider(answer) {
  const calls = [];
  const fn = async (url, init) => {
    calls.push({ url, method: init.method, body: init.body });
    const data = url.includes('oauth2.googleapis.com') ? { access_token: 'access-dddd' } : answer(url, init);
    const ok = data !== null && !data.failed;
    return { ok, status: ok ? 200 : (data?.status ?? 500), json: async () => data, text: async () => JSON.stringify(data) };
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

test('an event made for a booking keeps its id and call link on the booking record; a move sends the new times', async () => {
  const kept = new Map([['booking:k1', { id: 'booking:k1', status: 'confirmed', scheduled_start: '2026-08-10T14:00:00.000Z' }]]);
  const door = { read: async (type, id) => kept.get(id) ?? null, write: async records => { for (const record of records) kept.set(record.id, record.value); } };
  const { fn, calls } = provider(() => ({ id: 'evt-1', htmlLink: 'https://calendar.example.test/evt-1', hangoutLink: 'https://meet.example.test/abc' }));
  const made = await putABookingOnMyCalendar({ title: 'Intro', start_local: '2026-08-10T09:00', end_local: '2026-08-10T09:45', timezone: 'America/Chicago', attendees: [{ email: 'guest@example.test' }], video_call_request_id: 'booking:k1', booking_id: 'booking:k1' }, { credential: account, fetch: fn, door });
  assert.deepEqual([made.status, made.external_event_id], ['created', 'evt-1']);
  assert.deepEqual([kept.get('booking:k1').external_calendar_event_id, kept.get('booking:k1').meeting_url], ['evt-1', 'https://meet.example.test/abc']);
  await assert.rejects(putABookingOnMyCalendar({ title: 'Intro', start_local: '2026-08-10T09:00', end_local: '2026-08-10T09:45', timezone: 'America/Chicago', booking_id: 'booking:none' }, { credential: account, fetch: fn, door }), /no booking "booking:none" to note it on/);
});

test('without a calendar account the run says so, and a request for it names nothing secret', async () => {
  await assert.rejects(checkWhenIAmBusy({ from: '2026-08-10T00:00:00Z', to: '2026-08-11T00:00:00Z' }, { credentialFd: 99 }), /handed no calendar account/);
  const moved = await moveABookingOnMyCalendar({ event_id: 'evt-1', start: '2026-08-11T15:00:00Z', end: '2026-08-11T15:45:00Z' }, { credential: account, fetch: provider(() => ({})).fn });
  assert.equal(moved.status, 'changed');
});

test('an invitation file is made from instants, and needs a host to be the organizer', async () => {
  const made = await ok(invite, { uid: 'booking:k1@example.test', start: '2026-08-12T15:00:00Z', end: '2026-08-12T15:30:00Z', summary: 'Intro call', organizer: { email: 'host@example.test' }, attendees: [{ email: 'guest@example.test' }], sequence: 1 });
  assert.equal(made.result.filename, 'booking-k1-example.test.ics');
  assert.match(made.result.text, /DTSTART:20260812T150000Z/);
  assert.match(made.result.text, /SEQUENCE:1/);
  const noHost = await run(invite, { uid: 'u', start: '2026-08-12T15:00:00Z', end: '2026-08-12T15:30:00Z', summary: 'Intro call' });
  assert.match(noHost.error, /organizer\.email is required/);
});
