// Carries the package's overlap-packing and view cases, and adds the person's own days (a UTC offset), month and agenda
// layouts, clashes, and a view the code never named.
import test from 'node:test';
import assert from 'node:assert/strict';
import { chooseView, clashesOf, layOutView, monthGridDays, packOverlappingBlocks, parseViewDescriptor, timeGridDays } from '../read-data/calendar-views.mjs';

const slot = (id, startMinute, endMinute) => ({ id, startMinute, endMinute });
const block = (id, start, end, allDay = false) => ({ id, interval: { start, end, allDay } });
const view = (over = {}) => ({ kind: 'calendar-view-descriptor', view_id: 'v', layout: 'time-grid', ...over });

test('blocks that do not overlap each take the full column', () => {
  assert.deepEqual(packOverlappingBlocks([slot('a', 0, 60), slot('b', 60, 120)]), [
    { id: 'a', column: 0, columnCount: 1 },
    { id: 'b', column: 0, columnCount: 1 },
  ]);
});

test('two overlapping blocks split into two equal columns', () => {
  const out = packOverlappingBlocks([slot('a', 0, 90), slot('b', 30, 120)]);
  assert.deepEqual(out.find(p => p.id === 'a'), { id: 'a', column: 0, columnCount: 2 });
  assert.deepEqual(out.find(p => p.id === 'b'), { id: 'b', column: 1, columnCount: 2 });
});

test('a freed column is reused and a cluster keeps one denominator', () => {
  const out = packOverlappingBlocks([slot('a', 0, 60), slot('b', 0, 60), slot('c', 30, 120), slot('d', 70, 130)]);
  const byId = Object.fromEntries(out.map(p => [p.id, p]));
  assert.equal(byId.c.column, 2);
  assert.equal(byId.d.column, 0);
  assert.deepEqual(new Set(out.map(p => p.columnCount)), new Set([3]));
});

test('thirty identical blocks pack into thirty columns, deterministically', () => {
  const inputs = Array.from({ length: 30 }, (_, index) => slot(`b${String(index).padStart(2, '0')}`, 0, 60));
  const out = packOverlappingBlocks(inputs);
  assert.equal(new Set(out.map(p => p.column)).size, 30);
  assert.ok(out.every(p => p.columnCount === 30));
  assert.deepEqual(packOverlappingBlocks([...inputs].reverse()), out);
});

test('separate clusters do not share a denominator, and only clusters of two or more are clashes', () => {
  const inputs = [slot('a', 0, 60), slot('b', 30, 90), slot('c', 200, 260)];
  const byId = Object.fromEntries(packOverlappingBlocks(inputs).map(p => [p.id, p]));
  assert.equal(byId.a.columnCount, 2);
  assert.equal(byId.c.columnCount, 1);
  assert.deepEqual(clashesOf(inputs), [['a', 'b']]);
});

test('a descriptor parses, a malformed one does not, and the same id keeps the last one given', () => {
  assert.equal(parseViewDescriptor(view({ view_id: 'x', label: 'X', order: 5 })).view_id, 'x');
  assert.equal(parseViewDescriptor({ kind: 'other', view_id: 'x', layout: 'time-grid' }), null);
  assert.equal(parseViewDescriptor({ kind: 'calendar-view-descriptor', layout: 'time-grid' }), null);
  const chosen = chooseView([view({ view_id: 'day', order: 10 }), view({ view_id: 'week', order: 20, label: 'A week' }), view({ view_id: 'week', order: 20, label: 'My week' }), view({ view_id: 'early', order: 1 })], 'week');
  assert.deepEqual(chosen.views.map(v => v.view_id), ['early', 'day', 'week']);
  assert.equal(chosen.active.label, 'My week');
  assert.equal(chooseView([view({ view_id: 'only' })], 'unknown').active.view_id, 'only');
  assert.equal(chooseView([], 'x').active, null);
});

// 2026-06-24 is a Wednesday, so aligning to the week and starting at the anchor give different columns.
test('day_count sets the columns, a week or a skip of weekends starts on Monday, and a work week is Monday to Friday', () => {
  assert.equal(timeGridDays('2026-06-24', view({ day_count: 1 })).length, 1);
  assert.deepEqual(timeGridDays('2026-06-24', view({ day_count: 3 })).map(d => d.key), ['2026-06-24', '2026-06-25', '2026-06-26']);
  const week = timeGridDays('2026-06-24', view({ day_count: 7 }));
  assert.equal(week[0].key, '2026-06-22');
  assert.equal(week.length, 7);
  const work = timeGridDays('2026-06-24', view({ day_count: 5, skip_weekends: true }));
  assert.deepEqual(work.map(d => d.weekday), [1, 2, 3, 4, 5]);
});

test('the month grid is six Monday-first weeks that hold the month', () => {
  const days = monthGridDays('2026-06-24');
  assert.equal(days.length, 42);
  assert.equal(days[0].key, '2026-06-01');
  assert.equal(days[0].weekday, 1);
  assert.equal(days.filter(d => d.in_month).length, 30);
  assert.equal(monthGridDays('2026-02-10')[0].key, '2026-01-26');
});

