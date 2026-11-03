// Vendored unchanged except for import paths from bitfield-packages/packages/group/read-data/board-habit.ts.
// packages/group/read-data/board-habit.ts
//
// The HABIT/STREAK primitive: a completion log of days on an item + the pure streak engine that reads
// it. A vision board tracks HABITS toward goals ("meditate daily") — the complement of the outcome-goal
// support (checklist "what" + due-date "when"); this is the "how consistently". ONE blind engine yields
// a current streak, longest streak, total completions, a completion rate, and "logged today?" — all from
// DATA (L069/L090). The item carries `extra.habitLog` (an array of UTC-day-start ms). Pure +
// deterministic: `now` is INJECTED (no clock lives here); day math uses UTC-day boundaries.

const DAY_MS = 86_400_000;

/** A habit log = the set of days completed, as a sorted, de-duplicated array of UTC-day-start ms. */
export type HabitLog = readonly number[];

/** The canonical empty log (an item that is not a tracked habit → no streak badge). */
export const EMPTY_LOG: HabitLog = [];

/** Floor a timestamp to its UTC-day start (timezone-independent, deterministic). */
export function dayStart(ms: number): number {
  return Math.floor(ms / DAY_MS) * DAY_MS;
}

/**
 * Normalize opaque DATA into a {@link HabitLog}, fail-closed: keep only positive-integer ms, floor each
 * to its UTC-day, de-duplicate, sort ascending. Non-array → empty. Self-describing DATA + a generic
 * reader (L090) — the badge/streak/rate never parse by hand.
 */
export function habitLogFromRaw(raw: unknown): HabitLog {
  if (!Array.isArray(raw)) return EMPTY_LOG;
  const days = new Set<number>();
  for (const v of raw) {
    if (typeof v === 'number' && Number.isInteger(v) && v > 0) days.add(dayStart(v));
  }
  return [...days].sort((a, b) => a - b);
}

/** Whether a given day (any ms in it) is logged. */
export function isLoggedOn(log: HabitLog, ms: number): boolean {
  const day = dayStart(ms);
  return log.includes(day);
}

/** Toggle a day's completion (add if absent, remove if present). Returns a new sorted log. */
export function toggleDay(log: HabitLog, ms: number): HabitLog {
  const day = dayStart(ms);
  return log.includes(day) ? log.filter((d) => d !== day) : [...log, day].sort((a, b) => a - b);
}

/** Total days completed. */
export function totalCompletions(log: HabitLog): number {
  return log.length;
}

/**
 * The CURRENT streak at `now`: consecutive completed days counting back from today — or from yesterday
 * if today is not yet logged (the universal habit-app grace: the streak survives until you miss a full
 * day). 0 if neither today nor yesterday is logged.
 */
export function currentStreak(log: HabitLog, now: number): number {
  const days = new Set(log);
  const today = dayStart(now);
  let anchor: number | null = days.has(today) ? today : days.has(today - DAY_MS) ? today - DAY_MS : null;
  if (anchor === null) return 0;
  let streak = 0;
  for (let d = anchor; days.has(d); d -= DAY_MS) streak += 1;
  return streak;
}

/** The LONGEST streak ever — the largest run of consecutive completed days. */
export function longestStreak(log: HabitLog): number {
  if (log.length === 0) return 0;
  let best = 1;
  let run = 1;
  for (let i = 1; i < log.length; i += 1) {
    run = log[i] === log[i - 1] + DAY_MS ? run + 1 : 1;
    if (run > best) best = run;
  }
  return best;
}

/** Completion rate over the last `windowDays` ending today (0..1): completed days in the window / window. */
export function completionRate(log: HabitLog, now: number, windowDays: number): number {
  if (windowDays <= 0) return 0;
  const today = dayStart(now);
  const oldest = today - (windowDays - 1) * DAY_MS;
  const inWindow = log.filter((d) => d >= oldest && d <= today).length;
  return inWindow / windowDays;
}

/** An item paired with its habit log — the input to the collection reducers (streak ranking). */
export interface HabitItem {
  readonly id: string;
  readonly log: HabitLog;
}

/** Habit items ranked by CURRENT streak, descending — the "Streaks" panel order (unstreak-0 excluded). */
export interface StreakRow {
  readonly id: string;
  readonly streak: number;
}
export function rankByStreak(items: readonly HabitItem[], now: number): StreakRow[] {
  return items
    .map((it): StreakRow => ({ id: it.id, streak: currentStreak(it.log, now) }))
    .filter((r) => r.streak > 0)
    .sort((a, b) => b.streak - a.streak);
}
