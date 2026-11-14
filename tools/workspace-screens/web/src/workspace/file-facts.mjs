// src/workspace/file-facts.mjs
//
// PURPOSE
//   The facts kept about each file (its namespace result of kind `facts`: when and where it was captured, its camera,
//   its length, the person's own fields) as fields the shared record views show in Files and Media: table, cards and
//   board, sorted, grouped and filtered by the formula engine like any other field. Which facts there are and how each
//   is written is DATA (file-facts.json); a fact nobody declared still shows, as a field of the kind its value reads as.
//
// NON-NEGOTIABLE INVARIANTS
//   1. A new fact is one row in file-facts.json: no screen names a fact.
//   2. What a rule compares is the fact itself (seconds, a date's milliseconds, the place as it is shown), never the
//      words drawn for it, so "longer than 30 seconds" and "captured in September" mean what they say.
//   3. A person's edit becomes the stored value of that fact's kind (a number, a date, a list), or null to take it away.
//   4. Pure: no page, no requests; the screens hand it their rows (each with `facts`).
import settings from './file-facts.json' with { type: 'json' };

export const FILE_FACTS = settings;

const clock = seconds => {
  const whole = Math.max(0, Math.round(Number(seconds)));
  const hours = Math.floor(whole / 3600);
  const rest = `${Math.floor(whole % 3600 / 60)}:${String(whole % 60).padStart(2, '0')}`;
  return hours ? `${hours}:${rest.padStart(5, '0')}` : rest;
};
const coordinates = value => `${Number(value.latitude).toFixed(4)}, ${Number(value.longitude).toFixed(4)}`;
const isPosition = value => value !== null && typeof value === 'object' && Number.isFinite(value.latitude) && Number.isFinite(value.longitude);
// A time in milliseconds; a date alone ("2026-09-03") is that day in the person's own calendar, as the filter reads days.
const asTime = value => {
  if (typeof value === 'number') return value;
  if (typeof value !== 'string') return NaN;
  const day = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value.trim());
  return day ? new Date(Number(day[1]), Number(day[2]) - 1, Number(day[3])).getTime() : Date.parse(value);
};

// How a fact is written for people (`show`), what its rules compare (`fact`) and where a row without it sorts
// (`blank`), per written form.
const FORMS = {
  text: { show: value => String(value), fact: value => String(value), blank: '' },
  number: { show: value => String(value), fact: value => (Number.isFinite(Number(value)) ? Number(value) : null), blank: -1 },
  clock: { show: value => (Number(value) > 0 ? clock(value) : ''), fact: value => (Number.isFinite(Number(value)) ? Number(value) : null), blank: -1 },
  day: {
    show: value => { const time = asTime(value); return Number.isFinite(time) ? new Date(time).toLocaleDateString(undefined, { dateStyle: 'medium' }) : ''; },
    fact: value => { const time = asTime(value); return Number.isFinite(time) ? time : null; },
    blank: -1,
  },
  list: { show: value => (Array.isArray(value) ? value.map(String) : [String(value)]), fact: value => (Array.isArray(value) ? value.map(String) : [String(value)]), blank: '' },
  place: { show: value => (isPosition(value) ? coordinates(value) : String(value)), fact: value => (isPosition(value) ? coordinates(value) : String(value)), blank: '' },
};

const empty = value => value === null || value === undefined || value === '' || (Array.isArray(value) && !value.length);

/** A fact's value on one row: the fact, else the first of its `else` sources that holds a value. */
export function factValue(row, field) {
  const facts = row?.facts ?? {};
  if (!empty(facts[field.id])) return facts[field.id];
  for (const source of field.else ?? []) {
    const value = 'fact' in source ? facts[source.fact] : row?.[source.row];
    if (!empty(value)) return value;
  }
  return null;
}

