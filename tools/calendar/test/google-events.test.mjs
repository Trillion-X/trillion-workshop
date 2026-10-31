// Reading events from the person's Google calendar: the request, the reading of the answer, and the sending with a
// stand-in for the network (no real account is used). The three credentials never leave the command.
import test from 'node:test';
import assert from 'node:assert/strict';
import { TOKEN_URL, eventsUrl, readEvents, requestProblems } from '../read-data/google-events.mjs';
import { heldCredentials, readGoogleCalendarEvents } from '../do-work/read-google-calendar-events.mjs';

const range = { range_start: '2026-06-01T00:00:00Z', range_end: '2026-07-01T00:00:00Z' };
const CREDENTIALS = ['client-id-zz', 'client-secret-zz', 'refresh-token-zz'];

test('the request asks for every occurrence in start order inside the range, for the named calendar', () => {
  const url = new URL(eventsUrl({ ...range, calendar_id: 'bakery team@example.test', max_results: 20 }));
  assert.equal(url.origin, 'https://www.googleapis.com');
  assert.equal(url.pathname, '/calendar/v3/calendars/bakery%20team%40example.test/events');
  assert.equal(url.searchParams.get('singleEvents'), 'true');
  assert.equal(url.searchParams.get('orderBy'), 'startTime');
  assert.equal(url.searchParams.get('maxResults'), '20');
  assert.equal(url.searchParams.get('timeMin'), '2026-06-01T00:00:00.000Z');
  assert.equal(url.searchParams.get('timeMax'), '2026-07-01T00:00:00.000Z');
  assert.match(eventsUrl(range), /calendars\/primary\/events/);
  assert.match(eventsUrl(range), /maxResults=50/);
});

test('every input problem is listed at once', () => {
  assert.deepEqual(requestProblems(range), []);
  const problems = requestProblems({ range_start: 'soon', range_end: 3, calendar_id: '', max_results: 0, connection_ref: 7 });
  assert.equal(problems.length, 5);
  assert.deepEqual(requestProblems({ range_start: '2026-06-02T00:00:00Z', range_end: '2026-06-01T00:00:00Z' }), ['range_end must be after range_start']);
  assert.equal(requestProblems(null).length, 1);
});

test('events become time blocks: a date is all day, a cancelled event is marked, one without a time is dropped', () => {
  const { blocks, issues } = readEvents({ items: [
    { id: 'e1', summary: 'Tasting', start: { dateTime: '2026-06-03T10:00:00-06:00', timeZone: 'Zone/One' }, end: { dateTime: '2026-06-03T11:00:00-06:00' }, htmlLink: 'https://calendar.example.test/e1' },
    { id: 'e2', start: { date: '2026-06-04' }, end: { date: '2026-06-05' }, status: 'cancelled' },
    { id: 'e3', start: { dateTime: '2026-06-05T10:00:00Z' } },
    { summary: 'no id', start: { dateTime: '2026-06-05T10:00:00Z' } },
    'junk',
  ] }, { status: 200, connectionRef: 'account:main' });
  assert.deepEqual(blocks.map(b => b.id), ['google-calendar:e1', 'google-calendar:e2', 'google-calendar:e3']);
  assert.deepEqual(blocks[0].interval, { start: '2026-06-03T10:00:00-06:00', end: '2026-06-03T11:00:00-06:00', allDay: false, timezone: 'Zone/One' });
  assert.deepEqual(blocks[0].relations, { account: ['account:main'], list: ['google-calendar:primary'], linkedRecord: ['https://calendar.example.test/e1'], conflict: [] });
  assert.equal(blocks[1].interval.allDay, true);
  assert.equal(blocks[1].state.ref, 'cancelled');
  assert.equal(blocks[1].display.title, 'Untitled');
  assert.equal(blocks[2].interval.end, '2026-06-05T10:00:00Z');
  assert.deepEqual(issues, []);
});

