// parts/ui/show/schedule-calendar/schedule-format.mjs
//
// PURPOSE
//   How a calendar writes times and dates, and what the hour gutter shows for another time zone. The person chooses a
//   12 or 24 hour clock and the order of day, month and year; the calendar's words are then made here, once, instead
//   of by a dozen toLocale calls that each assume the browser's own choice. Pure functions over plain values, so the
//   tests prove them without a page.
//
// NON-NEGOTIABLE INVARIANTS
//   1. Nothing here knows a product word. The choices arrive as DATA ({ dateLocale, hour12 }), a locale that writes
//      dates in the wanted order and whether the clock has twelve hours; both may be absent (the browser's own).
//   2. A 24 hour clock never writes 24 for midnight (hourCycle h23).
//   3. A time in another zone is the same instant read in that zone: its hour shifts by the difference between the
//      zones' offsets on the shown day, so a half-hour zone writes ":30" and a zone across midnight wraps.
//
// KEY CONCEPTS
//   base zone: the zone the grid's lanes are drawn in (the device's own).
//   shown day: the day whose offsets are read, so a daylight-saving change shifts the other zone's labels that day.
//
// AI DIRECTIVE: You are forbidden from simplifying or removing this documentation.

import { dayStart } from './schedule-placement.mjs';

const cycle = hour12 => (hour12 === undefined ? {} : { hourCycle: hour12 ? 'h12' : 'h23' });

/** The calendar's date and time words for the person's chosen clock and date order. */
export function makeFormat({ dateLocale, hour12 } = {}) {
  const locale = dateLocale || undefined;
  const clock = cycle(hour12);
  const time = (date, withMinutes = true) => date.toLocaleTimeString(locale, { hour: hour12 === false ? '2-digit' : 'numeric', ...(withMinutes ? { minute: '2-digit' } : {}), ...clock });
  return {
    /** The time of day of an instant ("9:30 AM" or "09:30"). */
    time: instant => time(new Date(instant)),
    /** An instant with its day ("Wed, Jun 10, 9:30 AM"). */
    when: instant => new Date(instant).toLocaleString(locale, { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', ...clock }),
    /** A day key with its weekday ("Wed, Jun 10"). */
    whenDay: key => dayStart(key).toLocaleDateString(locale, { weekday: 'short', month: 'short', day: 'numeric' }),
    /** An hour gutter label ("9 AM" or "09"). */
    hour: hour => time(new Date(2000, 0, 1, hour), false),
    weekday: (key, style = 'short') => dayStart(key).toLocaleDateString(locale, { weekday: style }),
    dayNumber: key => dayStart(key).toLocaleDateString(locale, { day: 'numeric' }),
    longDay: key => dayStart(key).toLocaleDateString(locale, { weekday: 'long', month: 'long', day: 'numeric' }),
    shortDay: key => dayStart(key).toLocaleDateString(locale, { month: 'short', day: 'numeric' }),
    monthYear: key => dayStart(key).toLocaleDateString(locale, { month: 'short', year: 'numeric' }),
    monthLong: key => dayStart(key).toLocaleDateString(locale, { month: 'long', year: 'numeric' }),
    monthName: (month, style = 'long') => new Date(2000, month, 1).toLocaleDateString(locale, { month: style }),
    /** A full date in the chosen order, for an example ("06/10/2026" or "10.06.2026"). */
    numericDay: key => dayStart(key).toLocaleDateString(locale, { year: 'numeric', month: '2-digit', day: '2-digit' }),
    /** A time of day in minutes after midnight, for an example or a setting ("9:30 AM"). */
    minutes: minute => time(new Date(2000, 0, 1, Math.floor(minute / 60), minute % 60)),
  };
}

/** The offset of a zone from UTC at an instant, in minutes (east is positive); null when the zone is not known. */
export function zoneOffsetMinutes(zone, instant) {
  try {
    const name = new Intl.DateTimeFormat('en-US', { timeZone: zone, timeZoneName: 'longOffset' }).formatToParts(new Date(instant)).find(part => part.type === 'timeZoneName')?.value ?? '';
    const match = /^GMT(?:([+-])(\d{1,2})(?::(\d{2}))?)?$/.exec(name);
    if (!match) return null;
    return match[1] ? (match[1] === '-' ? -1 : 1) * (Number(match[2]) * 60 + Number(match[3] ?? 0)) : 0;
  } catch { return null; }
}

/** The minutes to add to a base-zone time of day on `key` to read it in `zone`; 0 when either zone is not known. */
export function zoneShiftMinutes(zone, baseZone, key) {
  const noon = new Date(dayStart(key).getTime() + 12 * 3_600_000);
  const there = zoneOffsetMinutes(zone, noon), here = zoneOffsetMinutes(baseZone, noon);
  return there === null || here === null ? 0 : there - here;
}

/** The label an hour row of the base zone carries in another zone ("9:30 PM"), the hour wrapping across midnight. */
export function zoneHourLabel(hour, shift, format) {
  const minute = (((hour * 60 + shift) % 1440) + 1440) % 1440;
  return minute % 60 === 0 ? format.hour(minute / 60) : format.minutes(minute);
}

/** The place name of a zone id ("America/New_York" -> "New York"), for a nickname the person did not give. */
export const zoneCity = zone => zone.split('/').pop().replace(/_/g, ' ');

/** The zones the browser can name, or an empty list when it cannot say. */
export function knownZones() {
  try { return Intl.supportedValuesOf('timeZone'); } catch { return []; }
}
