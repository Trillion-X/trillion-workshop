// tools/calendar/test/calendar-composio-keys.test.mjs
// The Composio read sends the account's user id and the project id with the call, so a person's own key is accepted.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readEvents } from '../read-data/adapters/google-via-composio.mjs';

test('the Composio events read passes the user id and the project id with the execute call', async () => {
  const calls = [];
  const execute = async (...args) => { calls.push(args); return { items: [] }; };
  await readEvents({ execute, accountId: 'ca_1', userId: 'user-1', projectId: 'proj-1' }, { calendarId: 'primary', rangeStart: '2026-11-20T00:00:00.000Z', rangeEnd: '2026-11-21T00:00:00.000Z', maxResults: 5 });
  assert.equal(calls.length, 1);
  const [tool, accountId, , userId, projectId] = calls[0];
  assert.equal(tool, 'GOOGLECALENDAR_EVENTS_LIST');
  assert.equal(accountId, 'ca_1');
  assert.equal(userId, 'user-1');
  assert.equal(projectId, 'proj-1');
});
