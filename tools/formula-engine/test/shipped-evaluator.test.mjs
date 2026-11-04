// tools/formula-engine/test/shipped-evaluator.test.mjs
//
// The evaluator this folder ships (built-stored-bytes/evaluate-over-rows, rebuilt from trillion-rust
// crates/evaluate-over-rows by trillion-apps web/scripts/build-formula-evaluator.mjs) loads from its own bytes the way the
// page's computed columns load it (trillion-apps web/src/workspace/list-targets.ts: loadRowEvaluator, then
// evaluate(binding, context)), answers a rule compiled by rules/compile-rules.mjs for one row, and filters a table.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { loadRowEvaluator } from '../rules/evaluate-over-rows.mjs';
import { compileRules, ruleVocabulary } from '../rules/compile-rules.mjs';

const operators = JSON.parse(readFileSync(new URL('../rules/rule-operators.json', import.meta.url), 'utf8'));
const bytes = new Uint8Array(readFileSync(new URL('../built-stored-bytes/evaluate-over-rows/evaluate-over-rows_bg.wasm', import.meta.url)));
const fields = [{ id: 'amount', label: 'Amount', kind: 'number' }, { id: 'stage', label: 'Stage', kind: 'text' }];
const tree = { kind: 'group', combinator: 'and', negate: false, rules: [{ kind: 'rule', field: 'amount', operator: 'greater_than', params: { value: 5 } }] };

test('the shipped evaluator loads from its bytes and answers one row, as a computed column asks it', () => {
  const evaluator = loadRowEvaluator(bytes);
  const { binding, reads } = compileRules(tree, { fields, vocabulary: ruleVocabulary(operators) });
  assert.deepEqual(reads, ['amount']);
  assert.equal(evaluator.evaluate(binding, { amount: 9 }), true);
  assert.equal(evaluator.evaluate(binding, { amount: 2 }), false);
});

test('the shipped evaluator filters a table of rows by the same rule', () => {
  const evaluator = loadRowEvaluator(bytes);
  const { binding } = compileRules(tree, { fields, vocabulary: ruleVocabulary(operators) });
  assert.deepEqual(evaluator.filterRows([{ amount: 1 }, { amount: 6 }, { amount: null }, { amount: 50 }], binding).matches, [1, 3]);
});
