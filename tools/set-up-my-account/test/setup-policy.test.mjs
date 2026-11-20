// Setup policy at the real setup/rules boundary, ported from the retired repository test/setup-policy.test.mjs (tag
// before-worker-retire, b6ae0ebf81; not moved with the rest: only setup-policy-formula.test.mjs was) with its
// assertions kept. Conditional rule semantics have a separate test against the compiled formula evaluator
// (setup-policy-formula.test.mjs); injected answers here test the evaluator's incomplete/error contract.
// What differs from the old file: the evaluator is the formula-engine tool's compiled bytes; the recipe is the row
// tools/workflows/recipes/setup-with-your-ai.json; the rules store (tools/decide-when-things-show) keeps its changes for the
// caller to write (held / changes()) where the old one wrote a records handle; the experiment bucket is the funnels-screen
// copy of score-candidates.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { setupStepsWithRules as composeSetup, readSetupPolicy } from '../read-data/setup-steps.mjs';
import { makeShowRules } from '../../decide-when-things-show/read-data/show-rules-store.mjs';
import { provenSetup } from './setup-fixtures.mjs';
import capabilityPolicy from '../read-data/setup-policy.json' with { type: 'json' };
import setupRecipes from '../../workflows/recipes/setup-with-your-ai.json' with { type: 'json' };
import { recipeProblems } from '../../workflows/read-data/recipe-problems.mjs';
import { observerBucket } from '../../funnels-screen/read-data/score-candidates.ts';
import { initSync, filterRecords } from '../../formula-engine/built-stored-bytes/formula-engine/formula_engine.js';
initSync({ module: readFileSync(new URL('../../formula-engine/built-stored-bytes/formula-engine/formula_engine_bg.wasm', import.meta.url)) });
const filter = { filterRowsByRulesNow: ({ tree, fields, rows }) => filterRecords({ records: rows, fields, tree }) };

const NOW = Date.parse('2026-10-08T12:00:00Z');
// These boundary tests explicitly turn off the operator's conditional starting rule. The shipped default and
// cohort/account/time conditions are exercised with the real compiled evaluator in setup-policy-formula.test.mjs.
const setupStepsWithRules = input => composeSetup({ filterRows: filter.filterRowsByRulesNow, ...input, sharedRules: { ...input?.sharedRules,
  starting: { ...input?.sharedRules?.starting, 'setup-require-assigned-devices': { on: false } } } });
const ready = { ...provenSetup(), accountId: 'member-a', computers: [], now: NOW };
const tree = (...rules) => ({ kind: 'group', combinator: 'and', negate: false, rules });
const named = field => ({ kind: 'rule', field, operator: 'is_any_of', params: { values: ['ai-connection'] } });
const change = (id, set, when = null) => ({ id, subject: 'setup-step', effect: 'change', when,
  set: Object.entries(set).map(([field, value]) => ({ path: [field], value })) });
const step = (result, id) => result.requirements.find(row => row.id === id);

test('the setup policy binds configuration to the existing recipe without changing the twelve capability contract', () => {
  const policy = capabilityPolicy.workflow;
  const recipe = setupRecipes.records.find(row => row.payload.default_for?.includes(policy.default_for)).payload;
  assert.deepEqual(recipeProblems(recipe), []);
  assert.equal(capabilityPolicy.requirements.length, 12);
  assert.deepEqual(policy.input.required_components, capabilityPolicy.requirements.map(row => row.id));
  assert.equal(policy.configuration_step, 'configure');
  const stages = [
    [policy.inventory_step, 'requirements'], [policy.configuration_step, 'results'], [policy.verification_step, 'verified'],
  ];
  for (const [id, field] of stages) {
    const stage = recipe.steps.find(row => row.id === id), item = stage.submit.properties[field].items;
    assert.ok(stage.submit.required.includes(field));
    for (const scope of ['scope_ids', 'harness_scopes']) assert.ok(item.required.includes(scope), `${id} already admits ${scope}`);
  }
  for (const id of [policy.configuration_step, policy.verification_step]) {
    const checks = recipe.steps.find(row => row.id === id).checks;
    assert.ok(checks.some(row => row.kind === 'covers' && row.of[1] === policy.inventory_step));
    assert.ok(checks.some(row => row.kind === 'subset-of' && row.of[1] === policy.inventory_step));
  }
});

