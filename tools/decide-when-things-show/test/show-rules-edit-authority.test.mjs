// Account show-rule mutations use the common evaluator, trusted actor headers, expiry and owner compare-and-write.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import operators from '../parts/formula-engine/rules/rule-operators.json' with { type: 'json' };
import showRuleData from '../src/workspace/show-rules.json' with { type: 'json' };
import simpleWorkspace from './fixtures/simple-workspace-profile.json' with { type: 'json' };
import accountFactsData from '../src/work-for-ais.json' with { type: 'json' };
import { makeRowFilter } from '../parts/formula-engine/rules/filter-rows-by-rules.mjs';
import { givenAccountFields, handleShowRulesRequest, makeShowRules } from '../src/show-rules-store.mjs';
import { showRuleAnnotations, showRuleTools } from '../src/show-rules-tools.mjs';

const wasm = () => readFileSync(new URL('../parts/formula-engine/built-stored-bytes/evaluate-over-rows/evaluate-over-rows_bg.wasm', import.meta.url));
const filter = makeRowFilter({ operators, wasm });
await filter.load();
const nowFilter = filter.filterRowsByRulesNow;
const NOW = Date.parse('2026-10-13T16:00:00Z');

function world(initial = null, conflictOnWrite = false) {
  let current = initial;
  const records = {
    read: label => label === 'show-rules' ? current : null,
    identity: value => JSON.stringify(value),
    write: writes => {
      const [write] = writes;
      if (conflictOnWrite || write.expected_identity !== (current ? JSON.stringify(current) : null)) return { written: 0, conflicts: [{ address: 'show-rules' }] };
      current = write.payload;
      return { written: 1 };
    },
    update() {},
  };
  return { records, current: () => current, store: makeShowRules({ records, filterRows: nowFilter, now: () => new Date(NOW), validateActor: actor => actor?.account_id === 'account-a' }) };
}

const rule = { id: 'hide-tabs', label: 'Hide tabs', subject: 'control', effect: 'hide' };
const blocked = { id: 'blocked-reader', effect: 'deny', who: { kind: 'reader', reader: 'app:blocked' }, actions: ['change_rule'], until: new Date(NOW + 60_000).toISOString() };
const accountActor = { account_id: 'account-a' };
const matchesAccount = (tree, facts) => nowFilter({ tree, fields: accountFactsData.facts, rows: [facts] }).matches.length === 1;

function assignmentWorld({ policy = null, context = { accounts: { 'account-a': { cohorts: [], experiments: [] } } }, clock = () => new Date(NOW), readSource = null } = {}) {
  // The operator keeps the preset it gives in its own record; no type ships in show-rules.json.
  const kept = new Map([['show-rules', { types: [simpleWorkspace], ...(policy ?? {}) }], ['setup-context', context]]);
  let updates = 0;
  const records = { read: label => kept.get(label) ?? null, write() { throw new Error('assignment must use the context owner'); },
    update(label, change) { const value = change(kept.get(label) ?? null); updates++; kept.set(label, value); } };
  const givenSource = async () => {
    const facts = { cohorts: kept.get('setup-context').accounts['account-a'].cohorts,
      experiments: kept.get('setup-context').accounts['account-a'].experiments ?? [] };
    const source = { giver: kept.get('show-rules'), facts, matches: matchesAccount,
      stamp: JSON.stringify([kept.get('show-rules'), facts]) };
    if (readSource) await readSource({ kept, source });
    return source;
  };
  return { kept, updates: () => updates, store: makeShowRules({ records, givenSource, authority: 'operator',
    filterRows: nowFilter, now: clock, validateActor: actor => actor?.account_id === 'account-a' }) };
}

