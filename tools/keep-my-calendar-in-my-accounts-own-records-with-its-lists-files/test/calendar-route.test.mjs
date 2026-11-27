// The page's calendar routes as the engine runs them through tool:answer-the-calendar-page-route (workshop-routes):
// src/calendar-route.mjs runs the moved owner (src/native-calendar-owner.mjs calendar:request) over the rows the caller
// hands in as `records`; what a run writes comes back as `keep`. Every record here is made up.
import test from 'node:test';
import assert from 'node:assert/strict';
import { answerOf, rowOf } from '../../../test-helpers/run-a-row.mjs';
import { answerTheCalendarRoute } from '../src/calendar-route.mjs';
import rows from '../what-this-tool-does-and-how-to-run-it.json' with { type: 'json' };

const route = (records, path, method = 'GET', query = {}, body = {}) => answerTheCalendarRoute({ path, method, query, body, browser: {}, records });

const dentist = { id: 'record:calendar-task:calendar-dentist-1', type: 'record:calendar-task', value: { title: 'Sample dentist', duration_minutes: 60, created_at: '2026-11-18T21:59:01.357Z', description: '', labels: [], status: 'To do', manual_order: 'V', starts_at: '2036-10-06T09:00:00.000Z', ends_at: '2036-10-06T10:00:00.000Z' } };

test('GET /calendar reads the rows handed in as its personal-tasks source and says the sources a run cannot reach', async () => {
  const answer = await route([dentist], '/calendar', 'GET', { from: '2036-10-05T00:00:00Z', to: '2036-10-12T00:00:00Z' });
  assert.equal(answer.status, 200, JSON.stringify(answer.body));
  const by = Object.fromEntries(answer.body.sources.map(row => [row.id, row]));
  assert.equal(by['personal-tasks'].read, true);
  assert.ok(answer.body.items.some(item => item.source === 'personal-tasks' && item.title === 'Sample dentist'));
  for (const id of ['meetings', 'posts']) {
    assert.equal(by[id].read, false);
    assert.match(by[id].said, /could not be read/);
  }
  assert.equal(answer.keep.filter(row => row.type === 'record:calendar-task').length, 0, 'a read keeps no task');
});

test('a span the calendar refuses is the owner\'s refusal in its words; routes only a tool runner answers are not here', async () => {
  const refused = await route([], '/calendar', 'GET', { from: '2036-10-12T00:00:00Z', to: '2036-10-05T00:00:00Z' });
  assert.equal(refused.status >= 400, true);
  assert.equal(typeof refused.body.error, 'string');
  for (const path of ['/calendar/actions', '/calendar/availability', '/elsewhere']) {
    const missing = await route([], path, 'POST');
    assert.equal(missing.status, 404);
    assert.deepEqual(missing.body, { error: 'Not found' });
  }
});

test('a POST to the task routes is refused in the moved words: keeping is the store\'s own workflow, and nothing is kept', async () => {
  const refused = await route([], '/calendar/tasks', 'POST', {}, { action: 'create', request_key: 'sample-task-1', title: 'Sample errand', duration_minutes: 15 });
  assert.equal(refused.status, 405, JSON.stringify(refused.body));
  assert.match(refused.body.error, /workflow:keep-my-calendar-tasks-and-proposals/);
  assert.deepEqual(refused.keep, []);
});

test('the route row runs as the engine runs it, over the rows its sample hands in, and keeps no task for a read', async () => {
  const row = rowOf(rows, 'tool:answer-the-calendar-page-route');
  const [sample] = row.verify;
  const ran = await answerOf(row, sample.input, sample);
  assert.equal(ran.status, 0, JSON.stringify(ran));
  assert.equal(ran.result.status, 200, JSON.stringify(ran.result));
  assert.equal((ran.result.keep ?? []).filter(row => row.type === 'record:calendar-task').length, 0, 'a read keeps no task');
});
