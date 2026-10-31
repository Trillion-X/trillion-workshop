// tools/wall-time/read-data/wall-time.mjs
//
// Wall time in a named zone: the one place a local date and clock time ("2026-11-01", "09:00", "America/New_York")
// becomes an instant and back, and the one test of whether a zone name is a zone. Every tool that keeps a time a person
// said in their own clock (held agreements, schedules, events, posts, calendar repeats) reads it here, so a clock change
// is handled one way everywhere. A library: it offers no tool of its own.
//
// Invariants:
// - A zone is an IANA name the runtime knows ("Europe/London", "UTC"), kept in its canonical spelling. An offset
//   ("+05:00"), an abbreviation the runtime does not know or an empty value is refused, never read as UTC.
// - A local time that does not exist (the hour skipped when clocks go forward) is a gap; one that happens twice (the
//   hour repeated when clocks go back) is a fold. The caller's gap policy ('skip' | 'next-valid') and fold policy
//   ('earlier' | 'later' | 'both') decide: a gap is skipped or moved to the next minute that exists; a fold takes the
//   earlier, the later or both instants.
// - Pure: no clock is read and nothing is stored here.
//
// A civil time is { date: 'YYYY-MM-DD', time: 'HH:MM' }.

export const DAY_MS = 86_400_000;
const MAX_GAP_SEARCH_MINUTES = 2_160; // accommodates a whole skipped civil day.
const ZONE_NAME = /^[A-Za-z][A-Za-z0-9_+-]*(?:\/[A-Za-z0-9_+-]+)*$/;

/** The canonical name of a time zone, or null when `value` is not a zone the runtime knows (never a UTC fallback). */
export function timeZoneName(value) {
  if (typeof value !== 'string' || value.length > 80 || !ZONE_NAME.test(value)) return null;
  try { return formatterFor(value).resolvedOptions().timeZone; } catch { return null; }
}

/** The instant (ms) of a local date (YYYY-MM-DD) and time (HH:MM) in `zone`, by the gap and fold rule; null in a
 *  skipped gap or for a date, time or zone that is not one. */
export function instantAt(date, time, zone, { gap = 'next-valid', fold = 'earlier' } = {}) {
  if (!parseDate(date) || !parseTime(time) || timeZoneName(zone) === null) return null;
  return resolveStart({ date, time }, zone, gap, fold)[0]?.instant_ms ?? null;
}

/** The local date (YYYY-MM-DD) and time (HH:MM) of an instant in `zone`. */
export function wallTimeOf(instantMs, zone) {
  return localParts(instantMs, zone);
}

export function pad(value) {
  return value < 10 ? `0${value}` : String(value);
}

export function parseDate(date) {
  const match = /^(\d{4,})-(\d{2})-(\d{2})$/.exec(date);
  if (!match) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const utc = new Date(Date.UTC(year, month - 1, day));
  if (!Number.isInteger(year) || utc.getUTCFullYear() !== year || utc.getUTCMonth() !== month - 1 || utc.getUTCDate() !== day) return null;
  return { year, month, day };
}

export function parseTime(time) {
  const match = /^(\d{2}):(\d{2})$/.exec(time);
  if (!match) return null;
  const hour = Number(match[1]);
  const minute = Number(match[2]);
  if (!Number.isInteger(hour) || !Number.isInteger(minute) || hour > 23 || minute > 59) return null;
  return { hour, minute };
}

export function formatUtcDate(ms) {
  const date = new Date(ms);
  return `${date.getUTCFullYear()}-${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())}`;
}

export function addCivilDays(date, days) {
  const parsed = parseDate(date);
  return formatUtcDate(Date.UTC(parsed.year, parsed.month - 1, parsed.day) + days * DAY_MS);
}

/** The same day `months` months on (YYYY-MM-DD); a day the month does not have is its last (31 January + 1 is 28 or 29 February). */
export function addCivilMonths(date, months) {
  const parsed = parseDate(date);
  const index = parsed.year * 12 + (parsed.month - 1) + months;
  const year = Math.floor(index / 12);
  const month = index - year * 12 + 1;
  const last = new Date(Date.UTC(year, month, 0)).getUTCDate();
  return `${year}-${pad(month)}-${pad(Math.min(parsed.day, last))}`;
}

