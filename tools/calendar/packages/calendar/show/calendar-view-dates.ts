import type { CalendarTimeBlock } from '../read-data/read-calendar-time-blocks';
import type { CalendarViewDescriptor } from '../read-data/read-calendar-view-descriptors';
import type { CalendarScreenModel } from './calendar-screen-model';

export type CalendarViewDay = {
  key: string;
  label: string;
  shortLabel: string;
  date: Date;
  inMonth: boolean;
};

const DAY_LABEL = new Intl.DateTimeFormat('en-US', {
  weekday: 'short',
  day: 'numeric',
  timeZone: 'UTC',
});

const SHORT_DAY_LABEL = new Intl.DateTimeFormat('en-US', {
  day: 'numeric',
  timeZone: 'UTC',
});

const MONTH_LABEL = new Intl.DateTimeFormat('en-US', {
  month: 'long',
  year: 'numeric',
  timeZone: 'UTC',
});

const TIME_LABEL = new Intl.DateTimeFormat('en-US', {
  hour: 'numeric',
  minute: '2-digit',
  timeZone: 'UTC',
});

function validDate(value: string | undefined): Date | null {
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

function utcDayStart(date: Date): Date {
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
}

function addDays(date: Date, days: number): Date {
  const next = new Date(date);
  next.setUTCDate(next.getUTCDate() + days);
  return next;
}

export function dayKeyFromDate(date: Date): string {
  return date.toISOString().slice(0, 10);
}

export function dayKeyFromIso(value: string): string {
  return dayKeyFromDate(utcDayStart(validDate(value) ?? new Date()));
}

export function timeRange(start: string, end: string): string {
  return `${TIME_LABEL.format(new Date(start))} - ${TIME_LABEL.format(new Date(end))}`;
}

function anchorDate(model: CalendarScreenModel): Date {
  return utcDayStart(
    validDate(model.selectedBlock?.interval.start)
      ?? validDate(model.blocks[0]?.interval.start)
      ?? validDate(model.rangeStart)
      ?? new Date(),
  );
}

function viewDay(date: Date, month: number): CalendarViewDay {
  return {
    key: dayKeyFromDate(date),
    label: DAY_LABEL.format(date),
    shortLabel: SHORT_DAY_LABEL.format(date),
    date,
    inMonth: date.getUTCMonth() === month,
  };
}

function isWeekend(date: Date): boolean {
  const day = date.getUTCDay();
  return day === 0 || day === 6;
}

function mondayStart(date: Date): Date {
  const day = date.getUTCDay();
  return addDays(date, day === 0 ? -6 : 1 - day);
}

// The ONE generic day-column generator for the `time-grid` geometry. Day, Week,
// 3-day, Work week, and any future N-day view are all this function reading its
// descriptor's params — there is no per-view branch. `day_count` = how many day
// COLUMNS to show; a >=7 span (or a skip-weekends view) aligns to Monday so a
// "week" reads Mon-first and a "work week" reads Mon–Fri; smaller spans start at
// the anchor day (Day = anchor, 3-day = anchor..+2). Weekends are dropped when
// the descriptor asks (`skip_weekends`), so Work week (day_count 5) yields Mon–Fri.
export function timeGridDays(model: CalendarScreenModel, descriptor: CalendarViewDescriptor): CalendarViewDay[] {
  const anchor = anchorDate(model);
  const columns = Math.max(1, Math.floor(descriptor.day_count ?? 1));
  const alignWeek = columns >= 7 || descriptor.skip_weekends === true;
  const start = alignWeek ? mondayStart(anchor) : anchor;
  const out: CalendarViewDay[] = [];
  for (let cursor = 0; out.length < columns && cursor < columns + 14; cursor += 1) {
    const date = addDays(start, cursor);
    if (descriptor.skip_weekends && isWeekend(date)) continue;
    out.push(viewDay(date, anchor.getUTCMonth()));
  }
  return out;
}

export function monthViewDays(model: CalendarScreenModel): CalendarViewDay[] {
  const anchor = anchorDate(model);
  const first = new Date(Date.UTC(anchor.getUTCFullYear(), anchor.getUTCMonth(), 1));
  const firstDay = first.getUTCDay();
  const mondayOffset = firstDay === 0 ? -6 : 1 - firstDay;
  const start = addDays(first, mondayOffset);
  return Array.from({ length: 42 }, (_, index) => viewDay(addDays(start, index), anchor.getUTCMonth()));
}

export function monthViewLabel(model: CalendarScreenModel): string {
  return MONTH_LABEL.format(anchorDate(model));
}

export function blocksForDay(blocks: CalendarTimeBlock[], dayKey: string): CalendarTimeBlock[] {
  return blocks.filter((block) => dayKeyFromIso(block.interval.start) === dayKey);
}