test('the base requirements remain unchanged and personal presentation cannot invent completion', async () => {
  const first = await setupStepsWithRules(ready);
  assert.equal(first.complete, true);
  assert.equal(first.steps.length, 12);
  assert.deepEqual(first.requirements.filter(row => row.required).map(row => row.id), [...capabilityPolicy.requirements.map(row => row.id), 'desktop']);
  assert.equal(step(first, 'watch'), undefined);
  const custom = await setupStepsWithRules({ ...ready, aiConnected: false,
    ownRules: { rules: [change('wording', { title: 'Your next step', body: 'Use the connection you chose.' })] } });
  assert.equal(custom.complete, false);
  assert.equal(step(custom, 'ai-connection').title, 'Your next step');
  assert.equal(step(custom, 'ai-connection').done, false);
  assert.deepEqual(step(custom, 'ai-connection').action, { label: 'Connect an AI', tone: 'quiet', open: '/ai' }, 'presentation rules change the words, never the destination');
  assert.ok(custom.policy.applied.some(row => row.source === 'personal' && row.rule === 'wording'));
  assert.match(custom.policy.source_version, /^1f:[a-f0-9]{64}$/);
});

test('only a verified operator policy can resolve to an empty required set', async () => {
  const rules = { rules: [change('control-cohort', { required: false, applicable: false })] };
  const control = await setupStepsWithRules({ ...ready, aiConnected: false, sharedRules: rules });
  assert.equal(control.complete, false, 'a policy waiver does not complete the full runtime');
  assert.equal(control.requirements_complete, true);
  assert.equal(control.workspace_ready, true);
  assert.equal(control.workspace_mode, 'configured');
  assert.equal(control.policy.requirements_resolved, true);
  assert.equal(control.policy.required_count, 0);
  assert.deepEqual(control.steps, []);
  assert.ok(control.policy.excluded.some(row => row.step === 'ai-connection' && row.rules.some(rule => rule.source === 'operator')));
  const selfWaived = await setupStepsWithRules({ ...ready, aiConnected: false, ownRules: rules });
  assert.equal(selfWaived.complete, false);
  assert.equal(selfWaived.policy.required_count, 13);
  assert.equal(step(selfWaived, 'ai-connection').required, true);
  for (const unknown of [{ sharedRulesKnown: false }, { contextKnown: false }, { accountId: null }]) {
    const result = await setupStepsWithRules({ ...ready, sharedRules: rules, ...unknown });
    assert.equal(result.complete, false);
    assert.equal(result.policy.requirements_resolved, false);
    assert.equal(step(result, 'setup-policy'), undefined, 'an unresolved policy is a status line, not a step');
  }
  const malformed = await setupStepsWithRules({ ...ready, sharedRules: { rules: [change('bad-waiver', { required: 'false' })] } });
  assert.equal(malformed.complete, false);
  assert.equal(malformed.policy.requirements_resolved, false);
});