test('assignment validates the trusted actor and configured reader policy before any context write', async () => {
  const deny = { id: 'deny-reader-assignment', effect: 'deny', who: { kind: 'reader', reader: 'app:blocked' }, actions: ['change_assignment'] };
  const fixture = assignmentWorld({ policy: { edit_rules: [...showRuleData.edit_authority.starting_rules, deny] } });
  const change = { give: { account_id: 'account-b', add: ['simple-workspace'], experiments: { add: ['pilot'] } } };
  const before = structuredClone(fixture.kept.get('setup-context'));
  await assert.rejects(fixture.store.set(change), /do not let.*change assignment/);
  await assert.rejects(fixture.store.set(change, { actor: { account_id: 'wrong-account' } }), /do not let.*change assignment/);
  await assert.rejects(fixture.store.set(change, { actor: { ...accountActor, reader: 'app:blocked' } }), /do not let.*change assignment/);
  assert.equal(fixture.updates(), 0);
  assert.deepEqual(fixture.kept.get('setup-context'), before);
  const answer = await fixture.store.set(change, { actor: accountActor });
  assert.deepEqual(answer.audience, { cohorts: ['simple-workspace'], experiments: ['pilot'] });
  assert.equal(fixture.updates(), 1);
});

test('self-assignment cannot impose an inherited or audience-selected policy that locks out its current editor', async () => {
  for (const audienceSelected of [false, true]) {
    const deny = { id: 'deny-assignment', effect: 'deny', who: { kind: 'account_owner' }, actions: ['change_assignment'] };
    const audience = { kind: 'group', combinator: 'and', negate: false, rules: [{ kind: 'rule', field: 'experiments', operator: 'has_any_of', params: { values: ['restricted'] } }] };
    const types = [{ id: 'restricted-parent', label: 'Restricted parent', inherits: [], rules: [], edit_rules: [deny] },
      { id: 'restricted-child', label: 'Restricted child', inherits: ['restricted-parent'], rules: [], ...(audienceSelected ? { audience } : {}) }];
    const fixture = assignmentWorld({ policy: { types } });
    const before = structuredClone(fixture.kept.get('setup-context'));
    const give = { account_id: 'account-a', ...(audienceSelected ? { experiments: { add: ['restricted'] } } : { add: ['restricted-child'] }) };
    await assert.rejects(fixture.store.set({ give }, { actor: accountActor }), /stop the actor from changing assignments again/);
    assert.deepEqual(fixture.kept.get('setup-context'), before);
    assert.equal(fixture.updates(), 0);
  }
});

test('assignment refuses a context race without overwriting the newer memberships', async () => {
  let reads = 0;
  const fixture = assignmentWorld({ readSource: ({ kept }) => {
    if (++reads === 3) kept.set('setup-context', { accounts: { 'account-a': { cohorts: [], experiments: [] }, 'account-b': { cohorts: ['newer'], experiments: [] } } });
  } });
  await assert.rejects(fixture.store.set({ give: { account_id: 'account-b', add: ['simple-workspace'] } }, { actor: accountActor }), /changed while this assignment/);
  assert.equal(fixture.updates(), 0);
  assert.deepEqual(fixture.kept.get('setup-context').accounts['account-b'].cohorts, ['newer']);
});

test('assignment refuses allow expiry during its final source read', async () => {
  let at = NOW, reads = 0;
  const allow = { id: 'temporary-assigner', effect: 'allow', who: { kind: 'account_owner' }, actions: ['change_assignment'], until: new Date(NOW + 1000).toISOString() };
  const fixture = assignmentWorld({ policy: { edit_rules: [allow] }, clock: () => new Date(at),
    readSource: () => { if (++reads === 3) at = NOW + 1000; } });
  await assert.rejects(fixture.store.set({ give: { account_id: 'account-b', add: ['simple-workspace'] } }, { actor: accountActor }), /assignment authority expired/);
  assert.equal(fixture.updates(), 0);
});

test('assignment refuses a rule-policy race even if its earlier source stamp was retained', async () => {
  let reads = 0;
  const deny = { id: 'changed-assigner', effect: 'deny', who: { kind: 'account_owner' }, actions: ['change_assignment'] };
  const fixture = assignmentWorld({ readSource: ({ kept }) => {
    if (++reads === 3) kept.set('show-rules', { edit_rules: [...showRuleData.edit_authority.starting_rules, deny] });
  } });
  await assert.rejects(fixture.store.set({ give: { account_id: 'account-b', add: ['simple-workspace'] } }, { actor: accountActor }), /changed while this assignment/);
  assert.equal(fixture.updates(), 0);
  assert.deepEqual(fixture.kept.get('show-rules').edit_rules.at(-1), deny);
});

