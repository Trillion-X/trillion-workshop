process.env.TZ = 'America/New_York';
import test from 'node:test';
import assert from 'node:assert/strict';
import { planSchedule } from '../do-work/schedule-planner.mjs';

const week = { start_minute: 9 * 60, end_minute: 17 * 60, weekdays: [1, 2, 3, 4, 5] };
const task = (id, duration_minutes, due = null) => ({ id, title: id, duration_minutes, due });

test('the planner fills local work hours around existing events and all-day events, in deadline order', () => {
  const inputTasks = [task('flexible', 60), task('deadline', 90, '2026-10-12T11:30:00-04:00'), task('blocked-day', 30)];
  const events = [
    { id: 'morning', starts_at: '2026-10-12T13:00:00Z', ends_at: '2026-10-12T14:00:00Z' },
    { id: 'afternoon', starts_at: '2026-10-12T16:30:00Z', ends_at: '2026-10-12T21:00:00Z' },
    { id: 'away', all_day: true, day: '2026-10-13', day_end: '2026-10-14' },
  ];
  const result = planSchedule(inputTasks, events, { start_day: '2026-10-12', horizon_days: 3, working_hours: week, slot_minutes: 30 });
  assert.deepEqual(result.proposals.map(({ task_id, starts_at }) => [task_id, new Date(starts_at).toLocaleString('en-US', { hour: 'numeric', minute: '2-digit', hour12: false })]), [
    ['deadline', '10:00'], ['flexible', '11:30'], ['blocked-day', '09:00'],
  ]);
  assert.equal(result.proposals[2].starts_at.slice(0, 10), '2026-10-14', 'the all-day event blocks Tuesday and the next open workday is Wednesday');
  assert.deepEqual(inputTasks.map(row => row.id), ['flexible', 'deadline', 'blocked-day'], 'planning leaves input order untouched');
});

test('deadlines and the bounded horizon return explicit reasons instead of writing or slipping tasks', () => {
  const result = planSchedule([
    task('already-due', 30, '2026-10-11'),
    task('too-long', 600),
    task('not-enough-room', 60, '2026-10-12T10:00:00-04:00'),
    task('beyond-plan', 30),
  ], [{ starts_at: '2026-10-12T13:00:00Z', ends_at: '2026-10-12T22:00:00Z' }], {
    start_day: '2026-10-12', horizon_days: 1, working_hours: week,
  });
  assert.deepEqual(result.unscheduled.map(row => [row.task_id, row.reason]), [
    ['already-due', 'due_passed'],
    ['not-enough-room', 'no_free_slot_before_horizon'],
    ['too-long', 'duration_exceeds_workday'],
    ['beyond-plan', 'no_free_slot_before_horizon'],
  ]);
  assert.deepEqual(result.proposals, []);
});

test('per-day work intervals use each weekday schedule', () => {
  const result = planSchedule([task('monday', 60), task('tuesday', 60)], [], {
    start_day: '2026-10-12', horizon_days: 2,
    working_hours: { days: [
      { weekday: 1, intervals: [{ start_minute: 9 * 60, end_minute: 10 * 60 }] },
      { weekday: 2, intervals: [{ start_minute: 13 * 60, end_minute: 14 * 60 }] },
    ] },
  });
  assert.deepEqual(result.proposals.map(row => [row.task_id, row.starts_at]), [
    ['monday', '2026-10-12T13:00:00.000Z'],
    ['tuesday', '2026-10-13T17:00:00.000Z'],
  ]);
});

test('work intervals allow breaks but never let a task cross one', () => {
  const result = planSchedule([task('morning', 60), task('afternoon', 60), task('too-long', 90)], [], {
    start_day: '2026-10-12', horizon_days: 1,
    working_hours: { days: [{ weekday: 1, intervals: [
      { start_minute: 9 * 60, end_minute: 10 * 60 },
      { start_minute: 10 * 60 + 30, end_minute: 11 * 60 + 30 },
    ] }] },
  });
  assert.deepEqual(result.proposals.map(row => [row.task_id, row.starts_at, row.ends_at]), [
    ['morning', '2026-10-12T13:00:00.000Z', '2026-10-12T14:00:00.000Z'],
    ['afternoon', '2026-10-12T14:30:00.000Z', '2026-10-12T15:30:00.000Z'],
  ]);
  assert.deepEqual(result.unscheduled, [{ task_id: 'too-long', title: 'too-long', reason: 'duration_exceeds_workday' }]);
});

