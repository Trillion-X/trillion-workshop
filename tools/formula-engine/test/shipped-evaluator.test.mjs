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