function operatorWithGivenPolicy(initial, facts) {
  const fixture = world(initial);
  const store = makeShowRules({ records: fixture.records, filterRows: nowFilter, authority: 'operator', now: () => new Date(NOW),
    validateActor: actor => actor?.account_id === 'account-a',
    givenSource: async candidate => ({ giver: candidate === undefined ? fixture.current() : candidate,
      current_giver: fixture.current(), facts, stamp: JSON.stringify([fixture.current(), facts]), matches: matchesAccount }) });
  return { ...fixture, store };
}

test('a current reader-specific deny beats the account-owner allow and expires at its deadline', async () => {
  const { store } = world({ edit_rules: [...showRuleData.edit_authority.starting_rules, blocked] });
  await assert.rejects(store.set({ rule }, { actor: { account_id: 'account-a', reader: 'app:blocked' } }), /edit rules do not let/);
  const afterExpiry = makeShowRules({ records: { read: () => ({ edit_rules: [...showRuleData.edit_authority.starting_rules, blocked] }), write() { return { written: 1 }; }, update() {} }, filterRows: nowFilter, now: () => new Date(NOW + 60_000), validateActor: actor => actor?.account_id === 'account-a' });
  await afterExpiry.set({ rule }, { actor: { account_id: 'account-a', reader: 'app:blocked' } });
});

test('a deny inherited through an assigned profile blocks the account owner', async () => {
  const inheritedDeny = { id: 'profile-deny', effect: 'deny', who: { kind: 'account_owner' }, actions: ['change_rule'] };
  const givenSource = async () => ({
    giver: { types: [
      { id: 'restricted-parent', edit_rules: [inheritedDeny] },
      { id: 'restricted-child', inherits: ['restricted-parent'] },
    ] },
    facts: { cohorts: ['restricted-child'] },
    matches: async () => true,
  });
  const { records } = world(null);
  const account = makeShowRules({ records, filterRows: nowFilter, now: () => new Date(NOW),
    validateActor: actor => actor?.account_id === 'account-a', givenSource });
  await assert.rejects(account.set({ rule }, { actor: { account_id: 'account-a' } }), /edit rules do not let/);
});

test('personal candidate profiles retain the actual operator giver policy', async () => {
  const deny = { id: 'operator-deny-policy-change', effect: 'deny', who: { kind: 'account_owner' }, actions: ['change_edit_rules'],
    audience: { kind: 'group', combinator: 'and', negate: false, rules: [] } };
  let writes = 0, givenCalls = 0;
  const { records } = world(null);
  const account = makeShowRules({ records: { ...records, write: (...args) => { writes++; return records.write(...args); } },
    filterRows: nowFilter, now: () => new Date(NOW), validateActor: actor => actor?.account_id === 'account-a',
    givenSource: async (_candidate, factsCandidate) => {
      givenCalls++;
      assert.ok(factsCandidate && typeof factsCandidate === 'object', 'candidate fact loading receives the proposed record');
      return { giver: { edit_rules: [deny] }, facts: { cohorts: [] }, matches: async () => true };
    } });
  await assert.rejects(account.set({ edit_rules: showRuleData.edit_authority.starting_rules }, { actor: accountActor }), /edit rules do not let/);
  assert.equal(writes, 0);
  assert.ok(givenCalls > 0);
});

test('the exposed MCP policy and conflict actions preserve their payload and owner route', async () => {
  const called = [];
  const tools = showRuleTools(async (...args) => { called.push(args); return { resolved: true }; });
  const policy = showRuleData.edit_authority.starting_rules;
  await tools.find(tool => tool.name === 'set_show_rule').run({ edit_rules: policy });
  const resolve = tools.find(tool => tool.name === 'resolve_show_rules_conflict');
  assert.deepEqual(resolve.inputSchema.required, ['id', 'branch_identity']);
  await resolve.run({ id: 'conflict:policy', branch_identity: 'stored:branch' });
  assert.deepEqual(called, [['/show-rules/set', { edit_rules: policy }],
    ['/show-rules/resolve', { id: 'conflict:policy', branch_identity: 'stored:branch' }]]);
  assert.equal(showRuleAnnotations.resolve_show_rules_conflict.readOnlyHint, false);
});

