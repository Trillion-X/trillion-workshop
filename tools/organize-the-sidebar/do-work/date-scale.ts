// packages/group/do-work/date-scale.ts
//
// DATE SCALE — the generative primitive behind "line the board up on a TIMELINE" (arrange by due date /
// created date / any date field, with a real dated axis). The board's generic axis engine (`arrange-by-axis`)
// places items on a continuous number line and ticks it at 1/2/5×10ⁿ round VALUES — perfect for votes/size,
// useless for time (a round number of milliseconds is not a day or a month boundary). A date axis needs its
// OWN two pieces, and they are the same for every date field: PARSE a messy date value into a timestamp, and
// pick DATE-ALIGNED ticks (day / week / month / quarter / year) over a span. Those two are this leaf; the
// timeline is then that leaf's output fed into the existing axis engine (no new placement code).
//
// Deterministic + timezone-STABLE: every calendar computation is UTC (no local-zone drift, no `Date.now`),
// so the same input always yields the same ticks + labels. Pure leaf, zero imports.

export const DAY_MS = 86_400_000;
const WEEK_MS = 7 * DAY_MS;

export type DateGranularity = 'day' | 'week' | 'month' | 'quarter' | 'year';

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'] as const;

/**
 * Parse a messy date value → a UTC millisecond timestamp, or null when it isn't a date. Accepts: a number
 * (ms since epoch, or seconds when it's small enough to be a plausible seconds timestamp), an ISO / common
 * date string (`new Date(str)`), or a `Date`. Fail-closed: anything unparseable → null (so the item parks in
 * the axis engine's no-value pile rather than getting a NaN coordinate).
 */
export function parseFlexibleDate(value: unknown): number | null {
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) return null;
    // < 1e11 (~year 5138 in seconds, but ~1973 in ms) → treat as SECONDS; else milliseconds.
    return Math.abs(value) < 1e11 ? value * 1000 : value;
  }
  if (typeof value === 'string') {
    const s = value.trim();
    if (s === '') return null;
    const t = new Date(s).getTime();
    return Number.isFinite(t) ? t : null;
  }
  if (value instanceof Date) {
    const t = value.getTime();
    return Number.isFinite(t) ? t : null;
  }
  return null;
}

const y = (ts: number) => new Date(ts).getUTCFullYear();
const mo = (ts: number) => new Date(ts).getUTCMonth();
const utc = (yr: number, mth: number, day = 1) => Date.UTC(yr, mth, day);

/** Floor a timestamp to UTC midnight. */
function startOfDay(ts: number): number {
  return Math.floor(ts / DAY_MS) * DAY_MS;
}

/** Floor to the start of the ISO-ish week (Monday, UTC). */
function startOfWeek(ts: number): number {
  const d = startOfDay(ts);
  const dow = (new Date(d).getUTCDay() + 6) % 7; // Mon=0 … Sun=6
  return d - dow * DAY_MS;
}

/** Choose the granularity whose aligned ticks land nearest `target` over the range. Finer wins ties. */
function pickGranularity(rangeMs: number, target: number): DateGranularity {
  const days = rangeMs / DAY_MS;
  if (days <= target * 1.5) return 'day';
  if (days / 7 <= target * 1.5) return 'week';
  if (days / 30.4 <= target * 1.5) return 'month';
  if (days / 91 <= target * 1.5) return 'quarter';
  return 'year';
}

/** One date tick: its UTC timestamp + the granularity that produced it (for formatting). */
export interface DateTick {
  readonly ts: number;
  readonly granularity: DateGranularity;
}

/**
 * DATE-ALIGNED ticks spanning [minTs, maxTs] — the calendar analog of `axisTicks`. Picks a day/week/month/
 * quarter/year step so ~`target` ticks cover the range, then emits ticks aligned to real calendar boundaries
 * (UTC midnight / Monday / 1st of month / Jan-Apr-Jul-Oct / Jan 1). Degenerate or non-finite range → a single
 * tick at the start. Never hangs, never NaN. Deterministic.
 */
export function niceDateTicks(minTs: number, maxTs: number, target = 6): DateTick[] {
  if (!Number.isFinite(minTs) || !Number.isFinite(maxTs)) return [];
  const lo = Math.min(minTs, maxTs);
  const hi = Math.max(minTs, maxTs);
  const range = hi - lo;
  const g = pickGranularity(range > 0 ? range : DAY_MS, Math.max(2, Math.min(24, Math.floor(target))));
  const ticks: DateTick[] = [];
  const push = (ts: number) => ticks.push({ ts, granularity: g });
  const GUARD = 2000; // bound the loop (never hang on a pathological range)

  if (g === 'day') {
    for (let t = startOfDay(lo), n = 0; t <= hi && n < GUARD; t += DAY_MS, n++) push(t);
  } else if (g === 'week') {
    for (let t = startOfWeek(lo), n = 0; t <= hi && n < GUARD; t += WEEK_MS, n++) push(t);
  } else if (g === 'month') {
    for (let yr = y(lo), m = mo(lo), n = 0; utc(yr, m) <= hi && n < GUARD; m++, n++) {
      if (m > 11) { m = 0; yr++; }
      push(utc(yr, m));
    }
  } else if (g === 'quarter') {
    let m = Math.floor(mo(lo) / 3) * 3;
    for (let yr = y(lo), n = 0; utc(yr, m) <= hi && n < GUARD; m += 3, n++) {
      if (m > 11) { m -= 12; yr++; }
      push(utc(yr, m));
    }
  } else {
    for (let yr = y(lo), n = 0; utc(yr, 0) <= hi && n < GUARD; yr++, n++) push(utc(yr, 0));
  }
  return ticks.length > 0 ? ticks : [{ ts: lo, granularity: g }];
}

/** Human label for a date tick (UTC), by granularity. */
export function formatDateTick(ts: number, granularity: DateGranularity): string {
  if (!Number.isFinite(ts)) return '';
  const d = new Date(ts);
  const yr = d.getUTCFullYear();
  const m = d.getUTCMonth();
  const day = d.getUTCDate();
  switch (granularity) {
    case 'day':
    case 'week':
      return `${MONTHS[m]} ${day}`;
    case 'month':
      return `${MONTHS[m]} ${yr}`;
    case 'quarter':
      return `Q${Math.floor(m / 3) + 1} ${yr}`;
    case 'year':
      return `${yr}`;
  }
}

/** A stable bucket KEY for a timestamp at a granularity (group items by day/week/month/…). UTC. */
export function dateBucketKey(ts: number, granularity: DateGranularity): string {
  if (!Number.isFinite(ts)) return '';
  const d = new Date(ts);
  const yr = d.getUTCFullYear();
  const m = d.getUTCMonth();
  switch (granularity) {
    case 'day':
      return new Date(startOfDay(ts)).toISOString().slice(0, 10);
    case 'week':
      return new Date(startOfWeek(ts)).toISOString().slice(0, 10);
    case 'month':
      return `${yr}-${String(m + 1).padStart(2, '0')}`;
    case 'quarter':
      return `${yr}-Q${Math.floor(m / 3) + 1}`;
    case 'year':
      return `${yr}`;
  }
}
