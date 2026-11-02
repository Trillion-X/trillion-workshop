// tools/formulas: the binding evaluator's three-state logic, comparisons, errors and path safety.
import test from 'node:test';
import assert from 'node:assert/strict';
import { evaluateBinding, filterRows, operatorIds } from '../do-work/evaluate-binding.mjs';

const at = (path, ...transform) => ({ $kind: 'binding', select: { from: 'self', path }, transform });
const value = (binding, input) => evaluateBinding(binding, input).value;
const group = (op, members, negate = false) => ({ $kind: 'binding', select: { from: 'self' }, transform: [{ op, args: { values: members } }, ...(negate ? [{ op: 'op:core.not' }] : [])] });
const gt = limit => at(['n'], { op: 'op:core.gt', args: { value: limit } });

test('and and or are three-state; not of unknown stays unknown', () => {
  const unknown = { n: null };
  assert.equal(value(group('op:core.and', [gt(1), gt(1)]), unknown), null);
  assert.equal(value(group('op:core.and', [gt(1), at(['n'], { op: 'op:core.is_null' })]), unknown), null);
  assert.equal(value(group('op:core.and', [at(['n'], { op: 'op:core.is_null' }), at(['n'], { op: 'op:core.is_null' })]), unknown), true);
  assert.equal(value(group('op:core.and', [gt(1), at(['n'], { op: 'op:core.is_null' }, { op: 'op:core.not' })]), unknown), false);
  assert.equal(value(group('op:core.or', [gt(1), at(['n'], { op: 'op:core.is_null' }, { op: 'op:core.not' })]), unknown), null);
  assert.equal(value(group('op:core.or', [gt(1), gt(1)], true), unknown), null);
  assert.equal(value(group('op:core.and', []), {}), true);
  assert.equal(value(group('op:core.or', []), {}), false);
  assert.deepEqual(filterRows([{ n: 5 }, { n: 0 }, { n: null }], group('op:core.and', [gt(1)], true)).matches, [1]);
});

test('and stops at the first false before it looks at a later value of the wrong kind', () => {
  assert.equal(evaluateBinding(group('op:core.and', [at(['a']), at(['b'])]), { a: false, b: 'x' }).error, null);
  assert.match(evaluateBinding(group('op:core.and', [at(['a']), at(['b'])]), { a: 'x', b: false }).error, /and: expected boolean or null/);
});

test('comparisons: unknown side is unknown, kinds must agree, strings compare by code point', () => {
  assert.equal(value(gt(1), { n: null }), null);
  assert.equal(value(gt(1), {}), null);
  assert.equal(value(gt(1), { n: 2 }), true);
  assert.equal(value(at(['s'], { op: 'op:core.lt', args: { value: 'b' } }), { s: 'a' }), true);
  assert.equal(value(at(['s'], { op: 'op:core.gt', args: { value: '\u{1F35E}' } }), { s: '～' }), false);
  assert.equal(value(at(['s'], { op: 'op:core.ge', args: { value: false } }), { s: true }), true);
  assert.match(evaluateBinding(at(['s'], { op: 'op:core.gt', args: { value: 1 } }), { s: 'a' }).error, /comparable types/);
  assert.equal(value(at(['a'], { op: 'op:core.eq', args: { value: [1, { k: 'x' }] } }), { a: [1, { k: 'x' }] }), true);
  assert.equal(value(at(['a'], { op: 'op:core.eq', args: { value: null } }), {}), true);
});

test('lists and text', () => {
  assert.equal(value(at(['l'], { op: 'op:core.index_of', args: { value: 'b' } }), { l: ['a', 'b'] }), 1);
  assert.equal(value(at(['l'], { op: 'op:core.index_of', args: { value: 'z' } }), { l: [] }), -1);
  assert.equal(value(at(['l'], { op: 'op:core.index_of', args: { value: 'z' } }), {}), null);
  assert.match(evaluateBinding(at(['l'], { op: 'op:core.index_of', args: { value: 'z' } }), { l: 'text' }).error, /array or null/);
  assert.equal(value(at(['k'], { op: 'op:core.in_list', args: { values: ['x', 'y'] } }), { k: 'y' }), true);
  assert.equal(value(at(['k'], { op: 'op:core.in_list', args: { values: ['x'] } }), { k: null }), false);
  assert.equal(value(at(['l'], { op: 'op:core.join', args: { delimiter: '|' } }), { l: ['a', 2, null, true] }), 'a|2||true');
  assert.equal(value(at(['t'], { op: 'op:core.lower' }, { op: 'op:core.starts_with', args: { prefix: 'ab' } }), { t: 'ABc' }), true);
  assert.equal(value(at(['t'], { op: 'op:core.lower' }), { t: null }), null);
  assert.match(evaluateBinding(at(['t'], { op: 'op:core.lower' }), { t: 3 }).error, /lower: expected string or null/);
});

