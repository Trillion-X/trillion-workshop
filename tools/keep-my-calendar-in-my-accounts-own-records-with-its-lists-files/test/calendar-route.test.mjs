// The page's calendar routes as the engine runs them through tool:answer-the-calendar-page-route (workshop-routes):
// src/calendar-route.mjs runs the moved owner (src/native-calendar-owner.mjs calendar:request) over the person's lists
// read and written through the records door. Every record here is made up.
import test from 'node:test';
import assert from 'node:assert/strict';
import { isDeepStrictEqual } from 'node:util';
import { recordsDoorFromCall, RecordsDoorError } from 'trillion-workshop/tools/records-door/read-data/records-door.mjs';
import { answerOf, rowOf } from '../../../test-helpers/run-a-row.mjs';
import { answerTheCalendarRoute } from '../src/calendar-route.mjs';
import rows from '../tool-rows.json' with { type: 'json' };

// The person's records as the door keeps them: read, list (greatest id first, in pages) and conditional writes.
function personDoor(records = [], { beforeWrite = () => {} } = {}) {
  const kept = new Map(records.map(record => [record.id, structuredClone(record)]));
  const calls = [];
  const door = recordsDoorFromCall(async (method, input) => {
    calls.push(method);
    if (method === 'records:read') {
      const one = kept.get(input.id);
      return { id: input.id, type: input.type, value: one?.type === input.type ? structuredClone(one.value) : null };
    }
    if (method === 'records:list') {
      const ids = [...kept.values()].filter(one => one.type === input.type && (!input.prefix || one.id.startsWith(input.prefix))).map(one => one.id).sort().reverse();
      const from = input.after === undefined ? 0 : ids.indexOf(input.after) + 1;
      const page = ids.slice(from, from + 2);
      return { records: page.map(id => structuredClone(kept.get(id))), next: from + 2 < ids.length ? page.at(-1) : null };
    }
    if (method === 'records:write') {
      beforeWrite(kept);
      for (const item of input.records) {
        const now = kept.get(item.id) ?? null;
        const fine = item.expected === null ? now === null : now && now.type === item.expected.type && isDeepStrictEqual(now.value, item.expected.value);
        if (!fine) throw new RecordsDoorError('original_command_conflict', 'changed', 'not_started');
      }
      for (const { expected: _expected, ...item } of input.records) item.value === null ? kept.delete(item.id) : kept.set(item.id, item);
      return { changed: input.records.length, write_count: input.records.length };
    }
    throw new Error(`unexpected ${method}`);
  }, { resource: '@own-records' });
  return { door, kept, calls };
}

const route = (door, path, method = 'GET', query = {}, body = {}) => answerTheCalendarRoute({ path, method, query, body, browser: {} }, { door });

test('a task added through POST /calendar/tasks is kept as the person\'s records and read back by GET', async () => {
  const { door, kept } = personDoor();
  const empty = await route(door, '/calendar/tasks');
  assert.equal(empty.status, 200);
  assert.deepEqual(empty.body.tasks ?? [], []);
  // The old owner's read makes the calendar's starting lists once when they are missing (calendar-tasks.mjs
  // ensureTaskList), and keeps no task.
  assert.ok(kept.has('list:calendar-tasks'));
  assert.equal([...kept.keys()].filter(id => id.startsWith('record:calendar-task:')).length, 0);
  const again = new Map(kept);
  await route(door, '/calendar/tasks');
  assert.deepEqual(kept, again, 'once made, a read writes nothing');

  const added = await route(door, '/calendar/tasks', 'POST', {}, { action: 'create', request_key: 'fern-1', title: 'Water the sample ferns', duration_minutes: 15 });
  assert.equal(added.status, 200, JSON.stringify(added.body));
  const taskIds = [...kept.keys()].filter(id => id.startsWith('record:calendar-task:'));
  assert.equal(taskIds.length, 1, 'one task record');
  assert.ok(kept.has('list:calendar-tasks'), 'the task list is made once, as the old owner made it');

  const read = await route(door, '/calendar/tasks');
  assert.equal(read.status, 200);
  assert.deepEqual(read.body.tasks.map(task => task.title), ['Water the sample ferns']);
});

test('GET /calendar reads the person\'s tasks as its personal-tasks source and says the sources a run cannot reach', async () => {
  const { door } = personDoor();
  const made = await route(door, '/calendar/tasks', 'POST', {}, { action: 'create', request_key: 'dentist-1', title: 'Sample dentist', duration_minutes: 60 });
  const scheduled = await route(door, '/calendar/tasks', 'POST', {}, { action: 'schedule', task_id: made.body.task.id, start: '2036-10-06T09:00:00.000Z', end: '2036-10-06T10:00:00.000Z' });
  assert.equal(scheduled.status, 200, JSON.stringify(scheduled.body));
  const answer = await route(door, '/calendar', 'GET', { from: '2036-10-05T00:00:00Z', to: '2036-10-12T00:00:00Z' });
  assert.equal(answer.status, 200, JSON.stringify(answer.body));
  const by = Object.fromEntries(answer.body.sources.map(row => [row.id, row]));
  assert.equal(by['personal-tasks'].read, true);
  assert.ok(answer.body.items.some(item => item.source === 'personal-tasks' && item.title === 'Sample dentist'));
  for (const id of ['meetings', 'posts']) {
    assert.equal(by[id].read, false);
    assert.match(by[id].said, /could not be read/);
  }
});

test('a span the calendar refuses is the owner\'s refusal in its words; routes only a tool runner answers are not here', async () => {
  const { door } = personDoor();
  const refused = await route(door, '/calendar', 'GET', { from: '2036-10-12T00:00:00Z', to: '2036-10-05T00:00:00Z' });
  assert.equal(refused.status >= 400, true);
  assert.equal(typeof refused.body.error, 'string');
  for (const path of ['/calendar/actions', '/calendar/availability', '/elsewhere']) assert.deepEqual(await route(door, path, 'POST'), { status: 404, body: { error: 'Not found' } });
});

test('a record changed while the request ran is never written over', async () => {
  let race = null;
  const { door, kept } = personDoor([], { beforeWrite: held => {
    if (!race) return;
    const id = race;
    race = null;
    held.set(id, { ...held.get(id), value: { ...held.get(id).value, title: 'Renamed meanwhile' } });
  } });
  const made = await route(door, '/calendar/tasks', 'POST', {}, { action: 'create', request_key: 'one', title: 'First sample', duration_minutes: 15 });
  const id = `record:calendar-task:${made.body.task.id}`;
  race = id;
  const refused = await route(door, '/calendar/tasks', 'POST', {}, { action: 'complete', task_id: made.body.task.id });
  assert.equal(refused.status, 500);
  assert.equal(kept.get(id).value.title, 'Renamed meanwhile', 'the change made meanwhile stands');
  assert.notEqual(kept.get(id).value.status, 'Done', 'the refused change wrote nothing');
});

test('the route row runs as the engine runs it, against the stand-in door with exactly its rights', async () => {
  const row = rowOf(rows, 'tool:answer-the-calendar-page-route');
  const [sample] = row.verify;
  const ran = await answerOf(row, sample.input, sample);
  assert.equal(ran.status, 0, JSON.stringify(ran));
  assert.equal(ran.result.status, 200, JSON.stringify(ran.result));
  assert.ok(ran.kept.some(record => record.type === 'record:calendar-task'), 'the task is kept through the door');
});
