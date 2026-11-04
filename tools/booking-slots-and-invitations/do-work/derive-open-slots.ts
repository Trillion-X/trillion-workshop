// packages/calendar-booker/do-work/derive-open-slots.ts
//
// =============================================================================
// PURPOSE: the generative availability primitive (L069)
// =============================================================================
//
// A PURE LEAF COMPUTE (zero I/O, DATA-configured) that derives the OPEN start
// times for a single day from a bookee's weekly availability, subtracting a
// `busy: Interval[]` union. It is the mutual-availability primitive: the slot
// derivation today only removes already-`taken` starts, so this adds an
// interval-subtraction input, letting the SAME engine also remove intervals the
// bookee OR the viewer are busy in (from a connected calendar's free-busy read).
//
//   open slots = availability windows
//                minus (slots that do not fit the window)
//                minus (already `taken` starts)
//                minus (any slot whose buffered span overlaps a `busy` interval)
//                minus (slots earlier than the minimum-notice horizon)
//
// The busy intervals are ABSOLUTE instants (UTC ms), because they come from
// external calendars in real time. The bookee's availability windows are
// WALL-CLOCK ("09:00" in a timezone), so this module converts each candidate
// window to absolute instants and the two can be intersected correctly. The tz
// conversion uses Intl (pure, deterministic: it depends only on the instant plus
// the zone, never on the host machine's local timezone), so the whole module
// stays a pure function with no I/O and no ambient clock.
//
// =============================================================================
// DELETION TEST (L069): with `busy = []` the result is IDENTICAL to a plain
// window-fit + `taken` derivation. Dropping every busy source (the whole
// mutual-availability feature) leaves the base scheduler behavior unchanged.
// Buffers only ever expand the conflict span checked against `busy`, so with
// `busy = []` buffers are a no-op too. Proven in `derive-open-slots.test.ts`.
// =============================================================================

// A weekly availability window, wall-clock in the availability timezone.
export interface AvailabilityWindow {
  // 0=Sun .. 6=Sat.
  weekday: number;
  // "HH:MM" wall-clock start in the availability timezone.
  start: string;
  // "HH:MM" wall-clock end (may be "24:00" for an all-day window).
  end: string;
}

// An absolute busy interval to subtract, half-open [startMs, endMs) in UTC ms.
export interface Interval {
  startMs: number;
  endMs: number;
}

// One open, bookable start time.
export interface OpenSlot {
  // Absolute start instant (UTC ms).
  startMs: number;
  // Absolute end instant (UTC ms) = startMs + durationMin * 60000.
  endMs: number;
  // "YYYY-MM-DD" of the slot in the availability timezone.
  date: string;
  // "HH:MM" wall-clock start in the availability timezone.
  time: string;
}

export interface DeriveOpenSlotsInput {
  // IANA id the windows are expressed in, e.g. "America/Los_Angeles".
  timezone: string;
  // The bookee's weekly availability windows.
  windows: readonly AvailabilityWindow[];
  // "YYYY-MM-DD" of the day to derive, in `timezone`.
  dateISO: string;
  // Meeting length in minutes (a slot must fit fully inside a window).
  durationMin: number;
  // Spacing between offered start times, in minutes.
  stepMin: number;
  // Minutes of required gap BEFORE a meeting (checked against `busy`). Default 0.
  bufferBeforeMin?: number;
  // Minutes of required gap AFTER a meeting (checked against `busy`). Default 0.
  bufferAfterMin?: number;
  // Minimum-notice horizon in minutes: a slot must start at/after
  // `nowMs + minNoticeMin * 60000`. Ignored unless `nowMs` is provided. Default 0.
  minNoticeMin?: number;
  // The "now" instant (UTC ms) for the minimum-notice horizon. Injected so the
  // module stays pure/deterministic; omit to disable min-notice filtering.
  nowMs?: number;
  // Absolute start instants (UTC ms) already booked on THIS booking surface.
  // An exact-start match drops the slot (mirrors the same-surface booking grid).
  taken?: readonly number[];
  // Absolute busy intervals (UTC ms) to subtract: the union of the bookee's and
  // the viewer's connected-calendar busy blocks. Default [] (the deletion test).
  busy?: readonly Interval[];
}

// weekday (0=Sun..6=Sat) for a "YYYY-MM-DD" string, computed via UTC so it never
// shifts by the host machine's runtime timezone.
export function weekdayOf(dateISO: string): number {
  validateDate(dateISO);
  const [y, m, d] = dateISO.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d)).getUTCDay();
}

function pad(n: number): string {
  return n < 10 ? `0${n}` : String(n);
}

// How many minutes a timezone is ahead of UTC at a given instant (DST-aware: it
// asks Intl what wall-clock that zone shows for the instant, then diffs). Pure:
// depends only on the instant and the zone.
export function tzOffsetMinutesAt(utcMs: number, tz: string): number {
  return offsetAt(utcMs, makeFormatter(tz));
}

