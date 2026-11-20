// tools/decide-with-a-method/method-rows/store-records.mjs
//
// One method of the old decision store, shaped into the records tool:read-a-method reads (method-rows/view.mjs). The caller
// reads two tables by plain SQL and hands their rows in: the method's row (old_store.method, `record:method:<id>`: its name and
// its steps) and the checklist rows that hold the checks of those steps (old_store.w_decision_step_checklist, each row a
// `checks` array). Nothing here reads a store; the records are the same shape recordsIn takes ({ id, type, value }):
//   list-view:method-rows-<method>:<method>   the saved view: rows with a question, in the method's own step order
//   list:method-rows-<method>                 the list the view is over: row type method-row-<method>, field question
//   record:method-row-<method>~<step>         one row per step: the step's own fields, its `order` and its `checks`
// A check belongs to the step its `step` names. A check id that more than one checklist row holds is kept once, from the first
// row by id, so the shaped view is the same whatever order the caller reads the rows in.
import { readAMethod } from './view.mjs';

const LIST_PREFIX = 'method-rows-';
const ROW_PREFIX = 'method-row-';
const QUESTION_RULE = { kind: 'group', combinator: 'and', negate: false, rules: [{ kind: 'rule', field: 'question', operator: 'is_not_empty', params: {} }] };

const asArray = value => (typeof value === 'string' ? JSON.parse(value) : value);
const byId = (a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

/**
 * The records of one method, from its old_store.method row and the checklist rows that hold its steps' checks.
 * Returns { view, records }: `view` is the saved view's id, the method a read names.
 */
export function recordsOfMethod(methodRow, checklistRows) {
  const steps = asArray(methodRow.steps);
  if (!Array.isArray(steps)) throw new Error(`method ${methodRow.id} has no steps list`);
  const slug = methodRow.id.slice(methodRow.id.lastIndexOf(':') + 1);
  const checksOf = new Map(steps.map(step => [step.id, []]));
  const kept = new Set();
  for (const row of [...checklistRows].sort(byId)) {
    for (const check of asArray(row.checks)) {
      if (!checksOf.has(check.step) || kept.has(check.id)) continue;
      kept.add(check.id);
      checksOf.get(check.step).push(check);
    }
  }
  const list = `${LIST_PREFIX}${slug}`;
  const view = `list-view:${list}:${slug}`;
  const records = [
    { id: `list:${list}`, type: 'list', value: { row_type: `${ROW_PREFIX}${slug}`, fields: [{ id: 'question', kind: 'long-text' }] } },
    { id: view, type: 'list-view', value: { list_id: list, view: { id: slug, label: methodRow.name, rules: QUESTION_RULE, sort: [{ field: 'order', direction: 'asc' }] } } },
    ...steps.map((step, order) => ({
      id: `record:${ROW_PREFIX}${slug}~${encodeURIComponent(step.id)}`,
      type: `record:${ROW_PREFIX}${slug}`,
      value: { ...step, order, checks: checksOf.get(step.id) },
    })),
  ];
  return { view, records };
}

/** One page of a method's rows, read by tool:read-a-method from the rows of the store (`after` and `limit` as the reader takes them). */
export function readAMethodFromStore({ methodRow, checklistRows, after, limit }) {
  const { view, records } = recordsOfMethod(methodRow, checklistRows);
  return readAMethod({ method: view, records, after, limit });
}
