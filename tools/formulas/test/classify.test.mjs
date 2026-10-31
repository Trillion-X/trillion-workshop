// tools/formulas: classify a record by a person's rules, on made-up bakery orders.
import test from 'node:test';
import assert from 'node:assert/strict';
import { classifyByRules } from '../do-work/classify-by-rules.mjs';

const NOW = Date.parse('2026-07-05T12:00:00Z');
const facts = [
  { key: 'collected', path: ['collected_at'], as: 'present' },
  { key: 'loaves', path: ['loaves'], as: 'number' },
  { key: 'waiting', path: ['ordered_at'], as: 'age-seconds' },
  { key: 'kind', path: ['kind'], as: 'value' },
];
const rules = [
  { key: 'forgotten', label: 'Forgotten', tone: 'alarm', severity: 'high', requires: [{ fact: 'collected', op: 'absent' }, { fact: 'waiting', op: 'gte', value: 1800 }] },
  { key: 'empty', label: 'Nothing baked', tone: ' soft ', requires: [{ fact: 'collected', op: 'present' }, { fact: 'loaves', op: 'lte', value: 0 }] },
  { key: 'standing', label: 'Standing order', requires: [{ fact: 'kind', op: 'eq', value: 'standing' }] },
  { key: 'done', label: 'Done', tone: 'good', severity: 'low', requires: [{ fact: 'collected', op: 'present' }] },
];
const classify = record => classifyByRules({ facts, rules, record, now_ms: NOW }).result;

test('the first rule whose clauses all hold answers, with the tone and severity the rule carries (trimmed) or null', () => {
  assert.deepEqual(classify({ ordered_at: '2026-07-05T10:00:00Z' }), { key: 'forgotten', label: 'Forgotten', tone: 'alarm', severity: 'high' });
  assert.deepEqual(classify({ ordered_at: '2026-07-05T11:59:00Z', collected_at: 'x', loaves: 0 }), { key: 'empty', label: 'Nothing baked', tone: 'soft', severity: null });
  assert.deepEqual(classify({ ordered_at: '2026-07-05T11:59:00Z', kind: 'standing', loaves: 3 }), { key: 'standing', label: 'Standing order', tone: null, severity: null });
  assert.equal(classify({ ordered_at: '2026-07-05T11:59:00Z', collected_at: 'x', loaves: 12 }).key, 'done');
  assert.equal(classify({ ordered_at: '2026-07-05T11:59:00Z', loaves: 12 }), null);
});

test('present means a true flag, a number above zero, non-blank text or a non-empty list or object; missing values read as zero or absent', () => {
  const present = value => classifyByRules({ facts: [{ key: 'v', path: ['v'], as: 'present' }], rules: [{ key: 'p', label: 'P', requires: [{ fact: 'v', op: 'present' }] }], record: { v: value } }).result !== null;
  assert.deepEqual([true, 1, 'a', [0], { k: 1 }].map(present), [true, true, true, true, true]);
  assert.deepEqual([false, 0, -1, '  ', [], {}, null, undefined].map(present), [false, false, false, false, false, false, false, false]);
  assert.equal(classify({}), null);   // no timestamp: age 0, below the limit
  assert.equal(classify({ ordered_at: 'not a date' }), null);
});

test('numbers read from numeric text, gte and lte need numbers on both sides, eq compares numbers by value and everything else exactly', () => {
  const one = (as, op, value, raw) => classifyByRules({ facts: [{ key: 'v', path: ['v'], as }], rules: [{ key: 'r', label: 'R', requires: [{ fact: 'v', op, value }] }], record: { v: raw } }).result !== null;
  assert.equal(one('number', 'gte', 2, ' 2.0 '), true);
  assert.equal(one('value', 'gte', 2, 'many'), false);
  assert.equal(one('value', 'lte', 'x', 1), false);
  assert.equal(one('value', 'eq', 2, '2'), true);
  assert.equal(one('value', 'eq', 'a', 'a'), true);
  assert.equal(one('value', 'eq', null, null), true);
  assert.equal(one('value', 'eq', ['a'], ['a']), true);
  assert.equal(one('value', 'eq', undefined, 'a'), false);
});

test('a path reaches into objects and list positions; age is whole seconds from a number of milliseconds and never negative', () => {
  const age = (raw, now) => classifyByRules({ facts: [{ key: 'a', path: ['t', 0, 'at'], as: 'age-seconds' }], rules: [{ key: 'old', label: 'Old', requires: [{ fact: 'a', op: 'gte', value: 2 }] }], record: { t: [{ at: raw }] }, now_ms: now }).result !== null;
  assert.equal(age(1000, 3500), true);    // 2.5 s rounds to 3
  assert.equal(age(1000, 2400), false);   // 1.4 s rounds to 1
  assert.equal(age(9000, 1000), false);   // in the future: 0
  const second = classifyByRules({ facts: [{ key: 'k', path: ['items', '1'], as: 'value' }], rules: [{ key: 'r', label: 'R', requires: [{ fact: 'k', op: 'eq', value: 'b' }] }], record: { items: ['a', 'b'] } });
  assert.equal(second.result.key, 'r');
});

test('an unfinished request is refused with a sentence that says what to send', () => {
  const ask = patch => () => classifyByRules({ facts, rules, record: {}, now_ms: NOW, ...patch });
  assert.throws(() => classifyByRules(null), /Send an object/);
  assert.throws(ask({ record: [] }), /record must be/);
  assert.throws(ask({ facts: [{ key: 'a', as: 'average' }] }), /facts must be a list/);
  assert.throws(ask({ facts: [...facts, facts[0]] }), /share a key/);
  assert.throws(ask({ rules: [{ key: 'r', label: 'R', requires: [] }] }), /every rule needs/);
  assert.throws(ask({ rules: [{ key: 'r', label: ' ', requires: [{ fact: 'kind', op: 'eq', value: 1 }] }] }), /every rule needs/);
  assert.throws(ask({ rules: [{ key: 'r', label: 'R', requires: [{ fact: 'kind', op: 'between' }] }] }), /op is not one of present, absent, gte, lte, eq/);
  assert.throws(ask({ rules: [{ key: 'r', label: 'R', requires: [{ fact: 'ghost', op: 'present' }] }] }), /"ghost", which facts does not declare/);
  assert.throws(ask({ now_ms: undefined }), /age-seconds needs now_ms/);
  assert.throws(ask({ now_ms: 'noon' }), /now_ms must be a number/);
  assert.deepEqual(classifyByRules({ facts: [], rules: [], record: {} }), { result: null });
});
