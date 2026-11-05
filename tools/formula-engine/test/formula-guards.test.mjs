// Formula evaluation guards (parts/formula-engine/rules/evaluation-guards.mjs): every evaluation, through the Workshop
// tools' row filter (tool:filter-rows-by-rules, tool:evaluate-binding) and the page's evaluator alike, is refused in its
// own words when the formula is too deep, too large, contains itself, compiles an unsafe pattern or is too much work.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import operators from '../rules/rule-operators.json' with { type: 'json' };
import guards from '../rules/evaluation-guards.json' with { type: 'json' };
import { makeRowFilter } from '../rules/filter-rows-by-rules.mjs';
import { loadRowEvaluator } from '../rules/evaluate-over-rows.mjs';
import { inSlices } from '../rules/evaluation-guards.mjs';

const wasm = () => readFileSync(new URL(import.meta.resolve('../built-stored-bytes/evaluate-over-rows/evaluate-over-rows_bg.wasm')));
const engine = makeRowFilter({ operators, wasm });
const select = path => ({ $kind: 'binding', select: { from: 'self', path } });
const refusedAs = guard => error => error.code === 'formula_guard' && error.guard === guard && typeof error.message === 'string' && error.message.length > 0;

test('an ordinary formula still evaluates, and a row filter still filters', async () => {
  assert.equal((await engine.evaluateBinding({ binding: { ...select(['minutes']), transform: [{ op: 'op:core.mul', args: { value: 60 } }] }, input: { minutes: 2 } })).value, '120');
  const answer = await engine.filterRowsByRules({ tree: { kind: 'group', combinator: 'and', rules: [{ kind: 'rule', field: 'n', operator: 'greater_than', params: { value: 1 } }] }, fields: [{ id: 'n', kind: 'number' }], rows: [{ n: 1 }, { n: 2 }, { n: 3 }] });
  assert.deepEqual(answer.matches, [1, 2]);
});

test('too deep, too large and self-containing bindings are refused before the evaluator sees them', async () => {
  let deep = { value: 1 };
  for (let level = 0; level < guards.max_depth + 1; level += 1) deep = { args: deep };
  await assert.rejects(engine.evaluateBinding({ binding: { ...select(['x']), transform: [{ op: 'op:core.coalesce', args: deep }] }, input: {} }), refusedAs('too_deep'));
  const wide = { ...select(['x']), transform: Array.from({ length: guards.max_nodes }, () => ({ op: 'op:core.identity' })) };
  await assert.rejects(engine.evaluateBinding({ binding: wide, input: {} }), refusedAs('too_large'));
  const looped = { ...select(['x']), transform: [{ op: 'op:core.coalesce', args: {} }] };
  looped.transform[0].args.again = looped;
  await assert.rejects(engine.evaluateBinding({ binding: looped, input: {} }), refusedAs('cycle'));
});

test('an unsafe pattern is refused; a safe one runs', async () => {
  const pattern = text => ({ ...select(['name']), transform: [{ op: 'op:core.text_regex_match', args: { pattern: text } }] });
  assert.equal((await engine.evaluateBinding({ binding: pattern('^A'), input: { name: 'Ana' } })).value, true);
  await assert.rejects(engine.evaluateBinding({ binding: pattern('a'.repeat(guards.regex_chars + 1)), input: { name: 'a' } }), refusedAs('unsafe_regex'));
  await assert.rejects(engine.evaluateBinding({ binding: pattern('(a{1000}){1000}'), input: { name: 'a' } }), refusedAs('unsafe_regex'));
});

test('a call whose work is past max_work is refused before it starts, whatever the host clock does', () => {
  const evaluator = loadRowEvaluator(wasm());
  const heavy = { ...select(['n']), transform: Array.from({ length: 1000 }, () => ({ op: 'op:core.identity' })) };
  const rows = Array.from({ length: Math.ceil(guards.max_work / 1000) + 1 }, (_, n) => ({ n }));
  assert.throws(() => evaluator.filterRows(rows, heavy), refusedAs('too_much_work'));
  assert.deepEqual(evaluator.filterRows(rows.slice(0, 3), { ...select(['n']), transform: [{ op: 'op:core.gt', args: { value: 0 } }] }).matches, [1, 2]);
});

test('rows are given a slice at a time, and a call past its time budget stops between slices and is paused', () => {
  const binding = { marker: 'slow-formula' };
  const rows = Array.from({ length: guards.rows_per_slice * 3 }, (_, n) => n);
  const seen = [];
  const answer = inSlices({ marker: 'fast' }, rows, slice => { seen.push(slice.length); return { matches: [0], errorRows: 0, firstError: null }; });
  assert.deepEqual(seen, [guards.rows_per_slice, guards.rows_per_slice, guards.rows_per_slice]);
  assert.deepEqual(answer.matches, [0, guards.rows_per_slice, guards.rows_per_slice * 2]);
  const slices = [];
  assert.throws(() => inSlices(binding, rows, slice => {
    slices.push(slice.length);
    const until = Date.now() + guards.budget_ms + 20;
    while (Date.now() < until) { /* a slice that outruns the budget */ }
    return { matches: [], errorRows: 0, firstError: null };
  }), refusedAs('over_time'));
  assert.equal(slices.length, 1, 'the second slice is never started');
});
