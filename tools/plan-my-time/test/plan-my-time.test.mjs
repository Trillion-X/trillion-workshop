// tools/plan-my-time/test/plan-my-time.test.mjs
//
// The plan's behaviour on small weeks: what goes first, how long tasks split around busy time, what waits for its
// blockers, where a hard deadline may spill past working hours, which meetings are proposed for decline, how a day
// over its cap names what to move, and what is not planned at all. Monday 2026-10-19 09:00 in New York is 13:00Z.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { planMyTime as plan } from '../do-work/plan-my-time.mjs';

const base = {
  now: '2026-10-19T13:00:00Z', time_zone: 'America/New_York', window_days: 3,
  pursuits: [{ id: 'main-project', needle_mover: true }, { id: 'hobby' }],
};
const task = (result, id) => result.tasks.find(item => item.id === id);
const busy = (start, end, more = {}) => ({ start: `2026-10-19T${start}:00Z`, end: `2026-10-19T${end}:00Z`, ...more });

test('ASAP goes first, then what serves the pursuit that matters most, then the rest', () => {
  const r = plan({ ...base, tasks: [
    { id: 'low', duration_minutes: 60, priority: 'low' },
    { id: 'needle', duration_minutes: 60, pursuit_ids: ['main-project'] },
    { id: 'asap', duration_minutes: 30, priority: 'asap' },
  ] });
  assert.equal(task(r, 'asap').pieces[0].start, '2026-10-19T13:00:00.000Z');
  assert.equal(task(r, 'needle').pieces[0].start, '2026-10-19T13:30:00.000Z');
  assert.equal(task(r, 'low').pieces[0].start, '2026-10-19T14:30:00.000Z');
});

test('a long task is split around busy time, and a short one is never split', () => {
  let r = plan({ ...base, busy: [busy('14:00', '15:00')], tasks: [{ id: 'big', duration_minutes: 240 }] });
  assert.deepEqual(r.tasks[0].pieces, [
    { start: '2026-10-19T13:00:00.000Z', end: '2026-10-19T14:00:00.000Z' },
    { start: '2026-10-19T15:00:00.000Z', end: '2026-10-19T18:00:00.000Z' },
  ]);
  r = plan({ ...base, busy: [busy('14:00', '15:00')], tasks: [{ id: 'whole', duration_minutes: 90 }] });
  assert.equal(r.tasks[0].pieces.length, 1);
  assert.equal(r.tasks[0].pieces[0].start, '2026-10-19T15:00:00.000Z');
});

test('a task waits for what blocks it, even when it is more urgent', () => {
  const r = plan({ ...base, tasks: [{ id: 'b', duration_minutes: 30, blocked_by: ['a'], priority: 'asap' }, { id: 'a', duration_minutes: 30 }] });
  assert.ok(task(r, 'b').pieces[0].start > task(r, 'a').pieces[0].start);
});

test('a hard deadline may use time outside working hours; a soft one that does not fit says so', () => {
  const day = { ...base, window_days: 1, schedule: { monday: [{ from: '09:00', to: '10:00' }] } };
  let r = plan({ ...day, tasks: [{ id: 'hard', duration_minutes: 120, deadline: 'hard', due: '2026-10-19T17:00:00Z' }] });
  assert.equal(r.tasks[0].fit, 'on_track');
  assert.match(r.tasks[0].said, /outside your working hours/);
  r = plan({ ...day, tasks: [{ id: 'soft', duration_minutes: 120, due: '2026-10-19T17:00:00Z' }] });
  assert.equal(r.tasks[0].fit, 'unfit_past_due');
});

test('a meeting that serves no pursuit is proposed for decline when it keeps needle-moving work from its deadline; a pursuit meeting is kept', () => {
  const day = { ...base, window_days: 1, schedule: { monday: [{ from: '09:00', to: '10:00' }] } };
  const r = plan({ ...day,
    meetings: [{ id: 'chat', start: '2026-10-19T13:00:00Z', end: '2026-10-19T13:30:00Z' }, { id: 'practice', start: '2026-10-19T13:30:00Z', end: '2026-10-19T14:00:00Z', pursuit_ids: ['hobby'] }],
    tasks: [{ id: 'ship', duration_minutes: 30, pursuit_ids: ['main-project'], due: '2026-10-19T14:00:00Z' }] });
  assert.equal(r.meetings.find(m => m.id === 'chat').verdict, 'propose_decline');
  assert.equal(r.meetings.find(m => m.id === 'practice').verdict, 'keep');
  assert.equal(r.tasks[0].fit, 'on_track');
  assert.match(r.meetings.find(m => m.id === 'chat').said, /serves none of your pursuits/);
});

test('a required meeting is never proposed for decline', () => {
  const day = { ...base, window_days: 1, schedule: { monday: [{ from: '09:00', to: '10:00' }] } };
  const r = plan({ ...day, meetings: [{ id: 'must', required: true, start: '2026-10-19T13:00:00Z', end: '2026-10-19T13:30:00Z' }],
    tasks: [{ id: 'ship', duration_minutes: 45, pursuit_ids: ['main-project'], due: '2026-10-19T14:00:00Z' }] });
  assert.equal(r.meetings[0].verdict, 'keep');
});

test('a task with no length, an unfinished-nothing task and a long-stale deadline are not planned, each with its reason', () => {
  const r = plan({ ...base, tasks: [
    { id: 'tbd' },
    { id: 'finished', duration_minutes: 30, done_minutes: 30 },
    { id: 'old', duration_minutes: 30, due: '2026-09-01T00:00:00Z' },
  ] });
  assert.deepEqual(r.tasks.map(item => item.fit), ['not_planned', 'not_planned', 'not_planned']);
  assert.deepEqual(r.tasks.map(item => item.said), ['It has no length yet.', 'It is already done.', 'Its deadline passed more than 14 days ago.']);
});

