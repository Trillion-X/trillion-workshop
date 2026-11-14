// src/list-aggregates.mjs
//
// Purpose: totals over a list, or over one of its saved views, without sending the rows. "How many open deals, and what
// are they worth?" is a count and a sum, not a thousand rows for the asker to add up. The measures are DATA
// (src/lists.json `aggregates`: each is a count of rows or a transform of the formula engine's array operators over a
// field's values), the rows are read from the list owner a page at a time through the same view the app shows, and the
// arithmetic is the formula engine's.
//
// Non-Negotiable Invariants:
//   1. A measure is a row of src/lists.json `aggregates`; nothing here names one. The engine does the arithmetic, so a sum
//      here is the sum a formula column would show.
//   2. At most limits.aggregate_scan_rows rows are read and the answer says `complete: false` when it stopped before the end;
//      a partial total is never presented as the whole.
//   3. A group is a value of the group_by field (each tag of a tags field counts the row once per tag); at most
//      limits.aggregate_groups groups, then `groups_more: true`.
//   4. Rows are read through the owner (any store the list lives in) and a view the same way the app reads it, so what is
//      counted is what the person sees.
//   5. A measure's own settings (the share of a quantile, the period of a streak) are `params` the aggregate row declares
//      (kind number, text, choice, map, field or now) and its transform names with { "$param": name }; this file fills them
//      in and checks their kind, it never names a measure. A row that says `pairs: <param>` hands the engine each value
//      with the value of the field that param names ({ value, <param> }, the row's place when none), which is how
//      "the latest" is a sort and a last element and nothing more.
//
import data from '../../keep-and-wake-ai-sessions-on-this-computer/src/lists.json' with { type: 'json' };
import { listSay as say } from './list-refusals.mjs';

const { limits } = data;
// A measure marked per_row (the linked values themselves) is for a rollup over one row's links (src/list-rollups.mjs), never a total.
const ops = Object.fromEntries(Object.entries(data.aggregates).filter(([id, row]) => !id.startsWith('_') && !row.per_row));
const KINDS = new Map(data.field_kinds.map(kind => [kind.id, kind]));
const isObject = value => Boolean(value) && typeof value === 'object' && !Array.isArray(value);
const empty = value => value === undefined || value === null || value === '' || (Array.isArray(value) && !value.length);
const asNumber = value => (typeof value === 'number' ? value : typeof value === 'string' && value.trim() !== '' ? Number(value) : NaN);
// The engine answers decimals as text ("8"); a number is a number to the asker.
const answered = value => (typeof value === 'string' && /^-?\d+(\.\d+)?$/.test(value) ? Number(value) : value);


const PARAM_KINDS = {
  number: value => typeof value === 'number' && Number.isFinite(value),
  text: value => typeof value === 'string' && value !== '',
  map: value => isObject(value) && Object.values(value).every(item => typeof item === 'number' && Number.isFinite(item)),
};

/** The measure's params, each checked against the kind its aggregate row declares, defaults filled in. */
export function paramsOf(op, given, fieldOf, now, refuse) {
  const declared = op.params ?? {};
  if (given !== undefined && (!isObject(given) || Object.keys(given).some(key => !Object.hasOwn(declared, key)))) throw refuse(`params ${JSON.stringify(given)} here (it takes: ${Object.keys(declared).join(', ') || 'none'})`);
  const out = {};
  for (const [name, spec] of Object.entries(declared)) {
    const value = given?.[name] ?? spec.default;
    if (spec.kind === 'now') out[name] = value ?? now();
    else if (value === undefined) { if (spec.required) throw refuse(`${op.label} without ${name}`); }
    else if (spec.kind === 'field') {
      const field = fieldOf(value);
      if (!field || KINDS.get(field.kind)?.value === 'computed') throw refuse(`${JSON.stringify(value)} for ${name}`);
      out[name] = field.id;
    } else if (spec.kind === 'choice') {
      if (!spec.choices?.includes(value)) throw refuse(`${JSON.stringify(value)} for ${name} (one of ${spec.choices?.join(', ')})`);
      out[name] = value;
    } else {
      if (!PARAM_KINDS[spec.kind]?.(value)) throw refuse(`${JSON.stringify(value)} for ${name} (a ${spec.kind})`);
      out[name] = value;
    }
  }
  return out;
}

/** A transform with each { "$param": name } replaced by the measure's value of it. */
export const filled = (template, params) => Array.isArray(template) ? template.map(item => filled(item, params))
  : isObject(template) ? (Object.hasOwn(template, '$param') ? params[template.$param] : Object.fromEntries(Object.entries(template).map(([key, value]) => [key, filled(value, params)])))
    : template;

/**
 * { list_id, view_id, rows_counted, complete, measures: [{ field, op, label, value }], groups?: [{ key, rows, measures }] }.
 * `readView({ list_id, view_id, limit, cursor })` reads a saved view's page; `readSnapshot({ list_id, snapshot_id, limit, cursor })`
 * a held snapshot's page (src/list-snapshots.mjs), so totals over a snapshot are the rows it held; `evaluateBinding(binding,
 * input)` is the formula engine.
 */
