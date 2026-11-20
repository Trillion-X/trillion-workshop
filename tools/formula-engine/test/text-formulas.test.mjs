// Formulas written as text, compiled by the engine (src/text.rs) into the binding they mean and run like any binding.
// Every function row of rules/text-formulas.json carries one example; each is run here through the shipped engine.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { initSync, evaluate, evaluateFormula, filterRows, compileText } from '../built-stored-bytes/formula-engine/formula_engine.js';

initSync({ module: readFileSync(new URL('../built-stored-bytes/formula-engine/formula_engine_bg.wasm', import.meta.url)) });
const table = JSON.parse(readFileSync(new URL('../rules/text-formulas.json', import.meta.url), 'utf8'));
const run = (text, input = {}) => evaluate({ text, input }).value;

test('every function row gives its example value', () => {
  const names = new Set();
  for (const row of table.functions) {
    for (const name of [row.name, ...(row.aliases ?? [])]) {
      assert.ok(!names.has(name.toUpperCase()), `${name} is named by two rows`);
      names.add(name.toUpperCase());
    }
    assert.deepEqual(run(row.example.text, row.example.row), row.example.value, row.example.text);
  }
  assert.ok(table.functions.length >= 100);
});

test('names read the row at any depth; lambda parameters read their item', () => {
  const order = { price: 5, discount: 1, quantity: 3, cancelled: false, lines: [{ qty: 2 }, { qty: 5 }], tags: ['a', 'b'] };
  assert.equal(run('=price * quantity', order), 15);
  assert.equal(run('(price - discount) * quantity >= 10 && !@.cancelled', order), true);
  assert.equal(run('0.1 + 0.2', {}), 0.3);
  assert.equal(run('7 / 2'), 3.5);
  assert.equal(run('-price + 1', order), -4);
  assert.deepEqual(run('FILTER(lines, |l| => l.qty > quantity)', order), [{ qty: 5 }]);
  assert.equal(run('REDUCE(lines, |sum, l| => sum + l.qty * price, 0)', order), 35);
  assert.deepEqual(run('MAP(lines, |l| => COUNTIF(lines, |m| => m.qty >= l.qty))', order), [2, 1]);
  assert.equal(run('tags[1]', order), 'b');
  assert.equal(run('lines[0].qty', order), 2);
  assert.equal(run('CONCAT(UPPER(tags[0]), "-", TEXT(quantity))', order), 'A-3');
  assert.deepEqual(run('#{ total: price * quantity, many: quantity > 2 }', order), { total: 15, many: true });
  assert.equal(run('lower("ABC")'), 'abc', 'a function name is read in any case');
});

test('a formula that cannot be compiled is refused with what is wrong', () => {
  assert.throws(() => run('price *'), /does not read/);
  assert.throws(() => run('NO_SUCH(1)'), /NO_SUCH is not a function/);
  assert.throws(() => run('ABS(1, 2)'), /ABS takes at most 1 arguments/);
  assert.throws(() => run('FILTER(xs, 3)'), /needs a lambda/);
  assert.throws(() => run('REDUCE(xs, |x| => x, 0)'), /takes 2 parameters/);
  assert.throws(() => run('|x| => x'), /only an argument of a function/);
  assert.throws(() => run('ABS@v2(1)'), /no formula is versioned/);
  assert.throws(() => run('REPLACE("abc", 1, 1, "z")'), /REPLACE is not a function/);
});

test('a text is held to the binding limits before it is parsed', () => {
  const guarded = (text, guard) => assert.throws(() => run(text), error => error.code === 'formula_guard' && error.guard === guard, text.slice(0, 40));
  guarded(`${'('.repeat(100000)}1${')'.repeat(100000)}`, 'too_deep');
  guarded(`${'!'.repeat(100000)}true`, 'too_deep');
  guarded(Array.from({ length: 3000 }, () => '1').join(' + '), 'too_large');
  assert.equal(run(Array.from({ length: 300 }, () => '1').join(' + ')), 300, 'a long chain is walked, not recursed');
  guarded(Array.from({ length: 1500 }, () => '1').join(' + '), 'too_large'); // compiled, then past the binding's max_nodes
  assert.equal(run(`${'('.repeat(40)}2${')'.repeat(40)} * 3`), 6);
  assert.equal(run('-(-3)'), 3);
});

test('text works wherever a binding does, over many rows', () => {
  const rows = [{ price: 2, quantity: 3 }, { price: 10, quantity: 1 }, { price: 1, quantity: 1 }];
  assert.deepEqual(filterRows({ rows, text: 'price * quantity > 5' }).matches, [0, 1]);
  assert.deepEqual(evaluateFormula({ rows, text: 'price * quantity' }).values, [6, 10, 1]);
  const { binding } = compileText({ text: 'price * quantity' });
  assert.equal(binding.$kind, 'binding');
  assert.deepEqual(binding.select, { from: 'context', path: ['price'] });
  assert.deepEqual(evaluateFormula({ rows, binding }).values, [6, 10, 1]);
  assert.deepEqual(filterRows({ rows, binding: { $kind: 'binding', select: { from: 'self', path: ['quantity'] }, transform: [{ op: 'op:core.eq', args: { value: 1 } }] } }).matches, [1, 2]);
});
