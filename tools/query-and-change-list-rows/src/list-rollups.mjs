// src/list-rollups.mjs
//
// Purpose: a column worked out from linked rows. A company's "open deal value" is the sum of `amount` over the deals
// its `deals` link names; a person's "company domain" is the `domain` of the company they link to. A rollup field says
// which link to follow (`through`; none means the row itself), which field of the linked rows to read (`field`), which of
// the linked rows count (`where`: the rule tree a saved view keeps, compiled by the formula engine's rule compiler) and what
// to make of their values (`op`, a row of src/lists.json `aggregates`, run by the formula engine), and its value is worked
// out whenever the row is read, so it is never out of date and never kept. A value in a `where` rule written
// `{ "settles_of": "<field id>" }` is the values that field of the linked list settles on, read from the list, so what
// counts as done is the field's own DATA and no word is named here.
//
// The computing step for a whole row is in this file too (withComputedFields, below): rollups and formulas worked out together
// with the one formula engine, for every reader.
//
// Non-Negotiable Invariants:
//   1. What a rollup can do is DATA: `op` names a row of `aggregates` (count, sum, average, min, max, distinct, values ...);
//      nothing here names an operation. The arithmetic is the formula engine's, so a rollup's sum is a formula's sum.
//   2. Linked rows are read from the list that owns them (any store), by id, only for the rows being shown, at most
//      limits.rollup_links of them per read; past that the rollup answers nothing rather than a partial value.
//   3. A rollup keeps no value in a row; a write naming it is refused like any computed field.
//   4. A rollup reads the computed values of the linked rows (another rollup, a formula) through the same computing step
//      (withComputedFields, below), which never follows a link back to a row whose value is being worked out.
//
import data from '../../keep-and-wake-ai-sessions-on-this-computer/src/lists.json' with { type: 'json' };
import operators from '../../formula-engine/rules/rule-operators.json' with { type: 'json' };
import { compileRules, ruleVocabulary } from '../../formula-engine/rules/compile-rules.mjs';
import { listSay as say } from './list-refusals.mjs';

const { limits } = data;
const KINDS = new Map(data.field_kinds.map(kind => [kind.id, kind]));
const ops = Object.fromEntries(Object.entries(data.aggregates).filter(([id]) => !id.startsWith('_')));
const isObject = value => Boolean(value) && typeof value === 'object' && !Array.isArray(value);
const idsOf = value => (Array.isArray(value) ? value : typeof value === 'string' && value ? [value] : []).filter(item => typeof item === 'string');
const empty = value => value === undefined || value === null || value === '' || (Array.isArray(value) && !value.length);
// The engine answers decimals as text ("8"); a number is a number to the reader.
const answered = value => (typeof value === 'string' && /^-?\d+(\.\d+)?$/.test(value) ? Number(value) : value);
const vocabulary = ruleVocabulary(operators);
const isComputed = field => KINDS.get(field?.kind)?.value === 'computed';
const chunks = (items, size) => Array.from({ length: Math.ceil(items.length / size) }, (_, index) => items.slice(index * size, (index + 1) * size));

/** A field as a view compares it: a rollup reads as the kind its measure answers (src/lists.json aggregates `answers`). */
export const asViewed = field => (KINDS.get(field.kind)?.carries?.key === 'rollup' && ops[field.rollup?.op]?.answers ? { ...field, kind: ops[field.rollup.op].answers } : field);

/** The rollup fields of a list being saved, checked against its fields and (when this store keeps it) the linked list. */
export function checkRollups(fields, listOf) {
  for (const field of fields) {
    if (KINDS.get(field.kind)?.carries?.key !== 'rollup') continue;
    const rollup = field.rollup;
    const refuse = what => say('bad_rollup', { field_id: field.id, ops: Object.keys(ops).join(', '), what });
    const self = rollup.through === undefined;
    const through = self ? null : fields.find(item => item.id === rollup.through);
    if (!self && (!through || !KINDS.get(through.kind)?.links)) throw refuse(`through ${JSON.stringify(rollup.through)}`);
    if (typeof rollup.op !== 'string' || !Object.hasOwn(ops, rollup.op)) throw refuse(`op ${JSON.stringify(rollup.op)}`);
    if (!ops[rollup.op].rows && typeof rollup.field !== 'string') throw refuse('field');
    if (rollup.where !== undefined && (!isObject(rollup.where) || rollup.where.kind !== 'group')) throw refuse('where');
    const target = self ? { fields } : listOf(through.links_to);
    const leaf = target?.fields?.find(item => item.id === rollup.field);
    if (target && !ops[rollup.op].rows && (!leaf
      || (ops[rollup.op].kinds?.length && !isComputed(leaf) && !ops[rollup.op].kinds.includes(KINDS.get(leaf.kind)?.ruleKind)))) throw refuse(`field ${JSON.stringify(rollup.field)}`);
  }
}