test('busy events that are declined, all-day or shown as free take no time', () => {
  const r = plan({ ...base, busy: [
    busy('13:00', '14:00', { response: 'declined' }),
    { start: '2026-10-19T13:00:00Z', end: '2026-10-20T13:00:00Z', all_day: true },
    busy('13:00', '14:00', { show_as: 'free' }),
  ], tasks: [{ id: 'x', duration_minutes: 30 }] });
  assert.equal(r.tasks[0].pieces[0].start, '2026-10-19T13:00:00.000Z');
});

test('a gap is kept after a busy event', () => {
  const r = plan({ ...base, gap_minutes: 10, busy: [busy('13:00', '13:30')], tasks: [{ id: 'g', duration_minutes: 30 }] });
  assert.equal(r.tasks[0].pieces[0].start, '2026-10-19T13:40:00.000Z');
});

test('a fixed-time task is held exactly, even before working hours, others work around it, and a clash is a conflict', () => {
  let r = plan({ ...base, tasks: [{ id: 'free', duration_minutes: 60 }, { id: 'standup', duration_minutes: 30, preferred_start: '2026-10-19T22:30:00Z', rigid: true }] });
  assert.equal(task(r, 'standup').pieces[0].start, '2026-10-19T22:30:00.000Z');
  assert.equal(task(r, 'standup').rigid, true);
  assert.equal(task(r, 'free').pieces[0].start, '2026-10-19T13:00:00.000Z');
  r = plan({ ...base, tasks: [{ id: 'free', duration_minutes: 60 }, { id: 'standup', duration_minutes: 30, preferred_start: '2026-10-19T13:00:00Z', rigid: true }] });
  assert.equal(task(r, 'standup').pieces[0].start, '2026-10-19T13:00:00.000Z');
  assert.equal(task(r, 'free').pieces[0].start, '2026-10-19T13:30:00.000Z');
  r = plan({ ...base, busy: [busy('13:00', '14:00')], tasks: [{ id: 'clash', duration_minutes: 30, preferred_start: '2026-10-19T13:00:00Z', rigid: true }] });
  assert.equal(r.tasks[0].fit, 'conflict');
});

test('a task that names a schedule lands in that schedule\'s hours', () => {
  const r = plan({ ...base, schedules: { evenings: { monday: [{ from: '17:00', to: '19:00' }] } }, tasks: [{ id: 'hit', duration_minutes: 60, schedule: 'evenings' }] });
  assert.equal(r.tasks[0].pieces[0].start, '2026-10-19T21:00:00.000Z');
});

test('a task that has moved day after day is placed but asks for a decision', () => {
  const r = plan({ ...base, tasks: [{ id: 'again', duration_minutes: 30, rolled_over: 2 }] });
  assert.equal(r.tasks[0].fit, 'needs_decision');
  assert.ok(r.tasks[0].pieces);
  assert.match(r.tasks[0].said, /moved 2 days in a row/);
});

test('a day over its cap names the lowest-value tasks to move first; an end-of-day override shortens the day', () => {
  let r = plan({ ...base, window_days: 1, rules: { daily_cap_minutes: { monday: 120 } }, tasks: [
    { id: 'needle', duration_minutes: 90, pursuit_ids: ['main-project'] },
    { id: 'meh', duration_minutes: 90, priority: 'low' },
  ] });
  const monday = r.days.find(d => d.date === '2026-10-19');
  assert.equal(monday.planned_minutes, 180);
  assert.equal(monday.over_by_minutes, 60);
  assert.deepEqual(monday.bump, ['meh']);
  r = plan({ ...base, window_days: 1, end_of_day: { '2026-10-19': '10:00' }, tasks: [{ id: 'long', duration_minutes: 90 }] });
  assert.notEqual(r.tasks[0].fit, 'on_track');
});

test('a task planned for a day without a length still shows its day', () => {
  const r = plan({ ...base, tasks: [{ id: 'later', planned_for: '2026-10-20' }] });
  assert.ok(r.days.some(d => d.date === '2026-10-20'));
});

test('the plan says when and in which zone it was made, and a request that is not an object is refused', () => {
  const r = plan({ ...base, tasks: [] });
  assert.equal(r.planned_at, '2026-10-19T13:00:00.000Z');
  assert.equal(r.time_zone, 'America/New_York');
  assert.throws(() => plan(null), /must be an object/);
  assert.throws(() => plan([]), /must be an object/);
});

// The row's own sample run, through the command the row names (the packed folders sit side by side here as they do under /opt).
test('the row\'s sample run answers through the command the row runs', () => {
  const folder = new URL('../', import.meta.url);
  const row = JSON.parse(readFileSync(new URL('tool-rows.json', folder), 'utf8')).records[0].payload;
  const [sample] = row.verify;
  const door = fileURLToPath(new URL('../records-door/do-work/run-an-export.mjs', folder));
  const module = fileURLToPath(new URL('do-work/plan-my-time.mjs', folder));
  assert.deepEqual(row.invoke.argv.slice(-2), ['/opt/plan-my-time/do-work/plan-my-time.mjs', 'planMyTime']);
  const run = spawnSync('node', [door, module, 'planMyTime'], { input: JSON.stringify(sample.input), encoding: 'utf8' });
  assert.equal(run.status, 0, run.stderr);
  const answer = JSON.parse(run.stdout.trim().split('\n').at(-1));
  assert.equal(answer.result.tasks[0].fit, sample.contains);
  assert.deepEqual(answer.result.tasks[0].pieces, [{ start: '2026-10-19T13:00:00.000Z', end: '2026-10-19T13:30:00.000Z' }]);
});
