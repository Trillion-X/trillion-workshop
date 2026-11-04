// packages/formula-engine/rules/filter-records.mjs
//
// Purpose
//   Filter a list a host already holds (the posts on a schedule, a table on a
//   page) with a person's rule tree, in one call. Compiles the tree with
//   compile-rules.mjs, reads only the fields the rules name, and lets the row
//   evaluator decide. The host describes each field once: its id, its kind and
//   how to read its value from one of its records.
//
// Non-negotiable invariants
//   - The evaluator decides every match; this file only reads values.
//   - A tree that constrains nothing returns the records unchanged.
//   - A value the host cannot read is null, which no comparison matches
//     (the engine's comparisons treat an unknown as unknown, never as a match).
//   - A row the evaluator cannot decide is left out, never kept by default.

import {compileRules, ruleVocabulary} from './compile-rules.mjs';
import {loadRowEvaluator} from './evaluate-over-rows.mjs';

/**
 * @param {{operators: object, wasmBytes: BufferSource}} setup
 * @returns {(records: object[], tree: object, fields: {id: string, kind: string, value: (record: object) => unknown}[]) => object[]}
 */
export function createRecordFilter({operators, wasmBytes}) {
  const vocabulary = ruleVocabulary(operators);
  const evaluator = loadRowEvaluator(wasmBytes);
  return (records, tree, fields) => {
    const {binding, reads} = compileRules(tree, {fields, vocabulary});
    if (!binding) return records;
    const read = fields.filter(field => reads.includes(field.id));
    const rows = records.map(record => Object.fromEntries(read.map(field => [field.id, field.value(record) ?? null])));
    // A row the evaluator could not decide (a value of the wrong shape) is
    // left out, the same as a row that does not match.
    const {matches} = evaluator.filterRows(rows, binding);
    return matches.map(index => records[index]);
  };
}