test('disabled inherited edit rules do not deny a change', async () => {
  const givenSource = async () => ({
    giver: { types: [{ id: 'unrestricted', edit_rules: [
      { id: 'disabled-deny', effect: 'deny', on: false, who: { kind: 'account_owner' }, actions: ['change_rule'] },
    ] }] },
    facts: { cohorts: ['unrestricted'] },
    matches: async () => true,
  });
  const { records } = world(null);
  const account = makeShowRules({ records, filterRows: nowFilter, now: () => new Date(NOW),
    validateActor: actor => actor?.account_id === 'account-a', givenSource });
  await account.set({ rule }, { actor: { account_id: 'account-a' } });
});

test('a malformed unrelated edit policy fails closed', async () => {
  const { store } = world({ edit_rules: [
    ...showRuleData.edit_authority.starting_rules,
    { id: 'unrelated-malformed', effect: 'allow', who: { kind: 'unknown-reader' }, actions: ['change_rule'] },
  ] });
  await assert.rejects(store.set({ rule }, { actor: { account_id: 'account-a' } }), /An edit rule names account_owner or one trusted reader/);
});

test('a request body cannot impersonate a different trusted reader', async () => {
  const { store } = world({ edit_rules: [
    { id: 'owner', effect: 'allow', who: { kind: 'account_owner' }, actions: ['change_rule', 'change_edit_rules'] }, blocked,
  ] });
  const request = new Request('https://person/show-rules/set', { method: 'POST', headers: { 'x-trillion-user': 'account-a', 'x-trillion-reader': 'app:blocked' },
    body: JSON.stringify({ rule, actor: { account_id: 'account-a', reader: 'app:allowed' } }) });
  const response = await handleShowRulesRequest(store, request);
  assert.equal(response.status, 403);
  assert.match((await response.json()).error, /edit rules do not let/);
});

test('a proposed edit policy that locks out its editor is refused', async () => {
  const { store } = world();
  await assert.rejects(store.set({ edit_rules: [{ id: 'read-only', effect: 'allow', who: { kind: 'account_owner' }, actions: ['change_rule'] }] },
    { actor: { account_id: 'account-a' } }), /stop the actor from making the same show-rule changes again/);
});

test('an assigned profile cannot acquire a new inherited deny that locks out its current operator', async () => {
  const restrictedParent = { id: 'restricted-parent', label: 'Restricted parent', inherits: [], rules: [], edit_rules: [
    { id: 'parent-deny-change-type', effect: 'deny', who: { kind: 'account_owner' }, actions: ['change_type'] },
  ] };
  const assignedProfile = { id: 'assigned-profile', label: 'Assigned profile', inherits: [], rules: [] };
  const initial = { types: [restrictedParent, assignedProfile] };
  const { current, store } = operatorWithGivenPolicy(initial, { cohorts: ['assigned-profile'], experiments: [] });
  const before = structuredClone(current());
  await assert.rejects(store.set({ type: { ...assignedProfile, inherits: ['restricted-parent'] } }, { actor: accountActor }), /stop the actor from making the same show-rule changes again/);
  assert.deepEqual(current(), before, 'a profile edit rejected by its proposed inherited policy is not persisted');
});

test('an audience-selected profile cannot newly impose an inherited deny on its current operator', async () => {
  const restrictedParent = { id: 'conditional-parent', label: 'Conditional parent', inherits: [], rules: [], edit_rules: [
    { id: 'parent-deny-change-type', effect: 'deny', who: { kind: 'account_owner' }, actions: ['change_type'] },
  ] };
  const initial = { types: [restrictedParent] };
  const facts = { cohorts: [], experiments: ['pilot'] };
  const { current, store } = operatorWithGivenPolicy(initial, facts);
  const before = structuredClone(current());
  const audience = { kind: 'group', combinator: 'and', negate: false, rules: [
    { kind: 'rule', field: 'experiments', operator: 'has_any_of', params: { values: ['pilot'] } },
  ] };
  await assert.rejects(store.set({ type: { id: 'pilot-profile', label: 'Pilot profile', inherits: ['conditional-parent'], audience, rules: [] } },
    { actor: accountActor }), /stop the actor from making the same show-rule changes again/);
  assert.deepEqual(current(), before, 'a profile newly selected by current account facts is evaluated before persistence');
});

