// Which of several given types decides one rule (src/workspace/show-rules.mjs heldTypes, givenRules): a type held directly
// comes before the types it inherits, a child's rule replaces its parent's rule with the same id (switched off or not),
// and held order breaks a tie at the same depth. Decided by the real formula engine.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import operators from '../parts/formula-engine/rules/rule-operators.json' with { type: 'json' };
import { makeRowFilter } from '../parts/formula-engine/rules/filter-rows-by-rules.mjs';
import data from '../src/workspace/show-rules.json' with { type: 'json' };
import accountFactsData from '../src/work-for-ais.json' with { type: 'json' };
import { accountFacts } from '../src/work-for-ais.mjs';
import { givenRules, heldTypes, showDecision, typesOf } from '../src/workspace/show-rules.mjs';

const wasm = () => readFileSync(new URL('../parts/formula-engine/built-stored-bytes/evaluate-over-rows/evaluate-over-rows_bg.wasm', import.meta.url));
const filter = makeRowFilter({ operators, wasm });
await filter.load();
const now = filter.filterRowsByRulesNow;
const NOW = Date.parse('2026-10-13T16:00:00Z');
const matches = (tree, row) => now({ tree, fields: accountFactsData.facts, rows: [row] }).matches.length === 1;
const TABS = 'arrangement.header.tabs';
const tabs = (id, effect, extra = {}) => ({ id, label: id, subject: 'control', effect, ...extra,
  when: { kind: 'group', combinator: 'and', negate: false, rules: [{ kind: 'rule', field: 'within', operator: 'has_any_of', params: { values: [TABS] } }] } });
const type = (id, inherits, rules) => ({ id, label: id, inherits, rules });
const shownGiven = given => !showDecision({ data, record: null, given, subject: 'control', thing: { control: TABS, within: [TABS] }, now: NOW, filterRows: now }).hidden;
const giverWith = types => ({ types });
const holds = (giver, cohorts) => givenRules({ data, giver, facts: accountFacts({ accountId: 'account-a', context: { cohorts } }), matches });

test('a type held directly comes before a type it inherits, at any depth', async () => {
  const giver = giverWith([
    type('base', [], [tabs('hide-tabs', 'hide')]),
    type('base-holder', ['base'], []),
    type('direct', [], [tabs('hide-tabs', 'show')]),
  ]);
  assert.deepEqual(heldTypes(typesOf(giver), ['base-holder', 'direct']), ['base-holder', 'direct', 'base']);
  const given = await holds(giver, ['base-holder', 'direct']);
  assert.deepEqual(given.map(rule => rule.id), ['type:direct:hide-tabs']);
  assert.equal(shownGiven(given), true, 'the directly held show wins over the inherited hide');
});

test('a child rule with the same id replaces its parent rule', async () => {
  const giver = giverWith([
    type('viewer', [], [tabs('hide-tabs', 'hide')]),
    type('cleaner', ['viewer'], [tabs('hide-tabs', 'show')]),
  ]);
  const given = await holds(giver, ['cleaner']);
  assert.deepEqual(given.map(rule => rule.id), ['type:cleaner:hide-tabs']);
  assert.equal(shownGiven(given), true);
  assert.equal(shownGiven(await holds(giver, ['viewer'])), false, 'the parent alone still hides');
});

test('a child that switches a parent rule off overrides it, so the parent rule does not return', async () => {
  const giver = giverWith([
    type('viewer', [], [tabs('hide-tabs', 'hide')]),
    type('cleaner', ['viewer'], [tabs('hide-tabs', 'hide', { on: false })]),
  ]);
  const given = await holds(giver, ['cleaner']);
  assert.deepEqual(given, []);
  assert.equal(shownGiven(given), true);
});

test('at the same depth the type held first decides, and the other type still supplies the rules it alone names', async () => {
  const giver = giverWith([
    type('first', [], [tabs('hide-tabs', 'hide')]),
    type('second', [], [tabs('hide-tabs', 'show'), { ...tabs('other-rule', 'hide'), when: { kind: 'group', combinator: 'and', negate: false, rules: [{ kind: 'rule', field: 'within', operator: 'has_any_of', params: { values: ['sidebar.hide'] } }] } }]),
  ]);
  const given = await holds(giver, ['first', 'second']);
  assert.deepEqual(given.map(rule => rule.id).sort(), ['type:first:hide-tabs', 'type:second:other-rule']);
  assert.equal(shownGiven(given), false, 'first held wins the tie');
});

test('inheritance terminates on a cycle and lists each type once in precedence order', () => {
  const types = [type('a', ['b'], []), type('b', ['a'], [])];
  assert.deepEqual(heldTypes(types, ['a']), ['a', 'b']);
});
