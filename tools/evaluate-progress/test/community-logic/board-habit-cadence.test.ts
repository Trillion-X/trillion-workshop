// Vendored unchanged except for import paths from bitfield-packages/packages/group/read-data/board-habit-cadence.test.ts.
// packages/group/read-data/board-habit-cadence.test.ts
import { describe, it, expect } from '../../../match-community-members/test/vitest-shim.mjs';
import { currentStreak, dayStart, habitLogFromRaw, type HabitLog } from '../../read-data/board-habit.ts';
import {
  cadenceFromRaw,
  cadenceStreak,
  currentPeriodProgress,
  meetsCadence,
  adherenceRate,
  completionsInPeriod,
  cadenceLabel,
  habitPulse,
  periodStartOf,
  prevPeriodStart,
  DAILY_CADENCE,
} from '../../read-data/board-habit-cadence.ts';

const DAY = 86_400_000;
const NOW = dayStart(1_800_000_000_000) + 12 * 3_600_000;
const dayN = (back: number) => dayStart(NOW) - back * DAY;
const log = (...days: number[]): HabitLog => habitLogFromRaw(days);
// Anchor week/month cases on period STARTS so buckets are robust regardless of NOW's weekday.
const WK = periodStartOf(NOW, 'week');
const WK_1 = prevPeriodStart(WK, 'week');
const WK_2 = prevPeriodStart(WK_1, 'week');

