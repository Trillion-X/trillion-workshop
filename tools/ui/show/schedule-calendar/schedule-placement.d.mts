// parts/ui/show/schedule-calendar/schedule-placement.d.mts
//
// PURPOSE
//   The types of schedule-placement.mjs, so the calendar and its callers read the pure placement functions typed.

export type ScheduleViewShape = { grid: 'month' } | { grid: 'hours'; days: number; rolling?: boolean };
export type Timed = { id: string; at: string | null; day?: string; dayEnd?: string; day_end?: string; minutes?: number };

export function dayKey(date: Date): string;
export function isWholeDay(at: unknown): at is string;
export function dayOf(at: string | null | undefined): string | null;
export function dayStart(key: string): Date;
export function addDays(key: string, count: number): string;
export function weekStart(key: string, weekStartsOn?: number): string;
export function weekNumber(key: string, weekStartsOn?: number): number;
export function visibleDays(view: ScheduleViewShape, anchor: string, weekStartsOn?: number): string[];
export function visibleRange(view: ScheduleViewShape, anchor: string, weekStartsOn?: number): { from: string; to: string };
export function shiftAnchor(view: ScheduleViewShape, anchor: string, direction: number): string;
export function moveToMonth(key: string, month: number): string;
export function minuteOf(at: string): number;
export function timeAt(key: string, minute: number): string;
export function minuteAtOffset(offset: number, extent: number, window?: { windowStart?: number; windowEnd?: number; snap?: number }): number;
export function durationAtDelta(originalMinutes: number, deltaPx: number, pixelsPerHour: number, bounds?: { snap?: number; min?: number; max?: number }): number;
export function shiftWhen(at: string, days: number): string;
export function wholeDayOf(item: { at?: string | null; day?: string }): string | null;
export function dayDropTime(key: string, earlierAt: string | null, defaultMinute?: number): string;
export function itemsByDay<T extends Timed>(items: T[], visibleDays?: string[]): Map<string, T[]>;
export function allDayBannerLayout<T extends Timed>(items: T[], days: string[]): { item: T; startColumn: number; columnSpan: number; row: number }[];
export function laneLayout<T extends Timed>(items: T[], durationMinutes?: number): { item: T & { at: string }; startMinute: number; endMinute: number; column: number; columnCount: number }[];
