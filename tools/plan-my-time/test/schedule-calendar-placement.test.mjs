// The calendar things are dragged onto (tools/plan-my-time/do-work/schedule-placement.mjs): which days each view
// shows, the span a view reads, moving back and forward, the time a drop means, and where overlapping things sit in an
// hour lane. Run in a fixed zone that changes its clocks inside the tested months, so a day never slips.
process.env.TZ = 'America/New_York';
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  addDays, allDayBannerLayout, dayDropTime, dayKey, durationAtDelta, itemsByDay, laneLayout, minuteAtOffset, minuteOf, moveToMonth, shiftAnchor, timeAt, visibleDays, visibleRange, weekNumber, weekStart,
} from '../do-work/schedule-placement.mjs';

const MONTH = { grid: 'month' };
const WEEK = { grid: 'hours', days: 7 };
const DAY = { grid: 'hours', days: 1 };

test('all-day spans appear on each visible month date and stop at the exclusive end', () => {
  const long = { id: 'before-view', at: '2026-05-20', dayEnd: '2026-06-10' };
  const bad = { id: 'invalid-end', at: '2026-06-08', dayEnd: 'tomorrow' };
  const days = ['2026-06-07', '2026-06-08', '2026-06-09', '2026-06-10'];
  const grouped = itemsByDay([long, bad], days);
  assert.deepEqual([...grouped].map(([day, rows]) => [day, rows.map(row => row.id)]), [
    ['2026-06-07', ['before-view']], ['2026-06-08', ['before-view', 'invalid-end']], ['2026-06-09', ['before-view']],
  ]);
  assert.equal(allDayBannerLayout([bad], days)[0].columnSpan, 1);
  assert.equal(allDayBannerLayout([{ ...bad, dayEnd: '2026-99-99' }], days)[0].columnSpan, 1);
});

test('all-day bars use exclusive ends, clip to visible columns, and stack overlapping spans by row', () => {
  const days = ['2026-06-07', '2026-06-08', '2026-06-09', '2026-06-10', '2026-06-11', '2026-06-12', '2026-06-13'];
  const spans = allDayBannerLayout([
    { id: 'left-clipped', at: '2026-06-05', dayEnd: '2026-06-09' },
    { id: 'overlap', at: '2026-06-08', dayEnd: '2026-06-10' },
    { id: 'right-clipped', at: '2026-06-12', dayEnd: '2026-06-16' },
    { id: 'single', at: '2026-06-10' },
  ], days);
  assert.deepEqual(spans.map(({ item, startColumn, columnSpan, row }) => [item.id, startColumn, columnSpan, row]), [
    ['left-clipped', 0, 2, 0],
    ['overlap', 1, 2, 1],
    ['single', 3, 1, 0],
    ['right-clipped', 5, 2, 0],
  ]);
});

test('all-day row packing uses span intervals and does not merge duplicate caller identities', () => {
  const spans = allDayBannerLayout([
    { id: 'same', day: '2026-06-08', dayEnd: '2026-06-11' },
    { id: 'same', day: '2026-06-09', dayEnd: '2026-06-10' },
    { id: 'after', day: '2026-06-11', dayEnd: '2026-06-12' },
  ], ['2026-06-08', '2026-06-09', '2026-06-10', '2026-06-11']);
  assert.deepEqual(spans.map(({ startColumn, columnSpan, row }) => [startColumn, columnSpan, row]), [[0, 3, 0], [1, 1, 1], [3, 1, 0]]);
});

test('a month shows six weeks from the Sunday on or before the first', () => {
  const days = visibleDays(MONTH, '2026-10-17');
  assert.equal(days.length, 42);
  assert.equal(days[0], '2026-09-27');
  assert.equal(days[4], '2026-10-01');
  assert.equal(days.at(-1), '2026-11-07');
  assert.equal(new Set(days).size, 42, 'the day the clocks change is one day, not two');
  assert.equal(visibleDays(MONTH, '2026-10-17', 1)[0], '2026-09-28', 'a week can start on Monday');
});

test('a week of hour lanes starts on the week\'s first day; one day starts on the anchor', () => {
  assert.deepEqual(visibleDays(WEEK, '2026-09-30'), ['2026-09-27', '2026-09-28', '2026-09-29', '2026-09-30', '2026-10-01', '2026-10-02', '2026-10-03']);
  assert.deepEqual(visibleDays(DAY, '2026-09-30'), ['2026-09-30']);
  assert.deepEqual(visibleDays({ grid: 'hours', days: 3 }, '2026-09-30'), ['2026-09-30', '2026-10-01', '2026-10-02']);
  assert.equal(weekStart('2026-09-27'), '2026-09-27');
});

test('the span a view reads runs from its first midnight to the midnight after its last day', () => {
  assert.deepEqual(visibleRange(WEEK, '2026-09-30'), { from: '2026-09-27T04:00:00.000Z', to: '2026-10-04T04:00:00.000Z' });
  // November's board ends after the clocks go back: the last midnight is five hours behind UTC.
  const november = visibleRange(MONTH, '2026-11-12');
  assert.equal(november.from, '2026-11-01T04:00:00.000Z');
  assert.equal(november.to, '2026-12-13T05:00:00.000Z');
});

test('moving back and forward goes by a calendar month, a week, or a day', () => {
  assert.equal(shiftAnchor(MONTH, '2026-01-31', 1), '2026-02-01');
  assert.equal(shiftAnchor(MONTH, '2026-01-15', -1), '2025-12-01');
  assert.equal(shiftAnchor(WEEK, '2026-09-30', 1), '2026-10-07');
  assert.equal(shiftAnchor(DAY, '2026-11-01', 1), '2026-11-02');
  assert.equal(addDays('2026-03-08', 1), '2026-03-09', 'the spring-forward day is still one day');
});

