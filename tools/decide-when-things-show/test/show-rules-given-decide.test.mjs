// The rules an operator gives an account reach that account's own decisions (src/show-rules-store.mjs decide, through the
// given source the person's store reads live from the operator's store). The account with the type is hidden a control; an
// account without it sees everything; and a request cannot supply given rules of its own.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import operators from '../parts/formula-engine/rules/rule-operators.json' with { type: 'json' };
import { makeRowFilter } from '../parts/formula-engine/rules/filter-rows-by-rules.mjs';
import data from '../src/workspace/show-rules.json' with { type: 'json' };
import simpleWorkspace from './fixtures/simple-workspace-profile.json' with { type: 'json' };
import accountFactsData from '../src/work-for-ais.json' with { type: 'json' };
import { accountFacts } from '../src/work-for-ais.mjs';
import { showDecision } from '../src/workspace/show-rules.mjs';
import { makeShowRules } from '../src/show-rules-store.mjs';

const wasm = () => readFileSync(new URL('../parts/formula-engine/built-stored-bytes/evaluate-over-rows/evaluate-over-rows_bg.wasm', import.meta.url));
const filter = makeRowFilter({ operators, wasm });
await filter.load();
const now = filter.filterRowsByRulesNow;
const NOW = Date.parse('2026-10-12T16:00:00Z');
const matches = (tree, row) => now({ tree, fields: accountFactsData.facts, rows: [row] }).matches.length === 1;
const thing = { control: 'sidebar.hide', within: ['sidebar', 'sidebar.hide'] };
const records = { read: () => null, write() {}, update() {} };
const decideFor = givenSource => makeShowRules({ records, filterRows: now, authority: 'personal', now: () => new Date(NOW), givenSource })
  .decide({ subject: 'control', thing });
// The operator keeps the preset in their own record; no type ships in show-rules.json.
const givenTo = cohorts => async () => ({
  giver: { types: [simpleWorkspace] },
  facts: { ...accountFacts({ accountId: 'account-a', context: { cohorts } }), cohorts },
  matches,
});

test('a type the operator gives an account hides its controls for that account', async () => {
  assert.equal((await decideFor(givenTo(['simple-workspace']))).hidden, true);
});

test('an account the operator gives no type sees the control', async () => {
  assert.equal((await decideFor(givenTo([]))).hidden, false);
});

test('the service keeps no operator source, so nothing is given and everything shows', async () => {
  assert.equal((await decideFor(null)).hidden, false);
});

test('the rules an account is given are listed for that account, and only for it', async () => {
  const listed = async cohorts => (await makeShowRules({ records, filterRows: now, authority: 'personal', now: () => new Date(NOW), givenSource: givenTo(cohorts) }).read()).rules;
  const given = (await listed(['simple-workspace'])).filter(rule => rule.id.startsWith('type:simple-workspace:'));
  assert.ok(given.length > 0 && given.every(rule => typeof rule.given === 'string' && rule.given.length > 0), 'each rule names the type it came from');
  assert.equal((await listed([])).some(rule => rule.id.startsWith('type:')), false);
});

test('a request cannot supply given rules of its own', async () => {
  const forged = [{ id: 'forged', subject: 'control', effect: 'hide', when: { kind: 'group', combinator: 'and', negate: false,
    rules: [{ kind: 'rule', field: 'within', operator: 'has_any_of', params: { values: ['sidebar.hide'] } }] } }];
  // The same rule does hide when the operator gives it, so the shape is real and the check below is not vacuous.
  assert.equal(showDecision({ data, record: null, given: forged, subject: 'control', thing, now: NOW, filterRows: now }).hidden, true);
  const answer = await makeShowRules({ records, filterRows: now, authority: 'personal', now: () => new Date(NOW), givenSource: null })
    .decide({ subject: 'control', thing, given: forged });
  assert.equal(answer.hidden, false);
});