// A rule tree with each `{ settles_of: <field id> }` value replaced by what that field of the list settles on.
function withSettles(node, fieldsById) {
  if (Array.isArray(node)) return node.map(item => withSettles(item, fieldsById));
  if (!isObject(node)) return node;
  if (typeof node.settles_of === 'string') return fieldsById.get(node.settles_of)?.settles ?? [];
  return Object.fromEntries(Object.entries(node).map(([key, value]) => [key, withSettles(value, fieldsById)]));
}

/** The test a rollup's `where` makes of one linked row (its values), or null when it has none. Compiled once per field. */
function rowTest(rollup, target, evaluateBinding) {
  if (!rollup.where) return null;
  const fieldsById = new Map((target?.fields ?? []).map(field => [field.id, field]));
  const { binding } = compileRules(withSettles(rollup.where, fieldsById), { fields: [...fieldsById.values()].map(field => ({ id: field.id, kind: KINDS.get(field.kind)?.ruleKind ?? field.kind })), vocabulary });
  return binding ? async values => (await evaluateBinding(binding, values)) === true : null;
}

/** A measure over the values a rollup reached. */
async function measured(values, op, evaluateBinding) {
  values = values.filter(value => !empty(value)).flatMap(value => (Array.isArray(value) ? value : [value])).map(value => (op.numeric ? Number(value) : value)).filter(value => !(op.numeric && Number.isNaN(value)));
  if (!values.length && op.numeric) return undefined;
  return answered(await evaluateBinding({ $kind: 'binding', select: { from: 'self', path: ['values'] }, transform: op.transform }, { values }));
}

/**
 * Works out one rollup field of `out` (rows being read, { id, values }, changed in place). `compute(list, rows, parents)` (parents: Map(linked row id -> ids of the rows that reached it)) answers
 * rows of another list (or this one) with their computed fields worked out, for a rollup that reads one; Without `evaluateBinding` only a measure that counts rows works.
 */
export async function rollupField(lists, list, out, field, { evaluateBinding, compute, shared = new Map(), budget = null }) {
  const { through, field: leafId, op: opId } = field.rollup;
  const op = ops[opId];
  const link = through === undefined ? null : list.fields.find(item => item.id === through);
  if (!op || (link && !link.links_to) || ((!op.rows || field.rollup.where) && !evaluateBinding)) return;
  const reachedOf = new Map();
  let target = link ? null : list;
  if (link) {
    const wanted = [...new Set(out.flatMap(row => idsOf(row.values[through])))];
    if (wanted.length > limits.rollup_links) return;
    const parentsOf = new Map();
    for (const row of out) for (const id of idsOf(row.values[through])) parentsOf.set(id, [...(parentsOf.get(id) ?? []), row.id]);
    const kept = shared.get(through);
    const linked = kept && wanted.every(id => kept.has(id)) ? kept : new Map();
    const reusing = linked === kept;
    if (!reusing) shared.set(through, linked);
    const restricted = !field.rollup.where;
    for (const group of reusing ? [] : chunks(wanted, limits.rows_per_read)) {
      // The reader's own time budget (its call deadline): a rollup that cannot finish inside it answers nothing, as one past the
      // link bound does, so a slow machine does fewer rows rather than holding the call past its deadline.
      if (budget && Date.now() > budget.until) return;
      let read = await lists.read(link.links_to, { row_ids: group, ...(restricted ? { only: op.rows ? [] : [leafId] } : {}) });
      target ??= read.list;
      let rows = read.rows;
      if (field.rollup.where || isComputed(target?.fields?.find(item => item.id === leafId))) {
        if (restricted) read = await lists.read(link.links_to, { row_ids: group });
        rows = await compute(target, read.rows, parentsOf);
      }
      for (const row of rows) linked.set(row.id, row.values);
      if (!(field.rollup.where || isComputed(target?.fields?.find(item => item.id === leafId)))) shared.delete(through);
    }
    for (const row of out) reachedOf.set(row.id, idsOf(row.values[through]).filter(id => linked.has(id)).map(id => linked.get(id)));
  } else for (const row of out) reachedOf.set(row.id, [row.values]);
  const test = rowTest(field.rollup, target, evaluateBinding);
  for (const row of out) {
    let reached = reachedOf.get(row.id);
    if (test) reached = (await Promise.all(reached.map(async values => [values, await test(values)]))).filter(([, kept]) => kept).map(([values]) => values);
    if (op.rows) { row.values[field.id] = reached.length; continue; }
    // A measure the engine cannot work out (a value past what it can hold) leaves this field without a value, as a formula that
    // fails does; it never fails the whole read.
    let value;
    try { value = await measured(reached.map(values => values[leafId]), op, evaluateBinding); } catch { value = undefined; }
    if (value !== undefined) row.values[field.id] = value;
  }
}

