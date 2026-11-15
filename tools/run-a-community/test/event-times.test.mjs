import assert from 'node:assert/strict';
import test from 'node:test';
import { activityMethods, eventTimes } from '../read-data/event-times.mjs';

test('weekly events keep their New York clock time across both DST changes and keep their duration', () => {
  const spring = eventTimes('2026-02-26T23:00:00.000Z', '2026-02-27T00:00:00.000Z', { every: 'week', count: 3, time_zone: 'America/New_York' });
  assert.deepEqual(spring.map(row => row.starts_at), ['2026-02-26T23:00:00.000Z', '2026-03-05T23:00:00.000Z', '2026-03-12T22:00:00.000Z']);
  assert.equal(spring[2].ends_at, '2026-03-12T23:00:00.000Z');
  const fall = eventTimes('2026-10-25T22:00:12.345Z', null, { every: 'week', count: 3, time_zone: 'America/New_York' });
  assert.deepEqual(fall.map(row => row.starts_at), ['2026-10-25T22:00:12.345Z', '2026-11-01T23:00:12.345Z', '2026-11-08T23:00:12.345Z']);
  assert.deepEqual(activityMethods.eventTimes('2026-02-26T23:00:00Z', null, null), [{ starts_at: '2026-02-26T23:00:00.000Z', ends_at: null }]);
});

test('monthly dates clamp from the original day and recover it in longer months', () => {
  assert.deepEqual(eventTimes('2026-01-31T15:00:00Z', null, { every: 'month', count: 3, time_zone: 'UTC' }).map(row => row.starts_at),
    ['2026-01-31T15:00:00.000Z', '2026-02-28T15:00:00.000Z', '2026-03-31T15:00:00.000Z']);
  assert.equal(eventTimes('2028-01-31T15:00:00Z', null, { every: 'month', count: 2, time_zone: 'UTC' })[1].starts_at, '2028-02-29T15:00:00.000Z');
});

test('daily events use the shared gap and fold rule, including a half-hour clock change', () => {
  assert.equal(eventTimes('2026-03-07T07:30:00Z', null, { every: 'day', count: 2, time_zone: 'America/New_York' })[1].starts_at, '2026-03-08T07:00:00.000Z');
  assert.equal(eventTimes('2026-10-24T00:30:00Z', null, { every: 'day', count: 2, time_zone: 'Europe/London' })[1].starts_at, '2026-10-25T00:30:00.000Z');
  assert.equal(eventTimes('2026-10-02T15:45:00Z', null, { every: 'day', count: 2, time_zone: 'Australia/Lord_Howe' })[1].starts_at, '2026-10-03T15:30:00.000Z');
});

test('recurrence requires a known zone and cadence; no repeat returns one event', () => {
  for (const time_zone of [undefined, '+05:00', 'Mars/Olympus', '']) assert.throws(() => eventTimes('2026-02-26T23:00:00Z', null, { every: 'week', time_zone }), /repeats\.time_zone/);
  assert.throws(() => eventTimes('2026-02-26T23:00:00Z', null, { every: 'fortnight', time_zone: 'UTC' }), /day, week or month/);
  assert.deepEqual(eventTimes('2026-02-26T23:00:00Z', null, null), [{ starts_at: '2026-02-26T23:00:00.000Z', ends_at: null }]);
  assert.equal(eventTimes('2026-02-26T23:00:00Z', null, { every: 'day', time_zone: 'UTC', count: 90 }).length, 52);
});
