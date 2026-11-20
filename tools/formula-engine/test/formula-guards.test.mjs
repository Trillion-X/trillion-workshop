// Formula evaluation guards (crates/formula-engine/src/guards.rs, limits in rules/evaluation-guards.json): every
// evaluation, through the Workshop tools' row filter (tool:filter-rows-by-rules, tool:evaluate-a-formula) and a page's
// calls alike, is refused in its own words when the formula is too deep, too large, contains itself, compiles an unsafe
// pattern or is too much work. The slicing by the clock is proven inside the crate with a clock it is handed
// (guards.rs a_call_past_its_budget_stops_between_slices_and_its_formula_is_paused).
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import guards from '../rules/evaluation-guards.json' with { type: 'json' };
import { initSync, evaluate, filterRecords, filterRows } from '../built-stored-bytes/formula-engine/formula_engine.js';

initSync({ module: readFileSync(new URL('../built-stored-bytes/formula-engine/formula_engine_bg.wasm', import.meta.url)) });
const engine = {
  evaluateBinding: async request => evaluate(request),
  filterRowsByRules: async ({ tree, fields, rows }) => filterRecords({ records: rows, fields, tree }),
};
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
  const evaluator = { filterRows: (rows, binding) => filterRows({ rows, binding }) };
  const heavy = { ...select(['n']), transform: Array.from({ length: 1000 }, () => ({ op: 'op:core.identity' })) };
  const rows = Array.from({ length: Math.ceil(guards.max_work / 1000) + 1 }, (_, n) => ({ n }));
  assert.throws(() => evaluator.filterRows(rows, heavy), refusedAs('too_much_work'));
  assert.deepEqual(evaluator.filterRows(rows.slice(0, 3), { ...select(['n']), transform: [{ op: 'op:core.gt', args: { value: 0 } }] }).matches, [1, 2]);
});

test('a binding the guards refuse never reaches the evaluator, in filterRows and filterRecords alike', () => {
  const deep = { $kind: 'binding', select: { from: 'self', path: ['x'] }, transform: [{ op: 'op:core.text_regex_match', args: { pattern: 'a{1000}' } }] };
  assert.throws(() => filterRows({ rows: [{ x: 'a' }], binding: deep }), refusedAs('unsafe_regex'));
  assert.equal(guards.rows_per_slice > 0 && guards.budget_ms > 0, true, 'the slicing limits are data the engine reads');
});
