// The common rule owner resolves formula matches, lifetime and effect precedence for display and access rules.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import operators from '../../formula-engine/rules/rule-operators.json' with { type: 'json' };
import { makeRowFilter } from '../../formula-engine/rules/filter-rows-by-rules.mjs';
import { decideRuleEffects } from '../read-data/rule-decisions.mjs';

const filter = makeRowFilter({ operators, wasm: () => readFileSync(new URL('../../formula-engine/built-stored-bytes/evaluate-over-rows/evaluate-over-rows_bg.wasm', import.meta.url)) });
await filter.load();
const condition = () => ({ kind: 'group', combinator: 'and', negate: false, rules: [
  { kind: 'rule', field: 'enabled', operator: 'is_true', params: {} },
] });
const row = { enabled: true };

test('display and access outcomes share formula matching, expiry, and declared precedence', () => {
  const effects = [
    { id: 'hide', strength: 2 }, { id: 'show', strength: 3 }, { id: 'change', strength: 0, changes: true },
    { id: 'allow', strength: 1 }, { id: 'deny', strength: 2 },
  ];
  const entries = [
    { rule: { id: 'hidden', effect: 'hide' }, when: condition(), row },
    { rule: { id: 'shown', effect: 'show' }, when: condition(), row },
    { rule: { id: 'layout-change', effect: 'change', set: [{ path: ['listed'], value: false }] }, when: condition(), row },
    { rule: { id: 'permit', effect: 'allow' }, when: condition(), row },
    { rule: { id: 'refuse', effect: 'deny', until: '2026-10-14T00:00:00Z' }, when: condition(), row },
  ];
  const result = filter.filterRowsByRulesNow;
  const visibility = decideRuleEffects({ entries: entries.slice(0, 3), effects, fields: [{ id: 'enabled', kind: 'boolean' }], now: Date.parse('2026-10-13T12:00:00Z'), filterRows: result });
  assert.deepEqual(visibility.winners.map(entry => entry.rule.id), ['shown']);
  assert.deepEqual(visibility.changes.map(entry => entry.rule.id), ['layout-change']);

  const access = decideRuleEffects({ entries: entries.slice(3), effects, fields: [{ id: 'enabled', kind: 'boolean' }], now: Date.parse('2026-10-13T12:00:00Z'), filterRows: result, strict: true });
  assert.deepEqual(access.winners.map(entry => entry.rule.id), ['refuse']);
  const expired = decideRuleEffects({ entries: entries.slice(3), effects, fields: [{ id: 'enabled', kind: 'boolean' }], now: Date.parse('2026-10-14T00:00:00Z'), filterRows: result, strict: true });
  assert.deepEqual(expired.winners.map(entry => entry.rule.id), ['permit']);
});

test('a transient formula-owner rejection is retried for the same current rules and facts', async () => {
  let calls = 0;
  const input = { entries: [{ rule: { id: 'retry-current-owner', effect: 'allow' }, row: { enabled: true } }],
    effects: [{ id: 'allow', strength: 1 }], fields: [{ id: 'enabled', kind: 'boolean' }],
    now: Date.parse('2026-10-13T12:00:00Z'), strict: true,
    filterRows: async () => {
      calls++;
      if (calls === 1) throw new Error('formula owner unavailable');
      return { matches: [0], incomplete: [] };
    } };
  await assert.rejects(Promise.resolve().then(() => decideRuleEffects(input)), /formula owner unavailable/);
  const current = await decideRuleEffects(input);
  assert.equal(calls, 2, 'a rejected answer is not an enduring authorization cache entry');
  assert.deepEqual(current.winners.map(entry => entry.rule.id), ['retry-current-owner']);
});

test('cached answers belong to the evaluator that produced them', () => {
  const input = { entries: [{ rule: { id: 'distinct-formula-owners', effect: 'allow' }, row }],
    effects: [{ id: 'allow', strength: 1 }], fields: [{ id: 'enabled', kind: 'boolean' }],
    now: Date.parse('2026-10-13T12:00:00Z'), strict: true };
  let firstCalls = 0, secondCalls = 0;
  const first = () => { firstCalls++; return { matches: [0], incomplete: [] }; };
  const second = () => { secondCalls++; return { matches: [], incomplete: [] }; };
  assert.equal(decideRuleEffects({ ...input, filterRows: first }).winners.length, 1);
  assert.equal(decideRuleEffects({ ...input, filterRows: second }).winners.length, 0);
  assert.equal(decideRuleEffects({ ...input, filterRows: first }).winners.length, 1);
  assert.equal(decideRuleEffects({ ...input, filterRows: second }).winners.length, 0);
  assert.deepEqual([firstCalls, secondCalls], [1, 1]);
});

test('the real formula owner attributes an unfinished leaf to its rule without blaming a valid same-field rule', () => {
  const unfinished = { kind: 'rule', field: 'score', operator: 'less_than', params: {} };
  const valid = { ...unfinished, params: { value: 10 } };
  const input = { entries: [
    { rule: { id: 'valid-same-field', effect: 'allow' }, when: valid, row: { score: 1 } },
    { rule: { id: 'unfinished-score', effect: 'deny' }, when: unfinished, row: { score: 1 } },
  ], effects: [{ id: 'allow', strength: 1 }, { id: 'deny', strength: 2 }],
  fields: [{ id: 'score', kind: 'number' }], now: Date.parse('2026-10-13T12:00:00Z'),
  strict: true, filterRows: filter.filterRowsByRulesNow };
  const answer = decideRuleEffects(input);
  assert.deepEqual(answer.incomplete, [{ ...unfinished, rule: 'unfinished-score' }]);
  assert.deepEqual(answer.held, [], 'unfinished conditions still refuse every strict match');
  const isolated = decideRuleEffects({ ...input, isolateIncomplete: true });
  assert.deepEqual(isolated.held.map(entry => entry.rule.id), ['valid-same-field'],
    'independent presentation rules retain valid requirements while refusing every unfinished rule');
  const unattributed = decideRuleEffects({ ...input, isolateIncomplete: true,
    filterRows: () => ({ matches: [0, 1], incomplete: [{ field: 'unknown-owner-field' }] }) });
  assert.deepEqual(unattributed.held, [], 'an unidentifiable incomplete rule still refuses every strict match');
});
