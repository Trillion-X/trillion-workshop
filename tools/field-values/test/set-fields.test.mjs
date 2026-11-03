// tools/field-values: rules that set fields on made-up card transactions of a made-up bakery.
import test from 'node:test';
import assert from 'node:assert/strict';
import { setFields } from '../do-work/requests.mjs';

const fields = [
  { id: 'merchant', kind: 'text', path: ['merchant'] },
  { id: 'amount', kind: 'number', path: ['amount'] },
  { id: 'account', kind: 'choice', path: ['account'] },
  { id: 'category', kind: 'choice', path: ['category'] },
  { id: 'memo', kind: 'text', path: ['memo'] },
];
const rule = (field, operator, params) => ({ kind: 'rule', field, operator, params });
const flour = rule('merchant', 'contains', { text: 'flour' });
const big = rule('amount', 'greater_than', { value: 500 });
const provenance = { path: ['_stamps'], kind_key: 'class', by_key: 'by' };
const rows = () => [
  { id: 't1', merchant: 'North Flour Mill', amount: 120, account: 'card-1' },
  { id: 't2', merchant: 'North Flour Mill', amount: 900, account: 'card-1' },
  { id: 't3', merchant: 'Oven Parts Co', amount: 80, account: 'card-2', category: 'Repairs', _stamps: { category: { class: 'person', by: 'owner' } } },
  { id: 't4', merchant: 'Corner Flour Shop', amount: 40, account: 'card-2', category: 'Snacks' },
];
const groups = [
  { id: 'specific', rules: [
    { id: 'big-flour', when: { kind: 'group', combinator: 'and', negate: false, rules: [flour, big] }, set: [{ field: 'category', value: 'Bulk ingredients' }, { field: 'memo', value: 'check the invoice' }] },
    { id: 'flour', when: flour, set: [{ field: 'category', value: 'Ingredients' }] },
  ] },
  { id: 'fallback', rules: [{ id: 'everything', set: [{ field: 'category', value: 'Uncategorised' }] }] },
];

test('the first rule in group order that matches a row sets each field; later rules that set the same field are shadowed', () => {
  const answer = setFields({ records: rows(), fields, groups, provenance, id_path: ['id'] });
  const set = Object.fromEntries(answer.changes.filter(change => change.field === 'category').map(change => [change.id, [change.to, change.rule]]));
  assert.deepEqual(set.t1, ['Ingredients', 'flour']);
  assert.deepEqual(set.t2, ['Bulk ingredients', 'big-flour']);
  assert.deepEqual(answer.changes.find(change => change.field === 'memo'), { row: 1, id: 't2', field: 'memo', from: null, to: 'check the invoice', rule: 'big-flour', group: 'specific', reason: 'set' });
  assert.ok(answer.shadowed.some(item => item.id === 't2' && item.rule === 'flour' && item.by_rule === 'big-flour'));
  assert.ok(answer.shadowed.some(item => item.id === 't1' && item.rule === 'everything' && item.by_rule === 'flour'));
});

test('a value a person set is held, naming them; a value with no known source holds by the default precedence and yields when it says so', () => {
  const held = setFields({ records: rows(), fields, groups, provenance, id_path: ['id'] });
  assert.deepEqual(held.held.find(item => item.id === 't3'), { row: 2, id: 't3', field: 'category', value: 'Repairs', held_by: { kind: 'person', by: 'owner' }, rule: 'everything', would_set: 'Uncategorised' });
  assert.equal(held.held.find(item => item.id === 't4').held_by.kind, null);
  assert.ok(!held.changes.some(change => change.id === 't4' && change.field === 'category'));
  const precedence = { kinds: [{ id: 'person' }, { id: 'rule' }], same_kind_order: [], unknown_source: 'yields', confidence_words: {} };
  const yields = setFields({ records: rows(), fields, groups, provenance, id_path: ['id'], precedence });
  assert.deepEqual(yields.changes.find(change => change.id === 't4' && change.field === 'category').to, 'Ingredients');
  assert.ok(yields.held.some(item => item.id === 't3'));
});

