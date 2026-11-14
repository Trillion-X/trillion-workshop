// A described week ("Mon-Fri 9 to 5, lunch 12 to 1, Saturday 10am-2pm") read into weekly hours.
//
// PURPOSE: the one reader that turns a person's words about their available hours into the same
// `{ weekday, intervals: [{ start_minute, end_minute }] }` days WeeklyAvailability edits. It holds
// no words of its own: every name, group, joiner and break word is a row of schedule-description.json.
//
// RULES: a clause names days, times, or both. A clause with times and no days keeps the days of the
// clause before it, so "Mon-Fri 9 to 5, break 12 to 1" means the break is on Mon-Fri. A break clause
// cuts its times out of the hours already given for those days. A day clause with an off word and no
// times clears those days. Hours without am/pm: a start below `afternoonBelowHour` (1 to 6) is the
// afternoon, 7 to 11 is the morning, 12 is noon; an end not after its start moves to the afternoon.
// What cannot be read is reported as an issue, never guessed, and nothing is applied.

import data from './schedule-description.json' with { type: 'json' };

const escape = text => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const longestFirst = names => [...names].sort((a, b) => b.length - a.length);

const dayRows = data.weekdays.flatMap(row => row.names.map(name => ({ name, weekdays: [row.weekday] })));
const groupRows = data.groups.flatMap(row => row.names.map(name => ({ name, weekdays: row.weekdays })));
const dayNames = longestFirst([...groupRows, ...dayRows].map(row => row.name));
const dayLookup = new Map([...dayRows, ...groupRows].map(row => [row.name, row.weekdays]));
const dayPattern = `(?<![a-z])(?:${dayNames.map(escape).join('|')})(?![a-z])`;
const joinerPattern = longestFirst(data.rangeJoiners).map(escape).join('|');
const meridiemPattern = longestFirst([...data.meridiem.am, ...data.meridiem.pm]).map(escape).join('|');
const clock = `(?:(?:[01]?\\d|2[0-4])(?::[0-5]\\d)?\\s*(?:${meridiemPattern})?|${[...data.noonWords, ...data.midnightWords].map(escape).join('|')})`;
const timeRange = new RegExp(`(${clock})\\s*(?:${joinerPattern})\\s*(${clock})`, 'g');
const dayRange = new RegExp(`(${dayPattern})\\s*(?:${joinerPattern})\\s*(${dayPattern})`, 'g');
const anyDay = new RegExp(dayPattern, 'g');
const containsWord = (text, words) => words.some(word => new RegExp(`(?<![a-z])${escape(word)}(?![a-z])`).test(text));
const separators = new RegExp(data.clauseSeparators.map(escape).join('|'), 'g');
const amSet = new Set(data.meridiem.am);

function clockParts(text) {
  const value = text.trim();
  if (data.noonWords.includes(value)) return { minutes: 720, meridiem: 'pm', bare: false };
  if (data.midnightWords.includes(value)) return { minutes: 0, meridiem: 'am', bare: false, midnight: true };
  const match = new RegExp(`^(\\d{1,2})(?::(\\d{2}))?\\s*(${meridiemPattern})?$`).exec(value);
  if (!match) return null;
  const hour = Number(match[1]);
  const minute = Number(match[2] ?? 0);
  if (hour > 24 || (hour === 24 && minute > 0)) return null;
  const meridiem = match[3] ? (amSet.has(match[3]) ? 'am' : 'pm') : null;
  if (meridiem && (hour < 1 || hour > 12)) return null;
  return { hour, minute, meridiem, bare: !meridiem };
}

function minutesOf(parts, assume) {
  if (parts.minutes !== undefined) return parts.minutes;
  const meridiem = parts.meridiem ?? assume;
  if (parts.hour === 24) return 1440;
  if (!meridiem) return parts.hour * 60 + parts.minute;
  return (parts.hour % 12) * 60 + parts.minute + (meridiem === 'pm' ? 720 : 0);
}

/** One written range as minutes, or null when it cannot be read. */
function readRange(fromText, toText) {
  const from = clockParts(fromText);
  const to = clockParts(toText);
  if (!from || !to) return null;
  const hours24 = from.hour > 12 || to.hour > 12 || from.hour === 0;
  if (hours24) {
    const start = minutesOf(from, null);
    const end = minutesOf(to, null);
    return end > start ? { start_minute: start, end_minute: end } : null;
  }
  let start;
  if (from.meridiem || from.minutes !== undefined) start = minutesOf(from, null);
  else if (to.meridiem) {
    start = minutesOf(from, to.meridiem);
    if (to.meridiem === 'pm' && start >= minutesOf(to, null)) start = minutesOf(from, 'am');
  } else start = minutesOf(from, from.hour === 12 || from.hour >= data.afternoonBelowHour ? (from.hour === 12 ? 'pm' : 'am') : 'pm');
  let end = to.meridiem || to.minutes !== undefined ? minutesOf(to, null) : minutesOf(to, 'am');
  if (!to.meridiem && to.minutes === undefined) {
    while (end <= start && end < 1440 - 720) end += 720;
    if (end <= start) end = minutesOf(to, null) + 720;
  }
  if (to.midnight) end = 1440;
  return end > start && end <= 1440 ? { start_minute: start, end_minute: end } : null;
}

