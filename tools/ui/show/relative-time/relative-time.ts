// parts/ui/show/relative-time/relative-time.ts
//
// PURPOSE
//   The one moment-in-words for every screen; a screen that adds its own moment-in-words helper repeats it. It is the
//   one place a moment becomes the plain words a person reads next to a post, a row or a notice: "just now",
//   "5 min ago", "3 hours ago", "Yesterday", a weekday within the week, then a date ("Sep 3", or "Sep 3, 2025" in
//   another year). Every part that shows when something happened reads it from here, so the same moment reads the
//   same everywhere.
//
// NON-NEGOTIABLE INVARIANTS
//   1. Pure: the answer depends only on the moment, `now` and the reader's locale and time zone. Nothing is read or
//      remembered, so a test passes `now` and gets the same words every time.
//   2. A moment that cannot be read gives '' (the caller shows nothing), never "NaN" or "Invalid Date".
//   3. "Yesterday" and the weekday are calendar days in the reader's time zone, not 24-hour spans; under an hour old
//      always reads in minutes, whatever the calendar says.
//   4. A moment slightly ahead of `now` (another clock running fast) reads "just now"; further ahead reads as its date.
//   5. With `clock`, a moment past the first hour also says the time of day ("4:12 PM", "Yesterday 4:12 PM",
//      "Sep 3, 4:12 PM"), for a list of things a person did where the hour tells two of them apart; another year's
//      date stays a date. relativeDay names the day a moment sits under, the heading such a list breaks into.

export type RelativeWhenOptions = {
  /** The words sit inside a sentence ("changed yesterday"), so "Yesterday" starts lower case. */
  inSentence?: boolean;
  /** Past the first hour, also say the time of day: "4:12 PM" today, "Yesterday 4:12 PM", "Sep 3, 4:12 PM". */
  clock?: boolean;
};

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

const weekday = new Intl.DateTimeFormat(undefined, { weekday: 'long' });
const thisYear = new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric' });
const otherYear = new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
const timeOfDay = new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit' });
const dayThisYear = new Intl.DateTimeFormat(undefined, { weekday: 'long', month: 'long', day: 'numeric' });
const dayOtherYear = new Intl.DateTimeFormat(undefined, { month: 'long', day: 'numeric', year: 'numeric' });

/** Midnight at the start of the calendar day holding `time`, in the reader's time zone. */
function startOfDay(time: number): number {
  const day = new Date(time);
  day.setHours(0, 0, 0, 0);
  return day.getTime();
}

/** How many calendar days lie between the two moments' days (0 = the same day). */
function calendarDaysBetween(earlier: number, later: number): number {
  return Math.round((startOfDay(later) - startOfDay(earlier)) / DAY);
}

/** When `when` happened, in plain words, read at `now` (default: this moment). `when` is an ISO date text or a
 *  millisecond time. */
export function relativeWhen(when: string | number, now: number = Date.now(), options: RelativeWhenOptions = {}): string {
  const time = typeof when === 'number' ? when : Date.parse(when);
  if (!Number.isFinite(time) || !Number.isFinite(now)) return '';
  const ago = now - time;
  if (ago < 45_000 && ago > -MINUTE) return 'just now';
  if (ago >= 45_000 && ago < HOUR) return `${Math.max(1, Math.round(ago / MINUTE))} min ago`;
  const days = ago > 0 ? calendarDaysBetween(time, now) : -1;
  const sameYear = new Date(time).getFullYear() === new Date(now).getFullYear();
  if (options.clock) {
    const hour = timeOfDay.format(time);
    if (days === 0) return hour;
    if (days === 1) return `${options.inSentence ? 'yesterday' : 'Yesterday'} ${hour}`;
    if (days > 1 && days < 7) return `${weekday.format(time)} ${hour}`;
    return sameYear ? `${thisYear.format(time)}, ${hour}` : otherYear.format(time);
  }
  if (days === 0) {
    const hours = Math.max(1, Math.round(ago / HOUR));
    return `${hours} ${hours === 1 ? 'hour' : 'hours'} ago`;
  }
  if (days === 1) return options.inSentence ? 'yesterday' : 'Yesterday';
  if (days > 1 && days < 7) return weekday.format(time);
  return (sameYear ? thisYear : otherYear).format(time);
}