test('a required inaccessible app exposes its factual prerequisite and recovery, then installation is read back', async () => {
  const prerequisite = { owner: 'device-distribution', source_id: 'ios-beta', state: 'invitation-required',
    reason: 'Your tester access is not confirmed.', next_action: 'request-access' };
  const device = { id: 'iphone', installed: false, get: [{ available: false, state: prerequisite.state, source_id: 'ios-beta',
    href: 'https://unverified.example/install', checked_at: new Date(NOW - 60_000).toISOString(),
    expires_at: new Date(NOW + 30_000).toISOString(), prerequisite, recovery: { label: 'Check app access', href: '/devices' } }] };
  const input = { ...ready, devices: [device], sharedRules: { rules: [change('required', { required: true, applicable: true })] } };
  const blocked = await setupStepsWithRules(input);
  assert.equal(blocked.complete, false);
  assert.equal(step(blocked, 'iphone').required, true);
  assert.equal(step(blocked, 'iphone').done, false);
  assert.equal(step(blocked, 'iphone').available, false);
  assert.equal(step(blocked, 'iphone').source_id, 'ios-beta');
  assert.equal(step(blocked, 'iphone').blocked.owner, 'device-distribution');
  assert.deepEqual(step(blocked, 'iphone').prerequisites, [prerequisite]);
  assert.equal(step(blocked, 'iphone').body, prerequisite.reason);
  assert.equal(step(blocked, 'iphone').action.href, '/devices');
  assert.equal(step(blocked, 'iphone').checked_at, undefined, 'an unavailable fallback cannot supply a usable route timestamp');
  assert.equal(step(blocked, 'iphone').expires_at, undefined);
  assert.ok(!JSON.stringify(step(blocked, 'iphone')).includes('unverified.example'));
  const verified = { ...device.get[0], available: true, state: 'ready', href: 'https://verified.example/install',
    checked_at: new Date(NOW).toISOString(), expires_at: new Date(NOW + 60_000).toISOString() };
  const open = await setupStepsWithRules({ ...input, devices: [{ ...device, get: [device.get[0], verified] }],
    ownRules: { rules: [change('forge-freshness', { checked_at: new Date(NOW + 99_000).toISOString(), expires_at: '2999-01-01T00:00:00.000Z' })] } });
  assert.equal(step(open, 'iphone').action.href, 'https://verified.example/install');
  assert.equal(step(open, 'iphone').checked_at, verified.checked_at);
  assert.equal(step(open, 'iphone').expires_at, verified.expires_at);
  assert.ok(open.policy.problems.some(row => row.rule === 'forge-freshness' && row.source === 'personal'));
  assert.equal(step(open, 'iphone').done, false, 'an accessible download is not an installed app');
  const installed = await setupStepsWithRules({ ...input, devices: [{ ...device, installed: true }] });
  assert.equal(step(installed, 'iphone').done, true);
  assert.equal(step(installed, 'iphone').action, undefined);
});

test('requiring a candidate hidden by default cannot silently discard its requirement', async () => {
  const result = await setupStepsWithRules({ ...ready, sharedRules: { rules: [change('require', { required: true })] } });
  assert.equal(result.complete, false);
  assert.equal(step(result, 'watch').required, true);
  assert.ok(result.policy.problems.some(row => row.step === 'watch' && row.reason === 'required-step-needs-explicit-applicability'));
});

test('neither personal rules nor raw records can waive an operator mandate or forge owner facts', async () => {
  const mandate = { rules: [change('mandate', { required: true, applicable: true })] };
  for (const fields of [{ required: false }, { applicable: false }, { done: true }, { available: true }, { owner: 'ai-connection' }, { device: 'desktop' }]) {
    const result = await setupStepsWithRules({ ...ready, sharedRules: mandate,
      ownRules: { starting: { mandate: { on: false } }, rules: [change('mandate', fields)] } });
    assert.equal(result.complete, false);
    assert.equal(step(result, 'iphone').required, true);
    assert.equal(step(result, 'iphone').done, false);
    assert.ok(result.policy.problems.some(row => row.source === 'personal' && row.rule === 'mandate'));
    assert.ok(!result.policy.applied.some(row => row.source === 'personal'));
  }
  for (const set of [[{ path: ['action', 'href'], value: 'https://attacker.example' }], [{ path: ['__proto__', 'done'], value: true }]]) {
    const result = await setupStepsWithRules({ ...ready, ownRules: { rules: [{ ...change('raw', {}), set }] } });
    assert.ok(result.policy.problems.some(row => row.source === 'personal'));
    assert.ok([undefined, '/ai'].includes(step(result, 'ai-connection').action?.open), 'a raw record cannot forge a destination');
    assert.doesNotMatch(JSON.stringify(step(result, 'ai-connection')), /attacker/);
  }
});

test('invalid operator records remain visibly unresolved and recover after the same record is repaired', async () => {
  for (const sharedRules of [{ rules: 'not-a-list' }, { rules: [change('forge', { done: true })] },
    { rules: [{ ...change('hide', {}), effect: 'hide' }] }, { rules: [change('a', { title: 'One' }), change('a', { title: 'Two' })] }]) {
    const result = await setupStepsWithRules({ ...ready, sharedRules });
    assert.equal(result.complete, false);
    assert.equal(result.notice.id, 'setup-policy', 'a blocking policy problem is named on the status line');
    assert.ok(result.notice.href.startsWith('mailto:'));
  }
  const failed = await setupStepsWithRules({ ...ready, sharedRulesKnown: false });
  assert.equal(failed.complete, false);
  assert.equal(failed.policy.sources.shared_known, false);
  assert.equal((await setupStepsWithRules({ ...ready, sharedRules: { rules: [] } })).complete, true);
});

