// parts/ui/show/schedule-calendar/event-reminders.mjs
//
// PURPOSE
//   The reminders of one event as a list of minutes before the start: adding one from a preset or from a number and a unit,
//   removing one, the words for each, and the provider's override list they become. The presets, the units, the most
//   reminders and the furthest ahead are the caller's DATA (src/workspace/calendar-event-forms.json `reminders`).
//
// NON-NEGOTIABLE INVARIANTS
//   1. A list holds each number of minutes once, soonest first, never more than `max`, never further ahead than `max_minutes`.
//   2. An amount that is not a whole number of at least 0, or whose unit is not a row, adds nothing (null), never a guess.

const fill = (text, values) => text.replace(/\{(\w+)\}/g, (_, key) => String(values[key] ?? ''));

/** The minutes a number of a unit is, or null when it is not a whole number of at least 0 or the unit is not a row. */
export function minutesOf(amount, unitId, data) {
  const unit = data.units.find(row => row.id === unitId);
  const number = typeof amount === 'string' && amount.trim() !== '' ? Number(amount) : amount;
  if (!unit || !Number.isSafeInteger(number) || number < 0) return null;
  const minutes = number * unit.minutes;
  return minutes <= data.max_minutes ? minutes : null;
}

/** The list with one more reminder, or null when it cannot take it (a repeat of one it holds, the limit, a bad number). */
export function withReminder(list, minutes, data) {
  if (!Number.isSafeInteger(minutes) || minutes < 0 || minutes > data.max_minutes) return null;
  if (list.includes(minutes) || list.length >= data.max) return null;
  return [...list, minutes].sort((a, b) => a - b);
}

export const withoutReminder = (list, minutes) => list.filter(value => value !== minutes);

/** The words for a reminder: the largest unit that divides it evenly ("1 hour before"), or "At start". */
export function reminderLabel(minutes, data) {
  if (minutes === 0) return data.at_start;
  const unit = [...data.units].sort((a, b) => b.minutes - a.minutes).find(row => minutes % row.minutes === 0) ?? data.units[0];
  const amount = minutes / unit.minutes;
  return fill(data.before, { amount, unit: amount === 1 ? unit.one : unit.other });
}

/** The provider's reminders field for a list: its own overrides, never the calendar's defaults. */
export const reminderOverrides = list => ({ useDefault: false, overrides: list.map(minutes => ({ method: 'popup', minutes })) });
