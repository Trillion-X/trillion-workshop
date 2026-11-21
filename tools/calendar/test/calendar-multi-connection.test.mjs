// tools/calendar/test/calendar-multi-connection.test.mjs
// One run reads every connection a Composio provider names: each account's events come back as blocks on its own
// account, an account that fails keeps its own words and hides none of the others, and a provider that reads one
// connection per run refuses a list.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readCalendarEvents } from '../read-data/calendar-events.mjs';

const range = { range_start: '2026-11-20T00:00:00.000Z', range_end: '2026-11-27T00:00:00.000Z' };
const key = () => 'made-up-composio-key';

// A stand-in for Composio's execute endpoint: the account named in the body decides the answer.
function standIn(answers) {
  const sent = [];
  const send = async (url, init) => {
    const body = JSON.parse(init.body);
    sent.push(body.connected_account_id);
    const answer = answers[body.connected_account_id];
    if (!answer) return new Response(JSON.stringify({ successful: false, error: 'no such account' }), { status: 400 });
    return new Response(JSON.stringify({ successful: true, data: answer }), { status: 200 });
  };
  return { sent, io: { read: key, send } };
}

const eventsFor = (...titles) => ({ items: titles.map((title, index) => ({ id: `${title}-${index}`, summary: title, start: { dateTime: `2026-11-2${index + 1}T10:00:00Z` }, end: { dateTime: `2026-11-2${index + 1}T11:00:00Z` } })) });

test('one run reads every connection, and each event is on its own account', async () => {
  const { sent, io } = standIn({ ca_a: eventsFor('Dentist'), ca_b: eventsFor('Bakery', 'Tennis') });
  const answer = await readCalendarEvents({ provider: 'google-calendar-via-composio', connections: [{ connection_id: 'ca_a' }, { connection_id: 'ca_b', user_id: 'user-1' }], ...range, max_results: 10 }, undefined, io);
  assert.deepEqual(sent.sort(), ['ca_a', 'ca_b']);
  assert.equal(answer.blocks.length, 3);
  assert.deepEqual(answer.blocks.map(block => block.relations.account[0]).sort(), ['ca_a', 'ca_b', 'ca_b']);
  assert.deepEqual(answer.reads.map(read => [read.connection_id, read.read, read.event_count]), [['ca_a', true, 1], ['ca_b', true, 2]]);
  assert.deepEqual(answer.issues, []);
});

test('an account that fails keeps its own words and the others still come back', async () => {
  const { io } = standIn({ ca_good: eventsFor('Dentist') });
  const answer = await readCalendarEvents({ provider: 'google-calendar-via-composio', connections: [{ connection_id: 'ca_bad' }, { connection_id: 'ca_good' }], ...range }, undefined, io);
  assert.equal(answer.blocks.length, 1);
  assert.equal(answer.blocks[0].relations.account[0], 'ca_good');
  assert.deepEqual(answer.reads.find(read => read.connection_id === 'ca_bad').read, false);
  assert.match(answer.reads.find(read => read.connection_id === 'ca_bad').said, /no such account/);
  assert.equal(answer.issues.length, 1);
  assert.equal(answer.issues[0].id, 'read-failed:ca_bad');
  assert.match(answer.issues[0].label, /could not read one account/);
});

test('a single connection that fails still throws, as before', async () => {
  const { io } = standIn({});
  await assert.rejects(readCalendarEvents({ provider: 'google-calendar-via-composio', connection: { connection_id: 'ca_bad' }, ...range }, undefined, io), /Composio refused/);
});

test('a list is refused for a provider that reads one connection per run, and an empty list or a missing account is refused', async () => {
  await assert.rejects(readCalendarEvents({ provider: 'google-calendar', connections: [{ connection_id: 'x' }], ...range }, undefined, {}), /one connection per run/);
  await assert.rejects(readCalendarEvents({ provider: 'google-calendar-via-composio', connections: [], ...range }, undefined, {}), /connections must be a list/);
  await assert.rejects(readCalendarEvents({ provider: 'google-calendar-via-composio', ...range }, undefined, {}), /Give connection, or connections/);
});
