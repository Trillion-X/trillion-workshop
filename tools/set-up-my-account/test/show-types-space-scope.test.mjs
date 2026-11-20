// A show-rules type with a `scope` { space_id } applies only inside that space (src/workspace/show-rules.mjs givenRules,
// changedRecord, typeProblem; src/show-rules-store.mjs decide). Outside the space it is as if it were not offered: its
// rules do not hold and it cannot be inherited. Decided by the real formula engine.
// Ported from the retired repository test/show-types-space-scope.test.mjs (b6ae0ebf81), assertions unchanged. What differs: the evaluator is the
// formula-engine tool's compiled bytes, the store is tools/decide-when-things-show (it keeps its changes for the caller: `held`
// replaces the old records handle), and the old HTTP read route handleShowRulesRequest is no longer a function of this store (the
// route's last assertion is dropped; the scoped read it forwarded is asserted through store.read).
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import data from '../read-data/show-rules.json' with { type: 'json' };
import { accountFacts } from '../../decide-when-things-show/read-data/account-facts.mjs';
import accountFactsData from '../../decide-when-things-show/read-data/work-for-ais.json' with { type: 'json' };
import { changedRecord, givenRules, showDecision, typeProblem } from '../read-data/show-rules.mjs';
import { makeShowRules } from '../../decide-when-things-show/read-data/show-rules-store.mjs';
import { initSync, filterRecords } from '../../formula-engine/built-stored-bytes/formula-engine/formula_engine.js';
initSync({ module: readFileSync(new URL('../../formula-engine/built-stored-bytes/formula-engine/formula_engine_bg.wasm', import.meta.url)) });
const now = ({ tree, fields, rows }) => filterRecords({ records: rows, fields, tree });
const NOW = Date.parse('2026-10-13T16:00:00Z');
const matches = (tree, row) => now({ tree, fields: accountFactsData.facts, rows: [row] }).matches.length === 1;
const thing = { control: 'sidebar.hide', within: ['sidebar', 'sidebar.hide'] };
const hideSidebar = { id: 'hide-sidebar', label: 'Hide sidebar', subject: 'control', effect: 'hide', when: null };
const leads = { id: 'leads-a', label: 'Leads', inherits: [], rules: [hideSidebar], scope: { space_id: 'space-a' } };
const giver = { types: [leads] };
const facts = cohorts => accountFacts({ accountId: 'account-a', context: { cohorts } });
const hiddenIn = async (space_id, cohorts = ['leads-a']) => {
  const given = await givenRules({ data, giver, facts: facts(cohorts), matches, space_id });
  return showDecision({ data, record: null, given, subject: 'control', thing, now: NOW, filterRows: now }).hidden;
};

test('a scoped type hides inside its space and does nothing outside it', async () => {
  assert.equal(await hiddenIn('space-a'), true);
  assert.equal(await hiddenIn('space-b'), false, 'another space does not see the space-a type');
  assert.equal(await hiddenIn(null), false, 'outside any space the type does not apply');
});

test('a scoped type that is not offered in this space is not inherited either', async () => {
  const child = { id: 'child-of-leads', label: 'Child', inherits: ['leads-a'], rules: [] };
  const given = await givenRules({ data, giver: { types: [leads, child] }, facts: facts(['child-of-leads']), matches, space_id: 'space-b' });
  assert.deepEqual(given, []);
});

test('an unscoped type applies in every space and outside them', async () => {
  const everywhere = { types: [{ ...leads, id: 'leads-everywhere', scope: undefined }] };
  for (const space_id of ['space-a', 'space-b', null]) {
    const given = await givenRules({ data, giver: everywhere, facts: facts(['leads-everywhere']), matches, space_id });
    assert.equal(given.length, 1, `applies with space ${space_id}`);
  }
});

test('a scope keeps its space when a type is saved, and a scope without a space is refused', () => {
  const saved = changedRecord(data, {}, { type: leads }, NOW);
  assert.deepEqual(saved.types[0].scope, { space_id: 'space-a' });
  assert.match(typeProblem(data, { id: 'bad-scope', rules: [], scope: {} }, []), /scope is \{ space_id \}/);
});

test('the store decides a scoped type only for a decision inside its space', async () => {
    const decideIn = space_id => makeShowRules({ held: {}, filterRows: now, authority: 'personal', now: () => new Date(NOW),
    givenSource: async () => ({ giver, facts: { ...facts(['leads-a']), cohorts: ['leads-a'] }, matches }) })
    .decide({ subject: 'control', thing, space_id });
  assert.equal((await decideIn('space-a')).hidden, true);
  assert.equal((await decideIn('space-b')).hidden, false);
  assert.equal((await decideIn(undefined)).hidden, false);
});

test('the store derives inherited Space types from the authenticated Space owner and refreshes after role changes', async () => {
  const inherited = { id: 'workspace-wide-hide', label: 'Workspace wide', inherits: [], rules: [hideSidebar] };
    let memberType = 'space-child';
  const store = makeShowRules({ held: {}, filterRows: now, authority: 'personal', now: () => new Date(NOW),
    givenSource: async () => ({ giver: { types: [inherited] }, facts: { ...facts([]), cohorts: [] }, matches }),
    spaceContext: async spaceId => spaceId === 'space-a' && memberType
      ? { member_type: memberType, member_types: [{ id: 'space-child', label: 'Child', inherits: ['workspace-wide-hide'] }, { id: 'space-other', label: 'Other', inherits: [] }] }
      : null,
  });
  assert.equal((await store.decide({ subject: 'control', thing, space_id: 'space-a' })).hidden, true,
    'the current member type inherits the giver profile through the Space type graph');
  assert.equal((await store.decide({ subject: 'control', thing, space_id: 'space-b' })).hidden, false,
    'the exact Space context does not leak into another Space');
  assert.equal((await store.read({ space_id: 'space-a' })).rules.some(rule => rule.given), true,
    'the scoped read supplies the same rules the live evaluator uses');
  memberType = 'space-other';
  assert.equal((await store.decide({ subject: 'control', thing, space_id: 'space-a' })).hidden, false,
    'a changed member role drops the old inherited rule');
  memberType = 'workspace-wide-hide';
  assert.equal((await store.decide({ subject: 'control', thing, space_id: 'space-a' })).hidden, false,
    'an undeclared legacy Space role cannot accidentally select a same-named giver profile');
  memberType = null;
  assert.equal((await store.decide({ subject: 'control', thing: { ...thing, member_type: 'space-child' }, space_id: 'space-a' })).hidden, false,
    'a role forged on the thing cannot replace current membership');
});
