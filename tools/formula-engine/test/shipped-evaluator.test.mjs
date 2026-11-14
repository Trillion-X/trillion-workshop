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

// The comparisons that stand in for code the Workshop kept twice. Each is proven against the answer of the code it replaces.
const evaluator = () => loadRowEvaluator(bytes);
const holds = (field, operator, params, row) => {
  const { binding } = compileRules({ kind: 'group', combinator: 'and', negate: false, rules: [{ kind: 'rule', field: field.id, operator, params }] }, { fields: [field], vocabulary: ruleVocabulary(operators) });
  return evaluator().evaluate(binding, row);
};

// tools/drive-the-screen/read-data/run-decision.mjs globMatches (the same function sits in tools/run-on-a-persons-computer): * is the wildcard, the whole text is matched, case is ignored.
const oldGlobMatches = (pattern, value) => new RegExp(`^${pattern.toLowerCase().replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*')}$`, 'u').test(value.toLowerCase());

test('matches_glob answers what the retired glob test answered, for every pattern and text', () => {
  const field = { id: 'action', kind: 'text' };
  const patterns = ['click', 'Click*', '*', '*.com', 'a.b', 'a*b*c', 'file(1)*', '[x]*', 'x+y?', 'price $5', '*Slack*', 'a|b', '^a', 'a\\b*', '', 'é*'];
  const texts = ['click', 'CLICK now', '', 'x.com', 'xacom', 'a.b', 'aXb', 'aXbYc', 'abc', 'file(1).txt', 'file1.txt', '[x]y', 'xy', 'x+y?', 'xxy', 'price $5', 'Open Slack app', 'a|b', 'a', '^a', 'a\\b\\c', 'Été'];
  for (const pattern of patterns) {
    for (const text of texts) {
      if (pattern === '') continue; // an empty text is a rule the person has not finished: it is left out, not matched
      assert.equal(holds(field, 'matches_glob', { text: pattern }, { action: text }), oldGlobMatches(pattern, text), `${JSON.stringify(pattern)} against ${JSON.stringify(text)}`);
    }
  }
});

test('matches_any_glob and matches_no_glob are the retired some() over a list of patterns', () => {
  const field = { id: 'app', kind: 'text' };
  const patterns = ['Safari', '*Chrome*', 'com.apple.*'];
  for (const text of ['safari', 'Google Chrome Beta', 'com.apple.Mail', 'Firefox', '']) {
    const any = patterns.some(pattern => oldGlobMatches(pattern, text));
    assert.equal(holds(field, 'matches_any_glob', { values: patterns }, { app: text }), any, text);
    assert.equal(holds(field, 'matches_no_glob', { values: patterns }, { app: text }), !any, text);
  }
});

// The ISO-8601 week of a date, worked out by the standard Thursday rule, for the proof of the bucket rows.
const isoWeekKey = date => {
  const thursday = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate() + 3 - ((date.getUTCDay() + 6) % 7)));
  const week = Math.floor((thursday - new Date(Date.UTC(thursday.getUTCFullYear(), 0, 4))) / 604800000 + ((new Date(Date.UTC(thursday.getUTCFullYear(), 0, 4)).getUTCDay() + 6) % 7) / 7) + 1;
  return `${thursday.getUTCFullYear()}-W${String(week).padStart(2, '0')}`;
};

test('in_iso_week and in_date_bucket place every day of four years in its week, month, year and day', () => {
  const field = { id: 'at', kind: 'date' };
  const row = at => ({ at });
  const rule = evaluator();
  const weekRule = key => compileRules({ kind: 'group', combinator: 'and', negate: false, rules: [{ kind: 'rule', field: 'at', operator: 'in_iso_week', params: { text: key } }] }, { fields: [field], vocabulary: ruleVocabulary(operators) }).binding;
  const cache = new Map();
  const weekAnswers = (key, at) => rule.evaluate(cache.get(key) ?? cache.set(key, weekRule(key)).get(key), row(at));
  for (let day = Date.UTC(2023, 11, 20); day <= Date.UTC(2028, 0, 10); day += 86_400_000) {
    const date = new Date(day);
    const iso = date.toISOString();
    const key = isoWeekKey(date);
    assert.equal(weekAnswers(key, iso.slice(0, 10)), true, `${iso.slice(0, 10)} is in ${key}`);
    assert.equal(weekAnswers(key, iso), true, `${iso} is in ${key}`);
    const lastWeek = isoWeekKey(new Date(day - 7 * 86_400_000));
    assert.equal(weekAnswers(lastWeek, iso), false, `${iso} is not in ${lastWeek}`);
    for (const bucket of [iso.slice(0, 4), iso.slice(0, 7), iso.slice(0, 10)]) assert.equal(holds(field, 'in_date_bucket', { text: bucket }, row(iso)), true, `${iso} in ${bucket}`);
  }
  assert.equal(holds(field, 'in_date_bucket', { text: '2026-11' }, row('2026-12-01')), false);
  assert.equal(holds(field, 'in_iso_week', { text: '2026-W53' }, row('2026-12-31')), true, '2026 has 53 ISO weeks and its last Thursday is 2026-12-31');
  assert.equal(holds(field, 'in_iso_week', { text: '2027-W01' }, row('2027-01-03')), false, '2027-01-03 is a Sunday of 2026-W53');
});

// ---- a rule tree over ONE set of facts (filter-rows-by-rules.mjs holdsNow) ----
// The comparisons the hand-written `holds` / `conditionHolds` evaluators of events, wake-stopped-chats, screen-spec and the
// stream specs made, each decided by this engine, over blank facts (no account is read).
import { makeRowFilter } from '../rules/filter-rows-by-rules.mjs';

