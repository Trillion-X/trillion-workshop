import test from 'node:test';
import assert from 'node:assert/strict';
import settings from '../src/calendar.json' with { type: 'json' };
import { CalendarActionError, runCalendarAction } from '../src/calendar-actions.mjs';
import { itemsOf, readCalendar } from '../src/calendar.mjs';

const request = (overrides = {}) => ({
  source: 'google-calendar', action: 'create', request_key: 'create-meeting-1',
  input: { title: 'Design review', start: '2026-10-14T10:00:00-07:00', end: '2026-10-14T10:30:00-07:00', time_zone: 'America/Los_Angeles' },
  ...overrides,
});

test('Calendar actions come only from source declarations and keep the source calendar fixed', async () => {
  let received;
  const result = await runCalendarAction(request(), { runTool: async (...args) => { received = args; return { state: 'completed', output: { event_id: 'made' } }; } });
  assert.deepEqual(received, [
    'tool:google-calendar-create_an_event',
    { ...request().input, calendar_id: 'primary' },
    'calendar:google-calendar:create:create-meeting-1',
  ]);
  assert.equal(result.output.event_id, 'made');
  await assert.rejects(runCalendarAction(request({ source: 'unknown' }), { runTool: async () => ({}) }), CalendarActionError);
  await assert.rejects(runCalendarAction(request({ action: 'invented' }), { runTool: async () => ({}) }), CalendarActionError);
  await assert.rejects(runCalendarAction(request({ input: { ...request().input, calendar_id: 'other' } }), { runTool: async () => ({}) }), /fixed by the selected calendar source/);
});

test('date-only event creation keeps the selected source and request identity', async () => {
  const input = { title: 'Conference', start_date: '2026-10-05', end_date: '2026-10-08' };
  let received;
  await runCalendarAction(request({ input, request_key: 'conference-day-range' }), {
    runTool: async (...args) => { received = args; return { state: 'completed' }; },
  });
  assert.equal(received[0], 'tool:google-calendar-create_an_event');
  assert.deepEqual(received[1], { ...input, calendar_id: 'primary' });
  assert.equal(received[2], 'calendar:google-calendar:create:conference-day-range');
});

test('move and cancel use declared tools and preserve asynchronous Workshop outcomes', async () => {
  for (const [action, input, expectedTool, state] of [
    ['move', { event_id: 'event-1', start: '2026-10-14T11:00:00-07:00', end: '2026-10-14T11:30:00-07:00' }, 'tool:google-calendar-move_an_event', 'working'],
    ['cancel', { event_id: 'event-1' }, 'tool:google-calendar-cancel_an_event', 'for_you_to_run'],
  ]) {
    let received;
    const result = await runCalendarAction(request({ action, input, request_key: `${action}-event-1` }), {
      runTool: async (...args) => { received = args; return { state, task_id: `task-${action}` }; },
    });
    assert.equal(received[0], expectedTool);
    assert.equal(received[1].calendar_id, 'primary');
    assert.equal(received[2], `calendar:google-calendar:${action}:${action}-event-1`);
    assert.deepEqual(result, { state, task_id: `task-${action}` });
  }
});

test('Google Meet creation is declared and derives its provider request ID from the stable action key', async () => {
  const input = { ...request().input };
  let received;
  const result = await runCalendarAction(request({ action: 'create-video-call', input }), {
    runTool: async (...args) => { received = args; return { state: 'completed', output: { id: 'event-1', hangoutLink: 'https://meet.google.com/abc-defg-hij' } }; },
  });
  assert.equal(received[0], 'tool:google-calendar-create_an_event_with_a_video_call');
  assert.deepEqual(received[1], {
    ...input, calendar_id: 'primary', request_id: 'calendar:google-calendar:create-video-call:create-meeting-1',
  });
  assert.equal(received[2], 'calendar:google-calendar:create-video-call:create-meeting-1');
  assert.equal(result.output.hangoutLink, 'https://meet.google.com/abc-defg-hij');
  await assert.rejects(runCalendarAction(request({ action: '' }), { runTool: async () => ({}) }), /action is required/);
  await assert.rejects(runCalendarAction(request({
    action: 'create-video-call', input: { ...input, request_id: 'caller-chosen' },
  }), { runTool: async () => ({}) }), /set from request_key/);
});

test('Google event edits use the declared PATCH operation and preserve supplied event fields', async () => {
  const input = {
    event_id: 'event-1', title: 'Updated review', description: 'Agenda', location: 'Room 2',
    start: { dateTime: '2026-10-14T18:00:00Z', timeZone: 'UTC' },
    end: { dateTime: '2026-10-14T18:30:00Z', timeZone: 'UTC' },
    attendees: [{ email: 'guest@example.com' }], recurrence: ['RRULE:FREQ=WEEKLY'],
    reminders: { useDefault: false, overrides: [{ method: 'popup', minutes: 10 }] },
  };
  let received;
  await runCalendarAction(request({ action: 'edit', input, request_key: 'edit-event-1' }), {
    runTool: async (...args) => { received = args; return { state: 'completed' }; },
  });
  assert.equal(received[0], 'tool:google-calendar-edit_an_event');
  assert.deepEqual(received[1], { ...input, calendar_id: 'primary' });
  assert.equal(received[2], 'calendar:google-calendar:edit:edit-event-1');
});

