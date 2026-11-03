// tools/plan-my-time/do-work/schedule-placement.mjs
//
// PURPOSE
//   The arithmetic of a calendar that things are dragged onto: which days a view shows, the span of time it covers (so
//   a caller reads only what is on screen), moving a view back and forward, the time a drop means (a day in a month,
//   or a pointer height in an hour lane), and where each timed thing sits in its day's lane when several overlap.
//   Pure functions over plain values, in the viewer's own time zone; ScheduleCalendar.tsx draws with them and the
//   tests prove them without a page.
//
// NON-NEGOTIABLE INVARIANTS
//   1. Nothing here knows what an item is. An item is { id, at, day? } (at: a date and time any Date can read, a
//      whole day "YYYY-MM-DD", or null; day: the date key of a thing that lasts the whole day, which places it on
//      that day in every time zone). Both whole-day shapes are read by wholeDayOf alone.
//   2. A view is DATA: { grid: "month" } is the six-week month board; { grid: "hours", days: n } is n day lanes of
//      hours, starting on the week's first day when n is a whole number of weeks, else on the anchor day. A view that
//      says `rolling` always starts on the anchor day, so a week begins today instead of on the week's first day.
//   3. Days are named by their local date key "YYYY-MM-DD", never by a UTC instant, so a day never slips across a zone.
//      A `when` that is itself a day key is that whole day wherever the viewer is: it has no time of day, sits first
//      in its day, and stays a day key when it is moved (a Date would read it as UTC midnight, the evening before in
//      every zone west of UTC).
//   4. A time a drop means is always inside the drop's own day and on the snap grid.
//
// KEY CONCEPTS
//   anchor: the day key the view is centred on (the month it belongs to, or the week or day that holds it).
//   window: the minutes of a day an hour lane shows (windowStart..windowEnd, 0..1440 for the whole day).
//   when: an item's `at`: an instant any Date reads, or a whole day "YYYY-MM-DD".
//
// AI DIRECTIVE: You are forbidden from simplifying or removing this documentation.

const pad = value => String(value).padStart(2, '0');

