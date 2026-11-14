// parts/ui/show/schedule-calendar/event-repeat.mjs
//
// PURPOSE
//   How an event repeats, as pure functions over DATA: the preset choices an event's start offers (every Wednesday, the 2nd
//   Wednesday of the month...), the RRULE a custom repeat makes, and the words for an RRULE an event already has. Which
//   presets exist, their words and the weekday and ordinal names are the caller's DATA rows (see
//   src/workspace/calendar-event-forms.json `repeat`); nothing here names a language, a source or a calendar.
//
// NON-NEGOTIABLE INVARIANTS
//   1. A preset's value is the exact RRULE line the provider stores (or 'none'); no other value is ever made.
//   2. The start's weekday, day and week of the month are read in the zone it is shown in, never the machine's.
//   3. A rule this module cannot describe as a custom repeat answers null from rruleToRecurrence, so a caller keeps it
//      untouched instead of rewriting it.

const parts = (ms, zone) => {
  const found = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone: zone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' })
    .formatToParts(new Date(ms)).map(part => [part.type, part.value]));
  return { year: Number(found.year), month: Number(found.month), day: Number(found.day), hour: Number(found.hour), minute: Number(found.minute), second: Number(found.second) };
};

/** The year, month, day and weekday (0 is Sunday) of an instant in a zone. */
export function zonedDate(startIso, zone) {
  const at = Date.parse(startIso);
  if (!Number.isFinite(at)) throw new TypeError('The start must be a date and time.');
  const { year, month, day } = parts(at, zone);
  return { year, month, day, weekday: new Date(Date.UTC(year, month - 1, day)).getUTCDay() };
}

const offsetAt = (ms, zone) => { const p = parts(ms, zone); return Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second) - Math.floor(ms / 1000) * 1000; };

/** The instant a zone's clock reads the end of a calendar day (23:59:59). */
export function endOfZonedDay(day, zone) {
  const [year, month, date] = day.split('-').map(Number);
  const wall = Date.UTC(year, month - 1, date, 23, 59, 59);
  const first = wall - offsetAt(wall, zone);
  return new Date(wall - offsetAt(first, zone));
}

const compactUtc = date => date.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');

/** The ordinal word for a day of the month ("10th") from the data's suffix per plural category. */
export function ordinalOf(number, suffixes) {
  return `${number}${suffixes[new Intl.PluralRules('en-US', { type: 'ordinal' }).select(number)] ?? ''}`;
}

const fill = (text, values) => text.replace(/\{(\w+)\}/g, (_, key) => String(values[key] ?? ''));

/** The repeat choices a start offers: [{ value, label }], 'none' for no repeat. `data` is the `repeat` DATA. */
export function presetsFor(startIso, zone, data) {
  const { year, month, day, weekday } = zonedDate(startIso, zone);
  const nth = Math.ceil(day / 7);
  const lastInMonth = day + 7 > new Date(Date.UTC(year, month, 0)).getUTCDate();
  const nthKey = lastInMonth && nth >= 4 ? '-1' : String(nth);
  const values = {
    weekday: data.weekday_names[weekday], byday: data.weekday_codes[weekday], dom: day, dom_ordinal: ordinalOf(day, data.ordinal_suffixes),
    nth: nthKey, nth_word: data.nth_words[nthKey] ?? ordinalOf(nth, data.ordinal_suffixes),
    date: new Date(Date.UTC(year, month - 1, day)).toLocaleDateString(undefined, { month: 'long', day: 'numeric', timeZone: 'UTC' }),
  };
  return data.presets.map(row => ({ id: row.id, value: row.rule === null ? 'none' : fill(row.rule, values), label: fill(row.label, values) }));
}