/** The day `when` sits under, as a list's heading reads it at `now`: "Today", "Yesterday", a weekday within the week,
 *  then "Wednesday, September 9", or "March 3, 2025" in another year. '' when the moment cannot be read. */
export function relativeDay(when: string | number, now: number = Date.now()): string {
  const time = typeof when === 'number' ? when : Date.parse(when);
  if (!Number.isFinite(time) || !Number.isFinite(now)) return '';
  const days = calendarDaysBetween(time, now);
  if (days <= 0) return 'Today';
  if (days === 1) return 'Yesterday';
  if (days < 7) return weekday.format(time);
  return (new Date(time).getFullYear() === new Date(now).getFullYear() ? dayThisYear : dayOtherYear).format(time);
}

// ---- Moments in words for a screen, and days a person plans by -----------------------------------------------------------
// momentInWords and stretchInWords say a moment or a span with its weekday and clock ("Tue, 14 Oct, 3:01 AM", never seconds);
// relativeDate says a day ahead or behind now ("Yesterday", "Tomorrow", "Tue 3:00 PM"). A time that is not a date is ''.

const DAY_FORMAT = { weekday: 'short', day: 'numeric', month: 'short' } as const;
const CLOCK_FORMAT = { hour: 'numeric', minute: '2-digit' } as const;

const realDate = (value: number | string | Date | null | undefined): Date | null => {
  if (value === null || value === undefined || value === '') return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isFinite(date.getTime()) ? date : null;
};

/** "Tue, 14 Oct, 3:01 AM". */
export function momentInWords(at: number | string | Date | null | undefined, locale?: string): string {
  const date = realDate(at);
  return date ? date.toLocaleString(locale, { ...DAY_FORMAT, ...CLOCK_FORMAT }) : '';
}

/** "Tue, 14 Oct, 3:00 AM – 4:00 AM" on one day; both moments in full when they fall on different days. */
export function stretchInWords(start: number | string | Date | null | undefined, end: number | string | Date | null | undefined, locale?: string): string {
  const from = realDate(start), to = realDate(end);
  if (!from) return '';
  if (!to) return momentInWords(from, locale);
  const sameDay = from.toDateString() === to.toDateString();
  return sameDay ? `${momentInWords(from, locale)} – ${to.toLocaleTimeString(locale, CLOCK_FORMAT)}` : `${momentInWords(from, locale)} – ${momentInWords(to, locale)}`;
}

const weekdayShort = new Intl.DateTimeFormat(undefined, { weekday: 'short' });

/**
 * A moment that may lie ahead or behind, as a person plans by it ("Yesterday", "Today", "Tomorrow", "Tue" within a week of
 * `now`, then "Oct 29", with the year in another year). A moment with a time of day (`clock`) also says it: "Tue 3:00 PM".
 * A date text with no time ("2026-10-29") is a whole day and never says a time. '' when the moment cannot be read.
 */
export function relativeDate(when: string | number, now: number = Date.now(), options: { clock?: boolean } = {}): string {
  const dateOnly = typeof when === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(when);
  const time = typeof when === 'number' ? when : Date.parse(dateOnly ? `${when}T12:00:00` : when);
  if (!Number.isFinite(time) || !Number.isFinite(now)) return '';
  const ahead = calendarDaysBetween(now, time);
  const day = ahead === 0 ? 'Today' : ahead === 1 ? 'Tomorrow' : ahead === -1 ? 'Yesterday'
    : Math.abs(ahead) < 7 ? weekdayShort.format(time)
      : (new Date(time).getFullYear() === new Date(now).getFullYear() ? thisYear : otherYear).format(time);
  return options.clock && !dateOnly ? `${day} ${timeOfDay.format(time)}` : day;
}