test('candidate-only offer and capability audiences are included in the account-fact read set', () => {
  const audience = field => ({ kind: 'group', combinator: 'and', negate: false, rules: [
    { kind: 'rule', field, operator: 'is_any_of', params: { values: ['candidate-value'] } },
  ] });
  const before = { types: [{ id: 'old-facts', label: 'Old facts', inherits: [], rules: [], audience: audience('plan') }] };
  const candidate = { types: [
    ...before.types,
    { id: 'new-offer-facts', label: 'Offer facts', inherits: [], rules: [], audience: audience('offers') },
    { id: 'new-capability-facts', label: 'Capability facts', inherits: [], rules: [], audience: audience('capabilities') },
  ] };
  const fields = new Set([...givenAccountFields(before), ...givenAccountFields(candidate)]);
  assert.ok(fields.has('offers'));
  assert.ok(fields.has('capabilities'));
});

test('operator current policy still uses its current giver while candidate facts use the proposed record', async () => {
  const deny = { id: 'future-profile-deny', effect: 'deny', who: { kind: 'account_owner' }, actions: ['change_type'] };
  const currentGiver = { edit_rules: [] };
  const restricted = { id: 'restricted-candidate', label: 'Restricted candidate', inherits: [], rules: [], edit_rules: [deny] };
  let observed = false;
  const { records } = world(null);
  const store = makeShowRules({ records, filterRows: nowFilter, authority: 'operator', now: () => new Date(NOW),
    validateActor: actor => actor?.account_id === 'account-a',
    givenSource: async (proposedGiver, factsGiver) => {
      if (factsGiver?.types?.some(type => type.id === restricted.id) && proposedGiver === undefined) {
        observed = true;
        return { giver: currentGiver, facts: { cohorts: ['restricted-candidate'] }, matches: async () => true };
      }
      return { giver: proposedGiver ?? currentGiver, facts: { cohorts: ['restricted-candidate'] }, matches: async () => true };
    } });
  await assert.rejects(store.set({ type: restricted }, { actor: accountActor }), /stop the actor from making the same show-rule changes again/);
  assert.equal(observed, true, 'the current-policy read distinguishes no proposed giver from candidate-only facts');
});

test('permission to change a profile does not bypass a deny on changing its edit policy', async () => {
  const profile = { id: 'profile-to-edit', label: 'Profile', inherits: [], rules: [] };
  const initial = { types: [profile], edit_rules: [...showRuleData.edit_authority.starting_rules,
    { id: 'deny-policy-edits', effect: 'deny', who: { kind: 'account_owner' }, actions: ['change_edit_rules'] },
  ] };
  const { current, store } = operatorWithGivenPolicy(initial, { cohorts: [], experiments: [] });
  await assert.rejects(store.set({ type: { ...profile, edit_rules: [
    { id: 'new-profile-policy', effect: 'allow', who: { kind: 'account_owner' }, actions: ['change_rule'] },
  ] } }, { actor: accountActor }), /edit rules do not let/);
  assert.deepEqual(current(), initial, 'the denied nested policy never reaches the current record');
});

test('a profile may deliberately carry no additional edit rules', async () => {
  const { current, store } = operatorWithGivenPolicy(null, { cohorts: [], experiments: [] });
  await store.set({ type: { id: 'unrestricted-profile', label: 'Unrestricted', inherits: [], rules: [], edit_rules: [] } }, { actor: accountActor });
  assert.deepEqual(current().types.find(type => type.id === 'unrestricted-profile').edit_rules, []);
});

test('changing a profile edit policy requires both profile and policy authority', async () => {
  const profile = { id: 'policy-profile', label: 'Policy profile', inherits: [], rules: [] };
  const initial = { types: [profile], edit_rules: [
    { id: 'allow-profile-change', effect: 'allow', who: { kind: 'account_owner' }, actions: ['change_type'] },
  ] };
  const { current, store } = operatorWithGivenPolicy(initial, { cohorts: [], experiments: [] });
  await assert.rejects(store.set({ type: { ...profile, edit_rules: [] } }, { actor: accountActor }), /current show-rule edit rules do not let.*change edit rules/);
  assert.deepEqual(current(), initial);
});

