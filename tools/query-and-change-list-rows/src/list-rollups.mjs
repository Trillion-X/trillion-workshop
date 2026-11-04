// src/list-rollups.mjs
//
// Purpose: a column worked out from linked rows. A company's "open deal value" is the sum of `amount` over the deals
// its `deals` link names; a person's "company domain" is the `domain` of the company they link to. A rollup field says
// which link to follow (`through`), which field of the linked rows to read (`field`) and what to make of their values
// (`op`, a row of src/lists.json `aggregates`, run by the formula engine), and its value is worked out whenever the row
// is read, so it is never out of date and never kept.
//
// Non-Negotiable Invariants:
//   1. What a rollup can do is DATA: `op` names a row of `aggregates` (count, sum, average, min, max, distinct, values ...);
//      nothing here names an operation. The arithmetic is the formula engine's, so a rollup's sum is a formula's sum.
//   2. Linked rows are read from the list that owns them (any store), by id, only for the rows being shown, at most
//      limits.rollup_links of them per read; past that the rollup answers nothing rather than a partial value.
//   3. A rollup keeps no value in a row; a write naming it is refused like any computed field.
//
import data from '../../keep-and-wake-ai-sessions-on-this-computer/src/lists.json' with { type: 'json' };
import { listSay as say } from './list-refusals.mjs';

const { limits } = data;
const KINDS = new Map(data.field_kinds.map(kind => [kind.id, kind]));
const ops = Object.fromEntries(Object.entries(data.aggregates).filter(([id]) => !id.startsWith('_')));
const isObject = value => Boolean(value) && typeof value === 'object' && !Array.isArray(value);
const idsOf = value => (Array.isArray(value) ? value : typeof value === 'string' && value ? [value] : []).filter(item => typeof item === 'string');
const empty = value => value === undefined || value === null || value === '' || (Array.isArray(value) && !value.length);
// The engine answers decimals as text ("8"); a number is a number to the reader.
const answered = value => (typeof value === 'string' && /^-?\d+(\.\d+)?$/.test(value) ? Number(value) : value);
const chunks = (items, size) => Array.from({ length: Math.ceil(items.length / size) }, (_, index) => items.slice(index * size, (index + 1) * size));

/** A field as a view compares it: a rollup reads as the kind its measure answers (src/lists.json aggregates `answers`). */
export const asViewed = field => (KINDS.get(field.kind)?.carries?.key === 'rollup' && ops[field.rollup?.op]?.answers ? { ...field, kind: ops[field.rollup.op].answers } : field);

/** The rollup fields of a list being saved, checked against its fields and (when this store keeps it) the linked list. */
export function checkRollups(fields, listOf) {
  for (const field of fields) {
    if (KINDS.get(field.kind)?.carries?.key !== 'rollup') continue;
    const rollup = field.rollup;
    const refuse = what => say('bad_rollup', { field_id: field.id, ops: Object.keys(ops).join(', '), what });
    const through = fields.find(item => item.id === rollup.through);
    if (!through || !KINDS.get(through.kind)?.links) throw refuse(`through ${JSON.stringify(rollup.through)}`);
    if (typeof rollup.op !== 'string' || !Object.hasOwn(ops, rollup.op)) throw refuse(`op ${JSON.stringify(rollup.op)}`);
    if (!ops[rollup.op].rows && typeof rollup.field !== 'string') throw refuse('field');
    const target = listOf(through.links_to);
    const leaf = target?.fields?.find(item => item.id === rollup.field);
    if (target && !ops[rollup.op].rows && (!leaf || KINDS.get(leaf.kind)?.value === 'computed'
      || (ops[rollup.op].kinds?.length && !ops[rollup.op].kinds.includes(KINDS.get(leaf.kind)?.ruleKind)))) throw refuse(`field ${JSON.stringify(rollup.field)}`);
  }
}

/**
 * The rows with each rollup field's value worked out: `rows` are read rows ({ id, values }); `evaluateBinding(binding, input)`
 * is the formula engine (without it, only measures that count rows are worked out). Answers new row objects.
 */
export async function withRollups(lists, list, rows, { evaluateBinding } = {}) {
  const rollups = (list.fields ?? []).filter(field => KINDS.get(field.kind)?.carries?.key === 'rollup' && isObject(field.rollup));
  if (!rollups.length || !rows.length) return rows;
  const out = rows.map(row => ({ ...row, values: { ...row.values } }));
  for (const field of rollups) {
    const { through, field: leafId, op: opId } = field.rollup;
    const op = ops[opId];
    const link = list.fields.find(item => item.id === through);
    if (!op || !link?.links_to || (!op.rows && !evaluateBinding)) continue;
    const wanted = [...new Set(out.flatMap(row => idsOf(row.values[through])))];
    if (wanted.length > limits.rollup_links) continue;
    const linked = new Map();
    for (const group of chunks(wanted, limits.rows_per_read)) {
      for (const row of (await lists.read(link.links_to, { row_ids: group, only: op.rows ? [] : [leafId] })).rows) linked.set(row.id, row.values);
    }
    for (const row of out) {
      const reached = idsOf(row.values[through]).filter(id => linked.has(id));
      if (op.rows) { row.values[field.id] = reached.length; continue; }
      const values = reached.map(id => linked.get(id)[leafId]).filter(value => !empty(value))
        .flatMap(value => (Array.isArray(value) ? value : [value])).map(value => (op.numeric ? Number(value) : value)).filter(value => !(op.numeric && Number.isNaN(value)));
      if (!values.length && op.numeric) continue;
      row.values[field.id] = answered(await evaluateBinding({ $kind: 'binding', select: { from: 'self', path: ['values'] }, transform: op.transform }, { values }));
    }
  }
  return out;
}
