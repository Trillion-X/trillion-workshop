// The Composio calendar adapter, against a stand-in transport (no network). Every id, name and key here is made up.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createExternalCalendarEvent } from '../do-work/create-external-calendar-event.ts';
import { cancelExternalCalendarEvent, readExternalCalendarBusy } from '../do-work/external-calendar-busy-and-changes.ts';

const KEY = 'key-for-tests-only';
const conn = { provider: 'composio', toolkit: 'googlecalendar', account: 'ca_test_1', user_id: 'user-test-1', project: 'pr_test_1', api_key: KEY };
const booking = {
  title: 'Intro call',
  start_local: '2026-08-12T09:00',
  end_local: '2026-08-12T09:15',
  timezone: 'America/Chicago',
  attendees: [{ email: 'guest@example.test' }],
};

// A transport that answers each Composio execute call with `data` (the tool's data), and keeps what it was sent.
function composio(data, { ok = true, status = 200, text } = {}) {
  const calls = [];
  const fn = async (url, init) => {
    calls.push({ url, init, body: JSON.parse(init.body) });
    const body = text ?? JSON.stringify({ successful: true, data });
    return { ok, status, json: async () => JSON.parse(body), text: async () => body };
  };
  return { fn, calls };
}

test('busy: one FIND_FREE_SLOTS run for the connected account, the intervals read from the calendar', async () => {
  const transport = composio({ response_data: { calendars: { primary: { busy: [{ start: '2026-08-12T15:00:00Z', end: '2026-08-12T15:30:00Z' }] } } } });
  const answer = await readExternalCalendarBusy(conn, Date.parse('2026-08-12T14:00:00Z'), Date.parse('2026-08-12T16:00:00Z'), transport.fn);
  assert.equal(answer.status, 'read');
  assert.deepEqual(answer.busy, [{ startMs: Date.parse('2026-08-12T15:00:00Z'), endMs: Date.parse('2026-08-12T15:30:00Z') }]);
  const [call] = transport.calls;
  assert.equal(call.url, 'https://backend.composio.dev/api/v3/tools/execute/GOOGLECALENDAR_FIND_FREE_SLOTS');
  assert.equal(call.init.headers['x-api-key'], KEY);
  assert.deepEqual(call.body, { connected_account_id: 'ca_test_1', user_id: 'user-test-1', arguments: { items: ['primary'], time_min: '2026-08-12T14:00:00.000Z', time_max: '2026-08-12T16:00:00.000Z', timezone: 'UTC' } });
});

test('busy: a calendar that cannot be read is unknown, never free', async () => {
  const transport = composio({ calendars: { primary: { busy: [], errors: [{ reason: 'notFound' }] } } });
  const answer = await readExternalCalendarBusy(conn, 0, 1000, transport.fn);
  assert.equal(answer.status, 'unknown');
  assert.deepEqual(answer.busy, []);
});

test('busy: a refused run is unknown with no key in the answer', async () => {
  const transport = composio(null, { ok: false, status: 401, text: 'bad key' });
  const answer = await readExternalCalendarBusy(conn, 0, 1000, transport.fn);
  assert.equal(answer.status, 'unknown');
  assert.equal(answer.error, 'composio-GOOGLECALENDAR_FIND_FREE_SLOTS-401');
  assert.equal(JSON.stringify(answer).includes(KEY), false);
});

test('create: the event is made with the local times, the attendee and a video room; the event id and the meeting link are read', async () => {
  const transport = composio({ response_data: { id: 'evt_1', htmlLink: 'https://calendar.example/evt_1', hangoutLink: 'https://meet.example/abc' } });
  const made = await createExternalCalendarEvent(conn, { ...booking, video_call: { request_id: 'req-1' } }, transport.fn);
  assert.deepEqual(made, { status: 'created', external_event_id: 'evt_1', html_link: 'https://calendar.example/evt_1', video_link: 'https://meet.example/abc' });
  const [call] = transport.calls;
  assert.equal(call.url, 'https://backend.composio.dev/api/v3/tools/execute/GOOGLECALENDAR_CREATE_EVENT');
  assert.deepEqual(call.body.arguments, { summary: 'Intro call', start_datetime: '2026-08-12T09:00', end_datetime: '2026-08-12T09:15', timezone: 'America/Chicago', attendees: ['guest@example.test'], create_meeting_room: true, send_updates: 'all' });
});

test('create: a video call that was asked for and not made is an error, not a made event', async () => {
  const transport = composio({ id: 'evt_2', htmlLink: 'https://calendar.example/evt_2' });
  const made = await createExternalCalendarEvent(conn, { ...booking, video_call: { request_id: 'req-2' } }, transport.fn);
  assert.equal(made.status, 'error');
  assert.equal(made.error, 'video-call-not-made');
  assert.equal(made.external_event_id, 'evt_2');
});

test('a user key (uak_) goes as x-user-api-key with the project named', async () => {
  const transport = composio({ id: 'evt_3' });
  await createExternalCalendarEvent({ ...conn, api_key: 'uak_test' }, booking, transport.fn);
  assert.deepEqual({ user: transport.calls[0].init.headers['x-user-api-key'], project: transport.calls[0].init.headers['x-project-id'] }, { user: 'uak_test', project: 'pr_test_1' });
});

test('cancel: the event id goes to DELETE_EVENT; changed on success, an error with no key on refusal', async () => {
  const ok = composio({});
  assert.deepEqual(await cancelExternalCalendarEvent(conn, 'evt_1', ok.fn), { status: 'changed' });
  assert.deepEqual(ok.calls[0].body.arguments, { event_id: 'evt_1', calendar_id: 'primary', send_updates: 'all' });
  const refused = composio(null, { ok: false, status: 500, text: 'nope' });
  const answer = await cancelExternalCalendarEvent(conn, 'evt_1', refused.fn);
  assert.deepEqual(answer, { status: 'error', error: 'composio-GOOGLECALENDAR_DELETE_EVENT-500' });
});

test('a Composio account with no key is refused before any call', async () => {
  const transport = composio({});
  const answer = await cancelExternalCalendarEvent({ ...conn, api_key: undefined }, 'evt_1', transport.fn);
  assert.deepEqual(answer, { status: 'error', error: 'composio-no-key' });
  assert.equal(transport.calls.length, 0);
});

test('the tool reads a Composio account and answers its busy times without the key in the answer', async () => {
  const { checkWhenIAmBusy } = await import('../do-work/book-time.mjs');
  const transport = composio({ response_data: { calendars: { primary: { busy: [] } } } });
  const answer = await checkWhenIAmBusy({ from: '2026-08-12T14:00:00Z', to: '2026-08-12T16:00:00Z' }, { credential: conn, fetch: transport.fn });
  assert.deepEqual(answer, { status: 'read', busy: [] });
  assert.equal(JSON.stringify(answer).includes(KEY), false);
});