test('omitted days and empty intervals mean no availability', () => {
  for (const working_hours of [
    { days: [] },
    { days: [{ weekday: 1, intervals: [] }] },
  ]) {
    const result = planSchedule([task('unavailable', 30)], [], {
      start_day: '2026-10-12', horizon_days: 1, working_hours,
    });
    assert.deepEqual(result.proposals, []);
    assert.deepEqual(result.unscheduled, [{ task_id: 'unavailable', title: 'unavailable', reason: 'no_workdays' }]);
  }
});

test('malformed, duplicate, unsorted, overlapping and mixed work schedules are rejected', () => {
  const invalidSchedules = [
    { days: [{ weekday: 1, intervals: [{ start_minute: 9 * 60 + 0.5, end_minute: 11 * 60 }] }] },
    { days: [{ weekday: 7, intervals: [] }] },
    { days: [{ weekday: 1, intervals: [] }, { weekday: 1, intervals: [] }] },
    { days: [{ weekday: 1, intervals: [{ start_minute: 10 * 60, end_minute: 11 * 60 }, { start_minute: 9 * 60, end_minute: 10 * 60 }] }] },
    { days: [{ weekday: 1, intervals: [{ start_minute: 9 * 60, end_minute: 11 * 60 }, { start_minute: 10 * 60, end_minute: 12 * 60 }] }] },
    { days: [{ weekday: 1 }] },
    { days: [], ...week },
    { ...week, weekdays: [1, 1] },
  ];
  for (const working_hours of invalidSchedules) {
    assert.throws(() => planSchedule([], [], { start_day: '2026-10-12', working_hours }), TypeError);
  }
});

test('per-day planning leaves tasks, events and work-hour inputs unchanged', () => {
  const inputTasks = [task('first', 30), task('second', 30)];
  const events = [{ starts_at: '2026-10-12T13:00:00Z', ends_at: '2026-10-12T13:30:00Z' }];
  const working_hours = { days: [{ weekday: 1, intervals: [
    { start_minute: 9 * 60, end_minute: 12 * 60 },
  ] }] };
  const before = structuredClone({ inputTasks, events, working_hours });
  planSchedule(inputTasks, events, { start_day: '2026-10-12', working_hours });
  assert.deepEqual({ inputTasks, events, working_hours }, before);
});

test('the planner skips nonexistent spring-forward wall times and emits valid elapsed-time intervals', () => {
  const result = planSchedule(Array.from({ length: 4 }, (_, index) => task(`spring-${index}`, 30)), [], {
    start_day: '2026-03-08', horizon_days: 1,
    working_hours: { start_minute: 60, end_minute: 240, weekdays: [0] }, slot_minutes: 30,
  });
  assert.deepEqual(result.proposals.map(row => new Date(row.starts_at).getHours()), [1, 1, 3, 3]);
  assert.ok(result.proposals.every(row => Date.parse(row.ends_at) - Date.parse(row.starts_at) === 30 * 60_000));
  assert.equal(result.unscheduled.length, 0);
});

test('the repeated fall-back hour produces unique instants and never schedules outside work hours', () => {
  const result = planSchedule(Array.from({ length: 6 }, (_, index) => task(`fall-${index}`, 30)), [], {
    start_day: '2026-11-01', horizon_days: 1,
    working_hours: { start_minute: 0, end_minute: 180, weekdays: [0] }, slot_minutes: 30,
  });
  assert.equal(new Set(result.proposals.map(row => row.starts_at)).size, result.proposals.length);
  assert.ok(result.proposals.every(row => new Date(row.starts_at).getHours() < 3));
  assert.ok(result.proposals.every(row => Date.parse(row.ends_at) - Date.parse(row.starts_at) === 30 * 60_000));
});

test('planner bounds reject oversized horizons and task batches', () => {
  assert.throws(() => planSchedule([], [], { start_day: '2026-10-12', horizon_days: 61, working_hours: week }), RangeError);
  assert.throws(() => planSchedule(Array.from({ length: 201 }, (_, index) => task(String(index), 15)), [], {
    start_day: '2026-10-12', working_hours: week,
  }), RangeError);
});

