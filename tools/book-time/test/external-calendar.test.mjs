// The calendar account's wire calls, against a stand-in transport (no network). Every name and address is made up.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createExternalCalendarEvent } from '../do-work/create-external-calendar-event.ts';
import { cancelExternalCalendarEvent, moveExternalCalendarEvent, readExternalCalendarBusy } from '../do-work/external-calendar-busy-and-changes.ts';

const conn = { provider: 'google', client_id: 'cid', client_secret: 'csec', refresh_token: 'rt', calendar_id: 'owner@example.test' };
const booking = {
  title: 'Intro call with Jane Rivera',
  description: 'Booked online',
  start_local: '2026-08-12T09:00',
  end_local: '2026-08-12T09:20:00',
  timezone: 'America/Chicago',
  attendees: [{ email: 'guest@example.test', displayName: 'Jane Rivera' }],
};

// A transport that answers the token call from `token` and every other call from `other`.
function transport({ token = () => ({ access_token: 'at-123' }), other }) {
  const calls = [];
  const fn = async (url, init) => {
    calls.push({ url, method: init.method, body: init.body, headers: init.headers });
    const reply = url.includes('oauth2.googleapis.com/token')
      ? (() => { const data = token(); return { ok: data !== null, status: data === null ? 400 : 200, data }; })()
      : other(url, init);
    return { ok: reply.ok, status: reply.status, json: async () => reply.data, text: async () => JSON.stringify(reply.data) };
  };
  return { fn, calls };
}

test('create: refreshes the token, inserts a correctly shaped event, invites attendees, parses the answer', async () => {
  const { fn, calls } = transport({ other: () => ({ ok: true, status: 200, data: { id: 'evt-987', htmlLink: 'https://calendar.example.test/evt-987' } }) });
  const answer = await createExternalCalendarEvent(conn, booking, fn);
  assert.deepEqual([answer.status, answer.external_event_id, answer.html_link], ['created', 'evt-987', 'https://calendar.example.test/evt-987']);
  assert.match(calls[0].url, /oauth2\.googleapis\.com\/token/);
  assert.match(calls[1].url, /\/calendars\/owner%40example\.test\/events/);
  assert.match(calls[1].url, /sendUpdates=all/);
  assert.equal(calls[1].headers.Authorization, 'Bearer at-123');
  const sent = JSON.parse(calls[1].body);
  assert.equal(sent.summary, booking.title);
  assert.deepEqual(sent.start, { dateTime: '2026-08-12T09:00:00', timeZone: 'America/Chicago' });
  assert.deepEqual(sent.end, { dateTime: '2026-08-12T09:20:00', timeZone: 'America/Chicago' });
  assert.deepEqual(sent.attendees, [{ email: 'guest@example.test', displayName: 'Jane Rivera' }]);
});

test('create: a video call is asked for only when the booking wants one, and is an error when none was made', async () => {
  const made = transport({ other: () => ({ ok: true, status: 200, data: { id: 'evt-1', hangoutLink: 'https://meet.example.test/abc' } }) });
  const withCall = await createExternalCalendarEvent(conn, { ...booking, video_call: { request_id: 'booking_1' } }, made.fn);
  assert.deepEqual([withCall.status, withCall.video_link], ['created', 'https://meet.example.test/abc']);
  assert.match(made.calls[1].url, /conferenceDataVersion=1/);
  assert.deepEqual(JSON.parse(made.calls[1].body).conferenceData.createRequest.requestId, 'booking_1');
  const none = transport({ other: () => ({ ok: true, status: 200, data: { id: 'evt-2' } }) });
  const failed = await createExternalCalendarEvent(conn, { ...booking, video_call: { request_id: 'booking_2' } }, none.fn);
  assert.deepEqual([failed.status, failed.error, failed.external_event_id], ['error', 'video-call-not-made', 'evt-2']);
  await createExternalCalendarEvent(conn, booking, none.fn);
  assert.doesNotMatch(none.calls.at(-1).url, /conferenceDataVersion/);
  assert.equal(JSON.parse(none.calls.at(-1).body).conferenceData, undefined);
});

