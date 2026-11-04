// Compatibility exports for Trillion's time owners. Workshop owns the shared algorithms.

import * as shared from 'trillion-workshop/tools/wall-time/read-data/wall-time.mjs';

export type DstGapPolicy = 'skip' | 'next-valid';
export type DstFoldPolicy = 'earlier' | 'later' | 'both';

export interface CivilDateTime {
  readonly date: string;
  readonly time: string;
}

export interface ResolvedStart {
  readonly requested: CivilDateTime;
  readonly resolved: CivilDateTime;
  readonly instant_ms: number;
  readonly fold: 'unique' | 'earlier' | 'later';
}

export const DAY_MS = shared.DAY_MS;

export function timeZoneName(value: unknown): string | null {
  return shared.timeZoneName(value);
}

export function instantAt(
  date: string,
  time: string,
  zone: string,
  options: { gap?: DstGapPolicy; fold?: Exclude<DstFoldPolicy, 'both'> } = {},
): number | null {
  return shared.instantAt(date, time, zone, options);
}

export function wallTimeOf(instantMs: number, zone: string): CivilDateTime {
  return shared.wallTimeOf(instantMs, zone) as CivilDateTime;
}

export function pad(value: number): string {
  return shared.pad(value);
}

export function parseDate(date: string): { year: number; month: number; day: number } | null {
  return shared.parseDate(date);
}

export function parseTime(time: string): { hour: number; minute: number } | null {
  return shared.parseTime(time);
}

export function formatUtcDate(ms: number): string {
  return shared.formatUtcDate(ms);
}

export function addCivilDays(date: string, days: number): string {
  return shared.addCivilDays(date, days);
}

export function addCivilMonths(date: string, months: number): string {
  return shared.addCivilMonths(date, months);
}

export function addCivilMinutes(start: CivilDateTime, minutes: number): CivilDateTime {
  return shared.addCivilMinutes(start, minutes) as CivilDateTime;
}

export function weekday(date: string): number {
  return shared.weekday(date);
}

export function formatterFor(timezone: string): Intl.DateTimeFormat {
  return shared.formatterFor(timezone);
}

export function partsAt(instantMs: number, timezone: string): Record<string, string> {
  return shared.partsAt(instantMs, timezone);
}

export function localParts(instantMs: number, timezone: string): CivilDateTime {
  return shared.localParts(instantMs, timezone) as CivilDateTime;
}

export function timezoneOffsetMinutesAt(instantMs: number, timezone: string): number {
  return shared.timezoneOffsetMinutesAt(instantMs, timezone);
}

export function possibleInstants(civil: CivilDateTime, timezone: string): number[] {
  return shared.possibleInstants(civil, timezone);
}

export function resolveStart(
  requested: CivilDateTime,
  timezone: string,
  gap: DstGapPolicy,
  fold: DstFoldPolicy,
): ResolvedStart[] {
  return shared.resolveStart(requested, timezone, gap, fold) as ResolvedStart[];
}
