// tools/formulas/do-work/requests.mjs
//
// One function per Workshop row. Each takes the request object a person's AI sent, refuses what it cannot run with a
// sentence that says what to send, and returns the answer. The comparisons are DATA (read-data/rule-operators.json, or the
// `operators` the request brings); no field, comparison or value is named in code.
import { classifyByRules } from './classify-by-rules.mjs';
import { compileRules, ruleVocabulary } from './compile-rules.mjs';
import { evaluateBinding, filterRows, operatorIds } from './evaluate-binding.mjs';
import defaultOperators from '../read-data/rule-operators.json' with { type: 'json' };

const isObject = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const need = (ok, sentence) => { if (!ok) throw new Error(sentence); };
const isPath = value => Array.isArray(value) && value.every(step => typeof step === 'string' || (Number.isInteger(step) && step >= 0));

function operatorsOf(request) {
  const operators = request.operators ?? defaultOperators;
  need(isObject(operators) && Array.isArray(operators.operators) && Array.isArray(operators.combinators), 'operators must be { combinators: [...], operators: [...] }, the shape of read-data/rule-operators.json.');
  need(operators.combinators.length > 0 && operators.combinators.every(row => isObject(row) && typeof row.id === 'string' && operatorIds.includes(row.op)), `every combinator needs an id and an op the evaluator runs (${operatorIds.join(', ')}).`);
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
  const { binding, reads, incomplete } = compileRules(request.tree ?? null, { fields: request.fields, vocabulary: ruleVocabulary(operatorsOf(request)) });
  const { matches, errorRows, firstError } = filterRows(request.records, binding);
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
  need(isObject(request.binding), `binding must be an object like { "$kind": "binding", "select": { "from": "self", "path": [...] }, "transform": [{ "op": ... }] }; the operators are ${operatorIds.join(', ')}.`);
  need(Array.isArray(request.rows), 'rows must be a list of values to evaluate the binding over.');
  const answers = request.rows.map(row => evaluateBinding(request.binding, row));
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
