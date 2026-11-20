// Reading a calendar on any provider: the row's variants come from the provider rows, each adapter asks its own host
// for the range and reads the answer into the same time blocks, and the key goes nowhere else.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { readCalendarEvents, makeCall, Refused } from '../read-data/calendar-events.mjs';

const folder = resolve(import.meta.dirname, '..');
const providers = JSON.parse(readFileSync(resolve(folder, 'read-data/calendar-providers.json'), 'utf8'));
const row = JSON.parse(readFileSync(resolve(folder, 'tool-rows.json'), 'utf8')).records.map(record => record.payload).find(item => item.id === 'tool:read-calendar-events');
const range = { range_start: '2026-11-20T00:00:00Z', range_end: '2026-11-21T00:00:00Z' };
const KEY = 'held-access-key';

const stand = replies => {
  const asked = [];
  const send = async (url, init) => {
    asked.push({ url: new URL(url), init });
    const reply = replies.shift() ?? { status: 200, body: {} };
    return { ok: reply.status >= 200 && reply.status < 300, status: reply.status, text: async () => JSON.stringify(reply.body) };
  };
  return { asked, io: { read: () => KEY, send } };
};

test('the row offers exactly the providers the rows name, each with its own connection and key renewal', () => {
  // A Composio connection kind holds no vendor connection: it mounts its key from the vault and reads no refresh.
  const variantOf = p => (p.connection?.kind === 'composio'
    ? { connection: null, credential_mounts: [{ secret_name: p.connection.secret, fd: 4 }] }
    : { connection: { vendor: p.connection_vendor, from_input: 'connection' }, refresh: p.refresh });
  const expected = Object.fromEntries(providers.providers.map(p => [p.id, variantOf(p)]));
  assert.deepEqual(row.invoke.by_input, { input: 'provider', variants: expected });
  assert.deepEqual(row.invoke.credential_mounts, [{ field_id: 'access_token', fd: 4 }]);
  assert.deepEqual(row.input_schema.required, ['provider', 'connection', 'range_start', 'range_end']);
});

test('Google: every occurrence in start order inside the range, read into blocks; a date is all day, a cancelled event is marked', async () => {
  const { asked, io } = stand([{ status: 200, body: { items: [
    { id: 'a', summary: 'Call', status: 'confirmed', start: { dateTime: '2026-11-20T15:00:00Z', timeZone: 'America/Chicago' }, end: { dateTime: '2026-11-20T15:15:00Z' }, htmlLink: 'https://calendar.google.com/a' },
    { id: 'b', summary: 'Away', status: 'cancelled', start: { date: '2026-11-20' }, end: { date: '2026-11-21' } },
    { summary: 'no id or time' },
  ] } }]);
  const answer = await readCalendarEvents({ provider: 'google-calendar', connection: { connection_id: 'service_connection:google-account:me' }, ...range }, undefined, io);
  assert.equal(asked.length, 1);
  const { url, init } = asked[0];
  assert.equal(`${url.origin}${url.pathname}`, 'https://www.googleapis.com/calendar/v3/calendars/primary/events');
  assert.equal(url.searchParams.get('singleEvents'), 'true');
  assert.equal(url.searchParams.get('orderBy'), 'startTime');
  assert.equal(url.searchParams.get('timeMin'), '2026-11-20T00:00:00.000Z');
  assert.equal(init.headers.Authorization, `Bearer ${KEY}`);
  assert.equal(init.method, 'GET');
  assert.equal(answer.blocks.length, 2);
  assert.deepEqual(answer.blocks[0].interval, { start: '2026-11-20T15:00:00Z', end: '2026-11-20T15:15:00Z', allDay: false, timezone: 'America/Chicago' });
  assert.equal(answer.blocks[0].display.ownerLabel, 'Google Calendar');
  assert.deepEqual(answer.blocks[0].relations.account, ['service_connection:google-account:me']);
  assert.equal(answer.blocks[1].interval.allDay, true);
  assert.equal(answer.blocks[1].state.ref, 'cancelled');
  assert.deepEqual(answer.source, { provider: 'google-calendar', event_count: 2 });
});

test('Outlook: the default calendar view or a named calendar, asked in UTC, read into the same blocks', async () => {
  const { asked, io } = stand([
    { status: 200, body: { value: [{ id: 'm1', subject: 'Review', start: { dateTime: '2026-11-20T15:00:00.0000000' }, end: { dateTime: '2026-11-20T16:00:00.0000000' }, webLink: 'https://outlook.office.com/m1' }] } },
    { status: 200, body: { value: [{ id: 'm2', subject: 'Holiday', isAllDay: true, isCancelled: true, start: { dateTime: '2026-11-20T00:00:00.0000000' }, end: { dateTime: '2026-11-21T00:00:00.0000000' } }] } },
  ]);
  const base = { provider: 'outlook-calendar', connection: { connection_id: 'service_connection:microsoft-account:me' }, ...range };
  const first = await readCalendarEvents(base, undefined, io);
  const second = await readCalendarEvents({ ...base, calendar_id: 'work id/1' }, undefined, io);
  assert.equal(`${asked[0].url.origin}${asked[0].url.pathname}`, 'https://graph.microsoft.com/v1.0/me/calendarView');
  assert.equal(asked[0].url.searchParams.get('startDateTime'), '2026-11-20T00:00:00.000Z');
  assert.equal(asked[0].init.headers.Prefer, 'outlook.timezone="UTC"');
  assert.equal(asked[1].url.pathname, '/v1.0/me/calendars/work%20id%2F1/calendarView');
  assert.equal(first.blocks[0].interval.start, '2026-11-20T15:00:00.0000000Z');
  assert.equal(first.blocks[0].display.ownerLabel, 'Outlook Calendar');
  assert.deepEqual(second.blocks[0].interval, { start: '2026-11-20', end: '2026-11-21', allDay: true, timezone: 'local' });
  assert.equal(second.blocks[0].state.ref, 'cancelled');
});