/** The local date key of a Date. */
export const dayKey = date => `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;

/** Whether a when names a whole day ("YYYY-MM-DD") rather than a moment. */
export const isWholeDay = at => typeof at === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(at);

/** The local day key a when falls on (a whole day is its own key), or null when it is not readable. */
export function dayOf(at) {
  if (isWholeDay(at)) return at;
  const date = at === null || at === undefined || at === '' ? null : new Date(at);
  return date && Number.isFinite(date.getTime()) ? dayKey(date) : null;
}

/** Local midnight at the start of a day key. */
export function dayStart(key) {
  const [year, month, day] = key.split('-').map(Number);
  return new Date(year, month - 1, day);
}

/** The day key `count` days after `key` (negative goes back). */
export function addDays(key, count) {
  const date = dayStart(key);
  date.setDate(date.getDate() + count);
  return dayKey(date);
}

/** The first day of the week holding `key`, weeks starting on `weekStartsOn` (0 = Sunday). */
export function weekStart(key, weekStartsOn = 0) {
  const back = (dayStart(key).getDay() - weekStartsOn + 7) % 7;
  return addDays(key, -back);
}

/** The day keys a view draws, in reading order. */
export function visibleDays(view, anchor, weekStartsOn = 0) {
  if (view.grid === 'month') {
    const first = `${anchor.slice(0, 7)}-01`;
    const start = weekStart(first, weekStartsOn);
    return Array.from({ length: 42 }, (_, index) => addDays(start, index));
  }
  const days = Math.max(1, Math.floor(view.days ?? 1));
  const start = days % 7 === 0 && !view.rolling ? weekStart(anchor, weekStartsOn) : anchor;
  return Array.from({ length: days }, (_, index) => addDays(start, index));
}

/**
 * The number of the week holding `key`, as the week-of-year a calendar header names ("W24"): the ISO-8601 number of the
 * Thursday of that week, so weeks starting on Sunday and on Monday both number the week the way people count it.
 */
export function weekNumber(key, weekStartsOn = 0) {
  const thursday = dayStart(addDays(weekStart(key, weekStartsOn), (4 - weekStartsOn + 7) % 7));
  const first = new Date(thursday.getFullYear(), 0, 1);
  return Math.floor(Math.round((thursday.getTime() - first.getTime()) / 86_400_000) / 7) + 1;
}

/** The span of time a view covers: from its first day's midnight to the midnight after its last day, as instants. */
export function visibleRange(view, anchor, weekStartsOn = 0) {
  const days = visibleDays(view, anchor, weekStartsOn);
  return { from: dayStart(days[0]).toISOString(), to: dayStart(addDays(days.at(-1), 1)).toISOString() };
}

/** The anchor one view-length back (direction -1) or forward (+1). A month moves by a calendar month. */
export function shiftAnchor(view, anchor, direction) {
  if (view.grid === 'month') {
    const date = dayStart(`${anchor.slice(0, 7)}-01`);
    date.setMonth(date.getMonth() + direction);
    return dayKey(date);
  }
  return addDays(anchor, direction * Math.max(1, Math.floor(view.days ?? 1)));
}

/** The same day of another month of the same year, or that month's last day when it is shorter ("2026-03-31" to February is "2026-02-28"). */
export function moveToMonth(key, month) {
  const [year, , day] = key.split('-').map(Number);
  return dayKey(new Date(year, month, Math.min(day, new Date(year, month + 1, 0).getDate())));
}

/** Minutes after local midnight of a when (a whole day starts at 0). */
export function minuteOf(at) {
  if (isWholeDay(at)) return 0;
  const date = new Date(at);
  return date.getHours() * 60 + date.getMinutes();
}

/** The instant at `minute` minutes into day `key`, as an ISO string. */
export function timeAt(key, minute) {
  const date = dayStart(key);
  date.setHours(Math.floor(minute / 60), minute % 60, 0, 0);
  return date.toISOString();
}

/** The minute a pointer height means in an hour lane `extent` pixels tall showing windowStart..windowEnd, on the
 *  snap grid and never past the window's last slot. */
export function minuteAtOffset(offset, extent, { windowStart = 0, windowEnd = 1440, snap = 15 } = {}) {
  const fraction = Math.max(0, Math.min(1, offset / Math.max(extent, 1)));
  const raw = windowStart + fraction * (windowEnd - windowStart);
  const snapped = windowStart + Math.round((raw - windowStart) / snap) * snap;
  return Math.max(windowStart, Math.min(windowEnd - snap, snapped));
}

/** A duration after moving a resize edge vertically, snapped and clamped to the caller's bounds. */
export function durationAtDelta(originalMinutes, deltaPx, pixelsPerHour, { snap = 15, min = snap, max = 1440 } = {}) {
  const safeSnap = Math.max(1, Math.floor(snap));
  const safeMin = Math.max(1, Math.floor(min));
  const safeMax = Math.max(safeMin, Math.floor(max));
  const raw = Math.max(safeMin, Math.min(safeMax, originalMinutes + (deltaPx / Math.max(1, pixelsPerHour)) * 60));
  const snapped = Math.round(raw / safeSnap) * safeSnap;
  return Math.max(safeMin, Math.min(safeMax, snapped));
}

/** The time a drop on a whole day means: a whole-day item stays a whole day, a timed item keeps its own time of day,
 *  and an item with no time takes `defaultMinute`. */
export function dayDropTime(key, earlierAt, defaultMinute = 540) {
  if (isWholeDay(earlierAt)) return key;
  const earlier = earlierAt ? new Date(earlierAt) : null;
  return timeAt(key, earlier && Number.isFinite(earlier.getTime()) ? minuteOf(earlier) : defaultMinute);
}

/** A when moved by whole local days: a whole day stays a day key, an instant keeps its time of day. */
export function shiftWhen(at, days) {
  if (isWholeDay(at)) return addDays(at, days);
  const moved = new Date(at);
  moved.setDate(moved.getDate() + days);
  return moved.toISOString();
}

/** The whole day an item lasts (its own `day`, else an `at` that is a day key), or null for a timed item. The one
 *  reader of both whole-day shapes. */
export function wholeDayOf(item) {
  if (isWholeDay(item.day)) return item.day;
  return isWholeDay(item.at) ? item.at : null;
}

/** Items grouped by the local day they fall on, whole-day items first and then by time; items with no readable when
 *  are left out. */
export function itemsByDay(items, visibleDays) {
  const days = new Map();
  for (const item of items) {
    const wholeDay = wholeDayOf(item);
    const key = wholeDay ?? dayOf(item.at);
    if (!key) continue;
    const end = wholeDay && isWholeDay(item.dayEnd) && dayKey(dayStart(item.dayEnd)) === item.dayEnd && item.dayEnd > wholeDay ? item.dayEnd : wholeDay ? addDays(wholeDay, 1) : null;
    const keys = wholeDay && visibleDays ? visibleDays.filter(day => day >= wholeDay && day < end) : [key];
    for (const day of keys) {
      if (!days.has(day)) days.set(day, []);
      days.get(day).push(item);
    }
  }
  // Whole-day things first, then the day's timed things in time order.
  const order = item => (wholeDayOf(item) ? -Infinity : Date.parse(item.at));
  for (const list of days.values()) list.sort((a, b) => (order(a) === order(b) ? 0 : order(a) - order(b)));
  return days;
}

/** Visible whole-day spans, clipped to the displayed columns and stacked in the first row without overlap.
 *  `dayEnd` is exclusive; a missing or invalid end occupies the start day only. */
export function allDayBannerLayout(items, days) {
  const spans = items.flatMap(item => {
    const startDay = wholeDayOf(item);
    if (!startDay) return [];
    const endDay = isWholeDay(item.dayEnd) && dayKey(dayStart(item.dayEnd)) === item.dayEnd && item.dayEnd > startDay ? item.dayEnd : addDays(startDay, 1);
    const columns = days.flatMap((day, index) => day >= startDay && day < endDay ? [index] : []);
    return columns.length ? [{ item, startColumn: columns[0], endColumn: columns.at(-1) + 1 }] : [];
  }).sort((a, b) => a.startColumn - b.startColumn || b.endColumn - a.endColumn || String(a.item.id).localeCompare(String(b.item.id)));
  const rowEnds = [];
  return spans.map(span => {
    let row = 0;
    while (rowEnds[row] !== undefined && rowEnds[row] > span.startColumn) row += 1;
    rowEnds[row] = span.endColumn;
    return { item: span.item, startColumn: span.startColumn, columnSpan: span.endColumn - span.startColumn, row };
  });
}

/** Where each of one day's timed items sits in its lane: its minutes, and its column among the items it overlaps
 *  (each item lasts its own `minutes`, else `durationMinutes`, and ends at the day's end at the latest). Items that
 *  overlap share a cluster; each takes the first free column. */
export function laneLayout(items, durationMinutes = 30) {
  const placed = [...items]
    .map(item => ({ item, startMinute: minuteOf(item.at), endMinute: Math.min(1440, minuteOf(item.at) + (item.minutes > 0 ? item.minutes : durationMinutes)) }))
    .sort((a, b) => a.startMinute - b.startMinute || String(a.item.id).localeCompare(String(b.item.id)));
  const out = [];
  let cluster = [];
  let clusterEnd = -1;
  const close = () => {
    const columnCount = cluster.reduce((most, entry) => Math.max(most, entry.column + 1), 1);
    for (const entry of cluster) out.push({ ...entry, columnCount });
    cluster = [];
  };
  for (const entry of placed) {
    if (cluster.length && entry.startMinute >= clusterEnd) close();
    const busy = new Set(cluster.filter(other => other.endMinute > entry.startMinute).map(other => other.column));
    let column = 0;
    while (busy.has(column)) column += 1;
    cluster.push({ ...entry, column });
    clusterEnd = Math.max(clusterEnd, entry.endMinute);
  }
  if (cluster.length) close();
  return out;
}