test('a time grid puts each block on the day it starts, its overlaps in columns, and names the clash', () => {
  const answer = layOutView({
    views: [view({ day_count: 2 })],
    anchor: '2026-06-24T12:00:00Z',
    blocks: [
      block('early', '2026-06-24T09:00:00Z', '2026-06-24T10:00:00Z'),
      block('overlap', '2026-06-24T09:30:00Z', '2026-06-24T10:30:00Z'),
      block('late', '2026-06-25T15:00:00Z', '2026-06-25T16:00:00Z'),
      block('holiday', '2026-06-24', '2026-06-25', true),
      block('bad', 'never', 'never'),
    ],
  });
  assert.equal(answer.anchor_day, '2026-06-24');
  assert.deepEqual(answer.days[0].all_day, ['holiday']);
  assert.deepEqual(answer.days[0].timed, [
    { id: 'early', start_minute: 540, end_minute: 600, column: 0, column_count: 2 },
    { id: 'overlap', start_minute: 570, end_minute: 630, column: 1, column_count: 2 },
  ]);
  assert.deepEqual(answer.days[1].timed, [{ id: 'late', start_minute: 900, end_minute: 960, column: 0, column_count: 1 }]);
  assert.deepEqual(answer.clashes, [{ day: '2026-06-24', ids: ['early', 'overlap'] }]);
  assert.deepEqual(answer.skipped, ['bad']);
});

test('the person\'s own day: an offset moves a block across midnight, and an all-day date stays where it is', () => {
  const blocks = [block('night', '2026-06-25T02:00:00Z', '2026-06-25T03:00:00Z'), block('date', '2026-06-25', '2026-06-26', true)];
  const utc = layOutView({ views: [view({ day_count: 1 })], anchor: '2026-06-25T12:00:00Z', blocks });
  assert.deepEqual(utc.days[0].timed.map(t => [t.id, t.start_minute]), [['night', 120]]);
  const west = layOutView({ views: [view({ day_count: 1 })], anchor: '2026-06-25T12:00:00Z', blocks, utc_offset_minutes: -360 });
  assert.equal(west.days[0].key, '2026-06-25');
  assert.deepEqual(west.days[0].timed, []);
  assert.deepEqual(west.days[0].all_day, ['date']);
  const day24 = layOutView({ views: [view({ day_count: 1 })], anchor: '2026-06-24T12:00:00Z', blocks, utc_offset_minutes: -360 });
  assert.deepEqual(day24.days[0].timed.map(t => [t.id, t.start_minute]), [['night', 20 * 60]]);
});

test('a block that runs past midnight ends at the last minute of its day', () => {
  const answer = layOutView({ views: [view()], anchor: '2026-06-24T00:00:00Z', blocks: [block('long', '2026-06-24T23:00:00Z', '2026-06-25T02:00:00Z')] });
  assert.equal(answer.days[0].timed[0].end_minute, 1440);
});

test('a month cell shows at most its cap and says how many more; an agenda lists only the days that have blocks', () => {
  const blocks = ['a', 'b', 'c'].map((id, index) => block(id, `2026-06-10T0${index + 1}:00:00Z`, `2026-06-10T0${index + 1}:30:00Z`)).concat(block('d', '2026-06-20T08:00:00Z', '2026-06-20T09:00:00Z'));
  const month = layOutView({ views: [view({ view_id: 'month', layout: 'month-grid', max_chips_per_cell: 2 })], anchor: '2026-06-10T00:00:00Z', blocks });
  const tenth = month.days.find(day => day.key === '2026-06-10');
  assert.deepEqual(tenth.shown, ['a', 'b']);
  assert.equal(tenth.more, 1);
  const agenda = layOutView({ views: [view({ view_id: 'agenda', layout: 'agenda-list' })], blocks });
  assert.deepEqual(agenda.days.map(day => [day.key, day.blocks]), [['2026-06-10', ['a', 'b', 'c']], ['2026-06-20', ['d']]]);
  assert.equal(agenda.anchor_day, '2026-06-10');
});

test('a view the code never named works from its row alone, and an unknown geometry is a notice, never a failure', () => {
  const blocks = [block('a', '2026-06-24T09:00:00Z', '2026-06-24T10:00:00Z')];
  const three = layOutView({ views: [view({ view_id: 'three-day', day_count: 3 }), view({ view_id: 'globe', layout: 'orbital-3d', order: 60 })], view_id: 'three-day', blocks });
  assert.equal(three.days.length, 3);
  const globe = layOutView({ views: [view({ view_id: 'globe', layout: 'orbital-3d' })], view_id: 'globe', blocks });
  assert.deepEqual(globe.days, []);
  assert.match(globe.notice, /orbital-3d/);
  assert.match(layOutView({ views: [], blocks }).notice, /No view/);
});

test('there is no clock: with nothing to pick the day from, it says so', () => {
  assert.match(layOutView({ views: [view()], blocks: [] }).notice, /anchor or a range_start/);
  assert.equal(layOutView({ views: [view()], blocks: [], range_start: '2026-06-24T00:00:00Z' }).anchor_day, '2026-06-24');
  const selected = layOutView({ views: [view()], blocks: [block('x', '2026-07-01T00:00:00Z', '2026-07-01T01:00:00Z'), block('y', '2026-07-09T00:00:00Z', '2026-07-09T01:00:00Z')], selected_block_id: 'y' });
  assert.equal(selected.anchor_day, '2026-07-09');
});