test('is_empty holds for unknown, empty text, empty lists, false and zero', () => {
  for (const [input, expected] of [[{}, true], [{ x: '' }, true], [{ x: [] }, true], [{ x: 0 }, true], [{ x: 'a' }, false], [{ x: [0] }, false]]) {
    assert.equal(value(at(['x'], { op: 'op:core.is_empty' }), input), expected);
  }
});

test('a nested binding that errors is an unknown value; the top binding that errors is an error', () => {
  const nested = group('op:core.or', [at(['s'], { op: 'op:core.gt', args: { value: 1 } }), at(['ok'])]);
  assert.equal(evaluateBinding(nested, { s: 'a', ok: true }).value, true);
  assert.equal(evaluateBinding(nested, { s: 'a', ok: false }).value, null);
  const outcome = filterRows([{ s: 'a' }, { s: 4 }], at(['s'], { op: 'op:core.gt', args: { value: 1 } }));
  assert.deepEqual([outcome.matches, outcome.errorRows], [[1], 1]);
  assert.match(outcome.firstError, /comparable types/);
});

test('a literal, a default and an unsupported operator', () => {
  assert.equal(value({ $kind: 'binding', select: { from: 'literal', value: 'Hi' }, transform: [{ op: 'op:core.lower' }] }, null), 'hi');
  assert.equal(value({ ...at(['x']), default: 'none' }, {}), 'none');
  assert.match(evaluateBinding({ $kind: 'binding', transform: [{ op: 'op:core.add' }] }, 1).error, /operator not supported: op:core\.add/);
  assert.match(evaluateBinding({ $kind: 'binding', select: { from: 'vars', key: 'a' } }, 1).error, /not read here/);
  assert.match(evaluateBinding({ select: {} }, 1).error, /\$kind/);
  assert.equal(operatorIds.length, 19);
});

test('a path stays inside the row', () => {
  assert.equal(value(at(['__proto__']), { a: 1 }), null);
  assert.equal(value(at(['constructor', 'name']), {}), null);
  assert.equal(value(at(['l', 1, 'k']), { l: [{ k: 1 }, { k: 2 }] }), 2);
  assert.equal(value(at(['l', 5]), { l: [] }), null);
  assert.equal(value(at(['a', 'b']), { a: 'text' }), null);
  assert.match(evaluateBinding(at([{}]), {}).error, /whole-number positions/);
});

test('coalesce, if and text_concat build a value from fields with the engine operators\' semantics', () => {
  const lit = v => ({ $kind: 'binding', select: { from: 'literal', value: v } });
  const self = (...transform) => ({ $kind: 'binding', select: { from: 'self' }, transform });
  assert.equal(value(self({ op: 'op:core.coalesce', args: { values: [at(['a']), at(['b']), lit('c')] } }), { b: 'second' }), 'second');
  assert.equal(value(self({ op: 'op:core.coalesce', args: { values: [at(['a'])] } }), {}), null);
  assert.equal(value(self({ op: 'op:core.coalesce', args: { values: [at(['a']), lit('x')] } }), { a: '' }), '', 'an empty text is a value, not unknown');
  assert.equal(value(at(['f'], { op: 'op:core.if', args: { then: 'yes', else: 'no' } }), { f: true }), 'yes');
  assert.equal(value(at(['f'], { op: 'op:core.if', args: { then: 'yes' } }), { f: false }), null);
  assert.match(evaluateBinding(at(['f'], { op: 'op:core.if', args: { then: 1, else: 2 } }), { f: null }).error, /if: expected boolean, got null/);
  assert.match(evaluateBinding(at(['f'], { op: 'op:core.if', args: { then: 1, else: 2 } }), { f: 'x' }).error, /if: expected boolean, got string/);
  assert.equal(value(self({ op: 'op:core.text_concat', args: { values: [at(['a']), lit('-'), at(['b'])] } }), { a: 'x' }), 'x-');
  assert.equal(value(self({ op: 'op:core.text_concat', args: { values: [] } }), {}), '');
  assert.match(evaluateBinding(self({ op: 'op:core.text_concat', args: { values: [at(['n'])] } }), { n: 1 }).error, /concat: expected string or null, got number/);

  // A display name: the nickname, else the first part, then " · part" for each later part that is set.
  const joiner = field => at([field], { op: 'op:core.is_empty' }, { op: 'op:core.if', args: { then: null, else: ' · ' } });
  const parts = self({ op: 'op:core.text_concat', args: { values: [at(['one']), joiner('two'), at(['two']), joiner('three'), at(['three'])] } });
  const name = self({ op: 'op:core.coalesce', args: { values: [at(['nickname']), parts] } });
  assert.equal(value(name, { one: 'Alpha', two: 'beta-2', three: 'Gamma box' }), 'Alpha · beta-2 · Gamma box');
  assert.equal(value(name, { one: 'Alpha', three: 'Gamma box' }), 'Alpha · Gamma box');
  assert.equal(value(name, { one: 'Alpha' }), 'Alpha');
  assert.equal(value(name, { nickname: 'My helper', one: 'Alpha' }), 'My helper');
  assert.equal(value(name, {}), '');
});
