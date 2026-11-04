import test from 'node:test';
import assert from 'node:assert/strict';
import data from '../calendar-tasks.json' with { type: 'json' };
import { localStore } from '../../keep-and-wake-ai-sessions-on-this-computer/src/local-store.mjs';
import { makeLists } from '../../keep-lists-of-rows/lists.mjs';
import { planSchedule } from '../parts/ui/show/schedule-calendar/schedule-planner.mjs';
import { changeCalendarTask, readCalendarTaskCollections, readCalendarTasks, CalendarTasksError } from '../calendar-tasks.mjs';

const stores = new WeakMap();
function freshLists() {
  const store = localStore(':memory:');
  const lists = makeLists({ eeaf: store.eeaf });
  stores.set(lists, store);
  return lists;
}
// The order index of a list is built in the background; a test waits for it the way the tasks' own order test does.
function orderReady(lists) {
  const store = stores.get(lists);
  lists.fillOrdering(data.collections.id);
  for (let page = 0; page < 100 && !store.eeaf.indexReady(`record:${data.collections.row_type}`, data.collections.ordering.index); page++) store.eeaf.backfillTables({ limit: 10 });
}
const act = (lists, input) => changeCalendarTask(lists, input);
const makeList = (lists, key, extra = {}) => act(lists, { action: 'create_collection', request_key: key, title: key, ...extra }).collection;
const refused = (lists, input, pattern) => assert.throws(() => act(lists, input), error => error instanceof CalendarTasksError && pattern.test(error.message));

test('a list is made with a colour, default calendar and preferred times, and a read answers them', () => {
  const lists = freshLists();
  const work = makeList(lists, 'work', {
    color: 'teal', default_calendar: { source_id: 'google', calendar_id: 'primary' }, ai_scheduling: false,
    preferred_times: { start_minute: 540, end_minute: 720, weekdays: [3, 1] },
  });
  assert.deepEqual(work, {
    id: 'calendar-collection-work', title: 'work', color: 'teal', default_calendar: { source_id: 'google', calendar_id: 'primary' },
    archived: false, ai_scheduling: false, preferred_times: { start_minute: 540, end_minute: 720, weekdays: [1, 3] },
  });
  assert.deepEqual(readCalendarTaskCollections(lists).collections, [work]);
  assert.equal(data.list_colors.length, 16);
  assert.ok(data.list_colors.every(row => data.collections.fields.find(field => field.id === 'color').choices.includes(row.id)));
});

test('update_collection changes only the settings it names, null clears one, and bad values are refused', () => {
  const lists = freshLists();
  const work = makeList(lists, 'work', { color: 'blue', ai_scheduling: true });
  const renamed = act(lists, { action: 'update_collection', collection_id: work.id, title: 'Projects' });
  assert.deepEqual(renamed.collection, { ...work, title: 'Projects' }, 'a rename leaves the colour and scheduling alone');
  const archived = act(lists, { action: 'update_collection', collection_id: work.id, archived: true });
  assert.equal(archived.collection.archived, true);
  assert.equal(archived.collection.color, 'blue');
  const cleared = act(lists, { action: 'update_collection', collection_id: work.id, color: null, ai_scheduling: null, archived: false });
  assert.deepEqual([cleared.collection.color, cleared.collection.ai_scheduling, cleared.collection.archived], [null, null, false]);
  refused(lists, { action: 'update_collection', collection_id: work.id, color: 'chartreuse' }, /list setting is not valid/);
  refused(lists, { action: 'update_collection', collection_id: work.id, default_calendar: { source_id: 'google' } }, /list setting is not valid/);
  refused(lists, { action: 'update_collection', collection_id: work.id, preferred_times: { start_minute: 600, end_minute: 600 } }, /list setting is not valid/);
  refused(lists, { action: 'update_collection', collection_id: work.id, preferred_times: { start_minute: 0, end_minute: 60, weekdays: [9] } }, /list setting is not valid/);
  refused(lists, { action: 'update_collection', collection_id: work.id, archived: 'yes' }, /list setting is not valid/);
  refused(lists, { action: 'update_collection', collection_id: work.id, title: '  ' }, /Give the list a name/);
  refused(lists, { action: 'update_collection', collection_id: work.id }, /list setting is not valid/);
  refused(lists, { action: 'update_collection', collection_id: 'nope', color: 'red' }, /no longer available/);
  assert.equal(readCalendarTaskCollections(lists).collections[0].title, 'Projects', 'a refusal changed nothing');
});