test('a current-time floor rejects past slots and long source spans stay bounded to the plan', () => {
  const result = planSchedule([task('today', 30), task('invalid-date', 30, 'not-a-date')], [
    { starts_at: '1900-01-01T00:00:00Z', ends_at: '2026-10-12T14:00:00Z' },
    { all_day: true, day: '1900-01-01', day_end: '2026-10-12' },
  ], { start_day: '2026-10-12', horizon_days: 1, working_hours: week, earliest_at: '2026-10-12T16:10:00Z' });
  assert.equal(result.proposals[0].starts_at, '2026-10-12T16:15:00.000Z');
  assert.equal(result.unscheduled[0].reason, 'invalid_due');
});

const hhmm = iso => new Date(iso).toLocaleString('en-US', { hour: 'numeric', minute: '2-digit', hour12: false });
const plan = (tasks, events = [], extra = {}) => planSchedule(tasks, events, { start_day: '2026-10-12', horizon_days: 2, working_hours: week, slot_minutes: 30, ...extra });

test('priority ranks tasks among themselves and never decides whether a deadline binds', () => {
  const result = plan([
    { ...task('low-first-in-list', 60), priority: 'low' },
    { ...task('high', 60), priority: 'high' },
    { ...task('medium', 60), priority: 'medium' },
    { ...task('due-soon-low', 60, '2026-10-12T10:00:00-04:00'), priority: 'low' },
  ]);
  assert.deepEqual(result.proposals.map(row => [row.task_id, hhmm(row.starts_at)]), [
    ['due-soon-low', '09:00'], ['high', '10:00'], ['medium', '11:00'], ['low-first-in-list', '12:00'],
  ]);
});

test('a soft deadline places the task late, a hard one refuses it with the deadline as the reason, none ignores the date', () => {
  const busyMorning = [{ starts_at: '2026-10-12T13:00:00Z', ends_at: '2026-10-12T16:00:00Z' }];
  const due = '2026-10-12T11:00:00-04:00';
  const result = plan([
    { ...task('soft', 60, due), deadline_type: 'soft' },
    { ...task('hard', 60, due), deadline_type: 'hard' },
    { ...task('none', 60, due), deadline_type: 'none' },
  ], busyMorning);
  assert.deepEqual(result.proposals.map(row => [row.task_id, row.status, row.late]), [['soft', 'late', true], ['none', 'scheduled', false]]);
  assert.deepEqual(result.unscheduled.map(row => [row.task_id, row.reason]), [['hard', 'no_free_slot_before_deadline']]);
});

test('an unknown deadline type is refused with the invalid-deadline reason', () => {
  const result = plan([{ ...task('odd', 30), deadline_type: 'whenever' }]);
  assert.deepEqual(result.unscheduled.map(row => [row.task_id, row.reason]), [['odd', 'invalid_due']]);
});

test('a task starts no earlier than start_on and after the end of what blocks it', () => {
  const result = plan([
    { ...task('later', 30), start_on: '2026-10-13' },
    { ...task('second', 30), blocked_by: ['first'] },
    task('first', 60),
  ]);
  const at = Object.fromEntries(result.proposals.map(row => [row.task_id, [row.starts_at.slice(0, 10), hhmm(row.starts_at)]]));
  assert.deepEqual(at.first, ['2026-10-12', '09:00']);
  assert.deepEqual(at.second, ['2026-10-12', '10:00'], 'the blocked task waits for the 60-minute blocker even though it is listed first');
  assert.deepEqual(at.later, ['2026-10-13', '09:00']);
});

test('a blocker that could not be placed, is unknown, or forms a ring is the reason, with its ids', () => {
  const result = plan([
    task('too-long', 600),
    { ...task('waits', 30), blocked_by: ['too-long'] },
    { ...task('lost', 30), blocked_by: ['nobody'] },
    { ...task('ring-a', 30), blocked_by: ['ring-b'] },
    { ...task('ring-b', 30), blocked_by: ['ring-a'] },
    { ...task('outside', 30), blocked_by: ['elsewhere', 'finished'] },
  ], [], { blockers: { elsewhere: { ends_at: '2026-10-12T14:00:00-04:00' }, finished: { done: true } } });
  const why = Object.fromEntries(result.unscheduled.map(row => [row.task_id, [row.reason, row.blocker_ids ?? null]]));
  assert.deepEqual(why['too-long'], ['duration_exceeds_workday', null]);
  assert.deepEqual(why.waits, ['blocked_by_unscheduled', ['too-long']]);
  assert.deepEqual(why.lost, ['blocker_unknown', ['nobody']]);
  assert.deepEqual(why['ring-a'], ['blocker_cycle', ['ring-b']]);
  assert.deepEqual(why['ring-b'], ['blocker_cycle', ['ring-a']]);
  assert.equal(hhmm(result.proposals.find(row => row.task_id === 'outside').starts_at), '14:00', 'an external blocker end is a floor');
});