test('a pointer height in an hour lane means a time on the snap grid, inside the window', () => {
  const lane = { windowStart: 0, windowEnd: 1440, snap: 15 };
  assert.equal(minuteAtOffset(0, 1152, lane), 0);
  assert.equal(minuteAtOffset(1152 / 2, 1152, lane), 720);
  assert.equal(minuteAtOffset(1152 * (9.1 / 24), 1152, lane), 540, '9:06 snaps to 9:00');
  assert.equal(minuteAtOffset(1152 * (9.2 / 24), 1152, lane), 555, '9:12 snaps to 9:15');
  assert.equal(minuteAtOffset(5000, 1152, lane), 1425, 'below the lane is the last slot of the day');
  assert.equal(minuteAtOffset(-40, 1152, lane), 0);
  assert.equal(minuteAtOffset(100, 0, lane), 1425, 'a lane with no height still answers inside the day');
  assert.equal(minuteAtOffset(0, 840, { windowStart: 420, windowEnd: 1260, snap: 30 }), 420);
});

test('a resize edge changes duration by its vertical delta, snaps, and stays inside the caller bounds', () => {
  assert.equal(durationAtDelta(30, 15, 60, { snap: 15, min: 15, max: 120 }), 45, '15px at 60px/hour adds 15 minutes');
  assert.equal(durationAtDelta(30, -120, 60, { snap: 15, min: 15, max: 120 }), 15, 'shortening stops at the minimum');
  assert.equal(durationAtDelta(30, 500, 60, { snap: 15, min: 15, max: 120 }), 120, 'lengthening stops at the lane boundary');
  assert.equal(durationAtDelta(30, 4, 60, { snap: 15, min: 15, max: 120 }), 30, 'small pointer movement remains on the current slot');
  assert.equal(durationAtDelta(30, 15, 0, { snap: 15, min: 15, max: 120 }), 120, 'a zero-height scale still returns a finite bounded result');
});

test('a time is named on its own day, and a whole-day drop keeps the time of day', () => {
  assert.equal(timeAt('2026-10-01', 570), '2026-10-01T13:30:00.000Z');
  assert.equal(timeAt('2026-11-02', 570), '2026-11-02T14:30:00.000Z', 'after the clocks go back, 9:30 is an hour later in UTC');
  assert.equal(minuteOf('2026-10-01T13:30:00.000Z'), 570);
  assert.equal(dayDropTime('2026-11-05', '2026-10-01T13:30:00.000Z'), '2026-11-05T14:30:00.000Z');
  assert.equal(dayDropTime('2026-10-09', null), '2026-10-09T13:00:00.000Z', 'with no time yet it takes 9:00');
  assert.equal(dayDropTime('2026-10-09', 'not a time', 600), '2026-10-09T14:00:00.000Z');
});

test('things are grouped by the local day they fall on, earliest first; things with no time are left out', () => {
  const days = itemsByDay([
    { id: 'late', at: '2026-10-02T03:30:00.000Z' },
    { id: 'b', at: '2026-10-01T20:00:00.000Z' },
    { id: 'a', at: '2026-10-01T13:00:00.000Z' },
    { id: 'none', at: null },
    { id: 'bad', at: 'soon' },
  ]);
  assert.deepEqual([...days.keys()], ['2026-10-01']);
  assert.deepEqual(days.get('2026-10-01').map(item => item.id), ['a', 'b', 'late'], '11:30 pm local is still the first of October');
  assert.equal(dayKey(new Date(2026, 9, 1, 23, 30)), '2026-10-01');
});

test('overlapping things share an hour lane side by side; apart, each takes the whole lane', () => {
  const at = minute => timeAt('2026-10-01', minute);
  const laid = laneLayout([
    { id: 'a', at: at(540) },
    { id: 'b', at: at(550) },
    { id: 'c', at: at(565) },
    { id: 'd', at: at(575) },
    { id: 'e', at: at(720) },
  ], 30);
  const by = Object.fromEntries(laid.map(entry => [entry.item.id, [entry.startMinute, entry.endMinute, entry.column, entry.columnCount]]));
  assert.deepEqual(by.a, [540, 570, 0, 3]);
  assert.deepEqual(by.b, [550, 580, 1, 3]);
  assert.deepEqual(by.c, [565, 595, 2, 3]);
  assert.deepEqual(by.d, [575, 605, 0, 3], 'a column frees once its thing ends');
  assert.deepEqual(by.e, [720, 750, 0, 1]);
  assert.deepEqual(laneLayout([]), []);
});

test('a rolling week starts on the anchor day, a plain week on the first day of the week', () => {
  assert.equal(visibleDays({ grid: 'hours', days: 7 }, '2026-06-10', 0)[0], '2026-06-07');
  assert.equal(visibleDays({ grid: 'hours', days: 7, rolling: true }, '2026-06-10', 0)[0], '2026-06-10');
  assert.equal(visibleDays({ grid: 'hours', days: 7, rolling: true }, '2026-06-10', 0).at(-1), '2026-06-16');
});

test('the week crumb numbers the week the way people count it', () => {
  assert.equal(weekNumber('2026-06-10', 0), 24);
  assert.equal(weekNumber('2026-06-10', 1), 24);
  assert.equal(weekNumber('2026-01-01', 0), 1);
  assert.equal(weekNumber('2024-12-30', 1), 1);
  assert.equal(weekNumber('2026-12-31', 1), 53);
});

test('another month of the same year keeps the day, or the last day of a shorter month', () => {
  assert.equal(moveToMonth('2026-06-10', 0), '2026-01-10');
  assert.equal(moveToMonth('2026-03-31', 1), '2026-02-28');
  assert.equal(moveToMonth('2024-03-31', 1), '2024-02-29');
});
