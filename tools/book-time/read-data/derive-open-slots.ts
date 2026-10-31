// tools/book-time/read-data/derive-open-slots.ts
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
// window to absolute instants and the two can be intersected correctly. The
// conversion is tools/wall-time's instantAt, the one owner of a local time in a
// zone across clock changes (a time the clock skips is not offered, a time it
// repeats is offered once, at the earlier), so the whole module stays a pure function
// with no I/O and no ambient clock.
//
// =============================================================================
// DELETION TEST (L069): with `busy = []` the result is IDENTICAL to a plain
// window-fit + `taken` derivation. Dropping every busy source (the whole
// mutual-availability feature) leaves the base scheduler behavior unchanged.
// Buffers only ever expand the conflict span checked against `busy`, so with
// `busy = []` buffers are a no-op too. Proven in `derive-open-slots.test.ts`.
// =============================================================================

import { instantAt, pad, timeZoneName, weekday } from '../../wall-time/read-data/wall-time.mjs';

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

function toMinutes(hhmm: string): number {
  const [h, m] = hhmm.split(':').map((n) => parseInt(n, 10));
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

  if (timeZoneName(timezone) === null) throw new RangeError(`${timezone} is not a time zone`);
  const wd = weekday(dateISO);
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
    const winStart = toMinutes(w.start);
    const winEnd = toMinutes(w.end);
    for (let t = winStart; t + durationMin <= winEnd; t += stepMin) {
      const time = `${pad(Math.floor(t / 60))}:${pad(t % 60)}`;
      const startMs = instantAt(dateISO, time, timezone, { gap: 'skip' });
      if (startMs === null) continue; // a time the clock skips that day cannot be booked
      if (seen.has(startMs)) continue;
      seen.add(startMs);

      if (startMs < earliestStartMs) continue;
      if (takenSet.has(startMs)) continue;

      const endMs = startMs + durationMs;
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

      slots.push({ startMs, endMs, date: dateISO, time });
    }
  }

  return slots.sort((a, b) => a.startMs - b.startMs);
}
