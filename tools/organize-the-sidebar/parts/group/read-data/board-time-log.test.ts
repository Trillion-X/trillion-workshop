// Proof for the time-log leaf: fail-closed normalize (positive-int start+duration, sorted), total /
// count / last-worked / window / average, formatDuration, progressPerHour, and total + recent rankings.
import { describe, expect, it } from '../../../../../test-helpers/vitest-shim.mjs';
import {
  averageSessionMs,
  formatDuration,
  lastWorkedAtMs,
  progressPerHour,
  rankByRecentTime,
  rankByTotalTime,
  sessionCount,
  timeInWindowMs,
  timeLogFromRaw,
  totalDurationMs,
  type TimeLog,
} from '../../../read-data/board-time-log.ts';

const DAY = 86_400_000;
const H = 3_600_000;
const NOW = 1_760_000_000_000;

describe('board-time-log — the pure time-log leaf', () => {
  it('timeLogFromRaw is fail-closed and sorts ascending by start', () => {
    const raw = [
      { startMs: NOW, durationMs: H },
      { startMs: NOW - DAY, durationMs: 30 * 60000 },
      { startMs: -5, durationMs: H }, // bad start
      { startMs: NOW, durationMs: 0 }, // bad duration
      { startMs: NOW, durationMs: -1 }, // bad duration
      'nope',
      null,
    ];
    expect(timeLogFromRaw(raw)).toEqual([
      { startMs: NOW - DAY, durationMs: 30 * 60000 },
      { startMs: NOW, durationMs: H },
    ]);
    expect(timeLogFromRaw('x')).toEqual([]);
    expect(timeLogFromRaw(null)).toEqual([]);
  });

  it('a FRACTIONAL ms session is dropped (the normalizer promises positive-INTEGER start + duration)', () => {
    // The predicate is named isPosInt and the contract says integer ms; a hand-crafted fractional session
    // (e.g. from a malformed share/template import) must fail closed, not slip through.
    expect(timeLogFromRaw([{ startMs: 1.5, durationMs: 0.5 }])).toEqual([]);
    expect(timeLogFromRaw([{ startMs: NOW + 0.25, durationMs: H }])).toEqual([]);
    // a genuine integer session still survives alongside a fractional one being dropped
    expect(timeLogFromRaw([{ startMs: 1.5, durationMs: 0.5 }, { startMs: NOW, durationMs: H }])).toEqual([
      { startMs: NOW, durationMs: H },
    ]);
  });

  it('total / count / last-worked / average', () => {
    const log: TimeLog = [
      { startMs: NOW - DAY, durationMs: 30 * 60000 },
      { startMs: NOW - H, durationMs: H },
    ];
    expect(totalDurationMs(log)).toBe(30 * 60000 + H);
    expect(sessionCount(log)).toBe(2);
    expect(lastWorkedAtMs(log)).toBe(NOW - H + H); // end of the latest-starting session = NOW
    expect(lastWorkedAtMs([])).toBeNull();
    expect(averageSessionMs(log)).toBe(Math.round((30 * 60000 + H) / 2));
    expect(averageSessionMs([])).toBe(0);
  });

  it('timeInWindowMs counts only sessions started within the trailing window', () => {
    const log: TimeLog = [
      { startMs: NOW - 10 * DAY, durationMs: H }, // outside a 7-day window
      { startMs: NOW - 2 * DAY, durationMs: 2 * H }, // inside
      { startMs: NOW - H, durationMs: 30 * 60000 }, // inside
    ];
    expect(timeInWindowMs(log, NOW, 7 * DAY)).toBe(2 * H + 30 * 60000);
  });

  it('formatDuration renders minute-granular human time', () => {
    expect(formatDuration(0)).toBe('0m');
    expect(formatDuration(45 * 60000)).toBe('45m');
    expect(formatDuration(90 * 60000)).toBe('1h 30m');
    expect(formatDuration(2 * H)).toBe('2h');
  });

  it('progressPerHour is progressed / hours, null when no time', () => {
    expect(progressPerHour(6, 2 * H)).toBe(3); // 6 units in 2h = 3/hr
    expect(progressPerHour(6, 0)).toBeNull();
  });

  it('rankByTotalTime + rankByRecentTime order by effort and exclude empties', () => {
    const items = [
      { id: 'a', log: [{ startMs: NOW - 10 * DAY, durationMs: 5 * H }] as TimeLog }, // 5h old
      { id: 'b', log: [{ startMs: NOW - H, durationMs: 2 * H }] as TimeLog }, // 2h recent
      { id: 'c', log: [] as TimeLog }, // excluded
    ];
    expect(rankByTotalTime(items, (i) => i.log).map((r) => r.item.id)).toEqual(['a', 'b']); // 5h > 2h
    expect(rankByRecentTime(items, (i) => i.log, NOW, 7 * DAY).map((r) => r.item.id)).toEqual(['b']); // only b in window
  });
});

describe('board-time-log — hostile extra.timeLog is capped + magnitude-bounded (cont.98 batch-20)', () => {
  it('a million-session log is capped to <= 2048', () => {
    const bomb = Array.from({ length: 1_000_000 }, (_, i) => ({ startMs: i + 1, durationMs: 60000 }));
    const log = timeLogFromRaw(bomb);
    expect(log.length).toBe(2048);
  });
  it('a Number.MAX_VALUE duration is rejected so totalDurationMs never overflows to Infinity', () => {
    // Two MAX_VALUE-duration sessions overflowed the sum to Infinity, poisoning averageSessionMs/formatDuration.
    const raw = [{ startMs: 1, durationMs: Number.MAX_VALUE }, { startMs: 2, durationMs: Number.MAX_VALUE }];
    const log = timeLogFromRaw(raw); // both durations exceed MAX_DURATION_MS → dropped
    expect(log.length).toBe(0);
    expect(Number.isFinite(totalDurationMs(log))).toBe(true);
  });
  it('even a full cap of large-but-valid sessions keeps the total finite/safe', () => {
    const big = Array.from({ length: 2048 }, (_, i) => ({ startMs: i + 1, durationMs: 3_999_999_999_999 }));
    const total = totalDurationMs(timeLogFromRaw(big));
    expect(Number.isFinite(total)).toBe(true);
    expect(total).toBeLessThan(Number.MAX_SAFE_INTEGER);
  });
});
