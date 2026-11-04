import test from 'node:test';
import assert from 'node:assert/strict';
import { deriveOpenSlots, weekdayOf, zonedWallClockToUtcMs } from '../do-work/derive-open-slots.ts';

const slot = (dateISO, start, end, timezone = 'America/Los_Angeles', extra = {}) => deriveOpenSlots({
  timezone, dateISO, durationMin: 30, stepMin: 30,
  windows: [{ weekday: new Date(`${dateISO}T00:00:00Z`).getUTCDay(), start, end }],
  ...extra,
});

test('spring gap is omitted and wall times after the transition use the new offset', () => {
  assert.ok(Number.isNaN(zonedWallClockToUtcMs('2026-03-08', 150, 'America/Los_Angeles')));
  assert.equal(zonedWallClockToUtcMs('2026-03-08', 210, 'America/Los_Angeles'), Date.parse('2026-03-08T10:30:00Z'));
  assert.deepEqual(slot('2026-03-08', '02:00', '04:00').map(s => s.time), ['03:00', '03:30']);
});

test('fall fold chooses the earlier occurrence once', () => {
  assert.equal(zonedWallClockToUtcMs('2026-11-01', 90, 'America/Los_Angeles'), Date.parse('2026-11-01T08:30:00Z'));
  assert.equal(slot('2026-11-01', '01:00', '02:00').filter(s => s.time === '01:30').length, 1);
  assert.equal(zonedWallClockToUtcMs('2026-11-01', 1440, 'America/Los_Angeles'), Date.parse('2026-11-02T08:00:00Z'));
  assert.deepEqual(slot('2026-11-01', '01:00', '01:30').map(s => s.time), ['01:00']);
});

test('fall-fold starts are judged by elapsed fit at the absolute window boundary', () => {
  const slots = deriveOpenSlots({ timezone: 'America/Los_Angeles', dateISO: '2026-11-01', durationMin: 30, stepMin: 15,
    windows: [{ weekday: 0, start: '01:00', end: '02:00' }] });
  assert.deepEqual(slots.map(s => s.time), ['01:00', '01:15', '01:30', '01:45']);
  assert.ok(slots.every(s => s.endMs <= Date.parse('2026-11-01T10:00:00Z')));
});

test('non-hour DST gap is omitted and valid post-transition time is converted', () => {
  assert.ok(Number.isNaN(zonedWallClockToUtcMs('2026-10-04', 135, 'Australia/Lord_Howe')));
  assert.equal(zonedWallClockToUtcMs('2026-10-04', 165, 'Australia/Lord_Howe'), Date.parse('2026-10-03T15:45:00Z'));
});

test('actual elapsed duration must fit the absolute window boundary across spring transition', () => {
  const slots = deriveOpenSlots({
    timezone: 'America/Los_Angeles', dateISO: '2026-03-08', durationMin: 60, stepMin: 30,
    windows: [{ weekday: 0, start: '01:00', end: '03:30' }],
  });
  assert.deepEqual(slots.map(s => s.time), ['01:00', '01:30']);
  assert.ok(slots.every(s => s.endMs <= Date.parse('2026-03-08T10:30:00Z')));
});

test('a window ending in a spring gap keeps pre-gap availability through the first valid endpoint', () => {
  const slots = deriveOpenSlots({ timezone: 'America/Los_Angeles', dateISO: '2026-03-08', durationMin: 60, stepMin: 30,
    windows: [{ weekday: 0, start: '01:00', end: '02:30' }] });
  assert.deepEqual(slots.map(s => s.time), ['01:00']);
  assert.equal(slots[0].endMs, Date.parse('2026-03-08T10:00:00Z'));
});

test('busy intervals are absolute half-open overlaps and buffers expand the conflict span', () => {
  const start = Date.parse('2026-06-01T16:00:00Z');
  const base = { timezone: 'America/Los_Angeles', dateISO: '2026-06-01', durationMin: 30, stepMin: 30,
    windows: [{ weekday: 1, start: '09:00', end: '10:00' }] };
  assert.deepEqual(deriveOpenSlots({ ...base, busy: [{ startMs: start + 30 * 60000, endMs: start + 60 * 60000 }] }).map(s => s.time), ['09:00']);
  assert.deepEqual(deriveOpenSlots({ ...base, bufferAfterMin: 1, busy: [{ startMs: start + 30 * 60000, endMs: start + 60 * 60000 }] }), []);
});

test('invalid duration, step, date, window, zone and busy interval fail clearly', () => {
  const base = { timezone: 'UTC', dateISO: '2026-06-01', durationMin: 30, stepMin: 30, windows: [{ weekday: 1, start: '09:00', end: '10:00' }] };
  for (const change of [{ durationMin: 0 }, { stepMin: 0 }, { dateISO: '2026-02-30' }, { timezone: 'No/Such_Zone' }, { windows: [{ weekday: 1, start: '25:00', end: '26:00' }] }, { busy: [{ startMs: 2, endMs: 1 }] }]) {
    assert.throws(() => deriveOpenSlots({ ...base, ...change }));
  }
  assert.throws(() => weekdayOf('not-a-date'));
  assert.throws(() => deriveOpenSlots({ ...base, timezone: undefined }));
});

test('ordinary-day window fit still uses the absolute end boundary', () => {
  const slots = deriveOpenSlots({ timezone: 'America/Los_Angeles', dateISO: '2026-06-01', durationMin: 30, stepMin: 15,
    windows: [{ weekday: 1, start: '09:00', end: '10:00' }] });
  assert.deepEqual(slots.map(s => s.time), ['09:00', '09:15', '09:30']);
});

test('a short overlapping window cannot suppress a start that fits a later window', () => {
  const input = { timezone: 'UTC', dateISO: '2026-06-01', durationMin: 30, stepMin: 30,
    windows: [{ weekday: 1, start: '09:00', end: '09:15' }, { weekday: 1, start: '09:00', end: '10:00' }] };
  assert.deepEqual(deriveOpenSlots(input).map(slot => slot.time), ['09:00', '09:30']);
  assert.deepEqual(deriveOpenSlots({ ...input, windows: [...input.windows].reverse() }), deriveOpenSlots(input));
});

test('historic second-sized offsets preserve exact wall minutes', () => {
  assert.equal(zonedWallClockToUtcMs('1900-01-01', 540, 'Europe/Paris'), Date.parse('1900-01-01T08:50:39Z'));
});
