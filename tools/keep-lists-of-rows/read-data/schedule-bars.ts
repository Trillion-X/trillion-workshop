// parts/visual-database/read-data/schedule-bars.ts
//
// PURPOSE
//   The geometry of the Gantt view (show/views/ScheduleView.tsx): which days a record's bar covers, the time axis the
//   bars sit on (its month and day or week headings, weekend shading, today), where each bar sits on it, and the curve
//   that joins one bar to the bar that follows it. Pure: no records, no React, no DOM.
//
// NON-NEGOTIABLE INVARIANTS
//   1. Days are whole UTC calendar days counted from 1970-01-01, so a bar covers the same days in every time zone.
//   2. What a zoom step looks like is DATA (source-data/schedule-zoom-levels.json); no step is named here.
//   3. An axis covers at most `max_days`, so a record dated centuries away cannot make a million headings.

const DAY_MS = 86_400_000;

/** One zoom step as the DATA row holds it. */
export interface ScheduleLevel {
  id: string;
  label: string;
  day_px: number;
  head: 'day' | 'week';
  before_days: number;
  after_days: number;
}

export interface ScheduleLimits {
  row_px: number;
  max_days: number;
  scroll_lead_px: number;
}

/** The whole days a record covers, first and last day inclusive. */
export interface ScheduleSpan {
  start: number;
  end: number;
}

/** The calendar day an ISO date or date-time names, as a day count; null for anything that is not one. */
export function dayOf(value: string | null | undefined): number | null {
  const match = typeof value === 'string' ? /^(\d{4})-(\d{2})-(\d{2})/.exec(value) : null;
  if (!match) return null;
  const instant = Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
  return Number.isNaN(instant) ? null : Math.floor(instant / DAY_MS);
}

/** The ISO day (YYYY-MM-DD) a day count names. */
export function isoOf(day: number): string {
  return new Date(day * DAY_MS).toISOString().slice(0, 10);
}

/** The days a record covers from its one or two dates: a lone date is a one-day bar; two dates span from the earlier to
 *  the later, whichever way round the list holds them. No date, no bar. */
export function spanOf(first: string | null | undefined, second?: string | null): ScheduleSpan | null {
  const a = dayOf(first);
  const b = dayOf(second);
  if (a === null && b === null) return null;
  const days = [a, b].filter((day): day is number => day !== null);
  return { start: Math.min(...days), end: Math.max(...days) };
}

/** 0 for Sunday through 6 for Saturday (day 0, 1970-01-01, was a Thursday). */
const weekdayOf = (day: number) => (((day + 4) % 7) + 7) % 7;
const isWeekend = (day: number) => weekdayOf(day) === 0 || weekdayOf(day) === 6;
const weekStartOf = (day: number) => day - weekdayOf(day);

export interface AxisHeading {
  label: string;
  left: number;
  width: number;
  today?: boolean;
}

export interface ScheduleAxis {
  /** The first day on the axis and how many days it covers. */
  first: number;
  days: number;
  dayPx: number;
  width: number;
  months: AxisHeading[];
  ticks: AxisHeading[];
  /** The left edge of each weekend day, and of each week's first day (the faint vertical lines). */
  weekends: number[];
  weekLines: number[];
  /** Where today's line sits, null when today is off the axis. */
  todayLeft: number | null;
}

const monthName = (day: number, locale?: string) => new Intl.DateTimeFormat(locale, { month: 'long', year: 'numeric', timeZone: 'UTC' }).format(day * DAY_MS);
const shortDate = (day: number, locale?: string) => new Intl.DateTimeFormat(locale, { month: 'short', day: 'numeric', timeZone: 'UTC' }).format(day * DAY_MS);
const dayNumber = (day: number, locale?: string) => new Intl.DateTimeFormat(locale, { day: 'numeric', timeZone: 'UTC' }).format(day * DAY_MS);

/** The time axis for these spans at one zoom step: from the earlier of the first bar and today (less the step's lead) to
 *  the later of the last bar and today (plus its tail), whole weeks, never longer than the limit. */