test('unfinished conditions cannot turn a matches-all evaluator answer into an eligibility waiver', async () => {
  const input = { ...ready, sharedRules: { rules: [change('unfinished', { applicable: false }, tree(named('step')))] } };
  const result = await setupStepsWithRules({ ...input, filterRows: async () => ({ matches: [0], incomplete: [{ field: 'step' }] }) });
  assert.equal(result.complete, false);
  assert.equal(result.policy.requirements_resolved, false);
  assert.equal(step(result, 'ai-connection').required, true);
  assert.deepEqual(result.policy.applied, []);
  assert.ok(result.policy.problems.some(row => row.rule === 'unfinished' && row.blocking));
  const unavailable = await setupStepsWithRules({ ...input, filterRows: async () => { throw new Error('Evaluator unavailable'); } });
  assert.equal(unavailable.complete, false);
  assert.equal(unavailable.policy.requirements_resolved, false);
  assert.equal(step(unavailable, 'setup-policy'), undefined, 'an unresolved policy is a status line, not a step');
});

test('empty and malformed conditions are invalid before any evaluator can omit them', async () => {
  let calls = 0;
  for (const when of [tree(), { kind: 'group', rules: 'bad' }, { ...tree(named('step')), combinator: 'invented' },
    { ...tree(named('step')), negate: 'false' }]) {
    const result = await setupStepsWithRules({ ...ready, sharedRules: { rules: [change('invalid', { required: false }, when)] },
      filterRows: () => { calls += 1; throw new Error('must not evaluate'); } });
    assert.equal(result.complete, false);
    assert.equal(step(result, 'ai-connection').required, true);
  }
  assert.equal(calls, 0);
});

test('selection cannot depend on personally editable inventory or the current browser', async () => {
  for (const field of ['preferred_devices', 'preferences', 'system']) {
    const result = await setupStepsWithRules({ ...ready, personalContext: { owned_devices: [], preferences: [] }, system: 'windows',
      sharedRules: { rules: [change('waive-from-person', { required: false }, tree(named(field)))] } });
    assert.equal(result.complete, false);
    assert.ok(result.policy.problems.some(row => /personal declaration/.test(row.reason)));
    assert.equal(step(result, 'ai-connection').required, true);
  }
});

test('the existing rules API exposes authorized changes and refuses unauthorized writes before persistence', async () => {
  // The store keeps its changes for the caller to write (changes()); the caller hands the next store what it kept, as the row's caller does.
  const held = {};
  let writes = 0;
  const filterRows = filter.filterRowsByRulesNow;
  const validateActor = actor => actor?.account_id === 'member-a';
  const store = authority => {
    const owner = makeShowRules({ held, filterRows, validateActor, authority, now: () => new Date(NOW) });
    const kept = async run => { const answer = await run(owner); for (const { label, value } of owner.changes()) { held[label] = value; writes += 1; } return answer; };
    return { read: () => owner.read(), set: (input, options) => kept(it => it.set(input, options)), remove: (input, options) => kept(it => it.remove(input, options)) };
  };
  const own = store('personal');
  const actor = { account_id: 'member-a' };
  assert.equal((await own.read()).authority, 'personal');
  assert.ok(!(await own.read()).subjects['setup-step'].change_fields.some(field => field.path[0] === 'required'));
  await assert.rejects(own.set({ rule: change('waive', { required: false }) }, { actor }), /Only the operator/);
  await assert.rejects(own.set({ rule: change('hide', { applicable: false }) }, { actor }), /Only the operator/);
  await assert.rejects(own.set({ starting: { id: 'setup-require-assigned-devices', on: false } }, { actor }), /Only the operator/);
  await assert.rejects(own.remove({ id: 'setup-require-assigned-devices' }, { actor }), /Only the operator/);
  assert.equal(writes, 0, 'a refused change writes nothing');
  const operator = store('operator');
  assert.equal((await operator.read()).record, 'show-rules');
  assert.ok((await operator.read()).subjects['setup-step'].change_fields.some(field => field.path[0] === 'required'));
  await operator.set({ rule: change('mandate', { required: true, applicable: true }) }, { actor });
  assert.equal(held['show-rules'].rules.length, 1);
  await operator.set({ rule: change('mandate', { title: 'Updated wording' }) }, { actor });
  assert.equal(held['show-rules'].rules.length, 1, 'the existing same-id update remains the owner');
  await operator.remove({ id: 'mandate' }, { actor });
  assert.equal(held['show-rules'].rules.length, 0);
  assert.equal(writes, 3, 'all changes go through the existing versioned record writer');
});