test('every list change answers the update that takes it back', () => {
  const lists = freshLists();
  const work = makeList(lists, 'work', { color: 'red' });
  const changed = act(lists, { action: 'update_collection', collection_id: work.id, title: 'Home', color: 'green', archived: true });
  assert.deepEqual(changed.undo, { action: 'update_collection', collection_id: work.id, title: 'work', color: 'red', archived: false });
  act(lists, changed.undo);
  assert.deepEqual(readCalendarTaskCollections(lists).collections, [work]);
  const created = act(lists, { action: 'create_collection', request_key: 'second', title: 'Second' });
  act(lists, created.undo);
  assert.deepEqual(readCalendarTaskCollections(lists).collections, [work], 'the undo of a create removes the list');
});

test('reorder_collection persists the order and answers the move back', () => {
  const lists = freshLists();
  const [a, b, c] = ['a', 'b', 'c'].map(key => makeList(lists, key));
  orderReady(lists);
  const order = () => readCalendarTaskCollections(lists).collections.map(row => row.id);
  assert.deepEqual(order(), [a.id, b.id, c.id]);
  const moved = act(lists, { action: 'reorder_collection', collection_id: c.id, anchor_id: a.id, placement: 'before' });
  assert.deepEqual(order(), [c.id, a.id, b.id]);
  assert.equal(moved.moved, true);
  act(lists, moved.undo);
  assert.deepEqual(order(), [a.id, b.id, c.id]);
  act(lists, { action: 'reorder_collection', collection_id: a.id, anchor_id: c.id, placement: 'after' });
  assert.deepEqual(order(), [b.id, c.id, a.id]);
  refused(lists, { action: 'reorder_collection', collection_id: a.id, anchor_id: a.id, placement: 'after' }, /Choose a list to move/);
  refused(lists, { action: 'reorder_collection', collection_id: a.id, anchor_id: c.id, placement: 'beside' }, /Choose a list to move/);
  refused(lists, { action: 'reorder_collection', collection_id: a.id, anchor_id: 'gone', placement: 'after' }, /no longer available/);
});

test('deleting a list detaches its tasks and an archived list still holds them', () => {
  const lists = freshLists();
  const work = makeList(lists, 'work');
  const task = act(lists, { action: 'create', request_key: 't', title: 'Task', duration_minutes: 30, collection_id: work.id }).task;
  act(lists, { action: 'update_collection', collection_id: work.id, archived: true });
  assert.equal(readCalendarTasks(lists).tasks[0].collection_id, work.id, 'archiving a list does not move its tasks');
  assert.equal(act(lists, { action: 'delete_collection', collection_id: work.id }).removed, true);
  assert.equal(readCalendarTasks(lists).tasks.find(row => row.id === task.id).collection_id, null);
});

test('a store made with the old plain lists is brought to the declared shape when read', () => {
  const lists = freshLists();
  lists.save({ id: data.collections.id, label: 'Task lists', row_type: 'calendar-task-list', title_field: 'title', fields: [{ id: 'title', label: 'List name', kind: 'text' }] }, { actor: { by: 'calendar' } });
  lists.putRows(data.collections.id, { rows: [{ id: 'old-one', values: { title: 'Old one' } }] }, { actor: { by: 'calendar' } });
  const read = readCalendarTasks(lists);
  assert.deepEqual(read.collections, [{ id: 'old-one', title: 'Old one', color: null, default_calendar: null, archived: false, ai_scheduling: null, preferred_times: null }]);
  const upgraded = lists.find(data.collections.id);
  assert.deepEqual(upgraded.fields.map(field => field.id), data.collections.fields.map(field => field.id));
  assert.equal(upgraded.ordering.index, 'manual_order');
  assert.equal(act(lists, { action: 'update_collection', collection_id: 'old-one', color: 'pink' }).collection.color, 'pink');
});

