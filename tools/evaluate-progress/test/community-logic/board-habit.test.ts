// Vendored unchanged except for import paths from bitfield-packages/packages/group/read-data/board-habit.test.ts.
// Proof for the habit/streak primitive: fail-closed normalize (dedupe/floor/sort), toggle, current
// streak with yesterday-grace, longest streak, completion rate. UTC-day math → deterministic.
import { describe, expect, it } from '../../../match-community-members/test/vitest-shim.mjs';
import {
  type HabitItem,
  completionRate,
  currentStreak,
  dayStart,
  habitLogFromRaw,
  isLoggedOn,
  longestStreak,
  rankByStreak,
  toggleDay,
  totalCompletions,
} from '../../read-data/board-habit.ts';

const DAY = 86_400_000;
const TODAY = dayStart(1_760_000_000_000);
const NOW = TODAY + 15 * 3_600_000; // mid-afternoon UTC today
const d = (n: number) => TODAY + n * DAY; // n days from today (negative = past)

describe('board-habit — the habit/streak primitive', () => {
  it('habitLogFromRaw is fail-closed: floors to UTC-day, dedupes, sorts, drops junk', () => {
    expect(habitLogFromRaw(undefined)).toEqual([]);
    expect(habitLogFromRaw('x')).toEqual([]);
    // two stamps in the same day collapse; a negative + a float are dropped
    expect(habitLogFromRaw([d(-1) + 3_600_000, d(-1) + 7_200_000, d(0), -5, 1.5])).toEqual([d(-1), d(0)]);
  });

  it('toggle + isLoggedOn + totalCompletions', () => {
    let log = toggleDay([], NOW);
    expect(isLoggedOn(log, NOW)).toBe(true);
    expect(totalCompletions(log)).toBe(1);
    log = toggleDay(log, NOW); // toggle off
    expect(isLoggedOn(log, NOW)).toBe(false);
    expect(totalCompletions(log)).toBe(0);
  });

  it('currentStreak counts back from today, with yesterday-grace, and breaks on a gap', () => {
    expect(currentStreak([], NOW)).toBe(0);
    expect(currentStreak([d(0), d(-1), d(-2)], NOW)).toBe(3); // today + 2 back
    expect(currentStreak([d(-1), d(-2)], NOW)).toBe(2); // not done today, but yesterday grace
    expect(currentStreak([d(-2), d(-3)], NOW)).toBe(0); // missed yesterday → streak broken
    expect(currentStreak([d(0), d(-2), d(-3)], NOW)).toBe(1); // gap at -1 → only today counts
  });

  it('longestStreak finds the largest consecutive run anywhere in history', () => {
    expect(longestStreak([])).toBe(0);
    expect(longestStreak([d(-10), d(-9), d(-8), d(-3), d(-2)])).toBe(3); // the -10..-8 run
    expect(longestStreak([d(-5)])).toBe(1);
  });

  it('completionRate = completed days in the trailing window / window', () => {
    const log = [d(0), d(-1), d(-3)]; // 3 of the last 7 days
    expect(completionRate(log, NOW, 7)).toBeCloseTo(3 / 7);
    expect(completionRate(log, NOW, 0)).toBe(0);
  });

  it('rankByStreak orders by current streak, excludes streak-0', () => {
    const items: HabitItem[] = [
      { id: 'meditate', log: [d(0), d(-1), d(-2)] }, // 3
      { id: 'run', log: [d(0)] }, // 1
      { id: 'read', log: [d(-5), d(-6)] }, // broken → 0, excluded
    ];
    expect(rankByStreak(items, NOW).map((r) => r.id)).toEqual(['meditate', 'run']);
    expect(rankByStreak(items, NOW).map((r) => r.streak)).toEqual([3, 1]);
  });
});