test('persisted context reads only the signed-in account and keeps personal declarations separate', async () => {
  const seen = [];
  const shared = { rules: [change('words', { title: 'Welcome' }), { id: 'private-other-surface', subject: 'notification', effect: 'hide' }] };
  const operator = { workspaceRecord: async label => {
    seen.push(['operator', label]);
    return label === 'show-rules' ? shared : { accounts: { 'member-a': { cohorts: ['pilot'], owned_devices: ['watch'] },
      'member-b': { cohorts: ['private-other-account'] } } };
  } };
  const own = { fetch: async request => {
    const url = new URL(request.url);
    seen.push(['own', url.pathname]);
    return url.pathname === '/show-rules' ? Response.json({ rules: [] })
      : Response.json({ records: { 'setup-context': { account_id: 'member-b', bucket: 99, owned_devices: ['desktop'] } } });
  } };
  const loaded = await readSetupPolicy({ own, operator, accountId: 'member-a' });
  assert.deepEqual(loaded.context, { cohorts: ['pilot'], owned_devices: ['watch'] });
  assert.deepEqual(loaded.personalContext.owned_devices, ['desktop']);
  assert.equal(loaded.accountId, 'member-a');
  assert.deepEqual(seen.sort(), [['operator', 'setup-context'], ['operator', 'show-rules'], ['own', '/records'], ['own', '/show-rules']].sort());
  const result = await setupStepsWithRules({ ...ready, ...loaded });
  assert.equal(result.complete, true);
  assert.ok(!JSON.stringify(result).includes('private-other'));
  const same = await setupStepsWithRules({ ...ready, ...loaded, sharedRules: { rules: [shared.rules[0]] } });
  assert.equal(result.policy.source_version, same.policy.source_version, 'unrelated operator records do not enter the policy projection');
});

test('the account\'s own rules and setup context are read from its own records resource, never PersonStore\'s copy', async () => {
  const seen = [];
  const operator = { workspaceRecord: async label => (label === 'show-rules' ? { rules: [] } : { accounts: { 'member-a': { cohorts: ['pilot'] } } }) };
  const own = { fetch: async request => {
    const url = new URL(request.url);
    seen.push(`${url.pathname}${url.search}`);
    return url.pathname === '/show-rules' ? Response.json({ rules: [change('words', { title: 'Mine' })] })
      : Response.json({ records: { 'setup-context': { owned_devices: ['phone'] } } });
  } };
  const loaded = await readSetupPolicy({ own, operator, accountId: 'member-a' });
  assert.deepEqual(seen.sort(), ['/records?label=setup-context', '/show-rules']);
  assert.deepEqual([loaded.ownRulesKnown, loaded.personalContextKnown], [true, true]);
  assert.deepEqual(loaded.ownRules.rules.map(rule => rule.id), [change('words', { title: 'Mine' }).id]);
  assert.deepEqual(loaded.personalContext, { owned_devices: ['phone'] });
  const unread = await readSetupPolicy({ own: { fetch: async () => Response.json({ error: 'no' }, { status: 503 }) }, operator, accountId: 'member-a' });
  assert.deepEqual([unread.ownRulesKnown, unread.personalContextKnown], [false, false], 'an unreadable own resource is unknown, never PersonStore\'s copy');
});