const factFilter = makeRowFilter({ operators, wasm: () => bytes });
await factFilter.load();
const rule = (field, operator, params = {}, extra = {}) => ({ kind: 'rule', field, operator, params, ...extra });
const all = (...rules) => ({ kind: 'group', combinator: 'and', negate: false, rules });
const any = (...rules) => ({ kind: 'group', combinator: 'or', negate: false, rules });
const none = (...rules) => ({ kind: 'group', combinator: 'and', negate: true, rules });
const factsHold = (tree, facts) => factFilter.holdsNow(tree, facts);

test('facts: an empty or missing tree holds', () => {
  assert.equal(factsHold(undefined, {}), true);
  assert.equal(factsHold(all(), {}), true);
});

test('facts: equals compares any shape exactly, and does_not_equal is its opposite', () => {
  assert.equal(factsHold(rule('a', 'equals', { value: 'x' }), { a: 'x' }), true);
  assert.equal(factsHold(rule('a', 'equals', { value: 'x' }), { a: 'y' }), false);
  assert.equal(factsHold(rule('a', 'equals', { value: 3 }), { a: 3 }), true);
  assert.equal(factsHold(rule('a', 'equals', { value: false }), { a: false }), true);
  assert.equal(factsHold(rule('a', 'equals', { value: '' }), { a: '' }), true);
  assert.equal(factsHold(rule('a', 'equals', { value: ['p', 1] }), { a: ['p', 1] }), true);
  assert.equal(factsHold(rule('a', 'equals', { value: ['p', 1] }), { a: ['p', 2] }), false);
  assert.equal(factsHold(rule('a', 'equals', { value: { k: 1 } }), { a: { k: 1 } }), true);
  assert.equal(factsHold(rule('a', 'does_not_equal', { value: 'x' }), { a: 'y' }), true);
  assert.equal(factsHold(rule('a', 'does_not_equal', { value: 'x' }), { a: 'x' }), false);
});

test('facts: a missing fact', () => {
  assert.equal(factsHold(rule('a', 'equals', { value: 'x' }), {}), false);
  assert.equal(factsHold(rule('a', 'is_known'), {}), false);
  assert.equal(factsHold(rule('a', 'is_unknown'), {}), true);
  assert.equal(factsHold(rule('a', 'is_known'), { a: '' }), true);
  assert.equal(factsHold(rule('a', 'is_not_empty'), { a: '' }), false);
  assert.equal(factsHold(rule('a', 'is_not_empty'), { a: 'x' }), true);
  console.log('does_not_equal over a missing fact:', factsHold(rule('a', 'does_not_equal', { value: 'x' }), {}));
  console.log('negated group over a missing fact:', factsHold(none(rule('a', 'equals', { value: 'x' })), {}));
});

test('facts: one of, begins with, pattern, order', () => {
  assert.equal(factsHold(rule('a', 'is_any_of', { values: ['p', 'q'] }), { a: 'q' }), true);
  assert.equal(factsHold(rule('a', 'is_any_of', { values: ['p', 'q'] }), { a: 'z' }), false);
  assert.equal(factsHold(rule('a', 'begins_with', { text: 'Ab' }), { a: 'Abc' }), true);
  assert.equal(factsHold(rule('a', 'begins_with', { text: 'ab' }), { a: 'Abc' }), false);
  assert.equal(factsHold(rule('a', 'matches_pattern', { text: '\\.example\\.com$' }), { a: 'host.example.com' }), true);
  assert.equal(factsHold(rule('a', 'matches_pattern', { text: '\\.example\\.com$' }), { a: 'host.example.org' }), false);
  assert.equal(factsHold(rule('a', 'greater_than', { value: 2 }), { a: 3 }), true);
  assert.equal(factsHold(rule('a', 'greater_than', { value: 2 }), { a: 2 }), false);
  assert.equal(factsHold(rule('a', 'at_least', { value: 2 }), { a: 2 }), true);
  assert.equal(factsHold(rule('a', 'less_than', { value: 2 }), { a: 1 }), true);
  assert.equal(factsHold(rule('a', 'at_most', { value: 2 }), { a: 2 }), true);
  assert.equal(factsHold(rule('a', 'is_truthy'), { a: true }), true);
  assert.equal(factsHold(rule('a', 'is_truthy'), { a: false }), false);
  console.log('is_truthy of [] / [1] / "" / "x" / 0:', [[], [1], '', 'x', 0].map(a => factsHold(rule('a', 'is_truthy'), { a })));
});

test('facts: groups join and negate; a path is a field name', () => {
  const tree = all(rule('/state/n', 'at_least', { value: 1 }), any(rule('/item/k', 'equals', { value: 'z' }), rule('/item/k', 'equals', { value: 'y' })));
  assert.equal(factsHold(tree, { '/state/n': 1, '/item/k': 'y' }), true);
  assert.equal(factsHold(tree, { '/state/n': 0, '/item/k': 'y' }), false);
  assert.equal(factsHold(tree, id => ({ '/state/n': 2, '/item/k': 'z' })[id]), true);
});

test('facts: the existing kinds still work over facts (text lowers, choice lists)', () => {
  assert.equal(factsHold(rule('t', 'contains', { text: 'hello' }, { field_kind: 'text' }), { t: 'Say HELLO' }), true);
  assert.equal(factsHold(rule('c', 'is_none_of', { values: ['a'] }, { field_kind: 'choice' }), { c: 'b' }), true);
});

test('facts: a condition the engine cannot finish is refused, never read as holding', () => {
  assert.throws(() => factsHold(rule('a', 'no_such_comparison', { value: 1 }), { a: 1 }), /could not finish/);
  assert.throws(() => factsHold(rule('a', 'equals', {}), { a: 1 }), /could not finish/);
});