test('the person-level preferences round trip, including a text one that an empty string clears', () => {
  const lists = freshLists();
  const read = () => readCalendarTasks(lists).preferences;
  assert.deepEqual(read(), {
    refit_on_move: false, external_display: 'off', ai_scheduling: true, default_todo_visibility: 'private',
    email_todos: false, email_split_contents: true, email_todo_account: '',
  });
  const set = act(lists, { action: 'set_preferences', ai_scheduling: false, default_todo_visibility: 'visible', external_display: 'busy', email_todos: true, email_split_contents: false, email_todo_account: ' me@example.test ' });
  assert.deepEqual(set.preferences, {
    refit_on_move: false, external_display: 'busy', ai_scheduling: false, default_todo_visibility: 'visible',
    email_todos: true, email_split_contents: false, email_todo_account: 'me@example.test',
  });
  assert.deepEqual(read(), set.preferences);
  act(lists, set.undo);
  assert.deepEqual(read().email_todo_account, '');
  assert.equal(read().ai_scheduling, true);
  act(lists, { action: 'set_preferences', email_todo_account: 'x@example.test' });
  act(lists, { action: 'set_preferences', email_todo_account: '' });
  assert.equal(read().email_todo_account, '');
  refused(lists, { action: 'set_preferences', default_todo_visibility: 'everyone' }, /planning preference/);
  refused(lists, { action: 'set_preferences', email_todo_account: 'x'.repeat(201) }, /planning preference/);
  refused(lists, { action: 'set_preferences', email_todo_account: 5 }, /planning preference/);
});

test('the super priority is stored, answered, restored and ranks before every other priority in the plan', () => {
  const lists = freshLists();
  const task = act(lists, { action: 'create', request_key: 'u', title: 'Urgent', duration_minutes: 30, priority: 'urgent' });
  assert.equal(task.task.priority, 'urgent');
  const changed = act(lists, { action: 'update', task_id: task.task.id, priority: 'high' });
  act(lists, changed.undo);
  assert.equal(readCalendarTasks(lists).tasks[0].priority, 'urgent');
  assert.equal(data.priority_labels.urgent, 'Super priority');
  const week = { start_minute: 540, end_minute: 600, weekdays: [0, 1, 2, 3, 4, 5, 6] };
  const plan = planSchedule([
    { id: 'high', title: 'high', duration_minutes: 60, priority: 'high', deadline_type: 'none' },
    { id: 'urgent', title: 'urgent', duration_minutes: 60, priority: 'urgent', deadline_type: 'none' },
  ], [], { start_day: '2026-10-21', horizon_days: 1, working_hours: week, earliest_at: '2026-10-21T00:00:00.000Z' });
  assert.equal(plan.proposals[0].task_id, 'urgent', 'the one slot goes to the super priority');
});

test('a preferred window confines a task to those times inside working hours, and none left says why', () => {
  const week = { start_minute: 540, end_minute: 1020, weekdays: [0, 1, 2, 3, 4, 5, 6] };
  const run = window => planSchedule([{ id: 't', title: 't', duration_minutes: 60, deadline_type: 'none', preferred_window: window }], [],
    { start_day: '2026-10-21', horizon_days: 2, working_hours: week, earliest_at: '2026-10-21T00:00:00.000Z' });
  const afternoon = run({ start_minute: 780, end_minute: 900 });
  const at = new Date(afternoon.proposals[0].starts_at);
  assert.equal(at.getHours() * 60 + at.getMinutes(), 780, 'placed at the start of the window, not the start of the day');
  assert.equal(run(undefined).proposals[0].starts_at < afternoon.proposals[0].starts_at, true, 'without a window it takes the first slot of the day');
  const thursday = new Date('2026-10-22T12:00:00').getDay();
  const wrongDay = run({ start_minute: 780, end_minute: 900, weekdays: [thursday] });
  assert.equal(new Date(wrongDay.proposals[0].starts_at).getDay(), thursday, 'only on the weekdays it names');
  const never = run({ start_minute: 60, end_minute: 120 });
  assert.deepEqual(never.proposals, []);
  assert.equal(never.unscheduled[0].reason, 'outside_preferred_times');
});