test('failed operator context reads are unknown while failed personal presentation reads do not waive or add requirements', async () => {
  const own = { fetch: async () => new Response('unavailable', { status: 503 }) };
  const operator = { workspaceRecord: () => { throw new Error('unavailable'); } };
  const failed = await readSetupPolicy({ own, operator, accountId: ready.accountId });
  assert.equal(failed.contextKnown, false);
  assert.equal((await setupStepsWithRules({ ...ready, ...failed })).complete, false);
  const ownFailure = await readSetupPolicy({ own, operator: null, accountId: ready.accountId });
  assert.equal((await setupStepsWithRules({ ...ready, ...ownFailure })).complete, false, 'a missing operator is an unreadable authority source');
  const emptyOperator = { workspaceRecord: async () => null };
  const defaultPolicy = await readSetupPolicy({ own, operator: emptyOperator, accountId: ready.accountId });
  assert.equal((await setupStepsWithRules({ ...ready, ...defaultPolicy })).complete, true, 'an explicit empty operator record is the base policy');
});

test('settled setup read failures log only their fixed source and classified code, then recover without a waiver', async t => {
  const logged = t.mock.method(console, 'error', () => {});
  const privateText = 'private record and credential must never appear';
  const operator = { workspaceRecord: async label => {
    throw Object.assign(new Error(privateText), label === 'show-rules'
      ? { failure_code: 'use-budget-reached' } : { overloaded: true });
  } };
  const own = { fetch: async () => { throw Object.assign(new Error(privateText), { retryable: true }); } };
  const failed = await readSetupPolicy({ own, operator, accountId: privateText });
  assert.deepEqual(logged.mock.calls.map(call => JSON.parse(call.arguments[0])), [
    { event: 'setup_policy_read_failed', source: 'operator_shared_rules', code: 'use-budget-reached' },
    { event: 'setup_policy_read_failed', source: 'personal_rules', code: 'service-interrupted' },
    { event: 'setup_policy_read_failed', source: 'operator_context', code: 'service-busy' },
    { event: 'setup_policy_read_failed', source: 'personal_context', code: 'service-interrupted' },
  ]);
  assert.ok(logged.mock.calls.every(call => call.arguments.length === 1));
  assert.ok(!JSON.stringify(logged.mock.calls.map(call => call.arguments)).includes(privateText));
  for (const flag of ['sharedRulesKnown', 'ownRulesKnown', 'contextKnown', 'personalContextKnown']) assert.equal(failed[flag], false);
  assert.equal((await setupStepsWithRules({ ...ready, ...failed })).workspace_ready, false);

  const recovered = await readSetupPolicy({ accountId: ready.accountId,
    operator: { workspaceRecord: async () => null },
    own: { fetch: async () => Response.json({ rules: [], records: {} }) },
  });
  assert.equal((await setupStepsWithRules({ ...ready, ...recovered })).workspace_ready, true);
  assert.equal(logged.mock.calls.length, 4, 'successful empty records have no failure diagnostic');
});

test('a malformed rejection cannot make setup diagnostics throw or expose the rejection value', async t => {
  const logged = t.mock.method(console, 'error', () => {});
  const rejected = { get failure_code() { throw new Error('private diagnostic detail'); } };
  const own = { fetch: async () => Response.json({ rules: [], records: {} }) };
  const operator = { workspaceRecord: async label => { if (label === 'show-rules') throw rejected; return null; } };
  const failed = await readSetupPolicy({ own, operator, accountId: ready.accountId });
  assert.equal(failed.sharedRulesKnown, false);
  assert.equal(failed.contextKnown, true);
  assert.equal((await setupStepsWithRules({ ...ready, ...failed })).workspace_ready, false);
  assert.deepEqual(logged.mock.calls.map(call => call.arguments), [
    [JSON.stringify({ event: 'setup_policy_read_failed', source: 'operator_shared_rules', code: 'unexpected' })],
  ]);
  await readSetupPolicy({ own, operator: null, accountId: ready.accountId });
  assert.equal(logged.mock.calls.length, 1, 'an absent operator is unknown, not a rejected read');
});

test('experiment group assignment uses the existing stable observer hash and rejects missing identity', () => {
  assert.equal(observerBucket('setup-v1:member-a', 100), observerBucket('setup-v1:member-a', 100));
  const buckets = Array.from({ length: 100 }, (_, index) => observerBucket(`setup-v1:member-${index}`, 100));
  assert.ok(buckets.every(bucket => Number.isInteger(bucket) && bucket >= 0 && bucket < 100));
  assert.ok(new Set(buckets).size > 1);
  for (const [key, count] of [['', 100], ['member', 0], ['member', 2.5]]) assert.throws(() => observerBucket(key, count));
});