test('moving an automatic item pins it until its time passes, then the planner takes it back', () => {
  const placed = { ...task('moved', 60), starts_at: '2026-10-12T14:00:00-04:00', ends_at: '2026-10-12T15:00:00-04:00', auto_placed: true };
  const pinned = plan([{ ...placed, pinned_until: '2026-10-12T15:00:00-04:00' }, task('other', 60)], [], { earliest_at: '2026-10-12T09:00:00-04:00' });
  assert.deepEqual(pinned.kept.map(row => [row.task_id, row.reason, hhmm(row.starts_at)]), [['moved', 'pinned', '14:00']]);
  assert.deepEqual(pinned.released, []);
  assert.deepEqual(pinned.proposals.map(row => hhmm(row.starts_at)), ['09:00']);
  const expired = plan([{ ...placed, pinned_until: '2026-10-12T15:00:00-04:00' }], [], { earliest_at: '2026-10-12T15:30:00-04:00' });
  assert.deepEqual(expired.kept, []);
  assert.deepEqual(expired.released, ['moved']);
  assert.deepEqual(expired.proposals.map(row => hhmm(row.starts_at)), ['15:30']);
  const unpinned = plan([placed], [], { earliest_at: '2026-10-12T09:00:00-04:00' });
  assert.deepEqual(unpinned.proposals.map(row => hhmm(row.starts_at)), ['09:00'], 'an automatic item with no pin is re-planned');
  const manual = plan([{ ...placed, auto_placed: false }, task('next', 60)], [], { earliest_at: '2026-10-12T09:00:00-04:00' });
  assert.deepEqual(manual.kept.map(row => row.reason), ['fixed'], 'an item nobody asked the planner to place stays fixed');
});

test('a day capacity caps planned minutes, reports its caution band and prefers the capacity reason', () => {
  const result = plan([task('a', 120), task('b', 120), task('c', 120)], [], {
    horizon_days: 1, capacity: { default_minutes: 300, caution_band_minutes: 30 },
  });
  assert.deepEqual(result.proposals.map(row => row.task_id), ['a', 'b']);
  assert.deepEqual(result.unscheduled.map(row => [row.task_id, row.reason]), [['c', 'over_capacity']]);
  assert.deepEqual(result.days, [{ day: '2026-10-12', planned_minutes: 240, threshold_minutes: 300, level: 'ok' }]);
  const near = plan([task('a', 120), task('b', 150)], [], { horizon_days: 1, capacity: { default_minutes: 300, caution_band_minutes: 60 } });
  assert.equal(near.days[0].level, 'caution');
  const perWeekday = plan([task('a', 60)], [], { horizon_days: 2, capacity: { default_minutes: 300, weekdays: { 1: 30 } } });
  assert.equal(perWeekday.proposals[0].starts_at.slice(0, 10), '2026-10-13', 'Monday allows only 30 minutes, so the hour goes to Tuesday');
  assert.throws(() => plan([], [], { capacity: { default_minutes: 0 } }), TypeError);
});

test('a day can start later, stop early, block hours or be switched off', () => {
  const result = plan([task('one', 60), task('two', 60), task('three', 60)], [], { horizon_days: 3, day_overrides: [
    { day: '2026-10-12', start_minute: 15 * 60 },
    { day: '2026-10-13', blocks: [{ start_minute: 9 * 60, end_minute: 16 * 60 }] },
  ] });
  assert.deepEqual(result.proposals.map(row => [row.starts_at.slice(0, 10), hhmm(row.starts_at)]), [
    ['2026-10-12', '15:00'], ['2026-10-12', '16:00'], ['2026-10-13', '16:00'],
  ]);
  const off = plan([task('x', 30)], [], { day_overrides: [{ day: '2026-10-12', off: true }] });
  assert.equal(off.proposals[0].starts_at.slice(0, 10), '2026-10-13');
  const early = plan([task('x', 60)], [], { horizon_days: 1, day_overrides: [{ day: '2026-10-12', end_minute: 9 * 60 + 30 }] });
  assert.deepEqual(early.unscheduled.map(row => row.reason), ['no_free_slot_before_horizon']);
  assert.throws(() => plan([], [], { day_overrides: [{ day: '2026-10-12' }, { day: '2026-10-12' }] }), TypeError);
});

