import test from 'node:test';
import assert from 'node:assert/strict';
import { localStore } from '../src/local-store.mjs';
import { makeLists } from '../../keep-lists-of-rows/lists.mjs';
import { changeCalendarTask, readCalendarTasks, runCalendarTaskRecurrencePage } from '../../plan-tasks-and-todo-lists/calendar-tasks.mjs';

const weekly = {
  frequency: 'week', interval: 2, weekdays: ['wed', 'mon'],
  ends: { kind: 'count', value: 8 }, nextTodo: 'when_done',
};

test('task recurrence is validated, normalized and saved through the shared Lists owner', async () => {
  const store = localStore(':memory:');
  const lists = makeLists({ eeaf: store.eeaf });
  const created = changeCalendarTask(lists, {
    action: 'create', request_key: 'weekly-review', title: 'Review the plan', duration_minutes: 30, recurrence: weekly,
  });
  assert.deepEqual(created.task.recurrence, {
    frequency: 'week', interval: 2, weekdays: ['mon', 'wed'],
    ends: { kind: 'count', value: 8 }, nextTodo: 'when_done',
    timeZone: 'UTC',
  });
  assert.equal(typeof (await lists.row('calendar-tasks', created.task.id)).values.recurrence, 'string');
  assert.deepEqual(readCalendarTasks(lists).tasks[0].recurrence, created.task.recurrence);
  assert.equal(changeCalendarTask(lists, {
    action: 'create', request_key: 'weekly-review', title: 'Review the plan', duration_minutes: 30, recurrence: weekly,
  }).kept, true, 'a repeated create request returns the same recurrence rule');
  assert.throws(() => changeCalendarTask(lists, {
    action: 'create', request_key: 'weekly-review', title: 'Review the plan', duration_minutes: 30, recurrence: { ...weekly, interval: 3 },
  }), /different task/);

  const edited = changeCalendarTask(lists, {
    action: 'update', task_id: created.task.id,
    recurrence: { ...weekly, interval: 3, ends: { kind: 'date', value: '2026-12-31' } },
  });
  assert.equal(edited.task.recurrence.interval, 3);
  assert.deepEqual(edited.task.recurrence.ends, { kind: 'date', value: '2026-12-31' });
  assert.equal(changeCalendarTask(lists, { action: 'update', task_id: created.task.id, recurrence: null }).task.recurrence, undefined);
});

function recurrenceFixture(recurrence, { due = '2026-01-01', now = '2026-01-01T09:00:00.000Z', ...details } = {}) {
  const store = localStore(':memory:');
  const lists = makeLists({ eeaf: store.eeaf });
  const created = changeCalendarTask(lists, {
    action: 'create', request_key: 'recurring-task', title: 'Recurring task', duration_minutes: 45,
    due, recurrence, description: 'Keep these notes', priority: 'high', labels: ['work', 'review'], ...details,
  }, { now: () => Date.parse(now) });
  return { lists, task: created.task, now: () => Date.parse(now) };
}

test('completing a repeated task creates one stable next task and preserves its details', () => {
  const { lists, task, now } = recurrenceFixture({
    frequency: 'day', interval: 1, weekdays: [], ends: { kind: 'never' }, nextTodo: 'when_done',
  });
  const first = changeCalendarTask(lists, { action: 'complete', task_id: task.id }, { now });
  const retry = changeCalendarTask(lists, { action: 'complete', task_id: task.id }, { now: () => Date.parse('2026-01-05T09:00:00.000Z') });
  assert.equal(first.next_task.id, `${task.id}-repeat-2`);
  assert.equal(retry.next_task.id, first.next_task.id);
  assert.equal(retry.next_task.due, '2026-01-02');
  assert.equal(retry.next_task.description, 'Keep these notes');
  assert.equal(retry.next_task.priority, 'high');
  assert.deepEqual(retry.next_task.labels, ['work', 'review']);
  assert.equal(retry.next_task.duration_minutes, 45);
  assert.equal(readCalendarTasks(lists).tasks.filter(item => item.id === first.next_task.id).length, 1);
});

