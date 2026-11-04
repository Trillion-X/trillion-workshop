import test from 'node:test';
import assert from 'node:assert/strict';
import { quietHoursAnswer } from '../do-work/quiet-hours.ts';

const ny = { start: '09:00', end: '17:00', time_zone: 'America/New_York', weekdays: [1, 2, 3, 4, 5] };
const at = iso => Date.parse(iso);

test('inside working hours nothing is said; outside, the person\'s mode decides', () => {
  assert.equal(quietHoursAnswer(ny, at('2026-10-14T14:00:00Z')).quiet, false, '10:00 in New York on a Wednesday');
  const night = quietHoursAnswer(ny, at('2026-10-14T23:30:00Z'));
  assert.deepEqual([night.quiet, night.nudge, night.send_silently], [true, true, false]);
  assert.equal(night.period_start_ms, at('2026-10-14T21:00:00Z'), 'the quiet period began at 17:00 local');
  assert.equal(night.opens_at_ms, at('2026-10-15T13:00:00Z'));
  assert.deepEqual(quietHoursAnswer(ny, at('2026-10-14T23:30:00Z'), 'auto_silent').send_silently, true);
  assert.deepEqual(quietHoursAnswer(ny, at('2026-10-14T23:30:00Z'), 'none').nudge, false);
  assert.equal(quietHoursAnswer(null, at('2026-10-14T23:30:00Z')).quiet, false, 'no working hours set: never quiet');
});

test('a weekend is quiet until Monday morning', () => {
  const saturday = quietHoursAnswer(ny, at('2026-10-17T16:00:00Z'));
  assert.equal(saturday.quiet, true);
  assert.equal(saturday.period_start_ms, at('2026-10-16T21:00:00Z'));
  assert.equal(saturday.opens_at_ms, at('2026-10-19T13:00:00Z'));
});

test('an end before the start is an overnight shift', () => {
  const night = { start: '22:00', end: '06:00', time_zone: 'UTC' };
  assert.equal(quietHoursAnswer(night, at('2026-10-14T23:00:00Z')).quiet, false);
  assert.equal(quietHoursAnswer(night, at('2026-10-15T05:59:00Z')).quiet, false);
  const day = quietHoursAnswer(night, at('2026-10-15T12:00:00Z'));
  assert.deepEqual([day.quiet, day.period_start_ms, day.opens_at_ms], [true, at('2026-10-15T06:00:00Z'), at('2026-10-15T22:00:00Z')]);
});

test('a dismissal lasts only for the quiet period it was made in', () => {
  const first = quietHoursAnswer(ny, at('2026-10-14T23:30:00Z'));
  assert.equal(quietHoursAnswer(ny, at('2026-10-15T01:00:00Z'), 'nudge', first.period_start_ms).nudge, false, 'same period: stays dismissed');
  assert.equal(quietHoursAnswer(ny, at('2026-10-15T23:30:00Z'), 'nudge', first.period_start_ms).nudge, true, 'next evening: the notice returns');
});

test('a clock change moves the window with the wall clock, and bad input is refused', () => {
  // New York leaves daylight time on 2026-11-01: 17:00 local is then 22:00 UTC, not 21:00.
  assert.equal(quietHoursAnswer(ny, at('2026-11-02T21:30:00Z')).quiet, false);
  assert.equal(quietHoursAnswer(ny, at('2026-11-02T22:30:00Z')).quiet, true);
  for (const bad of [{ ...ny, time_zone: 'Mars/Base' }, { ...ny, start: '9am' }, { ...ny, weekdays: [] }, { ...ny, weekdays: [7] }]) {
    assert.throws(() => quietHoursAnswer(bad, at('2026-10-14T14:00:00Z')), TypeError);
  }
  assert.throws(() => quietHoursAnswer(ny, at('2026-10-14T14:00:00Z'), 'loud'), /one of/);
});