export async function aggregateRows(lists, id, input, { readView, readSnapshot, evaluateBinding, now = () => new Date().toISOString() } = {}) {
  const slug = String(id).replace(/^list:/, '');
  const names = Object.keys(ops).join(', ');
  const refuse = what => say('bad_aggregate', { measures: limits.aggregate_measures, ops: names, kinds: 'the kind', what });
  if (!isObject(input) || Object.keys(input).some(key => !['view_id', 'snapshot_id', 'measures', 'group_by'].includes(key)) || !Array.isArray(input.measures)
    || !input.measures.length || input.measures.length > limits.aggregate_measures || (input.view_id !== undefined && typeof input.view_id !== 'string')
    || (input.snapshot_id !== undefined && (typeof input.snapshot_id !== 'string' || input.view_id !== undefined || !readSnapshot))
    || (input.group_by !== undefined && typeof input.group_by !== 'string')) throw refuse('that request');
  const list = await lists.find(slug);
  if (!list) throw say('no_list', { list_id: slug });
  const fieldOf = fieldId => list.fields.find(field => field.id === fieldId);
  const measures = input.measures.map(measure => {
    const op = isObject(measure) && Object.hasOwn(ops, measure.op) ? ops[measure.op] : null;
    if (!op) throw refuse(JSON.stringify(measure?.op ?? null));
    if (op.rows) return { op: measure.op, ...op, field: null, params: {} };
    const field = fieldOf(measure.field);
    if (!field || KINDS.get(field.kind)?.value === 'computed' || (op.kinds?.length && !op.kinds.includes(KINDS.get(field.kind)?.ruleKind)))
      throw say('bad_aggregate', { measures: limits.aggregate_measures, ops: names, kinds: (op.kinds ?? []).join(' or '), what: `${JSON.stringify(measure.field)} for ${measure.op}` });
    const params = paramsOf(op, measure.params, fieldOf, now, what => refuse(`${what} for ${measure.op}`));
    return { op: measure.op, ...op, field: field.id, params, transform: filled(op.transform, params) };
  });
  const groupField = input.group_by === undefined ? null : fieldOf(input.group_by);
  if (input.group_by !== undefined && !groupField) throw refuse(JSON.stringify(input.group_by));
  if (input.view_id !== undefined && !readView) throw refuse('a view here');
  if (measures.some(measure => !measure.rows) && !evaluateBinding) throw say('aggregate_unavailable');

  // groups: key -> { rows, values: per measure the field's values }.
  const groups = new Map();
  const total = { rows: 0, values: measures.map(() => []) };
  const take = (bucket, row) => {
    bucket.rows += 1;
    measures.forEach((measure, index) => {
      if (measure.rows) return;
      const value = row.values[measure.field];
      if (empty(value)) return;
      const held = measure.numeric ? asNumber(value) : Array.isArray(value) ? JSON.stringify(value) : value;
      // `pairs`: the value travels with the value the param names, or with the row's place when none is named.
      bucket.values[index].push(measure.pairs ? { value: held, [measure.pairs]: (measure.params[measure.pairs] ? row.values[measure.params[measure.pairs]] : null) ?? bucket.rows } : held);
    });
  };
  let cursor;
  let scanned = 0;
  let complete = false;
  let groupsMore = false;
  while (scanned < limits.aggregate_scan_rows) {
    const options = { limit: limits.read_page_rows, ...(cursor ? { cursor } : {}) };
    const page = input.snapshot_id ? await readSnapshot({ list_id: slug, snapshot_id: input.snapshot_id, ...options })
      : input.view_id ? await readView({ list_id: slug, view_id: input.view_id, ...options }) : await lists.read(slug, options);
    scanned += page.page?.scanned ?? page.rows.length;
    for (const row of page.rows) {
      take(total, row);
      if (!groupField) continue;
      const held = row.values[groupField.id];
      for (const key of empty(held) ? ['Empty'] : (Array.isArray(held) ? held : [held]).map(String)) {
        if (!groups.has(key) && groups.size >= limits.aggregate_groups) { groupsMore = true; continue; }
        if (!groups.has(key)) groups.set(key, { rows: 0, values: measures.map(() => []) });
        take(groups.get(key), row);
      }
    }
    cursor = page.page?.next_cursor ?? null;
    if (page.page?.complete !== false || !cursor) { complete = true; break; }
  }
  const work = async bucket => Promise.all(measures.map(async (measure, index) => {
    const value = measure.rows ? bucket.rows
      : answered(await evaluateBinding({ $kind: 'binding', select: { from: 'self', path: ['values'] }, transform: measure.transform }, { values: bucket.values[index].filter(item => !(measure.numeric && Number.isNaN(item))) }));
    return { field: measure.field, op: measure.op, label: measure.label, value };
  }));
  return {
    list_id: slug, ...(input.view_id ? { view_id: input.view_id } : {}), ...(input.snapshot_id ? { snapshot_id: input.snapshot_id } : {}), rows_counted: total.rows, complete,
    measures: await work(total),
    ...(groupField ? { group_by: groupField.id, groups: await Promise.all([...groups].map(async ([key, bucket]) => ({ key, rows: bucket.rows, measures: await work(bucket) }))), ...(groupsMore ? { groups_more: true } : {}) } : {}),
  };
}
