// Window-fit, taken starts, buffers, busy intervals and the minimum-notice horizon: the package's own cases.
import test from 'node:test';
import assert from 'node:assert/strict';
import { deriveOpenSlots } from '../read-data/derive-open-slots.ts';
import { instantAt } from '../../wall-time/read-data/wall-time.mjs';

const TZ = 'America/Chicago';
const DAY = '2026-08-10'; // a Monday
const MON = [{ weekday: 1, start: '09:00', end: '11:00' }];
const at = hhmm => { const [h, m] = hhmm.split(':').map(Number); return instantAt(DAY, hhmm, TZ); };
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
  assert.equal(instantAt('2026-03-07', '09:00', TZ), Date.UTC(2026, 2, 7, 15));
  assert.equal(instantAt('2026-03-08', '09:00', TZ), Date.UTC(2026, 2, 8, 14));
});

test('a time the clock skips is not offered and a time it repeats is offered once, at the earlier', () => {
  const sunday = [{ weekday: 0, start: '01:00', end: '04:00' }];
  const derived = date => deriveOpenSlots({ timezone: TZ, windows: sunday, dateISO: date, durationMin: 30, stepMin: 30 });
  // 2026-03-08: Chicago clocks go from 02:00 to 03:00, so 02:00 and 02:30 do not exist.
  const forward = derived('2026-03-08');
  assert.deepEqual(times(forward), ['01:00', '01:30', '03:00', '03:30']);
  assert.deepEqual(forward.map(slot => slot.startMs), [Date.UTC(2026, 2, 8, 7), Date.UTC(2026, 2, 8, 7, 30), Date.UTC(2026, 2, 8, 8), Date.UTC(2026, 2, 8, 8, 30)]);
  // 2026-11-01: clocks go from 02:00 back to 01:00, so 01:00 and 01:30 happen twice and are offered at the first.
  const back = derived('2026-11-01');
  assert.deepEqual(times(back), ['01:00', '01:30', '02:00', '02:30', '03:00', '03:30']);
  assert.deepEqual(back.slice(0, 3).map(slot => slot.startMs), [Date.UTC(2026, 10, 1, 6), Date.UTC(2026, 10, 1, 6, 30), Date.UTC(2026, 10, 1, 8)]);
});

test('a name that is not a time zone is refused', () => {
  assert.throws(() => deriveOpenSlots({ timezone: 'Nowhere/Land', windows: MON, dateISO: DAY, durationMin: 45, stepMin: 30 }), /not a time zone/);
});