test('monthly recurrence keeps an end-of-month anchor across shorter months', () => {
  const recurrence = { frequency: 'month', interval: 1, weekdays: [], ends: { kind: 'count', value: 3 }, nextTodo: 'when_done' };
  const { lists, task } = recurrenceFixture(recurrence, { due: '2026-01-31', now: '2026-01-31T09:00:00.000Z' });
  let now = Date.parse('2026-01-31T09:00:00.000Z');
  const february = changeCalendarTask(lists, { action: 'complete', task_id: task.id }, { now: () => now });
  assert.equal(february.next_task.due, '2026-02-28');
  now = Date.parse('2026-02-28T09:00:00.000Z');
  const march = changeCalendarTask(lists, { action: 'complete', task_id: february.next_task.id }, { now: () => now });
  assert.equal(march.next_task.due, '2026-03-31');
});

test('weekly recurrence follows selected weekdays in the active interval weeks', () => {
  const recurrence = { frequency: 'week', interval: 1, weekdays: ['mon', 'wed', 'fri'], ends: { kind: 'never' }, nextTodo: 'when_done' };
  const { lists, task } = recurrenceFixture(recurrence, { due: '2026-10-12', now: '2026-10-12T09:00:00.000Z' });
  let now = Date.parse('2026-10-12T09:00:00.000Z');
  const wednesday = changeCalendarTask(lists, { action: 'complete', task_id: task.id }, { now: () => now });
  assert.equal(wednesday.next_task.due, '2026-10-14');
  now = Date.parse('2026-10-14T09:00:00.000Z');
  const friday = changeCalendarTask(lists, { action: 'complete', task_id: wednesday.next_task.id }, { now: () => now });
  assert.equal(friday.next_task.due, '2026-10-16');
  now = Date.parse('2026-10-16T09:00:00.000Z');
  const nextMonday = changeCalendarTask(lists, { action: 'complete', task_id: friday.next_task.id }, { now: () => now });
  assert.equal(nextMonday.next_task.due, '2026-10-19');
});

test('recurrence keeps its local clock across daylight-saving changes', () => {
  const store = localStore(':memory:');
  const lists = makeLists({ eeaf: store.eeaf });
  const created = changeCalendarTask(lists, {
    action: 'create', request_key: 'dst-review', title: 'Review after the time change', duration_minutes: 30,
    due: '2026-03-07T09:00:00-08:00', recurrence: {
      frequency: 'day', interval: 1, weekdays: [], ends: { kind: 'count', value: 2 }, nextTodo: 'when_done', timeZone: 'America/Los_Angeles',
    },
  }, { now: () => Date.parse('2026-03-07T17:00:00Z') });
  const completed = changeCalendarTask(lists, { action: 'complete', task_id: created.task.id }, { now: () => Date.parse('2026-03-07T18:00:00Z') });
  assert.equal(completed.next_task.due, '2026-03-08T16:00:00.000Z');
});

test('direct recurrence creates one immediate successor, then advances on scheduled days', async () => {
  const recurrence = { frequency: 'week', interval: 1, weekdays: ['mon'], ends: { kind: 'count', value: 3 }, nextTodo: 'direct_even_if_open' };
  const { lists, task } = recurrenceFixture(recurrence, { due: '2026-10-12' });
  const immediate = await lists.row('calendar-tasks', `${task.id}-repeat-2`);
  assert.equal(immediate.values.due, '2026-10-19');
  assert.equal(runCalendarTaskRecurrencePage(lists, { now: Date.parse('2026-10-19T00:00:00Z') }).created, 0);
  const next = runCalendarTaskRecurrencePage(lists, { now: Date.parse('2026-10-26T00:00:00Z') });
  assert.equal(next.created, 1);
  assert.equal((await lists.row('calendar-tasks', `${task.id}-repeat-3`)).values.due, '2026-10-26');
  assert.equal(runCalendarTaskRecurrencePage(lists, { now: Date.parse('2026-10-26T00:00:00Z') }).created, 0, 'retry does not create a duplicate');
});