export function addCivilMinutes(start, minutes) {
  const date = parseDate(start.date);
  const time = parseTime(start.time);
  const value = Date.UTC(date.year, date.month - 1, date.day, time.hour, time.minute) + minutes * 60_000;
  const output = new Date(value);
  return { date: formatUtcDate(value), time: `${pad(output.getUTCHours())}:${pad(output.getUTCMinutes())}` };
}

/** 0 (Sunday) to 6 (Saturday) of a civil date. */
export function weekday(date) {
  const parsed = parseDate(date);
  return new Date(Date.UTC(parsed.year, parsed.month - 1, parsed.day)).getUTCDay();
}

// One formatter per zone, made once: building an Intl.DateTimeFormat costs far more than formatting with it.
const formatters = new Map();
export function formatterFor(timezone) {
  let formatter = formatters.get(timezone);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat('en-US', {
      timeZone: timezone, hourCycle: 'h23',
      year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit',
    });
    formatters.set(timezone, formatter);
  }
  return formatter;
}

export function partsAt(instantMs, timezone) {
  const values = {};
  for (const part of formatterFor(timezone).formatToParts(new Date(instantMs))) values[part.type] = part.value;
  return values;
}

export function localParts(instantMs, timezone) {
  const values = partsAt(instantMs, timezone);
  return { date: `${values.year}-${values.month}-${values.day}`, time: `${values.hour}:${values.minute}` };
}

export function timezoneOffsetMinutesAt(instantMs, timezone) {
  const values = partsAt(instantMs, timezone);
  const asUtc = Date.UTC(Number(values.year), Number(values.month) - 1, Number(values.day), Number(values.hour), Number(values.minute), Number(values.second));
  return Math.round((asUtc - instantMs) / 60_000);
}

function civilEpochMs(civil) {
  const date = parseDate(civil.date);
  const time = parseTime(civil.time);
  return Date.UTC(date.year, date.month - 1, date.day, time.hour, time.minute);
}

// There can be zero (gap), one, or two (fold) absolute instants for one local clock value. Sample offsets around the
// requested civil instant, then verify the formatted parts exactly; guessing a single offset is wrong on both DST edges.
// A zone's rules do not change while the code runs, so each civil time's instants are worked out once per zone and
// remembered (a bounded map, emptied when full).
const INSTANTS_REMEMBERED = 4096;
const instantsOf = new Map();
export function possibleInstants(civil, timezone) {
  const key = `${timezone}|${civil.date}T${civil.time}`;
  const known = instantsOf.get(key);
  if (known) return known;
  const guess = civilEpochMs(civil);
  const offsets = new Set();
  for (let hour = -36; hour <= 36; hour += 1) offsets.add(timezoneOffsetMinutesAt(guess + hour * 3_600_000, timezone));
  const candidates = [...offsets]
    .map(offset => guess - offset * 60_000)
    .filter(instant => {
      const parts = localParts(instant, timezone);
      return parts.date === civil.date && parts.time === civil.time;
    });
  const instants = [...new Set(candidates)].sort((left, right) => left - right);
  if (instantsOf.size >= INSTANTS_REMEMBERED) instantsOf.clear();
  instantsOf.set(key, instants);
  return instants;
}

/** [{ requested, resolved, instant_ms, fold: 'unique' | 'earlier' | 'later' }]: none in a skipped gap under 'skip'. */
export function resolveStart(requested, timezone, gap, fold) {
  let candidates = possibleInstants(requested, timezone);
  let resolved = requested;
  if (candidates.length === 0 && gap === 'next-valid') {
    for (let minute = 1; minute <= MAX_GAP_SEARCH_MINUTES; minute += 1) {
      const probe = addCivilMinutes(requested, minute);
      candidates = possibleInstants(probe, timezone);
      if (candidates.length > 0) { resolved = probe; break; }
    }
  }
  if (candidates.length === 0) return [];
  if (candidates.length === 1) return [{ requested, resolved, instant_ms: candidates[0], fold: 'unique' }];
  if (fold === 'both') {
    return [
      { requested, resolved, instant_ms: candidates[0], fold: 'earlier' },
      { requested, resolved, instant_ms: candidates[candidates.length - 1], fold: 'later' },
    ];
  }
  return [{ requested, resolved, instant_ms: fold === 'later' ? candidates[candidates.length - 1] : candidates[0], fold }];
}
