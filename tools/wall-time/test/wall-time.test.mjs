// A time a person says in their own clock is kept as that wall time and an IANA zone, read by one owner: a zone that is not
// one is refused, never read as UTC, and a time the clocks skip or repeat is resolved by one rule.
import assert from 'node:assert/strict';
import test from 'node:test';
import { addCivilDays, addCivilMinutes, addCivilMonths, instantAt, timeZoneName, wallTimeOf, weekday } from '../read-data/wall-time.mjs';

const iso = ms => new Date(ms).toISOString();

test('a zone is an IANA name the runtime knows, kept in its own spelling; anything else is no zone', () => {
  assert.equal(timeZoneName('Europe/London'), 'Europe/London');
  assert.equal(timeZoneName('UTC'), 'UTC');
  assert.equal(timeZoneName('america/new_york'), 'America/New_York', 'kept in the canonical spelling');
  for (const not of ['+05:00', '-0800', 'GMT+5', 'Mars/Olympus', 'Not a zone', '', '   ', null, undefined, 5, 'A'.repeat(81), 'Europe/../London']) assert.equal(timeZoneName(not), null, String(not));
});

test('a time the clocks skip moves to the first minute that exists, or is skipped; a repeated time takes the earlier or later', () => {
  // New York springs forward at 02:00 on 2026-03-08: 02:30 does not exist.
  assert.equal(iso(instantAt('2026-03-08', '02:30', 'America/New_York')), '2026-03-08T07:00:00.000Z');
  assert.equal(instantAt('2026-03-08', '02:30', 'America/New_York', { gap: 'skip' }), null);
  // London falls back at 02:00 BST on 2026-10-25: 01:30 happens twice.
  assert.equal(iso(instantAt('2026-10-25', '01:30', 'Europe/London')), '2026-10-25T00:30:00.000Z');
  assert.equal(iso(instantAt('2026-10-25', '01:30', 'Europe/London', { fold: 'later' })), '2026-10-25T01:30:00.000Z');
  // A half-hour zone and a zone whose clocks move by half an hour.
  assert.equal(iso(instantAt('2026-07-01', '09:00', 'Asia/Kolkata')), '2026-07-01T03:30:00.000Z');
  assert.equal(iso(instantAt('2026-10-04', '02:15', 'Australia/Lord_Howe')), '2026-10-03T15:30:00.000Z');
  assert.deepEqual(wallTimeOf(Date.parse('2026-10-25T01:30:00Z'), 'Europe/London'), { date: '2026-10-25', time: '01:30' });
  assert.equal(instantAt('2026-02-30', '09:00', 'UTC'), null, 'a day that is not one');
  assert.equal(instantAt('2026-03-01', '09:00', '+05:00'), null, 'an offset is not a zone');
});

test('civil dates add days and months by the calendar, and a month without the day takes its last', () => {
  assert.equal(addCivilMonths('2026-01-31', 1), '2026-02-28');
  assert.equal(addCivilMonths('2028-01-31', 1), '2028-02-29');
  assert.equal(addCivilMonths('2026-11-30', 3), '2027-02-28');
  assert.equal(addCivilMonths('2026-01-15', -2), '2025-11-15');
  assert.equal(addCivilDays('2026-02-27', 2), '2026-03-01');
  assert.deepEqual(addCivilMinutes({ date: '2026-12-31', time: '23:30' }, 45), { date: '2027-01-01', time: '00:15' });
  assert.equal(weekday('2026-10-25'), 0);
  assert.equal(weekday('2026-10-26'), 1);
});
