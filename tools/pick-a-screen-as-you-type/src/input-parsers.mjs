// src/input-parsers.mjs
//
// PURPOSE
//   Fills a screen's inputs from the words a person typed, with no model: "timer 25 min" gives a duration input 1500
//   seconds, "lunch with Ruth tomorrow at 1" gives a date-and-time input tomorrow at 13:00 and a person input Ruth. The
//   tool already says what each input is (its input_schema); which parser reads an input is DATA on that same schema
//   (`x-parse`, else its standard `format`, `enum` or `type`, mapped in input-parsers.json), so one registry of parsers
//   fills every screen and no screen carries parsing code of its own. Pure: it runs in the browser on every keystroke
//   and in the Worker.
//
// NON-NEGOTIABLE INVARIANTS
//   1. Blind: nothing here names a tool, a screen or an input. A parser is chosen by the input's schema alone.
//   2. Every word a parser knows (days, months, units, currencies, filler words) is DATA in input-parsers.json.
//   3. A span of the words fills at most one input; the most particular parser takes its words first (`order`).
//   4. A value is offered only when the input's own schema accepts it (its enum, its minimum and maximum, a whole
//      number for an integer); otherwise the input is left for the person.
//   5. Time is local to the person: dates and times are read against `now` in the device's own time zone.
//
// Shapes
//   parserOf(field, name?, data?) -> parser name | null
//   fillInputs(schema, text, { now?, used?: [[at, end]], choices?: { input: [{ value, label }] }, data? })
//     -> { values: { input: value }, spans: { input: [[at, end]] }, leftover: string }
//   INPUT_PARSERS: the registry, name -> (scan, field, name, context) -> [{ value, spans: [[at, end]] }]

import rules from './input-parsers.json' with { type: 'json' };
import { termsOf } from './word-match.mjs';

