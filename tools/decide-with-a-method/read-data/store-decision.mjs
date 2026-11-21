// tools/decide-with-a-method/read-data/store-decision.mjs
//
// One decision of the old store, shaped into the records tool:read-a-decisions-worked-steps reads (read-data/read-worked-steps.mjs).
// The caller reads plain rows by its own SQL, shapes them here, and hands the records to the tool as `records`; nothing here reads a store.
// Field citations: the reader's own lines, in this folder: the root's identity field `id` (decision-records.mjs:214-216 with
// read-data/decide-with-a-method.json identity_fields); `refs` and its record (decision-records.mjs:236-243); evidence (decision-records.mjs:381);
// `method_view` (decisions.mjs:77); answers by the key `method-answer:<decision>:<row>` (answer-words.mjs:62-68); method rows and
// the view's sort (method-rows/view.mjs:101-107 and method-rows/store-records.mjs, which shapes the same records for read-a-method). Each store row keeps its own
// columns, and a column that holds JSON text is parsed. The records it returns are the shape recordsIn takes ({ id, type, value }):
//   decision:<id>                     the root, from old_store.w_decision (its columns, `extra` left out)
//   decision-refs:<id>:c<refs>        the refs the root names, from old_store.w_decision_refs (items, step_refs)
//   decision-evidence:<id>:<nnnn>:c<ref>  one evidence row, from old_store.w_decision_evidence (its own id is the key)
//   method-answer:<id>:<row>          one answer, from old_store.w_method_answer (its own id is the key read-data reads by)
//   list:method-rows                  the list the method rows are, from old_store.w_list (`fields` parsed, `row_type` kept)
//   record:method-row:<method>~<row>  one method row, from old_store.method_row, with `order` = its step's place in old_store.method
//   list-view:method-rows:<method>    the saved view the decision's `method_view` names (no table holds it: its rules keep
//                                     every row handed in that has a question, and its sort is `order`, as method-rows/store-records.mjs does)
const parsed = text => {
  if (typeof text !== 'string') return text;
  const first = text.trimStart()[0];
  if (first !== '{' && first !== '[') return text;
  try { return JSON.parse(text); } catch { return text; }
};
// A row's columns as its record value: nulls and the store's `extra` left out, JSON text parsed.
const valueOf = (row, skip = []) => Object.fromEntries(Object.entries(row)
  .filter(([key, value]) => value !== null && value !== undefined && key !== 'extra' && !skip.includes(key))
  .map(([key, value]) => [key, parsed(value)]));
const methodStepsOf = method => parsed(method?.steps) ?? [];
// A method row's step id: its `extra` names it (`{"id": "scope"}`); else the record id's last part, decoded, without its leading slash.
const stepIdOf = row => parsed(row.extra)?.id ?? decodeURIComponent(row.id.slice(row.id.lastIndexOf('~') + 1)).replace(/^\//, '');

/**
 * The records a decision is read from: its root, its answers, and the method it was opened with. `decision` is one row of
 * old_store.w_decision; `refs` the old_store.w_decision_refs row the root's `refs` names; `evidence` the old_store.w_decision_evidence rows of the decision; `answers` the rows of old_store.w_method_answer for it; `methodList` the old_store.w_list row for
 * `list:method-rows`; `methodRows` the old_store.method_row rows of the method; `method` the old_store.method row whose steps
 * give the order of those rows (its `steps` text is parsed).
 */
export function decisionRecordsOfStore({ decision, refs = null, evidence = [], answers = [], methodList, methodRows = [], method = null }) {
  const view = decision.method_view;
  const method_id = view.slice(view.lastIndexOf(':') + 1);
  const order = new Map(methodStepsOf(method).map((step, n) => [step.id, n]));
  const rowRecords = methodRows.map(row => ({ id: row.id, type: 'record:method-row', value: { ...valueOf(row), order: order.get(stepIdOf(row)) ?? null } }));
  return [
    { id: decision.id, type: 'decision', value: valueOf(decision) },
    ...(refs ? [{ id: refs.id, type: 'decision-refs', value: valueOf(refs, ['id']) }] : []),
    ...evidence.map(row => ({ id: row.id, type: 'decision-evidence', value: valueOf(row, ['id']) })),
    ...answers.map(answer => ({ id: answer.id, type: 'method-answer', value: valueOf(answer, ['id', 'decision_id', 'method']) })),
    { id: `list:${methodList.id.slice('list:'.length)}`, type: 'list', value: { row_type: methodList.row_type, fields: parsed(methodList.fields) } },
    ...rowRecords,
    { id: view, type: 'list-view', value: { list_id: methodList.id.slice('list:'.length), view: { id: method_id, label: method?.name ?? method_id, rules: { kind: 'group', combinator: 'and', negate: false, rules: [{ kind: 'rule', field: 'question', operator: 'is_not_empty', params: {} }] }, sort: [{ field: 'order', direction: 'asc' }] } } },
  ];
}