test('create: a token failure and an insert failure are errors, never a made-up success', async () => {
  const noToken = transport({ token: () => null, other: () => ({ ok: true, status: 200, data: { id: 'never' } }) });
  assert.deepEqual(await createExternalCalendarEvent(conn, booking, noToken.fn), { status: 'error', error: 'token-refresh-failed' });
  const refused = transport({ other: () => ({ ok: false, status: 403, data: { error: 'forbidden' } }) });
  const answer = await createExternalCalendarEvent(conn, booking, refused.fn);
  assert.equal(answer.status, 'error');
  assert.match(answer.error, /insert-403/);
});

test('an unknown provider fails closed', async () => {
  const { fn } = transport({ other: () => ({ ok: true, status: 200, data: {} }) });
  const answer = await createExternalCalendarEvent({ ...conn, provider: 'other' }, booking, fn);
  assert.match(answer.error, /unsupported-provider:other/);
  assert.match((await readExternalCalendarBusy({ ...conn, provider: 'other' }, 0, 1, fn)).error, /unsupported-provider/);
  assert.match((await cancelExternalCalendarEvent({ ...conn, provider: 'other' }, 'e', fn)).error, /unsupported-provider/);
});

test('busy: reads the calendar\'s busy blocks as intervals; a read that cannot be made is unknown, never free', async () => {
  const ok = transport({ other: () => ({ ok: true, status: 200, data: { calendars: { 'owner@example.test': { busy: [{ start: '2026-08-12T15:00:00Z', end: '2026-08-12T16:00:00Z' }] } } } }) });
  const read = await readExternalCalendarBusy(conn, Date.parse('2026-08-12T00:00:00Z'), Date.parse('2026-08-13T00:00:00Z'), ok.fn);
  assert.deepEqual(read, { status: 'read', busy: [{ startMs: Date.parse('2026-08-12T15:00:00Z'), endMs: Date.parse('2026-08-12T16:00:00Z') }] });
  assert.match(ok.calls[1].url, /freeBusy/);
  const unreadable = transport({ other: () => ({ ok: true, status: 200, data: { calendars: { x: { errors: [{ reason: 'notFound' }] } } } }) });
  assert.deepEqual(await readExternalCalendarBusy(conn, 0, 1, unreadable.fn), { status: 'unknown', busy: [], error: 'calendar-not-readable' });
  const noToken = transport({ token: () => null, other: () => ({ ok: true, status: 200, data: {} }) });
  assert.equal((await readExternalCalendarBusy(conn, 0, 1, noToken.fn)).status, 'unknown');
  const refused = transport({ other: () => ({ ok: false, status: 500, data: 'down' }) });
  assert.match((await readExternalCalendarBusy(conn, 0, 1, refused.fn)).error, /freebusy-500/);
});

test('move and cancel: patch the new times, delete the event, and an event already gone counts as cancelled', async () => {
  const moved = transport({ other: () => ({ ok: true, status: 200, data: {} }) });
  assert.deepEqual(await moveExternalCalendarEvent(conn, 'evt 1', '2026-08-13T15:00:00.000Z', '2026-08-13T15:30:00.000Z', moved.fn), { status: 'changed' });
  assert.equal(moved.calls[1].method, 'PATCH');
  assert.match(moved.calls[1].url, /\/events\/evt%201\?sendUpdates=all/);
  assert.deepEqual(JSON.parse(moved.calls[1].body), { start: { dateTime: '2026-08-13T15:00:00.000Z' }, end: { dateTime: '2026-08-13T15:30:00.000Z' } });
  const gone = transport({ other: () => ({ ok: false, status: 404, data: {} }) });
  assert.deepEqual(await cancelExternalCalendarEvent(conn, 'evt-1', gone.fn), { status: 'changed' });
  assert.equal(gone.calls[1].method, 'DELETE');
  assert.match((await moveExternalCalendarEvent(conn, 'evt-1', 'a', 'b', gone.fn)).error, /patch-404/);
  const refused = transport({ other: () => ({ ok: false, status: 403, data: {} }) });
  assert.match((await cancelExternalCalendarEvent(conn, 'evt-1', refused.fn)).error, /delete-403/);
});
