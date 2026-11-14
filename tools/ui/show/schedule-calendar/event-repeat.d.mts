export interface RepeatData {
  presets: { id: string; label: string; rule: string | null }[];
  weekday_names: string[];
  weekday_codes: string[];
  weekday_short: string[];
  nth_words: Record<string, string>;
  ordinal_suffixes: Record<string, string>;
  describe: { every: string; every_one: string; units: Record<string, [string, string]>; on: string; until: string; count: string; custom: string };
  frequencies: { value: string; label: string; rrule: string; weekdays?: boolean }[];
  weekdays: { value: string; label: string; code: string }[];
}
export interface RepeatPreset { id: string; value: string; label: string }
export interface CustomRepeat {
  frequency: string;
  interval: number;
  weekdays: string[];
  ends: { kind: 'never' } | { kind: 'date'; value: string } | { kind: 'count'; value: number };
}
export function zonedDate(startIso: string, zone: string): { year: number; month: number; day: number; weekday: number };
export function endOfZonedDay(day: string, zone: string): Date;
export function ordinalOf(number: number, suffixes: Record<string, string>): string;
export function presetsFor(startIso: string, zone: string, data: RepeatData): RepeatPreset[];
export function recurrenceToRRule(value: Partial<CustomRepeat> | null | undefined, options: { allDay: boolean; zone: string }, data: RepeatData): string | null;
export function rruleToRecurrence(rule: string, options: { zone: string }, data: RepeatData): CustomRepeat | null;
export function rruleToLabel(rule: string, startIso: string, zone: string, data: RepeatData): string;