test('the order the planner places in is DATA the caller may replace', () => {
  const tasks = [task('short', 30), { ...task('long', 120), priority: 'high' }];
  assert.deepEqual(plan(tasks, [], { order_by: ['duration', 'input'] }).proposals.map(row => row.task_id), ['long', 'short']);
  assert.deepEqual(plan(tasks, [], { order_by: ['input'] }).proposals.map(row => row.task_id), ['short', 'long']);
  assert.throws(() => plan(tasks, [], { order_by: ['colour'] }), TypeError);
});

test('a task the planner takes back says where it was, whether it moves or cannot be placed again', () => {
  const placed = (id, at) => ({ ...task(id, 60), starts_at: at, ends_at: new Date(Date.parse(at) + 3600_000).toISOString(), auto_placed: true });
  const allDayBusy = [{ starts_at: '2026-10-12T13:00:00Z', ends_at: '2026-10-12T22:00:00Z' }];
  const result = plan([placed('moves', '2026-10-12T16:00:00Z'), placed('stuck', '2026-10-12T17:00:00Z')], allDayBusy, { horizon_days: 1, earliest_at: '2026-10-12T09:00:00-04:00' });
  assert.deepEqual(result.proposals, []);
  assert.deepEqual(result.unscheduled.map(row => [row.task_id, row.reason, row.was_at]), [
    ['moves', 'no_free_slot_before_horizon', '2026-10-12T16:00:00Z'], ['stuck', 'no_free_slot_before_horizon', '2026-10-12T17:00:00Z'],
  ]);
  const open = plan([placed('moves', '2026-10-12T16:00:00Z')], [], { horizon_days: 1, earliest_at: '2026-10-12T09:00:00-04:00' });
  assert.deepEqual(open.proposals.map(row => [row.task_id, hhmm(row.starts_at), row.was_at]), [['moves', '09:00', '2026-10-12T16:00:00Z']]);
});

test('a task too long to fit whole is placed in slices no shorter than its smallest useful slice, all or none', () => {
  // Free: 09:00-10:00, 11:00-12:00 and 13:00-14:30.
  const busy = [{ starts_at: '2026-10-12T14:00:00Z', ends_at: '2026-10-12T15:00:00Z' }, { starts_at: '2026-10-12T16:00:00Z', ends_at: '2026-10-12T17:00:00Z' }, { starts_at: '2026-10-12T18:30:00Z', ends_at: '2026-10-12T21:00:00Z' }];
  const result = plan([{ ...task('long', 150), minimum_duration_minutes: 60 }], busy, { horizon_days: 1 });
  assert.deepEqual(result.proposals.map(row => [hhmm(row.starts_at), row.duration_minutes, `${row.chunk_index}/${row.chunk_count}`]), [['09:00', 60, '1/2'], ['13:00', 90, '2/2']],
    'the 11:00 hour would leave a 30-minute remainder, shorter than the smallest slice, so it is passed over');
  const tooBig = plan([{ ...task('long', 150), minimum_duration_minutes: 100 }], busy, { horizon_days: 1 });
  assert.deepEqual(tooBig.proposals, [], 'no free stretch holds the smallest slice: nothing is placed and nothing is left half done');
  assert.deepEqual(tooBig.unscheduled.map(row => row.reason), ['no_free_slot_before_horizon']);
  const whole = plan([{ ...task('fits', 60), minimum_duration_minutes: 30 }], [], { horizon_days: 1 });
  assert.equal(whole.proposals.length, 1, 'a task that fits whole is not sliced');
  assert.equal(whole.proposals[0].chunk_index, undefined);
  const overDay = plan([{ ...task('week', 600), minimum_duration_minutes: 120 }], [], { horizon_days: 2 });
  assert.equal(overDay.proposals.reduce((sum, row) => sum + row.duration_minutes, 0), 600, 'a task longer than a working day is spread over days');
});