test('show-rules conflict resolution validates and forwards the exact persisted branch', async () => {
  const before = { rules: [rule] };
  const proposed = { rules: [{ ...rule, label: 'Changed label' }] };
  const conflict = { id: 'conflict-a', address: 'show-rules', state: 'open', branches: [
    { found: true, identity: JSON.stringify(before), value: before },
    { found: true, identity: JSON.stringify(proposed), value: proposed },
  ] };
  let resolved = null;
  const store = makeShowRules({
    records: { read: label => label === 'show-rules' ? before : null, identity: JSON.stringify },
    filterRows: nowFilter, now: () => new Date(NOW), validateActor: actor => actor?.account_id === 'account-a',
    readConflict: async id => id === conflict.id ? conflict : null,
    resolveConflict: async (...args) => { resolved = args; return { resolved: true, address: 'show-rules', kept: args[1] }; },
  });
  const result = await store.resolve({ id: conflict.id, branch_identity: JSON.stringify(proposed) }, { actor: accountActor });
  assert.equal(result.resolved, true);
  assert.equal(resolved[0], conflict.id);
  assert.equal(resolved[1], JSON.stringify(proposed));
  assert.deepEqual(resolved[2], { conflict_identity: JSON.stringify(conflict), current_identity: JSON.stringify(before) });
});

test('show-rules conflict resolution refuses an invalid selected branch before calling the resolver', async () => {
  const before = { rules: [rule] };
  const invalid = { rules: [{ ...rule, effect: 'unknown-effect' }] };
  const conflict = { id: 'conflict-invalid', address: 'show-rules', state: 'open', branches: [
    { found: true, identity: JSON.stringify(before), value: before },
    { found: true, identity: JSON.stringify(invalid), value: invalid },
  ] };
  let called = false;
  const store = makeShowRules({ records: { read: () => before, identity: JSON.stringify }, filterRows: nowFilter, now: () => new Date(NOW),
    validateActor: actor => actor?.account_id === 'account-a', readConflict: async () => conflict,
    resolveConflict: async () => { called = true; return { resolved: true }; } });
  await assert.rejects(store.resolve({ id: conflict.id, branch_identity: JSON.stringify(invalid) }, { actor: accountActor }), /effect|rule/);
  assert.equal(called, false);
});

test('a policy change racing after authorization loses the expected-identity write', async () => {
  const { store } = world({});
  const racing = makeShowRules({ records: { ...store, read: () => ({}), write: () => ({ written: 0, conflicts: [{ address: 'show-rules' }] }), identity: value => JSON.stringify(value), update() {} },
    filterRows: nowFilter, now: () => new Date(NOW), validateActor: actor => actor?.account_id === 'account-a' });
  await assert.rejects(racing.set({ rule }, { actor: { account_id: 'account-a' } }), /changed while this edit was being saved/);
});

test('a given operator policy change after authorization is detected before persistence', async () => {
  let reads = 0;
  const audience = { kind: 'group', combinator: 'and', negate: false, rules: [] };
  const deny = { id: 'new-operator-deny', effect: 'deny', who: { kind: 'account_owner' }, actions: ['change_rule'], audience };
  const givenSource = async () => ({
    giver: { edit_rules: ++reads <= 2 ? [] : [deny] },
    facts: { cohorts: [] },
    matches: async () => true,
  });
  let writes = 0;
  const { records } = world(null);
  const racing = makeShowRules({ records: { ...records, write: () => { writes++; return { written: 1 }; } },
    filterRows: nowFilter, now: () => new Date(NOW), validateActor: actor => actor?.account_id === 'account-a', givenSource });
  await assert.rejects(racing.set({ rule }, { actor: { account_id: 'account-a' } }), /authority changed during this edit/);
  assert.equal(writes, 0, 'the current rule record is not written after the policy snapshot changes');
});

test('an allow expiring during the final policy-snapshot await cannot authorize a write', async () => {
  let at = NOW, calls = 0, writes = 0;
  const allow = { id: 'short-allow', effect: 'allow', who: { kind: 'account_owner' }, actions: ['change_rule'], until: new Date(NOW + 60_000).toISOString() };
  const { records } = world({ edit_rules: [allow] });
  const expiring = makeShowRules({ records: { ...records, write: (...args) => { writes++; return records.write(...args); } },
    filterRows: nowFilter, now: () => new Date(at), validateActor: actor => actor?.account_id === 'account-a',
    givenSource: async () => {
      calls++;
      if (calls === 5) at = NOW + 60_000;
      return null;
    } });
  await assert.rejects(expiring.set({ rule }, { actor: accountActor }), /expired during validation/);
  assert.equal(calls, 5, 'the advance occurs during the final source snapshot read');
  assert.equal(writes, 0);
});


