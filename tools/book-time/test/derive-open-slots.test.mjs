// Window-fit, taken starts, buffers, busy intervals and the minimum-notice horizon: the package's own cases.
import test from 'node:test';
import assert from 'node:assert/strict';
import { deriveOpenSlots, zonedWallClockToUtcMs } from '../read-data/derive-open-slots.ts';

const TZ = 'America/Chicago';
const DAY = '2026-08-10'; // a Monday
const MON = [{ weekday: 1, start: '09:00', end: '11:00' }];
const at = hhmm => { const [h, m] = hhmm.split(':').map(Number); return zonedWallClockToUtcMs(DAY, h * 60 + m, TZ); };
const times = slots => slots.map(slot => slot.time);
const derive = extra => deriveOpenSlots({ timezone: TZ, windows: MON, dateISO: DAY, durationMin: 45, stepMin: 30, ...extra });

test('slots fit inside the window at the step', () => {
  const slots = derive({});
  assert.deepEqual(times(slots), ['09:00', '09:30', '10:00']);
  assert.equal(slots[0].startMs, at('09:00'));
  assert.equal(slots[0].endMs, at('09:00') + 45 * 60000);
});

test('a slot whose exact start is taken is dropped', () => {
  assert.deepEqual(times(derive({ taken: [at('09:30')] })), ['09:00', '10:00']);
});

test('an overlapping busy interval drops the slot, an adjacent one keeps it', () => {
  assert.deepEqual(times(derive({ busy: [{ startMs: at('09:15'), endMs: at('09:45') }] })), ['10:00']);
  assert.deepEqual(times(derive({ busy: [{ startMs: at('09:45'), endMs: at('10:30') }] })), ['09:00']);
});

test('a buffer widens the span checked against busy', () => {
  const busy = [{ startMs: at('09:45'), endMs: at('10:15') }];
  assert.ok(times(derive({ busy })).includes('09:00'));
  assert.ok(!times(derive({ busy, bufferAfterMin: 15 })).includes('09:00'));
});

test('the minimum-notice horizon counts from an injected now', () => {
  assert.deepEqual(times(derive({ nowMs: at('09:00'), minNoticeMin: 60 })), ['10:00']);
});

test('with no busy at all the result is the plain window-fit minus taken, whatever the buffers', () => {
  const base = derive({ taken: [at('09:30')] });
  const buffered = derive({ taken: [at('09:30')], busy: [], bufferBeforeMin: 20, bufferAfterMin: 20 });
  assert.deepEqual(buffered, base);
  assert.deepEqual(times(base), ['09:00', '10:00']);
});

test('a window in another weekday gives nothing, and two overlapping windows give each start once', () => {
  assert.deepEqual(derive({ windows: [{ weekday: 2, start: '09:00', end: '11:00' }] }), []);
  const twice = derive({ windows: [{ weekday: 1, start: '09:00', end: '10:30' }, { weekday: 1, start: '09:30', end: '11:00' }] });
  assert.deepEqual(times(twice), ['09:00', '09:30', '10:00']);
});

test('the wall clock is the zone\'s, across a clock change', () => {
  // 2026-03-08 is the day US clocks went forward; 09:00 in Chicago is then UTC-5, the day before UTC-6.
  assert.equal(zonedWallClockToUtcMs('2026-03-07', 9 * 60, TZ), Date.UTC(2026, 2, 7, 15));
  assert.equal(zonedWallClockToUtcMs('2026-03-08', 9 * 60, TZ), Date.UTC(2026, 2, 8, 14));
});