function readDays(text) {
  const found = new Set();
  let rest = text;
  rest = rest.replace(dayRange, (_, a, b) => {
    const first = dayLookup.get(a)?.[0];
    const last = dayLookup.get(b)?.[0];
    if (first === undefined || last === undefined || dayLookup.get(a).length > 1 || dayLookup.get(b).length > 1) return `${a} ${b}`;
    for (let weekday = first; ; weekday = (weekday + 1) % 7) { found.add(weekday); if (weekday === last) break; }
    return ' ';
  });
  for (const match of rest.matchAll(anyDay)) for (const weekday of dayLookup.get(match[0]) ?? []) found.add(weekday);
  return [...found].sort((a, b) => a - b);
}

function subtract(intervals, cut) {
  return intervals.flatMap(row => {
    if (cut.end_minute <= row.start_minute || cut.start_minute >= row.end_minute) return [row];
    const parts = [];
    if (cut.start_minute > row.start_minute) parts.push({ start_minute: row.start_minute, end_minute: cut.start_minute });
    if (cut.end_minute < row.end_minute) parts.push({ start_minute: cut.end_minute, end_minute: row.end_minute });
    return parts;
  });
}

function merge(intervals) {
  const sorted = [...intervals].sort((a, b) => a.start_minute - b.start_minute);
  const merged = [];
  for (const row of sorted) {
    const last = merged[merged.length - 1];
    if (last && row.start_minute <= last.end_minute) last.end_minute = Math.max(last.end_minute, row.end_minute);
    else merged.push({ ...row });
  }
  return merged;
}

/**
 * Reads a described week.
 * Returns `{ days, issues }`: `days` holds every weekday 0-6 that has hours, and `issues` is a list of
 * `{ code, text }` (`empty`, `no_times`, `unreadable_times`, `no_days`, `break_without_hours`) naming the
 * clause that could not be read. When `issues` is not empty nothing should be applied.
 */
export function readScheduleDescription(description) {
  const issues = [];
  const text = String(description ?? '').toLowerCase().trim();
  if (!text) return { days: [], issues: [{ code: 'empty', text: '' }] };
  const clauses = text.replace(/(\d)\.(\d)/g, '$1:$2').split(separators).map(part => part.trim()).filter(Boolean);
  const hours = new Map();
  const breaks = [];
  let lastDays = [];
  // Days named by a clause with no times ("Mon, Wed and Fri 10 to 6") wait for the next clause that has times.
  let waiting = [];
  let waitingText = '';
  for (const clause of clauses) {
    const ranges = [...clause.matchAll(timeRange)];
    const named = readDays(clause.replace(timeRange, ' '));
    const isBreak = containsWord(clause, data.breakWords);
    const isOff = !ranges.length && containsWord(clause, data.offWords);
    const days = ranges.length && waiting.length ? [...new Set([...waiting, ...named])].sort((a, b) => a - b) : named.length ? named : lastDays;
    if (isOff) {
      if (!named.length) { issues.push({ code: 'no_days', text: clause }); continue; }
      for (const weekday of named) hours.set(weekday, []);
      waiting = []; waitingText = '';
      lastDays = named;
      continue;
    }
    if (!ranges.length) {
      if (named.length) { waiting = [...new Set([...waiting, ...named])]; waitingText = waitingText ? `${waitingText}, ${clause}` : clause; }
      else issues.push({ code: 'unreadable_times', text: clause });
      continue;
    }
    waiting = []; waitingText = '';
    if (named.length || days.length) lastDays = days;
    const read = ranges.map(match => readRange(match[1], match[2]));
    if (read.some(row => row === null)) { issues.push({ code: 'unreadable_times', text: clause }); continue; }
    if (isBreak) { breaks.push({ days: named.length ? named : null, inherited: days, ranges: read, clause }); continue; }
    if (!days.length) { issues.push({ code: 'no_days', text: clause }); continue; }
    for (const weekday of days) hours.set(weekday, merge([...(hours.get(weekday) ?? []), ...read]));
  }
  if (waiting.length) issues.push({ code: 'no_times', text: waitingText });
  for (const cut of breaks) {
    const targets = cut.days ?? (cut.inherited.length ? cut.inherited : [...hours.keys()]);
    const withHours = targets.filter(weekday => (hours.get(weekday) ?? []).length);
    if (!withHours.length) { issues.push({ code: 'break_without_hours', text: cut.clause }); continue; }
    for (const weekday of withHours) for (const range of cut.ranges) hours.set(weekday, subtract(hours.get(weekday), range));
  }
  const days = [...hours].filter(([, intervals]) => intervals.length).sort((a, b) => a[0] - b[0])
    .map(([weekday, intervals]) => ({ weekday, intervals: merge(intervals) }));
  if (!issues.length && !days.length && !clauses.some(clause => containsWord(clause, data.offWords))) issues.push({ code: 'empty', text });
  return { days, issues };
}

/** The break minutes a one-tap "add break" removes, from DATA. */
export const defaultBreakMinutes = data.defaultBreakMinutes;

/**
 * Cuts a break out of the middle of the longest interval of a day, snapped to `snap` minutes.
 * Returns the day's new intervals, or the same intervals when no interval is long enough to hold the break
 * with at least `snap` minutes of work on each side.
 */
export function carveBreak(intervals, minutes = data.defaultBreakMinutes, snap = 15) {
  const longest = [...intervals].sort((a, b) => (b.end_minute - b.start_minute) - (a.end_minute - a.start_minute))[0];
  if (!longest || longest.end_minute - longest.start_minute < minutes + snap * 2) return intervals;
  const middle = (longest.start_minute + longest.end_minute) / 2;
  const start = Math.round((middle - minutes / 2) / snap) * snap;
  return intervals.flatMap(row => row === longest
    ? [{ start_minute: row.start_minute, end_minute: start }, { start_minute: start + minutes, end_minute: row.end_minute }]
    : [row]);
}