test('declared attributes use the same actor, edit policy, expected identity and expiry as rule edits', async () => {
  const kept = new Map();
  const records = { read: label => kept.get(label) ?? null, identity: JSON.stringify,
    write(writes) { const write = writes[0]; const before = kept.get(write.address_label) ?? null;
      assert.equal(write.expected_identity, before ? JSON.stringify(before) : null);
      kept.set(write.address_label, write.payload); return { written: 1 }; },
    update(label, change) { kept.set(label, change(kept.get(label) ?? null)); } };
  const store = makeShowRules({ records, authority: 'operator', filterRows: nowFilter, now: () => new Date(NOW),
    validateActor: actor => actor?.account_id === 'account-a' });
  await assert.rejects(store.set({ attribute: { id: 'departments', label: 'Departments' } }), /authenticated account actor/);
  assert.equal(kept.has('show-rules'), false);
  const result = await store.set({ attribute: { id: 'departments', label: 'Departments' } }, { actor: accountActor });
  assert.deepEqual(result.attribute, { id: 'departments', label: 'Departments', kind: 'tags' });
  await store.set({ rule }, { actor: accountActor });
  assert.deepEqual(kept.get('show-rules').attribute_fields, [result.attribute], 'ordinary edits preserve declared attributes');
  await store.set({ give: { account_id: 'account-b', attributes: { departments: { add: ['design'] } } } }, { actor: accountActor });
  assert.deepEqual(kept.get('setup-context').accounts['account-b'].attributes, { departments: ['design'] });
  const deny = { id: 'deny-attribute', effect: 'deny', who: { kind: 'reader', reader: 'app:blocked' }, actions: ['change_attribute'] };
  await store.set({ edit_rules: [...showRuleData.edit_authority.starting_rules, deny] }, { actor: accountActor });
  const before = structuredClone(kept.get('show-rules'));
  await assert.rejects(store.set({ attribute: { id: 'teams', label: 'Teams' } }, { actor: { ...accountActor, reader: 'app:blocked' } }), /change attribute/);
  assert.deepEqual(kept.get('show-rules'), before);
});

test('self-assignment checks proposed declared attribute audiences without replacing actual plan facts', async () => {
  const audience = { kind: 'group', combinator: 'and', negate: false, rules: [
    { kind: 'rule', field: 'departments', operator: 'has_any_of', params: { values: ['restricted'] } },
    { kind: 'rule', field: 'plan', operator: 'is_any_of', params: { values: ['paid'] } },
  ] };
  const deny = { id: 'deny-assignment', effect: 'deny', who: { kind: 'account_owner' }, actions: ['change_assignment'] };
  const policy = { attribute_fields: [{ id: 'departments', label: 'Departments', kind: 'tags' }],
    types: [{ id: 'restricted', label: 'Restricted', inherits: [], rules: [], edit_rules: [deny], audience }] };
  const kept = new Map([['show-rules', policy], ['setup-context', { accounts: { 'account-a': { cohorts: [], experiments: [], attributes: { departments: [] } } } }]]);
  let writes = 0;
  const matches = (tree, facts) => nowFilter({ tree, fields: [...accountFactsData.facts, ...policy.attribute_fields], rows: [facts] }).matches.length === 1;
  const store = makeShowRules({ records: { read: label => kept.get(label) ?? null,
    update(label, change) { const value = change(kept.get(label) ?? null); writes++; kept.set(label, value); } },
    authority: 'operator', filterRows: nowFilter, now: () => new Date(NOW), validateActor: actor => actor?.account_id === 'account-a',
    givenSource: async () => ({ giver: policy, facts: { plan: 'paid', cohorts: [], experiments: [], departments: [] }, matches,
      stamp: JSON.stringify([policy, kept.get('setup-context')]) }) });
  const before = structuredClone(kept.get('setup-context'));
  await assert.rejects(store.set({ give: { account_id: 'account-a', attributes: { departments: { add: ['restricted'] } } } }, { actor: accountActor }), /stop the actor from changing assignments again/);
  assert.equal(writes, 0);
  assert.deepEqual(kept.get('setup-context'), before);
});
