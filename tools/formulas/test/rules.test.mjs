// tools/formulas: rule trees compiled by compile-rules.mjs and evaluated by evaluate-binding.mjs, on a made-up bakery.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { compileRules, emptyRuleGroup, ruleVocabulary } from '../do-work/compile-rules.mjs';
import { filterRows } from '../do-work/evaluate-binding.mjs';

const vocabulary = ruleVocabulary(JSON.parse(readFileSync(new URL('../read-data/rule-operators.json', import.meta.url), 'utf8')));

const fields = [
  { id: 'minutes', kind: 'duration' },
  { id: 'notes', kind: 'text' },
  { id: 'labels', kind: 'tags' },
  { id: 'kind', kind: 'choice' },
  { id: 'temp', kind: 'number' },
];
const rows = [
  { minutes: 95, notes: 'Then the RYE bake', labels: ['drill'], kind: 'original', temp: -14 },
  { minutes: 30, notes: 'scones only', labels: ['junk'], kind: 'export', temp: -23 },
  { minutes: 240, notes: 'rye and sourdough', labels: ['junk', 'drill'], kind: 'original', temp: null },
  { minutes: null, notes: null, labels: [], kind: 'project', temp: -9 },
];

const rule = (field, operator, params = {}) => ({ kind: 'rule', field, operator, params });
const group = (combinator, members, negate = false) => ({ kind: 'group', combinator, negate, rules: members });
const matches = tree => filterRows(rows, compileRules(tree, { fields, vocabulary }).binding).matches;

test('and / or / not over nested groups', () => {
  assert.deepEqual(matches(group('and', [rule('minutes', 'greater_than', { value: 60 }), rule('kind', 'is_any_of', { values: ['original'] })])), [0, 2]);
  assert.deepEqual(matches(group('or', [rule('minutes', 'less_than', { value: 40 }), rule('kind', 'is_any_of', { values: ['project'] })])), [1, 3]);
  assert.deepEqual(matches(group('and', [group('or', [rule('labels', 'has_any_of', { values: ['junk'] })], true)])), [0, 3]);
  const nested = group('and', [
    rule('minutes', 'greater_than', { value: 60 }),
    group('or', [rule('notes', 'contains', { text: 'sourdough' }), rule('labels', 'has_none_of', { values: ['junk'] })]),
  ]);
  assert.deepEqual(matches(nested), [0, 2]);
});

test('over 60 minutes AND notes contain "rye" AND NOT label junk', () => {
  const tree = group('and', [
    rule('minutes', 'greater_than', { value: 60 }),
    rule('notes', 'contains', { text: 'Rye' }),
    group('and', [rule('labels', 'has_any_of', { values: ['junk'] })], true),
  ]);
  assert.deepEqual(matches(tree), [0]);
});

test('ranges keep either end or both, and unmeasured values never match a range', () => {
  assert.deepEqual(matches(rule('minutes', 'between', { min: 30, max: 120 })), [0, 1]);
  assert.deepEqual(matches(rule('minutes', 'between', { min: 100 })), [2]);
  assert.deepEqual(matches(rule('temp', 'between', { max: -14 })), [0, 1]);
  assert.deepEqual(matches(rule('temp', 'is_unknown')), [2]);
  assert.deepEqual(matches(rule('temp', 'is_known')), [0, 1, 3]);
});

test('multi-select: any of, all of and none of', () => {
  assert.deepEqual(matches(rule('kind', 'is_any_of', { values: ['export', 'project'] })), [1, 3]);
  assert.deepEqual(matches(rule('kind', 'is_none_of', { values: ['export', 'project'] })), [0, 2]);
  assert.deepEqual(matches(rule('labels', 'has_any_of', { values: ['junk', 'drill'] })), [0, 1, 2]);
  assert.deepEqual(matches(rule('labels', 'has_all_of', { values: ['junk', 'drill'] })), [2]);
  assert.deepEqual(matches(rule('labels', 'has_none_of', { values: ['junk'] })), [0, 3]);
  assert.deepEqual(matches(rule('labels', 'is_empty')), [3]);
});

test('contains ignores case; does not contain leaves unknown text out', () => {
  assert.deepEqual(matches(rule('notes', 'contains', { text: 'rye' })), [0, 2]);
  assert.deepEqual(matches(rule('notes', 'contains', { text: 'the rye bake' })), [0]);
  assert.deepEqual(matches(rule('notes', 'does_not_contain', { text: 'RYE' })), [1]);
});

test('unfinished rules are reported and left out; an empty tree matches every row', () => {
  const compiled = compileRules(group('and', [rule('minutes', 'greater_than', {}), rule('nope', 'contains', { text: 'x' }), rule('kind', 'is_any_of', { values: ['export'] })]), { fields, vocabulary });
  assert.equal(compiled.incomplete.length, 2);
  assert.deepEqual(compiled.reads, ['kind']);
  assert.deepEqual(filterRows(rows, compiled.binding).matches, [1]);
  const empty = compileRules(emptyRuleGroup(vocabulary), { fields, vocabulary });
  assert.equal(empty.binding, null);
  assert.deepEqual(filterRows(rows, empty.binding).matches, [0, 1, 2, 3]);
});