// The kind a fact nobody declared reads as, from its value.
function kindOf(value) {
  if (Array.isArray(value)) return 'tags';
  if (isPosition(value)) return 'place';
  if (typeof value === 'number') return 'number';
  if (typeof value === 'string' && /^\d{4}-\d{2}-\d{2}([T ]|$)/.test(value) && Number.isFinite(Date.parse(value))) return 'date';
  return 'text';
}
const labelOf = id => { const words = id.replace(/[_-]+/g, ' ').trim(); return words.charAt(0).toUpperCase() + words.slice(1); };

/** One fact as a record-views field. */
export function factField(field) {
  const kind = settings.kinds[field.kind] ?? settings.kinds.text;
  const form = FORMS[kind.show] ?? FORMS.text;
  const shown = row => { const value = factValue(row, field); return empty(value) ? '' : form.show(value); };
  const fact = row => { const value = factValue(row, field); return empty(value) ? null : form.fact(value); };
  return {
    id: field.id, label: field.label, icon: field.icon ?? 'Tag',
    ...(kind.field_kind ? { kind: kind.field_kind } : {}),
    ruleKind: kind.rule_kind, filterable: true, sortable: true, groupable: Boolean(field.groupable),
    ...(field.unit ? { unit: field.unit } : {}),
    width: field.width ?? 150, hiddenByDefault: Boolean(field.hiddenByDefault), editable: Boolean(field.editable),
    read: shown, factValue: fact, sortValue: row => fact(row) ?? form.blank,
  };
}

/** Every fact field for these rows: the declared ones, the person's own, then any other fact a row holds. */
export function factFields(rows = [], personFields = []) {
  const declared = [...settings.fields, ...personFields.map(field => ({ ...field, icon: field.icon ?? 'Tag', groupable: true, editable: true }))];
  const known = new Set([...declared.map(field => field.id), ...settings.quiet]);
  const seen = new Map();
  for (const row of rows) for (const [id, value] of Object.entries(row?.facts ?? {})) {
    if (!known.has(id) && !seen.has(id) && !empty(value)) seen.set(id, { id, label: labelOf(id), kind: kindOf(value), groupable: true, editable: true, hiddenByDefault: true });
  }
  return [...declared, ...seen.values()].map(factField);
}

/** The field-kind choices a person adds a field of their own from (record views' Add field form). */
export const personFieldKinds = () => settings.person_kinds.map(row => ({ id: row.id, label: row.label, kind: row.id, ruleKind: settings.kinds[row.id]?.rule_kind }));

/** A person's own field as it is kept: its id, name and kind. */
export const personField = input => ({ id: input.id, label: input.label, kind: settings.kinds[input.kind] ? input.kind : 'text' });

/** What an edit typed into a fact's cell stores: a value of the fact's kind, or null to take the fact away. */
export function editedFact(field, typed) {
  const text = String(typed ?? '').trim();
  if (!text) return null;
  const show = (settings.kinds[field.kind] ?? settings.kinds.text).show;
  if (show === 'number' || show === 'clock') { const number = Number(text); if (!Number.isFinite(number)) throw new Error(`${field.label} needs a number.`); return number; }
  if (show === 'day') { if (!Number.isFinite(asTime(text))) throw new Error(`${field.label} needs a date.`); return text; }
  if (show === 'list') return [...new Set(text.split(',').map(part => part.trim()).filter(Boolean))];
  return text;
}

/** The field a fact id names on these rows, declared, the person's own, or read from a value. */
export const findFactField = (id, rows = [], personFields = []) => {
  const declared = [...settings.fields, ...personFields].find(field => field.id === id);
  if (declared) return declared;
  const value = rows.map(row => row?.facts?.[id]).find(item => !empty(item));
  return value === undefined ? null : { id, label: labelOf(id), kind: kindOf(value) };
};

/** The facts a file's own bytes gave that it does not hold yet, plus when they were read: what was set by a person
 *  or an AI is never replaced by what the file says. */
export function factsFromFile(held, read, at) {
  const patch = Object.fromEntries(Object.entries(read).filter(([id, value]) => !empty(value) && empty(held?.[id])));
  return { ...patch, [settings.read_mark]: at };
}