test('Google Calendar retains its event-list read operation alongside edit and Meet creation', () => {
  const operations = settings.sources.find(row => row.id === 'google-calendar');
  assert.equal(operations.tool, 'tool:google-calendar-list_events_between');
  assert.ok(operations.calendar_actions.edit);
  assert.ok(operations.calendar_actions['create-video-call']);
  assert.equal(operations.calendar_actions.create.supports_all_day, true);
  assert.notEqual(settings.sources.find(row => row.id === 'meetings')?.calendar_actions?.create?.supports_all_day, true);
});

test('missing connection is an explicit refusal; provider write evidence stays fail-closed', async () => {
  const refused = await runCalendarAction(request(), { runTool: async () => { throw Object.assign(new Error('Connect Google Calendar first.'), { missing_connection: true }); } });
  assert.deepEqual(refused, { state: 'refused', connected: false, error: 'Connect Google Calendar first.' });
  const source = settings.sources.find(row => row.id === 'google-calendar');
  const items = itemsOf(source, { items: [
    { id: 'organizer', start: { dateTime: '2026-10-14T10:00:00-07:00' }, location: 'Room 2', hangoutLink: 'https://meet.google.com/abc-defg-hij', organizer: { self: true } },
    { id: 'creator', start: { dateTime: '2026-10-14T11:00:00-07:00' }, creator: { self: true } },
    { id: 'external', start: { dateTime: '2026-10-14T12:00:00-07:00' }, organizer: { self: false }, creator: { self: false } },
    { id: 'unknown', start: { dateTime: '2026-10-14T13:00:00-07:00' } },
    { id: 'all-day', start: { date: '2026-10-15' }, end: { date: '2026-10-17' } },
  ] });
  assert.deepEqual(items.map(item => [item.may_move, item.may_cancel]), [[true, true], [true, true], [false, false], [false, false], [false, false]]);
  assert.deepEqual([items[0].location, items[0].conference_url], ['Room 2', 'https://meet.google.com/abc-defg-hij']);
  assert.deepEqual([items[4].all_day, items[4].day, items[4].day_end], [true, '2026-10-15', '2026-10-17']);
  const tasks = settings.sources.find(row => row.id === 'personal-tasks');
  const imported = itemsOf(tasks, { tasks: [{ id: 'task-row', title: 'Imported task', starts_at: '2026-10-15T14:00:00Z', ends_at: '2026-10-15T14:30:00Z', source_id: 'amie-82', source_url: 'https://app.amie.so/tasks/82' }] })[0];
  assert.deepEqual([imported.source_id, imported.source_record_id, imported.source_url], ['task-row', 'amie-82', 'https://app.amie.so/tasks/82']);
});

test('calendar reads follow provider pages and fresh reads bypass the reuse key', async () => {
  const calls = [];
  const io = {
    route: async () => ({}), readRecord: () => null, now: () => 0,
    runTool: async (id, input, key) => {
      calls.push({ id, input, key });
      return { state: 'completed', output: { items: [{ id: input.page_token ? 'later' : 'first', start: { dateTime: '2026-10-15T10:00:00Z' } }], ...(input.page_token ? {} : { nextPageToken: 'page-2' }) } };
    },
  };
  const span = { from: '2026-10-14T00:00:00Z', to: '2026-10-16T00:00:00Z' };
  const answer = await readCalendar(span, io);
  assert.deepEqual(answer.items.map(item => item.source_id), ['first', 'later']);
  assert.equal(answer.sources.find(source => source.id === 'google-calendar').complete, true);
  const eventCalls = calls.filter(call => call.id === 'tool:google-calendar-list_events_between');
  assert.equal(eventCalls.length, 2);
  assert.equal(eventCalls[1].input.page_token, 'page-2');
  const reused = eventCalls[0].key;
  calls.length = 0;
  await readCalendar({ ...span, fresh: true }, io);
  assert.notEqual(calls.find(call => call.id === 'tool:google-calendar-list_events_between').key, reused);
});

test('a repeated provider cursor is incomplete and cannot look like a free calendar', async () => {
  const answer = await readCalendar({ from: '2026-10-14T00:00:00Z', to: '2026-10-16T00:00:00Z' }, {
    route: async () => ({}), readRecord: () => null,
    runTool: async () => ({ state: 'completed', output: { items: [], nextPageToken: 'same' } }),
  });
  assert.equal(answer.sources.find(source => source.id === 'google-calendar').complete, false);
});


test('long selected calendar identities keep bounded, distinct and retry-stable Meet keys', async () => {
  const calls = [];
  const source = id => ({ id, calendar_actions: { create: { tool: 'tool:meet', request_key_field: 'request_id' } } });
  const a = source('account-a:' + 'long-calendar'.repeat(30));
  const b = source('account-b:' + 'long-calendar'.repeat(30));
  const io = { sources: [a, b], runTool: async (...args) => { calls.push(args); return { state: 'completed' }; } };
  for (const row of [a, a, b]) await runCalendarAction({ source: row.id, action: 'create', input: {}, request_key: 'same-retry' }, io);
  assert.ok(calls[0][1].request_id.length <= 200);
  assert.equal(calls[0][1].request_id, calls[1][1].request_id);
  assert.notEqual(calls[0][1].request_id, calls[2][1].request_id);
});