const object = value => Boolean(value) && typeof value === 'object' && !Array.isArray(value);
const typesOf = field => [field?.type].flat().filter(Boolean);
const pad = number => String(number).padStart(2, '0');
const dayOf = date => `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
const offsetOf = date => {
  const minutes = -date.getTimezoneOffset();
  return `${minutes >= 0 ? '+' : '-'}${pad(Math.floor(Math.abs(minutes) / 60))}:${pad(Math.abs(minutes) % 60)}`;
};
const localStamp = date => `${dayOf(date)}T${pad(date.getHours())}:${pad(date.getMinutes())}:00${offsetOf(date)}`;
const escape = text => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const wordAlternatives = words => words.slice().sort((a, b) => b.length - a.length).map(escape).join('|');
// A whole word of the text, in any script: no letter or digit right before or after it.
const whole = source => new RegExp(`(?<![\\p{L}\\p{N}])(?:${source})(?![\\p{L}\\p{N}])`, 'giu');
const overlaps = (spans, at, end) => spans.some(([from, to]) => at < to && end > from);

/** The parser that reads one input, by its own schema (invariant 1). */
export function parserOf(field, name = '', data = rules) {
  if (!object(field)) return null;
  if (typeof field['x-parse'] === 'string') return field['x-parse'];
  if (typeof field.format === 'string' && data.by_format[field.format]) return data.by_format[field.format];
  if (Array.isArray(field.enum) && field.enum.length) return data.enum_parser;
  // A number input named after a unit of time (`minutes`, `duration_seconds`) or carrying `x-unit` holds a duration.
  if (typesOf(field).some(type => type === 'number' || type === 'integer') && durationUnitOf(field, name, data)) return 'duration';
  for (const type of typesOf(field)) if (data.by_type[type]) return data.by_type[type];
  return typesOf(field).includes('string') || !typesOf(field).length ? data.text_parser : null;
}

// What every parser reads: the text, its lower-case copy and its words.
function scanOf(text) {
  const source = String(text ?? '');
  return { text: source, lower: source.toLowerCase(), terms: termsOf(source) };
}

function numbersIn(scan, data) {
  const scales = wordAlternatives(Object.keys(data.number_scales));
  const symbols = Object.keys(data.currencies).filter(key => !/^[\p{L}]/u.test(key)).map(escape).join('');
  const found = [];
  const pattern = new RegExp(`(?<![\\p{L}\\p{N}.])([${symbols}])?\\s?(\\d{1,3}(?:,\\d{3})+|\\d+)(?:\\.(\\d+))?(?:\\s?(${scales})(?![\\p{L}\\p{N}]))?`, 'giu');
  for (const match of scan.lower.matchAll(pattern)) {
    const base = Number(`${match[2].replace(/,/g, '')}${match[3] ? `.${match[3]}` : ''}`);
    const scale = match[4] ? data.number_scales[match[4]] : 1;
    found.push({ value: base * scale, at: match.index, end: match.index + match[0].length, currency: match[1] ? data.currencies[match[1]] : null, scaled: Boolean(match[4]) });
  }
  for (const term of scan.terms) {
    if (Object.hasOwn(data.number_words, term.raw)) found.push({ value: data.number_words[term.raw], at: term.at, end: term.end, currency: null, scaled: false });
  }
  return found.sort((a, b) => a.at - b.at);
}

function durationsIn(scan, data) {
  const units = wordAlternatives(Object.keys(data.duration_units));
  const numbers = wordAlternatives(Object.keys(data.number_words));
  const parts = [];
  const pattern = new RegExp(`(?<![\\p{L}\\p{N}.])(\\d+(?:\\.\\d+)?|${numbers}|an?)\\s?(${units})(?![\\p{L}\\p{N}])`, 'giu');
  for (const match of scan.lower.matchAll(pattern)) {
    const amount = /^\d/.test(match[1]) ? Number(match[1]) : data.number_words[match[1]] ?? 1;
    parts.push({ seconds: amount * data.duration_units[match[2]], at: match.index, end: match.index + match[0].length });
  }
  // Parts said one after another ("1 hour 30 min", "1h30m", "2 hours and 15 minutes") are one duration.
  const joined = [];
  for (const part of parts) {
    const last = joined.at(-1);
    if (last && /^\s*(?:and\s*)?$/i.test(scan.lower.slice(last.end, part.at))) { last.seconds += part.seconds; last.end = part.end; }
    else joined.push({ ...part });
  }
  return joined;
}

function upcomingWeekday(now, day, skipWeek) {
  const date = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  let ahead = (day - date.getDay() + 7) % 7 || 7;
  if (skipWeek && ahead < 7) ahead += 7;
  date.setDate(date.getDate() + ahead);
  return date;
}

function datesIn(scan, now, data) {
  const found = [];
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const shifted = days => { const date = new Date(today); date.setDate(date.getDate() + days); return date; };
  for (const term of scan.terms) {
    if (Object.hasOwn(data.relative_days, term.raw)) found.push({ date: shifted(data.relative_days[term.raw]), at: term.at, end: term.end });
  }
  const weekdays = data.weekdays.map(name => `${escape(name.slice(0, 3))}[\\p{L}]*`).join('|');
  const next = wordAlternatives(data.next_words);
  for (const match of scan.lower.matchAll(whole(`(?:(${next})\\s+)?(${weekdays})`))) {
    const said = match[2];
    const day = data.weekdays.findIndex(name => name.startsWith(said.slice(0, 3)) && name.startsWith(said));
    if (day >= 0) found.push({ date: upcomingWeekday(now, day, false), at: match.index, end: match.index + match[0].length });
  }
  const months = data.months.map(name => `${escape(name.slice(0, 3))}[\\p{L}]*\\.?`).join('|');
  const monthOf = said => data.months.findIndex(name => name.startsWith(said.replace(/\.$/, '').slice(0, 3)) && name.startsWith(said.replace(/\.$/, '')));
  const inYear = (month, day, year) => {
    if (month < 0 || day < 1 || day > 31) return null;
    if (year) return new Date(Number(year), month, day);
    const date = new Date(now.getFullYear(), month, day);
    // A day already gone this year (by more than a day) is next year's.
    return date < shifted(-1) ? new Date(now.getFullYear() + 1, month, day) : date;
  };
  for (const match of scan.lower.matchAll(whole(`(${months})\\s*(\\d{1,2})(?:st|nd|rd|th)?(?:,?\\s*(\\d{4}))?`))) {
    const date = inYear(monthOf(match[1]), Number(match[2]), match[3]);
    if (date) found.push({ date, at: match.index, end: match.index + match[0].length });
  }
  for (const match of scan.lower.matchAll(whole(`(\\d{1,2})(?:st|nd|rd|th)?\\s*(?:of\\s+)?(${months})(?:,?\\s*(\\d{4}))?`))) {
    const date = inYear(monthOf(match[2]), Number(match[1]), match[3]);
    if (date) found.push({ date, at: match.index, end: match.index + match[0].length });
  }
  for (const match of scan.lower.matchAll(whole('(\\d{4})-(\\d{2})-(\\d{2})'))) {
    found.push({ date: new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3])), at: match.index, end: match.index + match[0].length });
  }
  for (const match of scan.lower.matchAll(whole('(\\d{1,2})/(\\d{1,2})(?:/(\\d{2,4}))?'))) {
    const [first, second] = [Number(match[1]), Number(match[2])];
    const [month, day] = data.numeric_date_order === 'dmy' ? [second, first] : [first, second];
    if (month < 1 || month > 12) continue;
    const year = match[3] ? (match[3].length === 2 ? `20${match[3]}` : match[3]) : null;
    const date = inYear(month - 1, day, year);
    if (date) found.push({ date, at: match.index, end: match.index + match[0].length });
  }
  // "in 3 days", "in 2 weeks": a day from now.
  const ins = wordAlternatives(data.in_words);
  for (const duration of durationsIn(scan, data)) {
    const before = scan.lower.slice(0, duration.at).match(new RegExp(`(?:${ins})\\s*$`, 'iu'));
    if (before && duration.seconds >= 86400) found.push({ date: shifted(Math.round(duration.seconds / 86400)), at: duration.at - before[0].length, end: duration.end });
  }
  return found.sort((a, b) => a.at - b.at);
}

function timesIn(scan, data) {
  const found = [];
  const meridiem = wordAlternatives(Object.keys(data.meridiem));
  for (const match of scan.lower.matchAll(whole(`(\\d{1,2})(?::(\\d{2}))?\\s?(${meridiem})\\.?(?:m\\.?)?`))) {
    let hour = Number(match[1]) % 12;
    const minute = Number(match[2] ?? 0);
    if (Number(match[1]) > 12 || minute > 59) continue;
    hour += data.meridiem[match[3]];
    found.push({ time: `${pad(hour)}:${pad(minute)}`, at: match.index, end: match.index + match[0].length });
  }
  for (const match of scan.lower.matchAll(whole('(\\d{1,2}):(\\d{2})'))) {
    const [hour, minute] = [Number(match[1]), Number(match[2])];
    if (hour > 23 || minute > 59 || overlaps(found.map(item => [item.at, item.end]), match.index, match.index + match[0].length)) continue;
    found.push({ time: `${pad(hour)}:${pad(minute)}`, at: match.index, end: match.index + match[0].length });
  }
  const at = wordAlternatives(data.at_words);
  for (const match of scan.lower.matchAll(new RegExp(`(?<![\\p{L}\\p{N}])(?:${at})\\s*(\\d{1,2})(?![\\p{L}\\p{N}:])`, 'giu'))) {
    const said = Number(match[1]);
    if (said > 23 || overlaps(found.map(item => [item.at, item.end]), match.index, match.index + match[0].length)) continue;
    const hour = said >= 1 && said < data.bare_hours_after_noon_below ? said + 12 : said;
    found.push({ time: `${pad(hour)}:00`, at: match.index, end: match.index + match[0].length });
  }
  for (const term of scan.terms) {
    if (Object.hasOwn(data.day_parts, term.raw)) found.push({ time: data.day_parts[term.raw], at: term.at, end: term.end, part: true });
  }
  return found.sort((a, b) => a.at - b.at);
}

// The unit of time a number input's name or `x-unit` says it holds (`minutes`), or null. Single letters (`m`, `s`) are
// units only when typed after a number, never as a name.
function durationUnitOf(field, name, data) {
  return [field?.['x-unit'], ...termsOf(String(name).replace(/_/g, ' ')).map(term => term.raw)]
    .find(word => typeof word === 'string' && word.length > 1 && Object.hasOwn(data.duration_units, word)) ?? null;
}
// The seconds in one unit of what a number input holds a duration in: the unit it names, else the DATA default.
const secondsPerUnit = (field, name, data) => data.duration_units[durationUnitOf(field, name, data) ?? data.duration_unit_of_number];

function accepted(value, field) {
  if (Array.isArray(field?.enum) && !field.enum.some(one => one === value)) return false;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) return false;
    if (typesOf(field).includes('integer') && !Number.isInteger(value)) return false;
    if (Number.isFinite(field?.minimum) && value < field.minimum) return false;
    if (Number.isFinite(field?.maximum) && value > field.maximum) return false;
  }
  return true;
}

/** Every parser, by the name an input's schema gives it (input-parsers.json). Each answers every reading it finds. */
export const INPUT_PARSERS = Object.freeze({
  date: (scan, _field, _name, { now, data }) => datesIn(scan, now, data).map(item => ({ value: dayOf(item.date), spans: [[item.at, item.end]] })),
  time: (scan, _field, _name, { data }) => timesIn(scan, data).map(item => ({ value: item.time, spans: [[item.at, item.end]] })),
  datetime: (scan, _field, _name, { now, data }) => {
    const ins = wordAlternatives(data.in_words);
    // "in 20 minutes": a moment from now.
    const soon = durationsIn(scan, data).flatMap(duration => {
      const before = scan.lower.slice(0, duration.at).match(new RegExp(`(?:${ins})\\s*$`, 'iu'));
      return before && duration.seconds < 86400 ? [{ value: localStamp(new Date(now.getTime() + duration.seconds * 1000)), spans: [[duration.at - before[0].length, duration.end]] }] : [];
    });
    const dates = datesIn(scan, now, data);
    const times = timesIn(scan, data).filter(time => !dates.some(date => overlaps([[date.at, date.end]], time.at, time.end)) || time.part);
    if (!dates.length && !times.length) return soon;
    const date = dates[0]?.date ?? new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const time = times.find(item => !item.part) ?? times[0];
    const [hour, minute] = (time?.time ?? data.default_time).split(':').map(Number);
    const at = new Date(date.getFullYear(), date.getMonth(), date.getDate(), hour, minute);
    const spans = [...(dates[0] ? [[dates[0].at, dates[0].end]] : []), ...(time ? [[time.at, time.end]] : [])];
    return [...soon, { value: localStamp(at), spans }];
  },
  duration: (scan, field, name, { data }) => durationsIn(scan, data).map(item => ({
    value: typesOf(field).some(type => type === 'number' || type === 'integer') ? item.seconds / secondsPerUnit(field, name, data) : `PT${item.seconds}S`,
    spans: [[item.at, item.end]],
  })),
  number: (scan, _field, _name, { data }) => numbersIn(scan, data).map(item => ({ value: item.value, spans: [[item.at, item.end]] })),
  amount: (scan, _field, _name, { data }) => {
    const numbers = numbersIn(scan, data);
    const words = Object.keys(data.currencies).filter(key => /^[\p{L}]/u.test(key));
    const named = numbers.filter(item => item.currency || words.some(word => new RegExp(`^\\s*${escape(word)}(?![\\p{L}])`, 'iu').test(scan.lower.slice(item.end))));
    return [...named, ...numbers.filter(item => !named.includes(item))].map(item => ({ value: item.value, spans: [[item.at, item.end]] }));
  },
  email: scan => [...scan.text.matchAll(/[\w.+-]+@[\w-]+(?:\.[\w-]+)+/g)].map(match => ({ value: match[0], spans: [[match.index, match.index + match[0].length]] })),
  url: scan => [...scan.text.matchAll(/\bhttps?:\/\/[^\s]+|\bwww\.[^\s]+/g)].map(match => ({ value: match[0].startsWith('www.') ? `https://${match[0]}` : match[0], spans: [[match.index, match.index + match[0].length]] })),
  person: (scan, _field, _name, { data }) => {
    // The lead words as typed in either case; the name itself must start with a capital letter (no `i` flag).
    const leads = wordAlternatives(data.person_lead_words.flatMap(word => [word, word.charAt(0).toUpperCase() + word.slice(1)]));
    const mentioned = [...scan.text.matchAll(/@([\p{L}][\p{L}\p{N}._-]*)/gu)].map(match => ({ value: match[1], spans: [[match.index, match.index + match[0].length]] }));
    const named = [...scan.text.matchAll(new RegExp(`(?<![\\p{L}])(?:${leads})\\s+(\\p{Lu}[\\p{L}'-]*(?:\\s+\\p{Lu}[\\p{L}'-]*)?)`, 'gu'))]
      .map(match => ({ value: match[1], spans: [[match.index + match[0].length - match[1].length, match.index + match[0].length]] }));
    return [...mentioned, ...named];
  },
  choice: (scan, field, _name, { choices }) => {
    const options = (field.enum ?? []).map(value => ({ value, said: [String(value), ...(choices ?? []).filter(choice => choice.value === String(value)).map(choice => choice.label)] }));
    return options.flatMap(option => option.said.filter(Boolean).flatMap(said => {
      const words = termsOf(String(said).replace(/[_-]+/g, ' '));
      if (words.length !== 1) return [...scan.lower.matchAll(whole(words.map(term => escape(term.raw)).join('[\\s_-]+')))].map(match => ({ value: option.value, spans: [[match.index, match.index + match[0].length]] }));
      // One word is said as itself, in its cut form, or with an ending ("warm", "warmer").
      const [one] = words;
      return scan.terms.filter(term => term.raw === one.raw || term.word === one.word || (one.raw.length > 3 && term.raw.startsWith(one.raw)))
        .map(term => ({ value: option.value, spans: [[term.at, term.end]] }));
    }));
  },
  switch: (scan, field, name, { data }) => {
    const own = new Set(termsOf(`${name.replace(/_/g, ' ')} ${field.title ?? ''}`).map(term => term.word));
    return scan.terms.flatMap((term, index) => {
      if (!own.has(term.word)) return [];
      const before = scan.terms.slice(Math.max(0, index - 2), index);
      const off = before.find(one => data.switch_off_words.includes(one.raw));
      return [{ value: !off, spans: [[off?.at ?? term.at, term.end]] }];
    });
  },
});

