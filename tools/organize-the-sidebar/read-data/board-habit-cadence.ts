// packages/group/read-data/board-habit-cadence.ts
//
// The CADENCE generalization of the habit primitive (read-data/board-habit): a habit's target is not
// always "every day" — real habits are "gym 3x/week", "publish weekly", "monthly money review". A cadence
// is N completions per PERIOD; DAILY is simply the cadence {period:'day', times:1}, so this is a true
// generalization of the daily streak (L069), proven equivalent in tests. It reads the SAME `HabitLog` (the
// completed-day set) the daily engine reads — no new storage — and yields: this period's progress ("2 of 3
// this week"), whether the period is met, a period-streak (consecutive periods that hit the target), and an
// adherence rate. Without a cadence a habit stays on the daily-streak path (zero regression). Pure +
// deterministic: `now` INJECTED, period boundaries are UTC (day/week aligned to the epoch, month = calendar
// UTC month) so buckets are timezone-independent. Fixes the moralizing bug: a met "3x/week" reads healthy,
// and a non-daily habit no longer looks "broken" for skipping a day.

import { currentStreak, dayStart, type HabitLog } from './board-habit';

const DAY_MS = 86_400_000;
const WEEK_MS = 7 * DAY_MS;

/** The recurrence bucket a target is measured over. */
export type CadencePeriod = 'day' | 'week' | 'month';

/** A habit's target: `times` completions per `period`. Daily = {period:'day', times:1}. */
export interface Cadence {
  readonly period: CadencePeriod;
  readonly times: number;
}

/** The default when a habit has no explicit cadence — daily once (the pre-cadence behaviour). */
export const DAILY_CADENCE: Cadence = { period: 'day', times: 1 };

/** Fail-closed: a valid period + a positive-integer `times`, else null (→ the caller uses the daily path). */
export function cadenceFromRaw(raw: unknown): Cadence | null {
  if (raw === null || typeof raw !== 'object') return null;
  const o = raw as Record<string, unknown>;
  const period = o.period;
  if (period !== 'day' && period !== 'week' && period !== 'month') return null;
  const times = o.times;
  if (typeof times !== 'number' || !Number.isInteger(times) || times < 1) return null;
  return { period, times };
}

/** The canonical START ms of the period containing `ms` — a unique, comparable key per period bucket.
 *  Weeks are calendar weeks starting MONDAY (UTC), months are calendar UTC months — so "3x/week" and
 *  "monthly review" bucket the way a person reads them, not on an epoch-aligned boundary. */
export function periodStartOf(ms: number, period: CadencePeriod): number {
  if (period === 'week') {
    const d0 = dayStart(ms);
    const mondayOffset = (new Date(d0).getUTCDay() + 6) % 7; // Mon=0 … Sun=6
    return d0 - mondayOffset * DAY_MS;
  }
  if (period === 'month') {
    const d = new Date(ms);
    return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1);
  }
  return dayStart(ms);
}

/** The start of the period immediately before the one starting at `startMs`. */
export function prevPeriodStart(startMs: number, period: CadencePeriod): number {
  if (period === 'week') return startMs - WEEK_MS;
  if (period === 'month') {
    const d = new Date(startMs);
    return Date.UTC(d.getUTCFullYear(), d.getUTCMonth() - 1, 1); // Date.UTC wraps month -1 → prior December
  }
  return startMs - DAY_MS;
}

/** The effective positive-integer target, or null when the `Cadence` is malformed. The type permits any
 *  `number`, so a hand-built `{times: 0}` (or NaN/negative) must fail closed here — never loop or read as
 *  "met". `cadenceFromRaw` already rejects these, but the pure functions defend their own boundary so a
 *  direct caller can never hang the render on a zero/negative target (an unbounded streak walk) or see a
 *  meaningless "0 per week" target reported as satisfied. */
function targetTimes(cadence: Cadence): number | null {
  const t = cadence.times;
  return Number.isFinite(t) && t >= 1 ? t : null;
}

/** How many logged days fall in the SAME period as `atMs`. */
export function completionsInPeriod(log: HabitLog, period: CadencePeriod, atMs: number): number {
  const key = periodStartOf(atMs, period);
  let n = 0;
  for (const d of log) if (periodStartOf(d, period) === key) n += 1;
  return n;
}

/** True iff the period containing `atMs` met the target (>= `times` completions). */
export function meetsCadence(log: HabitLog, cadence: Cadence, atMs: number): boolean {
  const times = targetTimes(cadence);
  return times !== null && completionsInPeriod(log, cadence.period, atMs) >= times;
}

/** This period's adherence readout — the DATA behind a "2 of 3 this week" badge. */
export interface PeriodProgress {
  readonly done: number;
  readonly target: number;
  readonly fraction: number; // clamped 0..1
  readonly met: boolean;
}