test('an empty range is said, and a provider refusal is quoted without the key', async () => {
  const empty = await readCalendarEvents({ provider: 'google-calendar', connection: { connection_id: 'c' }, ...range }, undefined, stand([{ status: 200, body: { items: [] } }]).io);
  assert.equal(empty.blocks.length, 0);
  assert.equal(empty.issues[0].id, 'sync-empty');
  await assert.rejects(readCalendarEvents({ provider: 'google-calendar', connection: { connection_id: 'c' }, ...range }, undefined, stand([{ status: 401, body: { error: { message: 'Invalid Credentials' } } }]).io),
    error => error instanceof Refused && /Google Calendar refused the request \(401\)/.test(error.message) && !error.message.includes(KEY));
});

test('bad input, an unknown provider and a missing key are refused before anything is sent', async () => {
  const { asked, io } = stand([]);
  await assert.rejects(readCalendarEvents({ provider: 'google-calendar', connection: { connection_id: 'c' }, range_start: 'x', range_end: '2026-11-21T00:00:00Z' }, undefined, io), /range_start must be an ISO time/);
  await assert.rejects(readCalendarEvents({ provider: 'fax-calendar', connection: { connection_id: 'c' }, ...range }, undefined, io), /fax-calendar is not a calendar provider here; the providers are google-calendar, outlook-calendar/);
  await assert.rejects(readCalendarEvents({ connection: { connection_id: 'c' }, ...range }, undefined, io), /Give provider/);
  await assert.rejects(readCalendarEvents({ provider: 'outlook-calendar', connection: { connection_id: 'c' }, ...range }, undefined, { read: () => '', send: io.send }), /holds no access key/);
  assert.equal(asked.length, 0);
});

test('the key goes only to the provider\'s own host, and nothing but reading is asked', async () => {
  const google = providers.providers.find(p => p.id === 'google-calendar');
  const { asked, io } = stand([]);
  const call = makeCall(google, io);
  await assert.rejects(call('GET', 'https://evil.example/calendar/v3'), /goes only to www.googleapis.com/);
  await assert.rejects(call('DELETE', '/calendars/primary/events/a'), /does not offer this/);
  assert.equal(asked.length, 0);
  const code = ['read-data/calendar-events.mjs', 'read-data/adapters/google.mjs', 'read-data/adapters/graph.mjs'].map(file => readFileSync(resolve(folder, file), 'utf8')).join('\n');
  assert.doesNotMatch(code, /'(POST|PUT|PATCH|DELETE)'/);
  assert.doesNotMatch(code, /console\.|process\.env/);
});

test('Composio: one execute call per range for the connected account, its key only in x-api-key, its events read like Google\'s', async () => {
  const seen = [];
  const send = async (url, init) => {
    seen.push({ url: new URL(url), init });
    const body = { successful: true, error: null, data: { items: [
      { id: 'c1', summary: 'Composio call', status: 'confirmed', start: { dateTime: '2026-11-20T15:00:00Z' }, end: { dateTime: '2026-11-20T15:30:00Z' } },
      { id: 'c2', summary: 'Gone', status: 'cancelled', start: { date: '2026-11-20' }, end: { date: '2026-11-21' } },
    ] } };
    return { ok: true, status: 200, text: async () => JSON.stringify(body) };
  };
  const answer = await readCalendarEvents({ provider: 'google-calendar-via-composio', connection: { connection_id: 'googlecalendar_moon-suku', user_id: 'default' }, ...range }, undefined, { read: () => KEY, send });
  assert.equal(seen.length, 1);
  assert.equal(`${seen[0].url.origin}${seen[0].url.pathname}`, 'https://backend.composio.dev/api/v3/tools/execute/GOOGLECALENDAR_EVENTS_LIST');
  assert.equal(seen[0].init.method, 'POST');
  assert.equal(seen[0].init.headers['x-api-key'], KEY);
  assert.equal(seen[0].init.headers.Authorization, undefined, 'no bearer header goes to Composio');
  const sent = JSON.parse(seen[0].init.body);
  assert.equal(sent.connected_account_id, 'googlecalendar_moon-suku');
  assert.equal(sent.user_id, 'default', 'the owning user id the connection names goes with the account');
  assert.deepEqual(sent.arguments, { calendarId: 'primary', timeMin: '2026-11-20T00:00:00.000Z', timeMax: '2026-11-21T00:00:00.000Z', singleEvents: true, orderBy: 'startTime', maxResults: 50 });
  assert.equal(answer.blocks.length, 2);
  assert.equal(answer.blocks[0].display.ownerLabel, 'Google Calendar');
  assert.deepEqual(answer.blocks[0].relations.account, ['googlecalendar_moon-suku']);
  assert.equal(answer.blocks[1].state.ref, 'cancelled');
});

test('Composio: a reply Composio marks unsuccessful is refused with its words, and a key is never sent anywhere else', async () => {
  const send = async () => ({ ok: true, status: 200, text: async () => JSON.stringify({ successful: false, error: 'connected account not found', data: null }) });
  await assert.rejects(readCalendarEvents({ provider: 'google-calendar-via-composio', connection: { connection_id: 'nope' }, ...range }, undefined, { read: () => KEY, send }), /connected account not found/);
});