// ---- the computing step: a row's rollups, then its formulas ------------------------------------------------------------
//
// Purpose: the fields of a row that are worked out when it is read and never kept: a rollup (from linked rows,
// the rollups above) and a formula (`derive`, the formula engine's binding over the row's own values). One step does both,
// for every reader (a page, a door, an AI), so a formula's value is the same wherever it is read and a rollup can read the
// computed value of a linked row (a task's total is the sum of its steps' totals, to any depth).
//
// Non-Negotiable Invariants:
//   1. The formula engine is the only evaluator: a rollup's measure, a rollup's `where` and a formula all run through the
//      `evaluateBinding` the reader gives. Without one, only a measure that counts rows is worked out.
//   2. A row's rollups are worked out first, then its formulas in the order the list declares them; a formula reads the row's
//      kept values and every computed value before it (`derive.context_from_fields` narrows them to the fields it names).
//   3. A rollup that follows links to computed fields never follows one back to a row whose value is being worked out up the
//      path that reached it (its ancestors): a value that depends on itself has no value, so links that return to a row cost the
//      rows read once and never loop. No depth number is set: the cost is the rows read, which limits.rollup_links bounds at
//      each step.
//   4. A formula that fails (a division by zero, a missing value) leaves its field without a value, as a rollup of nothing does.
//


const chainKey = (list, row) => `${list.id}/${row.id}`;
const keyOf = field => KINDS.get(field.kind)?.carries?.key;

/** Whether a list has a rollup or a formula field. */
export const hasComputedFields = list => (list.fields ?? []).some(field => ['rollup', 'derive'].includes(keyOf(field)));

/**
 * The rows with each rollup and formula field's value worked out: `rows` are read rows ({ id, values }); `evaluateBinding(binding,
 * input)` is the formula engine. Answers new row objects. `ancestors` names, for a row reached through links, the rows whose values are being worked out up the path that reached it.
 */
export async function withComputedFields(lists, list, rows, { evaluateBinding, ancestors = new Map(), budgetMs, budget = budgetMs === undefined ? null : { until: Date.now() + budgetMs } } = {}) {
  if (!rows.length || !hasComputedFields(list)) return rows;
  const out = rows.map(row => ({ ...row, values: { ...row.values } }));
  // `parents`: Map(row id of the linked list -> ids of the rows of this list that reached it). A linked row that is among its own
  // ancestors closes a ring and is left out; the others are worked out with their ancestors named.
  const compute = (other, linked, parents) => {
    const next = new Map();
    const kept = linked.filter(row => {
      const found = new Set();
      for (const parent of parents.get(row.id) ?? []) {
        found.add(chainKey(list, { id: parent }));
        for (const key of ancestors.get(chainKey(list, { id: parent })) ?? []) found.add(key);
      }
      if (found.has(chainKey(other, row))) return false;
      next.set(chainKey(other, row), found);
      return true;
    });
    return withComputedFields(lists, other, kept, { evaluateBinding, ancestors: next, budget });
  };
  const shared = new Map();
  for (const field of list.fields) {
    if (keyOf(field) === 'rollup' && isObject(field.rollup)) await rollupField(lists, list, out, field, { evaluateBinding, compute, shared, budget });
  }
  if (evaluateBinding) {
    for (const field of list.fields) {
      const binding = keyOf(field) === 'derive' ? field.derive?.request?.binding : null;
      if (!isObject(binding)) continue;
      const named = Array.isArray(field.derive.context_from_fields) ? field.derive.context_from_fields : null;
      for (const row of out) {
        const input = named ? Object.fromEntries(named.filter(id => row.values[id] !== undefined).map(id => [id, row.values[id]])) : row.values;
        try {
          const value = answered(await evaluateBinding(binding, input));
          if (value !== undefined && value !== null) row.values[field.id] = value;
        } catch { /* a formula that cannot be worked out for this row leaves its field without a value */ }
      }
    }
  }
  return out;
}
