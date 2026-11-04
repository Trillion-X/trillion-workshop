// A control hidden for a while by a rule with an `until` comes back by itself once that time has passed
// (src/workspace/show-rules.mjs showDecision): the affordance returns with no edit, and the answer says when it turns.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import operators from '../../formula-engine/rules/rule-operators.json' with { type: 'json' };
import { makeRowFilter } from '../../formula-engine/rules/filter-rows-by-rules.mjs';
import data from '../read-data/show-rules.json' with { type: 'json' };
import { showDecision } from '../read-data/show-rules.mjs';

const wasm = () => readFileSync(new URL('../../formula-engine/built-stored-bytes/evaluate-over-rows/evaluate-over-rows_bg.wasm', import.meta.url));
const filter = makeRowFilter({ operators, wasm });
await filter.load();

const UNTIL = '2026-10-13T18:00:00.000Z';
const thing = { control: 'sidebar.hide', within: ['sidebar', 'sidebar.hide'] };
const hideForAWhile = {
  id: 'hide-sidebar-hide-for-a-while',
  subject: 'control',
  effect: 'hide',
  until: UNTIL,
  when: { kind: 'group', combinator: 'and', negate: false, rules: [{ kind: 'rule', field: 'within', operator: 'has_any_of', params: { values: ['sidebar.hide'] } }] },
};
const decide = now => showDecision({ data, record: { rules: [hideForAWhile] }, subject: 'control', thing, now, filterRows: filter.filterRowsByRulesNow });

test('a control hidden until a time stays hidden before that time', () => {
  const before = decide(Date.parse('2026-10-13T17:59:00.000Z'));
  assert.equal(before.hidden, true);
  assert.equal(before.until, UNTIL);
});

test('the control returns by itself once the time has passed, with no edit', () => {
  const after = decide(Date.parse('2026-10-13T18:00:00.000Z'));
  assert.equal(after.hidden, false);
  assert.equal(after.silenced, false);
  assert.deepEqual(after.rules, []);
});