describe('board-habit-cadence — cadence generalizes the daily streak', () => {
  it('cadenceFromRaw is fail-closed: valid period + positive-int times only', () => {
    expect(cadenceFromRaw({ period: 'week', times: 3 })).toEqual({ period: 'week', times: 3 });
    expect(cadenceFromRaw({ period: 'day', times: 1 })).toEqual(DAILY_CADENCE);
    expect(cadenceFromRaw({ period: 'year', times: 1 })).toBeNull();
    expect(cadenceFromRaw({ period: 'week', times: 0 })).toBeNull();
    expect(cadenceFromRaw({ period: 'week', times: 2.5 })).toBeNull();
    expect(cadenceFromRaw({ period: 'week' })).toBeNull();
    expect(cadenceFromRaw(null)).toBeNull();
  });

  it('DAILY: cadenceStreak({day,1}) is byte-identical to currentStreak (the generalization holds)', () => {
    for (const days of [[0], [0, 1, 2], [1, 2, 3], [0, 2, 3], [], [0, 1, 3, 4, 5]]) {
      const l = log(...days.map((d) => dayN(d)));
      expect(cadenceStreak(l, DAILY_CADENCE, NOW)).toBe(currentStreak(l, NOW));
    }
  });

  it('3x/week: a met week reads healthy even with gaps between days', () => {
    const cad = { period: 'week', times: 3 } as const;
    const l = log(WK, WK + 2 * DAY, WK + 4 * DAY); // 3 in the current week, gapped
    expect(currentPeriodProgress(l, cad, NOW)).toEqual({ done: 3, target: 3, fraction: 1, met: true });
    expect(meetsCadence(l, cad, NOW)).toBe(true);
  });

  it('3x/week: an in-progress week (below target) does not penalize the streak', () => {
    const cad = { period: 'week', times: 3 } as const;
    const l = log(
      WK, // this week: 1 so far
      WK_1, WK_1 + DAY, WK_1 + 2 * DAY, // last week: 3
      WK_2, WK_2 + DAY, WK_2 + 2 * DAY, // week -2: 3
    );
    expect(currentPeriodProgress(l, cad, NOW).met).toBe(false);
    expect(cadenceStreak(l, cad, NOW)).toBe(2); // two completed weeks; in-progress week not counted against
  });

  it('3x/week: a missed week breaks the streak', () => {
    const cad = { period: 'week', times: 3 } as const;
    const l = log(
      WK, WK + DAY, WK + 2 * DAY, // this week: 3 (met)
      WK_1, // last week: 1 (miss)
      WK_2, WK_2 + DAY, WK_2 + 2 * DAY, // met, but the miss cuts the streak
    );
    expect(cadenceStreak(l, cad, NOW)).toBe(1);
  });

  it('monthly: calendar-UTC month buckets; a monthly habit met once counts', () => {
    const cad = { period: 'month', times: 1 } as const;
    const monthStart = periodStartOf(NOW, 'month');
    const l = log(monthStart + 4 * DAY);
    expect(completionsInPeriod(l, 'month', NOW)).toBe(1);
    expect(meetsCadence(l, cad, NOW)).toBe(true);
    expect(currentPeriodProgress(l, cad, NOW).met).toBe(true);
  });

  it('adherenceRate: fraction of the last N periods that met target', () => {
    const cad = { period: 'week', times: 2 } as const;
    const l = log(
      WK, WK + DAY, // this week: 2 met
      WK_1, // last week: 1 miss
      WK_2, WK_2 + DAY, // week -2: 2 met
    );
    expect(adherenceRate(l, cad, NOW, 3)).toBeCloseTo(2 / 3);
  });

  it('cadenceLabel reads in plain language', () => {
    expect(cadenceLabel({ period: 'day', times: 1 })).toBe('daily');
    expect(cadenceLabel({ period: 'week', times: 1 })).toBe('weekly');
    expect(cadenceLabel({ period: 'month', times: 1 })).toBe('monthly');
    expect(cadenceLabel({ period: 'week', times: 3 })).toBe('3x per week');
  });

  describe('fail-closed on a malformed cadence (the type permits any number for times)', () => {
    // cadenceFromRaw rejects these, but a direct caller can construct them — the pure functions must defend
    // their own boundary: never loop forever, never report a meaningless "0 per week" target as satisfied.
    const bad = [
      { period: 'week', times: 0 },
      { period: 'week', times: -1 },
      { period: 'day', times: Number.NaN },
    ] as const;
    const someLog = log(WK, WK + DAY, WK + 2 * DAY);

    it('cadenceStreak TERMINATES and returns 0 for a zero/negative/NaN target (no unbounded backward walk)', () => {
      for (const cad of bad) expect(cadenceStreak(someLog, cad, NOW)).toBe(0);
    });

    it('currentPeriodProgress never reads "met" for a malformed target', () => {
      for (const cad of bad) {
        const prog = currentPeriodProgress(someLog, cad, NOW);
        expect(prog.met).toBe(false);
        expect(prog.fraction).toBe(0);
        expect(prog.target).toBe(0);
      }
    });

    it('meetsCadence and adherenceRate fail closed for a malformed target', () => {
      for (const cad of bad) {
        expect(meetsCadence(someLog, cad, NOW)).toBe(false);
        expect(adherenceRate(someLog, cad, NOW, 3)).toBe(0);
      }
    });
  });

  describe('habitPulse — the cadence-aware read the lenses share', () => {
    it('daily (null cadence) is byte-identical to the daily streak — zero lens regression', () => {
      for (const days of [[0, 1, 2], [1, 2], [0], []]) {
        const l = log(...days.map((d) => dayN(d)));
        const p = habitPulse(l, null, NOW);
        expect(p.streak).toBe(currentStreak(l, NOW));
        expect(p.broken).toBe(l.length > 0 && currentStreak(l, NOW) === 0);
      }
    });

    it('a 3x/week habit meeting its target is ON A ROLL and NOT flagged broken (the bug fix)', () => {
      const cad = { period: 'week', times: 3 } as const;
      // met this week (3, gapped days) + met last week -> streak 2, met, not broken.
      const l = log(WK, WK + 2 * DAY, WK + 4 * DAY, WK_1, WK_1 + DAY, WK_1 + 2 * DAY);
      const p = habitPulse(l, cad, NOW);
      expect(p.streak).toBe(2);
      expect(p.met).toBe(true);
      expect(p.broken).toBe(false); // NOT broken despite non-consecutive days — the moralizing bug is gone
    });

    it('a 3x/week habit that stopped entirely IS broken (honest lapse)', () => {
      const cad = { period: 'week', times: 3 } as const;
      // only some old weeks, nothing recent -> no streak, nothing this week -> broken.
      const l = log(WK_2, WK_2 + DAY); // long ago, and never met 3 -> streak 0, done this week 0
      const p = habitPulse(l, cad, NOW);
      expect(p.streak).toBe(0);
      expect(p.broken).toBe(true);
    });

    it('a brand-new cadence habit in progress this period is not "broken"', () => {
      const cad = { period: 'week', times: 3 } as const;
      const l = log(WK); // 1 of 3 this week, no prior -> streak 0 but done>0 -> not broken
      expect(habitPulse(l, cad, NOW).broken).toBe(false);
    });
  });

  describe('adherenceRate red-team — untrusted `periods` never hangs or returns NaN (cont.98 batch-34)', () => {
    const cad = { period: 'day', times: 1 } as const;
    const l = log(dayN(0), dayN(1), dayN(2)); // 3 consecutive daily completions

    it('a NaN window returns 0 (not `0 / NaN` = NaN — the 0..1 contract holds)', () => {
      expect(adherenceRate(l, cad, NOW, Number.NaN)).toBe(0);
      expect(adherenceRate(l, cad, NOW, -5)).toBe(0);
    });

    it('a MAX_VALUE window is bounded (finite fraction, no O(periods) hang)', () => {
      const r = adherenceRate(l, cad, NOW, Number.MAX_VALUE);
      expect(Number.isFinite(r)).toBe(true);
      expect(r).toBeGreaterThanOrEqual(0);
      expect(r).toBeLessThanOrEqual(1);
    });

    it('a normal window is unchanged (zero regression)', () => {
      // 3 of the last 3 daily periods met -> 1.0
      expect(adherenceRate(l, cad, NOW, 3)).toBe(1);
    });
  });
});
