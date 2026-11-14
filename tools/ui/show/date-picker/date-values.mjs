// Calendar values stay calendar values. Converting a date-only string through
// UTC silently moves it to yesterday west of Greenwich. These helpers never do
// that; only localDayBounds deliberately turns a day into local instants.
const pad = value => String(value).padStart(2, '0');

export function parseDay(value) {
  if (typeof value !== 'string') return null;
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) return null;
  const year = Number(match[1]), month = Number(match[2]) - 1, day = Number(match[3]);
  if (year < 1 || month < 0 || month > 11 || day < 1 || day > 31) return null;
  const at = new Date(0);
  at.setUTCHours(12, 0, 0, 0);
  at.setUTCFullYear(year, month, day);
  return at.getUTCFullYear() === year && at.getUTCMonth() === month && at.getUTCDate() === day ? {year, month, day} : null;
}

export function calendarDay(value) {
  const match = typeof value === 'string' && /^(\d{4}-\d{2}-\d{2})(?:T|$)/.exec(value);
  return match && parseDay(match[1]) ? match[1] : null;
}

export function formatDay(year, month, day) {
  return `${String(year).padStart(4, '0')}-${pad(month + 1)}-${pad(day)}`;
}

export function localDay(value = new Date()) {
  return formatDay(value.getFullYear(), value.getMonth(), value.getDate());
}

export function shiftDay(value, days) {
  const parsed = parseDay(value);
  if (!parsed) return null;
  const at = new Date(0);
  at.setUTCHours(12, 0, 0, 0);
  at.setUTCFullYear(parsed.year, parsed.month, parsed.day + days);
  return formatDay(at.getUTCFullYear(), at.getUTCMonth(), at.getUTCDate());
}

export function dayInRange(value, min, max) {
  const day = calendarDay(value), from = calendarDay(min), to = calendarDay(max);
  return Boolean(day && (!from || day >= from) && (!to || day <= to));
}

export function boundedDay(value, min, max) {
  const day = calendarDay(value), from = calendarDay(min), to = calendarDay(max);
  if (!day) return from ?? to ?? null;
  return from && day < from ? from : to && day > to ? to : day;
}

export function localDayBounds(value) {
  const day = calendarDay(value);
  if (!day) return null;
  const start = new Date(`${day}T00:00:00`);
  const end = new Date(start);
  end.setDate(end.getDate() + 1);
  return {min: start.getTime(), max: end.getTime() - 1};
}

/** Accept typed H:mm or HH:mm and optional seconds, returning an HTML local
 * time value. No date, offset or invented timezone crosses this boundary. */
export function normalizeTime(value) {
  if (typeof value !== 'string') return null;
  const match = /^(\d{1,2}):(\d{2})(?::(\d{2})(?:\.(\d{1,3}))?)?$/.exec(value.trim());
  if (!match || Number(match[1]) > 23 || Number(match[2]) > 59 || (match[3] && Number(match[3]) > 59)) return null;
  return `${pad(Number(match[1]))}:${match[2]}${match[3] ? `:${match[3]}${match[4] ? `.${match[4]}` : ''}` : ''}`;
}

const timeNumber = value => {
  const time = normalizeTime(value);
  if (!time) return null;
  const [hours, minutes, seconds = '0'] = time.split(':');
  return Number(hours) * 3600000 + Number(minutes) * 60000 + Number(seconds) * 1000;
};

export function timeInRange(value, min, max) {
  const at = timeNumber(value), from = timeNumber(min), to = timeNumber(max);
  if (at === null) return false;
  // A time range may cross midnight, matching the time input's normal meaning.
  if (from !== null && to !== null && from > to) return at >= from || at <= to;
  return (from === null || at >= from) && (to === null || at <= to);
}

export function splitLocalDateTime(value) {
  if (typeof value !== 'string') return {day: null, time: null};
  const match = /^(\d{4}-\d{2}-\d{2})T(.+)$/.exec(value);
  const day = match ? calendarDay(match[1]) : null;
  const time = match ? normalizeTime(match[2]) : null;
  return day && time ? {day, time} : {day: null, time: null};
}

const dateTimeKey = value => {
  const {day, time} = splitLocalDateTime(value);
  return day && time ? `${day}T${String(timeNumber(time)).padStart(8, '0')}` : null;
};

export function dateTimeInRange(value, min, max) {
  const at = dateTimeKey(value), from = dateTimeKey(min), to = dateTimeKey(max);
  return Boolean(at && (!from || at >= from) && (!to || at <= to));
}

/** Whether a local wall-clock datetime exists in the browser's current timezone. */
export function isLocalDateTimeValid(day, time) {
  const date = calendarDay(day), clock = normalizeTime(time);
  if (!date || !clock) return false;
  const expected = parseDay(date);
  const parts = /^([0-2]\d):([0-5]\d)(?::([0-5]\d)(?:\.(\d{1,3}))?)?$/.exec(clock);
  if (!expected || !parts) return false;
  const at = new Date(`${date}T${clock}`);
  const milliseconds = Number((parts[4] ?? '').padEnd(3, '0') || 0);
  return Number.isFinite(at.getTime())
    && at.getFullYear() === expected.year
    && at.getMonth() === expected.month
    && at.getDate() === expected.day
    && at.getHours() === Number(parts[1])
    && at.getMinutes() === Number(parts[2])
    && at.getSeconds() === Number(parts[3] ?? 0)
    && at.getMilliseconds() === milliseconds;
}

export function combineLocalDateTime(day, time, min, max) {
  const date = calendarDay(day), clock = normalizeTime(time);
  if (!date || !clock || !isLocalDateTimeValid(date, clock)) return null;
  const value = `${date}T${clock}`;
  return dateTimeInRange(value, min, max) ? value : null;
}