function makeFormatter(tz: string): Intl.DateTimeFormat {
  return new Intl.DateTimeFormat('en-US', { timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

function offsetAt(utcMs: number, formatter: Intl.DateTimeFormat): number {
  const parts = formatter.formatToParts(new Date(utcMs));
  const map: Record<string, string> = {};
  for (const p of parts) map[p.type] = p.value;
  const asIfUtc = Date.UTC(+map.year, +map.month - 1, +map.day, +map.hour, +map.minute, +map.second);
  // Historical IANA offsets can include seconds. Preserve them so resolving
  // a whole wall minute does not shift it by a rounded offset.
  return (asIfUtc - Math.floor(utcMs / 1000) * 1000) / 60000;
}

// The absolute instant (UTC ms) of a wall-clock "YYYY-MM-DD" at `minutesOfDay`
// (minutes past midnight) expressed in `tz`. 1440 means next-day midnight.
// Returns NaN for a spring-forward gap; a fall-back fold chooses the earlier
// of its two instants.
export function zonedWallClockToUtcMs(dateISO: string, minutesOfDay: number, tz: string): number {
  validateDate(dateISO);
  if (!Number.isInteger(minutesOfDay) || minutesOfDay < 0 || minutesOfDay > 1440) {
    throw new RangeError('minutesOfDay must be an integer from 0 through 1440');
  }
  if (minutesOfDay === 1440) {
    const nextDate = new Date(Date.parse(`${dateISO}T00:00:00Z`) + 86400000).toISOString().slice(0, 10);
    return zonedWallClockToUtcMs(nextDate, 0, tz);
  }
  const formatter = validateTimezone(tz);
  const offsets = offsetsNearDate(dateISO, tz, formatter);
  return wallCandidates(dateISO, minutesOfDay, formatter, offsets)[0] ?? Number.NaN;
}

function offsetsNearDate(dateISO: string, tz: string, formatter: Intl.DateTimeFormat): number[] {
  const [y, mo, d] = dateISO.split('-').map(Number);
  const wallMs = Date.UTC(y, mo - 1, d);
  // Three samples span the possible UTC displacement and either side of a
  // transition near this local date, including non-hour changes.
  const offsets = new Set<number>();
  for (const delta of [-36, 0, 36]) offsets.add(offsetAt(wallMs + delta * 3600000, formatter));
  return [...offsets];
}

function wallCandidates(dateISO: string, minutesOfDay: number, formatter: Intl.DateTimeFormat, offsets: readonly number[]): number[] {
  const [y, mo, d] = dateISO.split('-').map(Number);
  const wallMs = Date.UTC(y, mo - 1, d, Math.floor(minutesOfDay / 60), minutesOfDay % 60);
  const candidates: number[] = [];
  for (const offset of offsets) {
    const instant = wallMs - offset * 60000;
    const parts = formatter.formatToParts(new Date(instant));
    const p: Record<string, string> = {};
    for (const part of parts) p[part.type] = part.value;
    if (`${p.year}-${p.month}-${p.day}` === dateISO && +p.hour * 60 + +p.minute === minutesOfDay && +p.second === 0) candidates.push(instant);
  }
  return candidates.sort((a, b) => a - b);
}

function validateDate(dateISO: string): void {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dateISO)) throw new RangeError('dateISO must be YYYY-MM-DD');
  const [y, m, d] = dateISO.split('-').map(Number);
  if (y < 100 || y > 9999) throw new RangeError('dateISO year must be from 0100 through 9999');
  const check = new Date(Date.UTC(y, m - 1, d));
  if (check.getUTCFullYear() !== y || check.getUTCMonth() !== m - 1 || check.getUTCDate() !== d) throw new RangeError('dateISO is not a valid calendar date');
}

function validateTimezone(tz: string): Intl.DateTimeFormat {
  if (typeof tz !== 'string' || tz.length === 0) throw new TypeError('timezone must be a non-empty IANA timezone string');
  return makeFormatter(tz);
}

function parseWindowMinute(value: string, allow24 = false): number {
  const match = /^(\d{2}):(\d{2})$/.exec(value);
  if (!match) throw new RangeError(`Invalid availability time: ${value}`);
  const h = Number(match[1]), m = Number(match[2]);
  if (m > 59 || (h > 23 && !(allow24 && h === 24 && m === 0))) throw new RangeError(`Invalid availability time: ${value}`);
  return h * 60 + m;
}

// True if the half-open interval [aStart, aEnd) overlaps [bStart, bEnd).
function overlaps(aStart: number, aEnd: number, bStart: number, bEnd: number): boolean {
  return aStart < bEnd && bStart < aEnd;
}

/**
 * Derive the open, bookable start times for one day.
 *
 * With `busy = []` this is a plain window-fit + `taken` derivation (the deletion
 * test). Each candidate window slot is converted to an absolute instant and
 * dropped if its buffered span [start - bufferBefore, end + bufferAfter) overlaps
 * any `busy` interval, if its exact start is `taken`, or if it starts before the
 * minimum-notice horizon.
 */
export function deriveOpenSlots(input: DeriveOpenSlotsInput): OpenSlot[] {
  const {
    timezone,
    windows,
    dateISO,
    durationMin,
    stepMin,
    bufferBeforeMin = 0,
    bufferAfterMin = 0,
    minNoticeMin = 0,
    nowMs,
    taken = [],
    busy = [],
  } = input;

  validateDate(dateISO);
  if (!Number.isSafeInteger(durationMin) || durationMin <= 0 || !Number.isSafeInteger(stepMin) || stepMin <= 0) throw new RangeError('durationMin and stepMin must be positive whole minutes');
  for (const [name, value] of [['bufferBeforeMin', bufferBeforeMin], ['bufferAfterMin', bufferAfterMin], ['minNoticeMin', minNoticeMin]] as const) {
    if (!Number.isFinite(value) || value < 0 || !Number.isFinite(value * 60000)) throw new RangeError(`${name} must be a finite non-negative number`);
  }
  if (nowMs !== undefined && !Number.isFinite(nowMs)) throw new RangeError('nowMs must be a finite instant');
  if (!Array.isArray(windows) || !Array.isArray(taken) || !Array.isArray(busy)) throw new TypeError('windows, taken, and busy must be arrays');
  const formatter = validateTimezone(timezone);
  const dayOffsets = new Map<string, number[]>();
  const candidatesFor = (day: string, minute: number): number[] => {
    let offsets = dayOffsets.get(day);
    if (!offsets) {
      offsets = offsetsNearDate(day, timezone, formatter);
      dayOffsets.set(day, offsets);
    }
    return wallCandidates(day, minute, formatter, offsets);
  };
  const startInstant = (day: string, minute: number): number => candidatesFor(day, minute)[0] ?? Number.NaN;
  const endInstant = (day: string, minute: number): number => {
    // A repeated endpoint uses the later occurrence to avoid truncating the
    // repeated portion of an availability window. A gap endpoint advances to
    // its first valid wall minute, preserving pre-gap availability.
    for (let candidateMinute = minute; candidateMinute <= 2880; candidateMinute++) {
      let candidateDay = day;
      let localMinute = candidateMinute;
      if (localMinute >= 1440) {
        const [y, m, d] = day.split('-').map(Number);
        candidateDay = new Date(Date.UTC(y, m - 1, d) + Math.floor(localMinute / 1440) * 86400000).toISOString().slice(0, 10);
        localMinute %= 1440;
      }
      const values = candidatesFor(candidateDay, localMinute);
      if (values.length) return values[values.length - 1];
    }
    return Number.NaN;
  };
  for (const w of windows) {
    if (!Number.isInteger(w.weekday) || w.weekday < 0 || w.weekday > 6) throw new RangeError('weekday must be an integer from 0 through 6');
    const start = parseWindowMinute(w.start);
    const end = parseWindowMinute(w.end, true);
    if (end <= start) throw new RangeError('availability window end must be after start on the same day');
  }
  for (const instant of taken) if (!Number.isFinite(instant)) throw new RangeError('taken instants must be finite');
  for (const interval of busy) if (!Number.isFinite(interval.startMs) || !Number.isFinite(interval.endMs) || interval.endMs <= interval.startMs) throw new RangeError('busy intervals must have finite increasing endpoints');
  const wd = weekdayOf(dateISO);
  const takenSet = new Set<number>(taken);
  const bufferBeforeMs = bufferBeforeMin * 60000;
  const bufferAfterMs = bufferAfterMin * 60000;
  const durationMs = durationMin * 60000;
  const earliestStartMs =
    typeof nowMs === 'number' ? nowMs + minNoticeMin * 60000 : Number.NEGATIVE_INFINITY;

  const slots: OpenSlot[] = [];
  const seen = new Set<number>(); // dedupe overlapping windows by start instant.

  for (const w of windows) {
    if (w.weekday !== wd) continue;
    const winStart = parseWindowMinute(w.start);
    const winEnd = parseWindowMinute(w.end, true);
    if (winEnd <= winStart) throw new RangeError('availability window end must be after start on the same day');
    const absoluteWindowEnd = endInstant(dateISO, winEnd);
    if (!Number.isFinite(absoluteWindowEnd)) continue;
    for (let t = winStart; t < winEnd; t += stepMin) {
      const startMs = startInstant(dateISO, t);
      if (!Number.isFinite(startMs)) continue;
      if (seen.has(startMs)) continue;

      if (startMs < earliestStartMs) continue;
      if (takenSet.has(startMs)) continue;

      const endMs = startMs + durationMs;
      if (endMs > absoluteWindowEnd) continue;
      const spanStart = startMs - bufferBeforeMs;
      const spanEnd = endMs + bufferAfterMs;
      let conflicted = false;
      for (const b of busy) {
        if (overlaps(spanStart, spanEnd, b.startMs, b.endMs)) {
          conflicted = true;
          break;
        }
      }
      if (conflicted) continue;

      const time = `${pad(Math.floor(t / 60))}:${pad(t % 60)}`;
      seen.add(startMs);
      slots.push({ startMs, endMs, date: dateISO, time });
    }
  }

  return slots.sort((a, b) => a.startMs - b.startMs);
}
