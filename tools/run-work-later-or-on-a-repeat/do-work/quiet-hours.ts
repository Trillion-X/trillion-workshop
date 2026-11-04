// parts/timed-action/do-work/quiet-hours.ts
//
// Purpose
//   Whether a moment is inside a person's working hours, and what a sender should be told when it is not: the
//   quiet-hours answer a composer reads before writing to that person. Pure: no clock, no store.
//
// Non-negotiable invariants
//   1. Working hours are a local wall-clock window in the person's own zone ("09:00" to "17:00", on the days they
//      work). An end that is not after the start is an overnight shift: the window runs into the next local day.
//      Clock changes follow wall-time.ts (a skipped or repeated hour is resolved there, one way everywhere).
//   2. An unknown zone or a malformed time is refused (TypeError), never read as UTC or as always-open.
//   3. What a mode does is DATA (quiet-hours.json); nothing here names a mode.
//   4. A dismissed notice lasts only for the quiet period it was dismissed in: it is remembered as that period's start
//      and the notice returns in the next period.
//   5. Quiet hours are advice to the sender. Nothing here blocks a message.
import data from './quiet-hours.json' with { type: 'json' };
import { addCivilDays, instantAt, parseTime, timeZoneName, wallTimeOf, weekday } from './wall-time.ts';

export interface WorkingHours {
  start: string;
  end: string;
  time_zone: string;
  /** Local weekdays the person works (Sunday 0); every day when absent. */
  weekdays?: number[];
}

export interface QuietHoursAnswer {
  quiet: boolean;
  /** The instant this quiet period began, which a dismissal is remembered by; null when working. */
  period_start_ms: number | null;
  /** The next instant the person is working, or null when they are now. */
  opens_at_ms: number | null;
  /** Show the sender a notice. */
  nudge: boolean;
  /** Send without a push. */
  send_silently: boolean;
}

export function checkedWorkingHours(hours: WorkingHours): Required<WorkingHours> {
  const zone = timeZoneName(hours?.time_zone);
  if (!zone || !parseTime(hours.start) || !parseTime(hours.end)) throw new TypeError('Working hours need start and end like 09:00 and a time zone like America/New_York.');
  const days = hours.weekdays ?? [0, 1, 2, 3, 4, 5, 6];
  if (!Array.isArray(days) || !days.length || days.some(day => !Number.isInteger(day) || day < 0 || day > 6)) throw new TypeError('Working weekdays are whole numbers from 0 (Sunday) to 6.');
  return { start: hours.start, end: hours.end, time_zone: zone, weekdays: [...new Set(days)].sort() };
}

// The working windows that can touch an instant: those starting the local day before, the same day and the next.
function windowsAround(hours: Required<WorkingHours>, atMs: number): Array<[number, number]> {
  const today = wallTimeOf(atMs, hours.time_zone).date;
  const overnight = hours.end <= hours.start;
  const found: Array<[number, number]> = [];
  for (const offset of [-1, 0, 1]) {
    const day = addCivilDays(today, offset);
    if (!hours.weekdays.includes(weekday(day))) continue;
    const from = instantAt(day, hours.start, hours.time_zone), to = instantAt(overnight ? addCivilDays(day, 1) : day, hours.end, hours.time_zone);
    if (from !== null && to !== null && to > from) found.push([from, to]);
  }
  return found;
}

/** The quiet-hours answer for writing to a person at `atMs`. `mode` is a row of quiet-hours.json; `dismissedPeriodStartMs`
 *  is the start of the quiet period in which the sender last dismissed the notice. */
export function quietHoursAnswer(hours: WorkingHours | null | undefined, atMs: number, mode: string = data.default_mode, dismissedPeriodStartMs: number | null = null): QuietHoursAnswer {
  const row = (data.modes as Record<string, { nudge: boolean; silent: boolean }>)[mode];
  if (!row) throw new TypeError(`The mode is one of: ${Object.keys(data.modes).join(', ')}.`);
  if (!hours) return { quiet: false, period_start_ms: null, opens_at_ms: null, nudge: false, send_silently: false };
  const checked = checkedWorkingHours(hours);
  // Windows that can touch the instant, plus those from further out to find where the quiet period began and ends.
  const windows = [...windowsAround(checked, atMs - 86_400_000), ...windowsAround(checked, atMs), ...windowsAround(checked, atMs + 86_400_000)]
    .sort((a, b) => a[0] - b[0]);
  if (windows.some(([from, to]) => from <= atMs && atMs < to)) return { quiet: false, period_start_ms: null, opens_at_ms: null, nudge: false, send_silently: false };
  const before = windows.filter(([, to]) => to <= atMs).at(-1);
  const after = windows.find(([from]) => from > atMs);
  const start = before ? before[1] : null;
  return {
    quiet: true, period_start_ms: start, opens_at_ms: after ? after[0] : null,
    nudge: row.nudge && !(start !== null && dismissedPeriodStartMs === start),
    send_silently: row.silent,
  };
}
