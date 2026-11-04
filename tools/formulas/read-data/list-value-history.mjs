// src/list-value-history.mjs
//
// Purpose: a field's values over time, so a list answers "how long has this deal been in Negotiation", "what was its
// stage on the first of the month", "was it ever Lost" and "what was it before" without a field kept by hand. A field
// that says `keeps_history: true` keeps, on its row, the values it has held with when each began (`_history`), written in
// the same write as the value itself; a field of kind `history` names that field and an op (a row of src/lists.json
// `value_history.ops`) and is worked out on every read from those steps. Because the answer is a value of the row, a
// view's rules, a formula's input (derive context_from_fields), aggregates and rollups read it like any other value.
//
// Why not the record log: the store's log (parts/record-log record-time readAt, valuesAt) reads a record's changes by
// scanning the log for its id, and older changes leave the database for files after src/record-history.json keep_days,
// so it can neither be read per row on every list read nor reach back further than that. The steps kept on the row are
// O(changes of that field), bounded, and stay with the row.
//
// Non-Negotiable Invariants:
//   1. What an op does is DATA (`value_history.ops`: which reduction, what it needs, what kind it answers); the reductions
//      are the interval arithmetic itself (the value at a moment, the one before, since when, time spent in, ever held).
//   2. Bounded: a field keeps at most `value_history.steps_kept` steps; when older ones are let go the field says `cut`,
//      and an answer that would need what was let go is null, never a guess. A step whose start is not known (the value a
//      row held before the field kept history) has `at: null` and counts the same way.
//   3. A step says who wrote it and by which road (`by`, `via`, src/write-via.mjs), so the history reads as lines a person
//      understands (fieldHistory `said`).
//
import data from './lists.json' with { type: 'json' };
import { listSay as say } from './list-refusals.mjs';
import { viaWords } from './write-via.mjs';

const config = data.value_history;
const KEY = 'history';
const KINDS = new Map(data.field_kinds.map(kind => [kind.id, kind]));
const OPS = new Map(Object.entries(config.ops).filter(([id]) => !id.startsWith('_')));
const same = (a, b) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
const ms = at => (typeof at === 'string' ? Date.parse(at) : NaN);
const isHistory = field => KINDS.get(field.kind)?.carries?.key === KEY;
// A value matches a step's value when equal, or (a list of values, like tags) when it holds it.
const holds = (stepValue, wanted) => same(stepValue, wanted) || (Array.isArray(stepValue) && stepValue.some(item => same(item, wanted)));

/** The fields of a list that keep their history. */
export const historyKeptBy = list => (list.fields ?? []).filter(field => field.keeps_history === true);

/**
 * Adds to `value._history` the step each history-keeping field of `list` took in this write: `before` is the row as it was
 * (null: a new row; undefined: not known), `at` the write's time and `actor` its writer. Mutates and answers `value`.
 */
export function keepValueHistory(list, value, { before, at, actor }) {
  const fields = historyKeptBy(list);
  if (!fields.length) return value;
  const history = { ...(value._history ?? {}) };
  for (const field of fields) {
    const kept = history[field.id] ?? { cut: false, steps: [] };
    const steps = [...kept.steps];
    const last = steps.at(-1);
    const prior = last ? last.v : before ? before[field.id] : undefined;
    const now = value[field.id];
    if (same(prior, now)) continue;
    // The value a row held before its field kept history began at a time nobody kept.
    if (!last && before && before[field.id] !== undefined) steps.push({ v: before[field.id], at: null });
    steps.push({ v: now ?? null, at, ...(actor?.by ? { by: actor.by } : {}), ...(actor?.via ? { via: actor.via } : {}) });
    const cut = kept.cut || steps.length > config.steps_kept;
    history[field.id] = { cut, steps: steps.slice(-config.steps_kept) };
  }
  value._history = history;
  return value;
}

/** Refuses a history field that names no history-keeping field of the list, no op, or not what its op needs. */
export function checkHistoryFields(fields) {
  for (const field of fields) {
    if (!isHistory(field)) continue;
    const spec = field[KEY];
    const op = OPS.get(spec.op);
    const source = fields.find(item => item.id === spec.field && item.keeps_history === true);
    const unit = spec.unit ?? op?.unit;
    if (!op || !source || (op.needs === 'value' && spec.value === undefined)
      || (op.needs === 'at' && !Number.isFinite(ms(spec.at)) && !(Number.isFinite(spec.days_ago) && spec.days_ago >= 0))
      || (unit !== undefined && !Object.hasOwn(config.units, unit)))
      throw say('bad_history', { field_id: field.id, ops: [...OPS.keys()].join(', '), units: Object.keys(config.units).join(', ') });
  }
}

