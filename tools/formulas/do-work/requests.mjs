// tools/formulas/do-work/requests.mjs
//
// One function per Workshop row. Each takes the request object a person's AI sent, refuses what it cannot run with a
// sentence that says what to send, and returns the answer. The comparisons are DATA (the formula engine's
// rule-operators.json, or the `operators` the request brings); no field, comparison or value is named in code. The formula
// engine (tools/formula-engine: its rule compiler and the ops-core evaluator built to WebAssembly) decides every row; this
// file keeps no evaluator of its own.
import { readFileSync } from 'node:fs';
import { classifyByRules } from './classify-by-rules.mjs';
import { compileRules, ruleVocabulary } from 'trillion-workshop/tools/formula-engine/rules/compile-rules.mjs';
import { loadRowEvaluator } from 'trillion-workshop/tools/formula-engine/rules/evaluate-over-rows.mjs';
import { checkHistoryFields, fieldHistoryOf, historyValues } from '../read-data/list-value-history.mjs';
import defaultOperators from 'trillion-workshop/tools/formula-engine/rules/rule-operators.json' with { type: 'json' };

const isObject = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const need = (ok, sentence) => { if (!ok) throw new Error(sentence); };
const isPath = value => Array.isArray(value) && value.every(step => typeof step === 'string' || (Number.isInteger(step) && step >= 0));

// Loaded on the first rule or formula, so a history request never reads the engine's bytes.
let evaluator = null;
const engine = () => (evaluator ??= loadRowEvaluator(readFileSync(new URL(import.meta.resolve('trillion-workshop/tools/formula-engine/built-stored-bytes/evaluate-over-rows/evaluate-over-rows_bg.wasm')))));

// Every group names a combinator the vocabulary holds: a group is never joined by a guess.
function checkCombinators(node, operators) {
  if (!isObject(node) || node.kind !== 'group') return;
  const ids = operators.combinators.map(row => row.id);
  need(ids.includes(node.combinator), `a group's combinator ${JSON.stringify(node.combinator ?? null)} is not one of ${ids.join(', ')}; a group is never joined by a guess.`);
  for (const member of node.rules || []) checkCombinators(member, operators);
}

function operatorsOf(request) {
  const operators = request.operators ?? defaultOperators;
  need(isObject(operators) && Array.isArray(operators.operators) && Array.isArray(operators.combinators), 'operators must be { combinators: [...], operators: [...] }, the shape of the formula engine\'s rule-operators.json.');
  const joins = [...new Set(defaultOperators.combinators.map(row => row.op))];
  need(operators.combinators.length > 0 && operators.combinators.every(row => isObject(row) && typeof row.id === 'string' && joins.includes(row.op)), `every combinator needs an id and an op the formula engine joins rules with (${joins.join(', ')}).`);
  need(operators.operators.every(row => isObject(row) && typeof row.id === 'string' && Array.isArray(row.applies_to) && isObject(row.binding ?? row.parts?.[0]?.binding)), 'every comparison needs an id, applies_to and a binding (or parts).');
  return operators;
}

/** The rows of a list that a person's rule tree keeps, with the rules it could not use. */
export function filterRecords(request) {
  need(isObject(request), 'Send an object with records, fields and a rule tree.');
  need(Array.isArray(request.records) && request.records.every(isObject), 'records must be a list of objects.');
  need(Array.isArray(request.fields) && request.fields.every(field => isObject(field) && typeof field.id === 'string' && typeof field.kind === 'string' && (field.path === undefined || isPath(field.path))), 'fields must be a list of { id, kind, path? }, path being a list of keys and positions into a record (the id by default).');
  need(new Set(request.fields.map(field => field.id)).size === request.fields.length, 'two fields share an id; each field id must be its own.');
  need(request.tree === undefined || request.tree === null || isObject(request.tree), 'tree must be a group { kind: "group", combinator, negate, rules } or a rule { kind: "rule", field, operator, params }.');
  const operators = operatorsOf(request);
  checkCombinators(request.tree, operators);
  const { binding, reads, incomplete } = compileRules(request.tree ?? null, { fields: request.fields, vocabulary: ruleVocabulary(operators) });
  const { matches, errorRows, firstError } = engine().filterRows(request.records, binding);
  return {
    total: request.records.length,
    matches,
    records: matches.map(at => request.records[at]),
    reads,
    incomplete,
    error_rows: errorRows,
    first_error: firstError,
  };
}

