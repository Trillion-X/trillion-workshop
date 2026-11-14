// parts/ui/show/schedule-calendar/schedule-format.d.mts
//
// PURPOSE
//   The types of schedule-format.mjs, so the calendar and its callers read the pure formatting functions typed.

export interface ScheduleFormatChoice { dateLocale?: string; hour12?: boolean }
export interface ScheduleFormat {
  time(instant: string): string;
  when(instant: string): string;
  whenDay(key: string): string;
  hour(hour: number): string;
  weekday(key: string, style?: 'short' | 'long'): string;
  dayNumber(key: string): string;
  longDay(key: string): string;
  shortDay(key: string): string;
  monthYear(key: string): string;
  monthLong(key: string): string;
  monthName(month: number, style?: 'short' | 'long'): string;
  numericDay(key: string): string;
  minutes(minute: number): string;
}
export function makeFormat(choice?: ScheduleFormatChoice): ScheduleFormat;
export function zoneOffsetMinutes(zone: string, instant: string | number | Date): number | null;
export function zoneShiftMinutes(zone: string, baseZone: string, key: string): number;
export function zoneHourLabel(hour: number, shift: number, format: ScheduleFormat): string;
export function zoneCity(zone: string): string;
export function knownZones(): string[];
