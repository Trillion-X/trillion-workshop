// Time ranges dragged on the calendar, turned into what an availability link stores.
//
// PURPOSE: the one conversion between the spans a person draws ({ startAt, endAt } instants on one day) and a
// link's two ways of holding times: weekly windows (a link that repeats) and fixed one-off slots (one
// duration each). Weekday and clock are read in the link's own time zone, so the windows mean the same
// thing to the people who book.

const weekdayNames = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const formats = new Map();

function localParts(ms, timezone) {
  let format = formats.get(timezone);
  if (!format) {
    format = new Intl.DateTimeFormat('en-US', { timeZone: timezone, hourCycle: 'h23', weekday: 'short', hour: '2-digit', minute: '2-digit' });
    formats.set(timezone, format);
  }
  const parts = Object.fromEntries(format.formatToParts(new Date(ms)).map(part => [part.type, part.value]));
  return { weekday: weekdayNames.indexOf(parts.weekday), minute: Number(parts.hour) * 60 + Number(parts.minute) };
}

const clock = minutes => minutes === 1440 ? '24:00' : `${String(Math.floor(minutes / 60)).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')}`;

/** The ranges with overlapping or touching ones joined, in time order. Each result keeps the earliest range's id. */
export function mergeRanges(ranges) {
  const sorted = ranges.map(range => ({ ...range, start: Date.parse(range.startAt), end: Date.parse(range.endAt) }))
    .filter(range => Number.isFinite(range.start) && Number.isFinite(range.end) && range.end > range.start)
    .sort((a, b) => a.start - b.start);
  const merged = [];
  for (const range of sorted) {
    const last = merged[merged.length - 1];
    if (last && range.start <= last.end) {
      if (range.end > last.end) { last.end = range.end; last.endAt = range.endAt; }
    } else merged.push({ ...range });
  }
  return merged.map(({ start, end, ...range }) => range);
}

/** A range added to the drawn ones; it joins any it touches. */
export function addRange(ranges, range) {
  return mergeRanges([...ranges, { id: range.startAt, ...range }]);
}

/** Weekly windows (`{ weekday, start, end }`) from drawn ranges, in `timezone`. A range crossing midnight is cut at it. */
export function rangesToWindows(ranges, timezone) {
  const windows = [];
  for (const range of mergeRanges(ranges)) {
    const start = Date.parse(range.startAt);
    const end = Date.parse(range.endAt);
    const from = localParts(start, timezone);
    const to = localParts(end, timezone);
    if (from.weekday === to.weekday && to.minute > from.minute) windows.push({ weekday: from.weekday, start: clock(from.minute), end: clock(to.minute) });
    else {
      windows.push({ weekday: from.weekday, start: clock(from.minute), end: '24:00' });
      if (to.minute > 0) windows.push({ weekday: to.weekday, start: '00:00', end: clock(to.minute) });
    }
  }
  const byDay = new Map();
  for (const window of windows) byDay.set(window.weekday, [...(byDay.get(window.weekday) ?? []), window]);
  return [...byDay].sort((a, b) => a[0] - b[0]).flatMap(([, rows]) => {
    const sorted = rows.sort((a, b) => a.start.localeCompare(b.start));
    const joined = [];
    for (const row of sorted) {
      const last = joined[joined.length - 1];
      if (last && row.start <= last.end) { if (row.end > last.end) last.end = row.end; } else joined.push({ ...row });
    }
    return joined;
  });
}

/** Fixed slots of exactly `durationMin` from drawn ranges; time left over at the end of a range is dropped. */
export function rangesToOneOffs(ranges, durationMin) {
  const length = durationMin * 60_000;
  const slots = [];
  for (const range of mergeRanges(ranges)) {
    const end = Date.parse(range.endAt);
    for (let start = Date.parse(range.startAt); start + length <= end; start += length) slots.push({ start_ms: start, end_ms: start + length });
  }
  return slots;
}

/** Weekly windows covering fixed slots, so a one-time link can repeat. */
export function oneOffsToWindows(slots, timezone) {
  return rangesToWindows(slots.map(slot => ({ id: String(slot.start_ms), startAt: new Date(slot.start_ms).toISOString(), endAt: new Date(slot.end_ms).toISOString() })), timezone);
}

/**
 * Drawn ranges for the given local days from a weekly schedule (`days: [{ weekday, intervals }]`).
 * `at(dayKey, minute)` turns a day and minute into an instant (ISO string), so the caller owns the time zone.
 */
export function scheduleToRanges(schedule, dayKeys, weekdayOf, at) {
  const ranges = [];
  for (const key of dayKeys) {
    const day = schedule.days.find(row => row.weekday === weekdayOf(key));
    for (const interval of day?.intervals ?? []) {
      const startAt = at(key, interval.start_minute);
      ranges.push({ id: startAt, startAt, endAt: at(key, interval.end_minute) });
    }
  }
  return ranges;
}