/** The RRULE line for a custom repeat { frequency, interval, weekdays, ends }, or null when it is incomplete. `data` is the `repeat` DATA. */
export function recurrenceToRRule(value, { allDay, zone }, data) {
  const frequency = data.frequencies.find(row => row.value === value?.frequency);
  if (!frequency || !Number.isSafeInteger(value.interval) || value.interval < 1) return null;
  const pieces = [`FREQ=${frequency.rrule}`];
  if (value.interval > 1) pieces.push(`INTERVAL=${value.interval}`);
  if (frequency.weekdays && value.weekdays?.length) {
    const codes = value.weekdays.map(day => data.weekdays.find(row => row.value === day)?.code);
    if (codes.some(code => !code)) return null;
    pieces.push(`BYDAY=${[...new Set(codes)].sort((a, b) => data.weekday_codes.indexOf(a) - data.weekday_codes.indexOf(b)).join(',')}`);
  }
  if (value.ends?.kind === 'date') {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(value.ends.value ?? '')) return null;
    pieces.push(`UNTIL=${allDay ? value.ends.value.replace(/-/g, '') : compactUtc(endOfZonedDay(value.ends.value, zone))}`);
  } else if (value.ends?.kind === 'count') {
    if (!Number.isSafeInteger(value.ends.value) || value.ends.value < 1) return null;
    pieces.push(`COUNT=${value.ends.value}`);
  }
  return `RRULE:${pieces.join(';')}`;
}

const readRule = rule => {
  if (typeof rule !== 'string' || !rule.startsWith('RRULE:')) return null;
  const found = {};
  for (const piece of rule.slice(6).split(';')) {
    const at = piece.indexOf('=');
    if (at < 1) return null;
    found[piece.slice(0, at)] = piece.slice(at + 1);
  }
  return found;
};

/** The custom-repeat value a rule is, or null when the rule says more than the custom editor can (so it is kept as it is). */
export function rruleToRecurrence(rule, { zone }, data) {
  const found = readRule(rule);
  const frequency = found && data.frequencies.find(row => row.rrule === found.FREQ);
  const known = new Set(['FREQ', 'INTERVAL', 'BYDAY', 'COUNT', 'UNTIL']);
  if (!frequency || Object.keys(found).some(key => !known.has(key))) return null;
  const interval = found.INTERVAL === undefined ? 1 : Number(found.INTERVAL);
  if (!Number.isSafeInteger(interval) || interval < 1) return null;
  let weekdays = [];
  if (found.BYDAY !== undefined) {
    if (!frequency.weekdays) return null;
    weekdays = found.BYDAY.split(',').map(code => data.weekdays.find(row => row.code === code)?.value);
    if (weekdays.some(day => !day)) return null;
  }
  let ends = { kind: 'never' };
  if (found.UNTIL !== undefined) {
    const match = /^(\d{4})(\d{2})(\d{2})(T\d{6}Z)?$/.exec(found.UNTIL);
    if (!match) return null;
    const day = match[4] ? (() => { const p = parts(Date.parse(`${match[1]}-${match[2]}-${match[3]}T${match[4].slice(1, 3)}:${match[4].slice(3, 5)}:${match[4].slice(5, 7)}Z`), zone); return `${String(p.year).padStart(4, '0')}-${String(p.month).padStart(2, '0')}-${String(p.day).padStart(2, '0')}`; })() : `${match[1]}-${match[2]}-${match[3]}`;
    ends = { kind: 'date', value: day };
  } else if (found.COUNT !== undefined) {
    const count = Number(found.COUNT);
    if (!Number.isSafeInteger(count) || count < 1) return null;
    ends = { kind: 'count', value: count };
  }
  return { frequency: frequency.value, interval, weekdays, ends };
}

/** The words for a rule an event has: its preset's label when it is one, else a description of it. */
export function rruleToLabel(rule, startIso, zone, data) {
  const preset = presetsFor(startIso, zone, data).find(row => row.value === rule);
  if (preset) return preset.label;
  const found = readRule(rule);
  const unit = found && data.describe.units[found.FREQ];
  const value = rruleToRecurrence(rule, { zone }, data);
  if (!unit || !value) return data.describe.custom;
  const interval = value.interval;
  const words = [interval > 1 ? fill(data.describe.every, { interval, unit: unit[1] }) : fill(data.describe.every_one, { unit: unit[0] })];
  if (value.weekdays.length) words.push(fill(data.describe.on, { days: value.weekdays.map(day => data.weekday_short[data.weekday_codes.indexOf(data.weekdays.find(row => row.value === day).code)]).join(', ') }));
  if (value.ends.kind === 'date') words.push(fill(data.describe.until, { date: new Date(`${value.ends.value}T12:00:00Z`).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' }) }));
  if (value.ends.kind === 'count') words.push(fill(data.describe.count, { count: value.ends.value }));
  return words.join(', ');
}