export function axisFor(spans: readonly ScheduleSpan[], level: ScheduleLevel, limits: ScheduleLimits, today: number, locale?: string): ScheduleAxis {
  const earliest = spans.length ? Math.min(...spans.map(span => span.start)) : today;
  const latest = spans.length ? Math.max(...spans.map(span => span.end)) : today;
  const lowest = Math.min(earliest - 7, today - level.before_days);
  const highest = Math.max(latest + 7, today + level.after_days);
  const longest = Math.max(7, Math.floor(limits.max_days / 7) * 7);
  // Today stays in view; the part of the range farthest from it goes first.
  const low = highest - lowest + 1 > longest ? Math.max(lowest, today - Math.floor(longest / 3)) : lowest;
  const first = weekStartOf(low);
  const days = Math.min(longest, Math.ceil((highest - first + 1) / 7) * 7);
  const dayPx = level.day_px;
  const months: AxisHeading[] = [];
  const ticks: AxisHeading[] = [];
  const weekends: number[] = [];
  const weekLines: number[] = [];
  let monthKey = '';
  for (let i = 0; i < days; i += 1) {
    const day = first + i;
    const date = new Date(day * DAY_MS);
    const key = `${date.getUTCFullYear()}-${date.getUTCMonth()}`;
    if (key !== monthKey) {
      months.push({ label: monthName(day, locale), left: i * dayPx, width: 0 });
      monthKey = key;
    }
    months[months.length - 1]!.width += dayPx;
    if (isWeekend(day)) weekends.push(i * dayPx);
    if (weekdayOf(day) === 0) weekLines.push(i * dayPx);
    if (level.head === 'day') ticks.push({ label: dayNumber(day, locale), left: i * dayPx, width: dayPx, today: day === today });
    else if (weekdayOf(day) === 0) ticks.push({ label: shortDate(day, locale), left: i * dayPx, width: dayPx * 7, today: today >= day && today < day + 7 });
  }
  const todayLeft = today >= first && today < first + days ? (today - first) * dayPx + dayPx / 2 : null;
  return { first, days, dayPx, width: days * dayPx, months, ticks, weekends, weekLines, todayLeft };
}

export interface BarBox {
  left: number;
  width: number;
  /** The bar starts before or ends after the axis, so the axis shows only part of it. */
  clipped: boolean;
}

/** Where a span's bar sits on the axis; null when it lies wholly outside it. A bar is at least one day wide. */
export function barBox(span: ScheduleSpan, axis: ScheduleAxis): BarBox | null {
  const last = axis.first + axis.days - 1;
  if (span.end < axis.first || span.start > last) return null;
  const start = Math.max(span.start, axis.first);
  const end = Math.min(span.end, last);
  return { left: (start - axis.first) * axis.dayPx, width: (end - start + 1) * axis.dayPx, clipped: start !== span.start || end !== span.end };
}

/** The curve from the right edge of one bar (at row height `fromY`) to the left edge of the next (`toY`). A follower
 *  that starts before its predecessor ends is joined by a dashed curve, so the order reads as out of sequence. */
export function dependencyPath(from: { right: number; y: number }, to: { left: number; y: number }): { d: string; outOfOrder: boolean } {
  const reach = Math.max(16, Math.abs(to.left - from.right) / 2);
  const d = `M${from.right} ${from.y} C${from.right + reach} ${from.y}, ${to.left - reach} ${to.y}, ${to.left} ${to.y}`;
  return { d, outOfOrder: to.left < from.right };
}
/** A date value moved by whole days, written the way the list holds it: a day alone stays a day, an instant keeps its time. */
export function shiftIso(value: string, days: number): string {
  const day = dayOf(value);
  if (day === null) return value;
  const shifted = isoOf(day + days);
  return /^\d{4}-\d{2}-\d{2}$/.test(value) ? shifted : `${shifted}${value.slice(10)}`;
}

/** A date value as the list should keep it after a move: midnight UTC is a day, anything else an instant. */
export function keptIso(value: string): string {
  return /T00:00:00(?:\.0+)?Z$/.test(value) ? value.slice(0, 10) : value;
}

/** Which of a record's two date values is its first day and which its last (the first when both are the same day),
 *  so an edge change writes the field that holds that edge. */
export function edgeFields(first: string | null | undefined, second: string | null | undefined): { start: 'first' | 'second' | null; end: 'first' | 'second' | null } {
  const a = dayOf(first);
  const b = dayOf(second);
  if (a === null && b === null) return { start: null, end: null };
  if (b === null) return { start: 'first', end: 'first' };
  if (a === null) return { start: 'second', end: 'second' };
  return a <= b ? { start: 'first', end: 'second' } : { start: 'second', end: 'first' };
}