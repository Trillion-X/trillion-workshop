// The put-a-booking tool with an attendee given as an email text (what the booking page sends), against a stand-in Composio transport.
// Every address and key here is made up.
import test from 'node:test';
import assert from 'node:assert/strict';
import { putABookingOnMyCalendar } from '../do-work/book-time.mjs';

const KEY = 'key-for-tests-only';
const conn = { provider: 'composio', toolkit: 'googlecalendar', account: 'ca_test_1', user_id: 'user-test-1', project: 'pr_test_1', api_key: KEY };
const input = { title: 'Intro call', start_local: '2026-08-12T09:00:00', end_local: '2026-08-12T09:15:00', timezone: 'America/Chicago' };

function composio(data) {
  const calls = [];
  const fn = async (url, init) => {
    calls.push({ url, body: JSON.parse(init.body) });
    const body = JSON.stringify({ successful: true, data });
    return { ok: true, status: 200, json: async () => JSON.parse(body), text: async () => body };
  };
  return { fn, calls };
}

test('an attendee given as an email text reaches Composio as that text, in a list of strings', async () => {
  const transport = composio({ response_data: { id: 'evt_9', htmlLink: 'https://calendar.example/evt_9' } });
  const answer = await putABookingOnMyCalendar({ ...input, attendees: ['booking-proof@example.test'] }, { credential: conn, fetch: transport.fn });
  assert.equal(answer.status, 'created');
  assert.deepEqual(transport.calls[0].body.arguments.attendees, ['booking-proof@example.test']);
  assert.equal(JSON.stringify(answer).includes(KEY), false);
});

test('an attendee given as a person keeps its email as the text Composio takes', async () => {
  const transport = composio({ response_data: { id: 'evt_10', htmlLink: 'https://calendar.example/evt_10' } });
  await putABookingOnMyCalendar({ ...input, attendees: [{ email: 'guest@example.test', displayName: 'Guest' }] }, { credential: conn, fetch: transport.fn });
  assert.deepEqual(transport.calls[0].body.arguments.attendees, ['guest@example.test']);
});

test('an attendee with no email is refused before any call', async () => {
  const transport = composio({});
  await assert.rejects(putABookingOnMyCalendar({ ...input, attendees: [{ displayName: 'No mail' }] }, { credential: conn, fetch: transport.fn }), /attendee email is required/);
  assert.equal(transport.calls.length, 0);
});