/** The history fields a read works out (all of them, or those `only` names). */
export const historyFieldsOf = (list, only) => (list.fields ?? []).filter(field => isHistory(field) && (!only || only.includes(field.id)));

/** A history field as a view compares it: the kind its op answers (`source`: the kind of the field it reads). */
export function historyViewed(field, fields) {
  if (!isHistory(field)) return field;
  const answers = OPS.get(field[KEY]?.op)?.answers;
  if (answers === 'source') return { ...field, kind: fields.find(item => item.id === field[KEY].field)?.kind ?? field.kind };
  return answers ? { ...field, kind: answers } : field;
}

// The steps of one field as intervals: [{ v, from, until }] (from/until in ms; from null when not known, until null now).
const intervalsOf = kept => kept.steps.map((step, index) => ({ v: step.v, from: step.at === null ? null : ms(step.at), until: index + 1 < kept.steps.length ? ms(kept.steps[index + 1].at) : null }));

// One op over one field's kept steps, as of `now` (ms). null when the answer would need history that is not kept.
function reduce(op, spec, kept, now) {
  const intervals = intervalsOf(kept);
  const unknownStart = kept.cut || !intervals.length || intervals[0].from === null;
  const firstKnown = intervals.find(interval => interval.from !== null)?.from ?? null;
  const current = intervals.at(-1);
  if (op.reduce === 'since') return current && current.from !== null ? new Date(current.from).toISOString() : null;
  if (op.reduce === 'previous') return intervals.length >= 2 ? intervals.at(-2).v : null;
  if (op.reduce === 'at') {
    const moment = Number.isFinite(ms(spec.at)) ? ms(spec.at) : now - spec.days_ago * 86_400_000;
    const found = intervals.find(interval => (interval.from === null || interval.from <= moment) && (interval.until === null || moment < interval.until));
    if (!found) return null;
    // Before the first known start the row may have held something else.
    return found.from === null || (unknownStart && firstKnown !== null && moment < firstKnown) ? null : found.v;
  }
  if (op.reduce === 'duration') {
    const matching = intervals.filter(interval => holds(interval.v, spec.value));
    if (matching.some(interval => interval.from === null) || (unknownStart && kept.cut)) return null;
    const total = matching.reduce((sum, interval) => sum + ((interval.until ?? now) - interval.from), 0);
    return Math.round((total / config.units[spec.unit ?? op.unit]) * 1000) / 1000;
  }
  if (op.reduce === 'ever') {
    if (intervals.some(interval => holds(interval.v, spec.value))) return true;
    return unknownStart ? null : false;
  }
  return null;
}

/** The value of each history field `fields` of one kept row, as of `now` (ms): { [field id]: value }. */
export function historyValues(kept, fields, now) {
  const out = {};
  for (const field of fields) {
    const spec = field[KEY];
    const steps = kept?._history?.[spec.field];
    const op = OPS.get(spec.op);
    out[field.id] = steps && op ? reduce(op, spec, steps, now) : null;
  }
  return out;
}

/**
 * One field's history of one row as lines a person reads: { complete, steps: [{ value, from, until, by, said }] }, newest
 * last. complete is false when older steps were let go or the first step's start is not known.
 */
export function fieldHistoryOf(list, listId, rowId, kept, fieldId) {
  const field = (list.fields ?? []).find(item => item.id === fieldId && item.keeps_history === true);
  if (!field) throw say('bad_history', { field_id: fieldId, ops: [...OPS.keys()].join(', '), units: Object.keys(config.units).join(', ') });
  const history = kept?._history?.[fieldId] ?? { cut: false, steps: [] };
  const steps = history.steps.map((step, index) => ({
    value: step.v, from: step.at, until: history.steps[index + 1]?.at ?? null,
    ...(step.by ? { by: step.by } : {}), ...(step.at === null ? {} : { said: viaWords({ by: step.by, via: step.via }) }),
  }));
  return { list_id: listId, row_id: rowId, field_id: fieldId, complete: !history.cut && (steps.length === 0 || steps[0].from !== null), steps };
}