// How far a reading sits from where the input is named ("width 300 height 200"): the nearest mention of its name.
function distanceToName(spans, name, field, scan) {
  const own = new Set(termsOf(`${name.replace(/_/g, ' ')} ${field.title ?? ''}`).map(term => term.word));
  const mentions = scan.terms.filter(term => own.has(term.word));
  if (!mentions.length) return Infinity;
  const [at, end] = spans[0];
  // A name said before its value ("width 300") is nearer than the same gap after it.
  return Math.min(...mentions.map(term => (term.end <= at ? at - term.end : term.at >= end ? term.at - end + 0.5 : 0)));
}

/** The values the words give the schema's inputs, the spans each took, and the words nothing took. */
export function fillInputs(schema, text, { now = new Date(), used = [], choices = {}, data = rules } = {}) {
  const properties = object(schema?.properties) ? schema.properties : {};
  const scan = scanOf(text);
  const taken = used.map(span => [...span]);
  const values = {};
  const spans = {};
  const parsers = Object.entries(properties).map(([name, field]) => ({ name, field, parser: parserOf(field, name, data) })).filter(item => item.parser);
  const context = { now, data };
  for (const kind of data.order) {
    for (const { name, field, parser } of parsers.filter(item => item.parser === kind)) {
      const read = INPUT_PARSERS[kind];
      if (!read) continue;
      const readings = read(scan, field, name, { ...context, choices: choices[name] })
        .filter(item => accepted(item.value, field) && !item.spans.some(([at, end]) => overlaps(taken, at, end)));
      if (!readings.length) continue;
      const near = readings.map(item => ({ item, distance: distanceToName(item.spans, name, field, scan) }));
      const chosen = near.some(one => Number.isFinite(one.distance)) ? near.sort((a, b) => a.distance - b.distance)[0].item : readings[0];
      values[name] = chosen.value;
      spans[name] = chosen.spans;
      taken.push(...chosen.spans);
    }
  }
  // What nothing took, without the filler words at its edges (input-parsers.json leftover_skip).
  const left = scan.terms.filter(term => !overlaps(taken, term.at, term.end));
  let first = 0;
  let last = left.length - 1;
  while (first <= last && data.leftover_skip.includes(left[first].raw)) first += 1;
  while (last >= first && data.leftover_skip.includes(left[last].raw)) last -= 1;
  const kept = left.slice(first, last + 1);
  // Words with a taken reading between them ("call Sam tomorrow about rent") are joined as words; otherwise as typed.
  const broken = kept.length > 1 && overlaps(taken, kept[0].at, kept.at(-1).end);
  const leftover = !kept.length ? '' : broken ? kept.map(term => scan.text.slice(term.at, term.end)).join(' ') : scan.text.slice(kept[0].at, kept.at(-1).end).trim();
  // The one plain text input takes it (input-parsers.json text_parser); with several, nobody can know which.
  const texts = parsers.filter(item => item.parser === data.text_parser && !object(item.field['x-record']));
  if (texts.length === 1 && leftover && accepted(leftover, texts[0].field)) {
    values[texts[0].name] = leftover;
    spans[texts[0].name] = kept.map(term => [term.at, term.end]);
  }
  return { values, spans, leftover };
}