test('day-based recurrence waits for completion when requested and ignores a disabled or superseded rule', () => {
  const recurrence = { frequency: 'day', interval: 1, weekdays: [], ends: { kind: 'never' }, nextTodo: 'on_day_when_done' };
  const fixture = recurrenceFixture(recurrence, { due: '2026-10-12' });
  const beforeDone = runCalendarTaskRecurrencePage(fixture.lists, { now: Date.parse('2026-10-20T12:00:00Z') });
  assert.equal(beforeDone.created, 0);
  changeCalendarTask(fixture.lists, { action: 'complete', task_id: fixture.task.id }, { now: fixture.now });
  const afterDone = runCalendarTaskRecurrencePage(fixture.lists, { now: Date.parse('2026-10-20T12:00:00Z') });
  assert.equal(afterDone.created, 1);
  assert.equal(fixture.lists.row('calendar-tasks', `${fixture.task.id}-repeat-2`).values.due, '2026-10-13');

  const disabled = recurrenceFixture({ ...recurrence, nextTodo: 'on_day_even_if_open' }, { due: '2026-10-12' });
  changeCalendarTask(disabled.lists, { action: 'update', task_id: disabled.task.id, recurrence: null });
  const afterDisable = runCalendarTaskRecurrencePage(disabled.lists, { now: Date.parse('2026-10-20T12:00:00Z') });
  assert.equal(afterDisable.created, 0);

  const revised = recurrenceFixture({ ...recurrence, nextTodo: 'on_day_even_if_open' }, { due: '2026-10-12' });
  changeCalendarTask(revised.lists, { action: 'update', task_id: revised.task.id, recurrence: { ...recurrence, frequency: 'week', interval: 2, nextTodo: 'on_day_even_if_open' } });
  const afterEdit = runCalendarTaskRecurrencePage(revised.lists, { now: Date.parse('2026-10-20T12:00:00Z') });
  assert.equal(afterEdit.created, 0);
  assert.equal(afterEdit.next_at, Date.parse('2026-10-26T00:00:00.000Z'));
  const onNewDate = runCalendarTaskRecurrencePage(revised.lists, { now: Date.parse('2026-10-27T12:00:00Z') });
  assert.equal(onNewDate.created, 1);
  assert.ok(revised.lists.row('calendar-tasks', `${revised.task.id}-rule-2-repeat-2`));
  assert.equal(revised.lists.row('calendar-tasks', `${revised.task.id}-repeat-2`), null);
});

test('recurrence stops at its occurrence count and date boundary', () => {
  const counted = recurrenceFixture({
    frequency: 'day', interval: 1, weekdays: [], ends: { kind: 'count', value: 2 }, nextTodo: 'when_done',
  });
  const second = changeCalendarTask(counted.lists, { action: 'complete', task_id: counted.task.id }, { now: counted.now });
  assert.ok(second.next_task);
  const final = changeCalendarTask(counted.lists, { action: 'complete', task_id: second.next_task.id }, { now: counted.now });
  assert.equal(final.next_task, undefined);

  const dated = recurrenceFixture({
    frequency: 'day', interval: 1, weekdays: [], ends: { kind: 'date', value: '2026-01-02' }, nextTodo: 'when_done',
  });
  const lastAllowed = changeCalendarTask(dated.lists, { action: 'complete', task_id: dated.task.id }, { now: dated.now });
  assert.equal(lastAllowed.next_task.due, '2026-01-02');
  const after = changeCalendarTask(dated.lists, { action: 'complete', task_id: lastAllowed.next_task.id }, { now: dated.now });
  assert.equal(after.next_task, undefined);
});

test('task recurrence rejects malformed dates, weekdays, counts and unsupported follow-on choices', () => {
  const store = localStore(':memory:');
  const lists = makeLists({ eeaf: store.eeaf });
  const create = (recurrence, request_key) => changeCalendarTask(lists, {
    action: 'create', request_key, title: 'Repeating task', duration_minutes: 15, recurrence,
  });
  assert.throws(() => create({ ...weekly, interval: 0 }, 'bad-interval'), /Repeat interval/);
  assert.throws(() => create({ ...weekly, weekdays: ['monday'] }, 'bad-weekday'), /valid repeat days/);
  assert.throws(() => create({ ...weekly, ends: { kind: 'date', value: '2026-02-30' } }, 'bad-date'), /valid repeat end/);
  assert.throws(() => create({ ...weekly, ends: { kind: 'count', value: 0 } }, 'bad-count'), /valid repeat end/);
  assert.throws(() => create({ ...weekly, nextTodo: 'invented' }, 'bad-follow-on'), /when to create the next task/);
  assert.throws(() => create({ ...weekly, frequency: 'week', weekdays: ['mon', 'mon'] }, 'duplicate-weekday'), /valid repeat days/);
});