test('an unknown value never matches a comparison that cannot tell nor its negation, but is simply not in a list or not equal to a word', () => {
  const unknown = [{ notes: null, kind: null }, { notes: 'rye', kind: 'original' }];
  const keep = (field, operator, params) => filterRows(unknown, compileRules(rule(field, operator, params), { fields, vocabulary }).binding).matches;
  assert.deepEqual(keep('notes', 'contains', { text: 'rye' }), [1]);
  assert.deepEqual(keep('notes', 'does_not_contain', { text: 'rye' }), []);
  assert.deepEqual(keep('notes', 'starts_with', { text: 'r' }), [1]);
  assert.deepEqual(keep('kind', 'is_any_of', { values: ['original'] }), [1]);
  assert.deepEqual(keep('kind', 'is_none_of', { values: ['original'] }), [0]);   // unknown is not in the list
  assert.deepEqual(keep('notes', 'is_text', { text: 'rye' }), [1]);
  assert.deepEqual(keep('notes', 'is_not_text', { text: 'rye' }), [0]);          // unknown is not equal to the word
});

test('a group with a combinator the vocabulary does not hold is refused, an empty tree still matches every row', () => {
  assert.throws(() => compileRules(group('xor', [rule('kind', 'is_any_of', { values: ['export'] })]), { fields, vocabulary }), /combinator "xor" is not one of and, or/);
  assert.throws(() => compileRules(group(undefined, []), { fields, vocabulary }), /combinator null is not one of/);
  assert.equal(compileRules(emptyRuleGroup(vocabulary), { fields, vocabulary }).binding, null);
});

test('a comparison only applies to the field kinds its row names', () => {
  const compiled = compileRules(rule('notes', 'greater_than', { value: 3 }), { fields, vocabulary });
  assert.equal(compiled.binding, null);
  assert.equal(compiled.incomplete.length, 1);
});

test('a day keeps the rows from the start of that day up to its end', () => {
  const dated = [{ at: Date.UTC(2026, 0, 5, 8) }, { at: Date.UTC(2026, 0, 5, 20) }, { at: Date.UTC(2026, 0, 6, 8) }, { at: null }];
  const day = { min: Date.UTC(2026, 0, 5), max: Date.UTC(2026, 0, 6) - 1 };
  const { binding, incomplete } = compileRules(group('and', [rule('at', 'on_day', day)]), { fields: [{ id: 'at', kind: 'date' }], vocabulary });
  assert.deepEqual(incomplete, []);
  assert.deepEqual(filterRows(dated, binding).matches, [0, 1]);
});

test('words said: all of these words, any of them, none of them, or one exact phrase', () => {
  const said = [{ notes: 'Then the RYE bake' }, { notes: 'scones only' }, { notes: 'rye and sourdough' }, { notes: null }];
  const one = [{ id: 'notes', kind: 'text' }];
  const keep = (operator, params) => filterRows(said, compileRules(group('and', [rule('notes', operator, params)]), { fields: one, vocabulary }).binding).matches;
  assert.deepEqual(keep('has_all_words', { values: ['rye', 'bake'] }), [0]);
  assert.deepEqual(keep('has_any_words', { values: ['Sourdough', 'scones'] }), [1, 2]);
  assert.deepEqual(keep('has_no_words', { values: ['rye'] }), [1]);
  assert.deepEqual(keep('contains', { text: 'rye and' }), [2]);
  assert.deepEqual(keep('starts_with', { text: 'then' }), [0]);
  assert.deepEqual(keep('is_text', { text: 'SCONES ONLY' }), [1]);
  assert.deepEqual(keep('is_not_text', { text: 'scones only' }), [0, 2, 3]);
  assert.equal(compileRules(group('and', [rule('notes', 'has_any_words', { values: [] })]), { fields: one, vocabulary }).incomplete.length, 1);
});

test('a path reaches into a record, and a tag list can be searched as text', () => {
  const orders = [{ item: { name: 'Rye', tags: ['a-1', 'b-2'] } }, { item: { name: 'Scone', tags: [] } }, {}];
  const reach = [{ id: 'name', kind: 'text', path: ['item', 'name'] }, { id: 'tags', kind: 'tags', path: ['item', 'tags'] }];
  const keep = tree => filterRows(orders, compileRules(tree, { fields: reach, vocabulary }).binding).matches;
  assert.deepEqual(keep(rule('name', 'contains', { text: 'sc' })), [1]);
  assert.deepEqual(keep(rule('tags', 'has_one_containing', { text: 'b-' })), [0]);
  assert.deepEqual(keep(rule('tags', 'has_none_containing', { text: 'b-' })), [1]);
});