/** One binding evaluated over each row: the value or the error it gave. */
export function evaluateFormula(request) {
  need(isObject(request), 'Send an object with a binding and rows.');
  need(isObject(request.binding), 'binding must be an object like { "$kind": "binding", "select": { "from": "self", "path": [...] }, "transform": [{ "op": ... }] }, the ops being the formula engine\'s (op:core.*).');
  need(Array.isArray(request.rows), 'rows must be a list of values to evaluate the binding over.');
  const answers = request.rows.map(row => {
    try {
      return { value: engine().evaluate(request.binding, row), error: null };
    } catch (error) {
      return { value: null, error: error.message };
    }
  });
  const errors = answers.flatMap(({ error }, at) => (error === null ? [] : [{ row: at, error }]));
  return { values: answers.map(({ value, error }) => (error === null ? value : null)), errors };
}

/** The comparisons and combinators on offer, for one kind of field or all. */
export function listComparisons(request) {
  need(isObject(request), 'Send an object; field_kind is optional.');
  need(request.field_kind === undefined || typeof request.field_kind === 'string', 'field_kind must be text.');
  const operators = operatorsOf(request);
  const kinds = [...new Set(operators.operators.flatMap(row => row.applies_to))];
  return {
    combinators: operators.combinators.map(({ id, label, sentence }) => ({ id, label, sentence })),
    comparisons: operators.operators
      .filter(row => request.field_kind === undefined || row.applies_to.includes(request.field_kind))
      .map(({ id, label, input, applies_to: appliesTo }) => ({ id, label, input, applies_to: appliesTo })),
    field_kinds: kinds,
  };
}

/** The label of the first of a person's rules that holds for a record. */
export function classifyRecord(request) {
  return classifyByRules(request);
}

/**
 * The values of a row's history fields, worked out from the steps its history-keeping fields kept
 * (read-data/list-value-history.mjs, moved from old trillion src/list-value-history.mjs): value_at, previous_value,
 * value_set_at, time_spent_in, has_been_in. With list and row_id and field_id instead, one field's history as lines a
 * person reads. now_ms is the moment the answers are as of.
 */
export function historyFieldValues(request) {
  need(isObject(request), 'Send an object with fields (history fields) and kept (the row, with its _history).');
  need(Array.isArray(request.fields) && request.fields.every(field => isObject(field) && typeof field.id === 'string'), 'fields must be a list of { id, kind: "history", history: { field, op, value?, at?, days_ago?, unit? } }.');
  need(Number.isFinite(request.now_ms), 'now_ms must be the moment, in milliseconds, the answers are as of.');
  const fields = request.fields.map(field => ({ kind: 'history', ...field }));
  if (request.check !== false) checkHistoryFields([...(request.kept_fields ?? fields.map(field => ({ id: field.history?.field, keeps_history: true }))), ...fields]);
  return { values: historyValues(isObject(request.kept) ? request.kept : null, fields, request.now_ms) };
}

/** One field's history of one row as lines a person reads: who changed it, by which road, from when until when. */
export function fieldHistory(request) {
  need(isObject(request) && isObject(request.list) && Array.isArray(request.list.fields), 'Send list { fields }, row_id, field_id and kept (the row, with its _history).');
  return fieldHistoryOf(request.list, request.list.id ?? null, request.row_id ?? null, isObject(request.kept) ? request.kept : null, request.field_id);
}