test('a refusal and an empty range are each said', () => {
  const refused = readEvents({ error: { message: 'Not allowed' } }, { status: 403 });
  assert.deepEqual(refused.issues.map(i => [i.id, i.detail]), [['sync-error', 'Not allowed']]);
  assert.equal(readEvents({}, { status: 500 }).issues[0].detail, 'Google Calendar did not return events.');
  assert.equal(readEvents({ items: [] }, { status: 200 }).issues[0].id, 'sync-empty');
});

function stand(events, { tokenStatus = 200, tokenBody = { access_token: 'access-zz' }, eventsStatus = 200 } = {}) {
  const calls = [];
  const fetchImpl = async (url, options = {}) => {
    calls.push({ url: String(url), options });
    if (String(url) === TOKEN_URL) return new Response(JSON.stringify(tokenBody), { status: tokenStatus });
    return new Response(JSON.stringify(events), { status: eventsStatus });
  };
  return { calls, fetchImpl };
}

test('one token request and one events request, the access token on the second, blocks and the source back', async () => {
  const { calls, fetchImpl } = stand({ items: [{ id: 'e1', summary: 'Tasting', start: { dateTime: '2026-06-03T10:00:00Z' }, end: { dateTime: '2026-06-03T11:00:00Z' } }] });
  const answer = await readGoogleCalendarEvents({ ...range, connection_ref: 'account:main' }, { credentials: CREDENTIALS, fetchImpl });
  assert.equal(calls.length, 2);
  const form = new URLSearchParams(calls[0].options.body);
  assert.deepEqual([form.get('client_id'), form.get('client_secret'), form.get('refresh_token'), form.get('grant_type')], [...CREDENTIALS, 'refresh_token']);
  assert.equal(calls[1].options.headers.authorization, 'Bearer access-zz');
  assert.equal(calls[1].options.method, undefined);
  assert.deepEqual(answer.source, { provider: 'google-calendar', http_status: 200, event_count: 1 });
  assert.equal(answer.blocks[0].display.title, 'Tasting');
  assert.equal(answer.range_start, '2026-06-01T00:00:00.000Z');
  const said = JSON.stringify(answer);
  for (const secret of [...CREDENTIALS, 'access-zz']) assert.ok(!said.includes(secret), 'no credential in the answer');
});

test('when Google does not give access it says why with every credential taken out, and no events request is made', async () => {
  const { calls, fetchImpl } = stand({}, { tokenStatus: 400, tokenBody: { error: 'invalid_grant', error_description: `Bad refresh token ${CREDENTIALS[2]} for ${CREDENTIALS[0]}` } });
  await assert.rejects(readGoogleCalendarEvents(range, { credentials: CREDENTIALS, fetchImpl }), error => {
    assert.match(error.message, /^Google did not give access: Bad refresh token \[held value\] for \[held value\]\.$/);
    for (const secret of CREDENTIALS) assert.ok(!error.message.includes(secret));
    return true;
  });
  assert.equal(calls.length, 1);
});

test('an events refusal that echoes a credential shows it taken out', async () => {
  const { fetchImpl } = stand({ error: { message: `denied for ${CREDENTIALS[1]}` } }, { eventsStatus: 403 });
  const answer = await readGoogleCalendarEvents(range, { credentials: CREDENTIALS, fetchImpl });
  assert.equal(answer.issues[0].detail, 'denied for [held value]');
  assert.deepEqual(answer.blocks, []);
});

test('bad input is refused before anything is sent', async () => {
  const { calls, fetchImpl } = stand({});
  await assert.rejects(readGoogleCalendarEvents({ range_start: 'soon' }, { credentials: CREDENTIALS, fetchImpl }), /range_start must be an ISO time; range_end must be an ISO time/);
  assert.equal(calls.length, 0);
});

test('a missing credential is refused by what it is, never by its value', () => {
  assert.deepEqual(heldCredentials(fd => `value-${fd}\n`), ['value-3', 'value-4', 'value-5']);
  assert.throws(() => heldCredentials(fd => (fd === 4 ? '  ' : 'x')), /No Google client secret arrived/);
  assert.throws(() => heldCredentials(() => { throw new Error('ENXIO'); }), /No Google client id arrived/);
});