test('each changed row comes back whole with the value written at its path and the rule kept as its source', () => {
  const answer = setFields({ records: rows(), fields, groups, provenance, id_path: ['id'] });
  const t2 = answer.rows.find(row => row.id === 't2');
  assert.deepEqual(t2.fields, ['category', 'memo']);
  assert.equal(t2.record.category, 'Bulk ingredients');
  assert.deepEqual(t2.record._stamps, { category: { class: 'rule', by: 'big-flour' }, memo: { class: 'rule', by: 'big-flour' } });
  assert.equal(t2.record.merchant, 'North Flour Mill');
  assert.equal(rows()[1].category, undefined, 'the rows handed in are not changed');
});

test('the preview says per rule how many rows it matches, changes, finds already set and cannot change', () => {
  const answer = setFields({ records: rows(), fields, groups, provenance, id_path: ['id'] });
  const flourRule = answer.rules.find(summary => summary.rule === 'flour');
  assert.deepEqual([flourRule.matches, flourRule.changes, flourRule.held, flourRule.shadowed], [[0, 1, 3], 1, 1, 1]);
  const everything = answer.rules.find(summary => summary.rule === 'everything');
  assert.deepEqual([everything.matches.length, everything.changes, everything.held, everything.shadowed], [4, 0, 1, 3]);
  const again = setFields({ records: answer.rows.reduce((list, row) => { list[row.row] = row.record; return list; }, rows()), fields, groups, provenance, id_path: ['id'] });
  assert.equal(again.changes.length, 0, 'running the rules again over their own output changes nothing');
  assert.equal(again.rules.find(summary => summary.rule === 'flour').already, 1);
});

test('a field a rule set goes back to empty when no rule sets it any more, so taking a rule away undoes what it alone did', () => {
  const first = setFields({ records: rows(), fields, groups, provenance, id_path: ['id'] });
  const written = first.rows.reduce((list, row) => { list[row.row] = row.record; return list; }, rows());
  const withoutMemoRule = [{ id: 'specific', rules: [{ id: 'flour', when: flour, set: [{ field: 'category', value: 'Ingredients' }] }] }];
  const answer = setFields({ records: written, fields, groups: withoutMemoRule, provenance, id_path: ['id'] });
  const memo = answer.changes.find(change => change.field === 'memo');
  assert.deepEqual([memo.id, memo.from, memo.to, memo.rule, memo.reason], ['t2', 'check the invoice', null, 'big-flour', 'rule removed']);
  const category = answer.changes.find(change => change.id === 't2' && change.field === 'category');
  assert.deepEqual([category.from, category.to, category.rule], ['Bulk ingredients', 'Ingredients', 'flour']);
  assert.deepEqual(answer.rows.find(row => row.id === 't2').record._stamps, { category: { class: 'rule', by: 'flour' } });
});

test('a value can come from another field of the row, and an unfinished rule sets nothing and is named', () => {
  const answer = setFields({
    records: rows(), fields, id_path: ['id'],
    groups: [{ id: 'g', rules: [
      { id: 'copy-account', when: big, set: [{ field: 'memo', from: ['account'] }] },
      { id: 'broken', when: rule('amount', 'contains', { text: 'x' }), set: [{ field: 'memo', value: 'never' }] },
    ] }],
  });
  assert.deepEqual(answer.changes.map(change => [change.id, change.to]), [['t2', 'card-1']]);
  assert.equal(answer.incomplete.length, 1);
  assert.equal(answer.incomplete[0].rule, 'broken');
  assert.deepEqual(answer.rules.find(summary => summary.rule === 'broken').matches, []);
});

test('requests that cannot be run are refused with a sentence saying what to send', () => {
  assert.throws(() => setFields({ records: [], fields, groups: [] }), /groups must be a list/);
  assert.throws(() => setFields({ records: [], fields, groups: [{ id: 'g', rules: [{ id: 'r', set: [{ field: 'nope', value: 1 }] }] }] }), /not one of the fields/);
  assert.throws(() => setFields({ records: [], fields, groups: [{ id: 'g', rules: [{ id: 'r', set: [{ field: 'memo', value: 1, from: ['a'] }] }] }] }), /not both/);
  assert.throws(() => setFields({ records: [], fields, groups: [{ id: 'g', rules: [{ id: 'r', set: [{ field: 'memo', value: 1 }] }, { id: 'r', set: [{ field: 'memo', value: 2 }] }] }] }), /share the id r/);
  assert.throws(() => setFields({ records: [], fields, groups, rule_kind: 'robot' }), /not a kind of the precedence/);
  assert.throws(() => setFields({ records: [], fields, groups, provenance: { path: 'x' } }), /provenance must be/);
});