test('the smart list of a task is stored, validated and kept by a duplicate', () => {
  const lists = freshLists();
  const task = act(lists, { action: 'create', request_key: 's', title: 'Mail', duration_minutes: 15, smart_list: 'email' }).task;
  assert.equal(task.smart_list, 'email');
  assert.equal(act(lists, { action: 'update', task_id: task.id, smart_list: 'other' }).task.smart_list, 'other');
  assert.equal(act(lists, { action: 'update', task_id: task.id, smart_list: null }).task.smart_list, null);
  refused(lists, { action: 'update', task_id: task.id, smart_list: 'inbox' }, /Email, Calendar or Other/);
  act(lists, { action: 'update', task_id: task.id, smart_list: 'calendar' });
  assert.equal(act(lists, { action: 'duplicate', task_id: task.id, request_key: 'copy' }).task.smart_list, 'calendar');
});

test('a pulled calendar event belongs to the Calendar list', () => {
  const lists = freshLists();
  const pulled = act(lists, { action: 'from_event', event: { id: 'e1', source: 'google', title: 'Standup', starts_at: '2026-10-21T09:00:00Z', ends_at: '2026-10-21T09:30:00Z', attendee_count: 3 } });
  assert.equal(pulled.task.smart_list, 'calendar');
});

test('a task keeps when it was added, can be snoozed, and logs time spent', () => {
  const lists = freshLists();
  const at = Date.parse('2026-10-20T09:00:00.000Z');
  const made = changeCalendarTask(lists, { action: 'create', title: 'Draft', duration_minutes: 30, request_key: 'draft' }, { now: () => at }).task;
  assert.equal(made.created_at, '2026-10-20T09:00:00.000Z');
  assert.equal(made.time_spent_minutes, 0);
  assert.equal(made.snoozed_until, null);
  const snoozed = act(lists, { action: 'update', task_id: made.id, snoozed_until: '2026-10-22' }).task;
  assert.equal(snoozed.snoozed_until, '2026-10-22');
  assert.equal(act(lists, { action: 'update', task_id: made.id, snoozed_until: null }).task.snoozed_until, null);
  refused(lists, { action: 'update', task_id: made.id, snoozed_until: 'someday' }, /Snoozed until/);
  assert.equal(act(lists, { action: 'log_time', task_id: made.id, minutes: 25 }).task.time_spent_minutes, 25);
  assert.equal(act(lists, { action: 'log_time', task_id: made.id, minutes: 10 }).task.time_spent_minutes, 35);
  assert.equal(act(lists, { action: 'update', task_id: made.id, time_spent_minutes: 0 }).task.time_spent_minutes, 0);
  refused(lists, { action: 'log_time', task_id: made.id, minutes: 0 }, /Time spent/);
  refused(lists, { action: 'log_time', task_id: made.id, minutes: 1.5 }, /Time spent/);
  refused(lists, { action: 'log_time', task_id: 'missing', minutes: 5 }, /not in your Calendar tasks/);
  const copy = changeCalendarTask(lists, { action: 'duplicate', task_id: made.id, request_key: 'copy' }, { now: () => at + 60_000 }).task;
  assert.equal(copy.created_at, '2026-10-20T09:01:00.000Z');
  assert.equal(readCalendarTasks(lists).tasks.find(task => task.id === made.id).created_at, '2026-10-20T09:00:00.000Z');
});
