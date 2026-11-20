// tools/formula-engine: the contains_exactly comparison matches the words as written (case kept), and a row without them does not match.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { initSync, compileRules as engineCompileRules, filterRows as engineFilterRows } from 'trillion-workshop/tools/formula-engine/built-stored-bytes/formula-engine/formula_engine.js';
import operators from 'trillion-workshop/tools/formula-engine/rules/rule-operators.json' with { type: 'json' };

initSync({ module: readFileSync(new URL(import.meta.resolve('trillion-workshop/tools/formula-engine/built-stored-bytes/formula-engine/formula_engine_bg.wasm'))) });
const fields = [{ id: 'notes', kind: 'text' }];
const rule = (field, operator, params = {}) => ({ kind: 'rule', field, operator, params });
const group = (combinator, members, negate = false) => ({ kind: 'group', combinator, negate, rules: members });
const matches = (rows, tree) => engineFilterRows({ rows, binding: engineCompileRules({ tree, fields }).binding }).matches;

test('contains_exactly keeps case: Hello matches in "say Hello", and hello does not match', () => {
  assert.ok(operators.operators.some(o => o.id === 'contains_exactly'));
  assert.deepEqual(matches([{ notes: 'say Hello' }, { notes: 'say hello' }], group('and', [rule('notes', 'contains_exactly', { text: 'Hello' })])), [0]);
});