export function currentPeriodProgress(log: HabitLog, cadence: Cadence, now: number): PeriodProgress {
  const done = completionsInPeriod(log, cadence.period, now);
  const target = targetTimes(cadence);
  if (target === null) return { done, target: 0, fraction: 0, met: false }; // malformed cadence -> never "met"
  const fraction = Math.min(1, done / target);
  return { done, target, fraction, met: done >= target };
}

/**
 * The CADENCE streak: consecutive PERIODS (counting back) that met the target. Same grace as the daily
 * streak — the current period counts if already met; if it is not yet met, the streak anchors at the
 * previous period rather than breaking (an in-progress period never penalizes). For {period:'day',times:1}
 * this is byte-identical to `currentStreak` (proven in tests) — cadence generalizes the daily streak.
 */
export function cadenceStreak(log: HabitLog, cadence: Cadence, now: number): number {
  const { period } = cadence;
  const times = targetTimes(cadence);
  if (times === null) return 0; // malformed target -> no streak, and no unbounded backward walk
  const meetsStart = (pStart: number): boolean => {
    let n = 0;
    for (const d of log) if (periodStartOf(d, period) === pStart) n += 1;
    return n >= times;
  };
  const current = periodStartOf(now, period);
  let anchor = meetsStart(current) ? current : prevPeriodStart(current, period);
  if (!meetsStart(anchor)) return 0;
  let streak = 0;
  for (let p = anchor; meetsStart(p); p = prevPeriodStart(p, period)) streak += 1;
  return streak;
}

/** Over ~10 years even a daily period is < 3700 buckets — a window past this is not a real
 *  adherence question, only an untrusted `periods` (NaN slips a `<= 0` gate; MAX_VALUE would
 *  hang the O(periods x log) walk). Bound the window so the read is always finite and fast. */
const MAX_ADHERENCE_PERIODS = 10_000;

/** Adherence over the last `periods` periods ending now: the fraction that met the target (0..1). */
export function adherenceRate(log: HabitLog, cadence: Cadence, now: number, periods: number): number {
  // `periods > 0` (not `<= 0`) rejects NaN too — a NaN window otherwise ran 0 loops and returned
  // `0 / NaN` = NaN, violating the 0..1 contract. Then cap the walk so a huge window can't hang.
  if (!(periods > 0)) return 0;
  const window = Math.min(Math.floor(periods), MAX_ADHERENCE_PERIODS);
  const times = targetTimes(cadence);
  if (times === null) return 0; // malformed target -> zero adherence, no meaningless "met"
  let met = 0;
  let p = periodStartOf(now, cadence.period);
  for (let i = 0; i < window; i += 1) {
    if (completionsInPeriod(log, cadence.period, p) >= times) met += 1;
    p = prevPeriodStart(p, cadence.period);
  }
  return met / window;
}

/** Human label for a cadence — "daily", "weekly", "3x per week" — the render-boundary translation. */
export function cadenceLabel(cadence: Cadence): string {
  const { period, times } = cadence;
  if (times === 1) {
    return period === 'day' ? 'daily' : period === 'week' ? 'weekly' : 'monthly';
  }
  return `${times}x per ${period}`;
}

/**
 * A habit's consistency "pulse" — the ONE cadence-aware read the momentum/attention lenses share so they
 * never moralize wrong. Without a cadence it is the plain DAILY streak (byte-identical to `currentStreak`,
 * so daily-habit lens scoring is unchanged — zero regression). With a cadence it is the PERIOD streak +
 * whether this period's target is met, so a "3x/week" habit meeting its target reads as ON A ROLL (not
 * momentum-0), and is not falsely flagged "broken" just because two of its days were not consecutive.
 */
export interface HabitPulse {
  readonly streak: number; // periods (cadence) or days (daily)
  readonly met: boolean; // this period's target is satisfied (daily: the streak is live)
  readonly broken: boolean; // the habit has a log but has fallen off its cadence entirely
}

export function habitPulse(log: HabitLog, cadence: Cadence | null, now: number): HabitPulse {
  if (cadence === null) {
    const streak = currentStreak(log, now);
    return { streak, met: streak > 0, broken: log.length > 0 && streak === 0 };
  }
  const streak = cadenceStreak(log, cadence, now);
  const prog = currentPeriodProgress(log, cadence, now);
  // "Broken" only when there is no period streak AND nothing done this period — an in-progress period (or
  // a live streak) is never broken. This is the cadence analogue of the daily "streak fell to 0".
  return { streak, met: prog.met, broken: log.length > 0 && streak === 0 && prog.done === 0 };
}
