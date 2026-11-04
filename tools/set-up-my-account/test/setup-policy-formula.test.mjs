// Conditional onboarding policy exercised through Trillion's actual compiled formula evaluator. A missing evaluator
// artifact is a test-environment failure; no mock or alternate interpreter stands in for it.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import operators from '../../formula-engine/rules/rule-operators.json' with { type: 'json' };
import { makeRowFilter } from '../../formula-engine/rules/filter-rows-by-rules.mjs';
import { setupStepsWithRules, readSetupPolicy } from '../read-data/setup-steps.mjs';
import { provenSetup, pendingSetup } from './setup-fixtures.mjs';
import { observerBucket } from '../../funnels-screen/read-data/score-candidates.ts';
import computerRows from '../../run-on-a-persons-computer/computer-sources.json' with { type: 'json' };

const filter = makeRowFilter({ operators, wasm: () => readFileSync(new URL('../../formula-engine/built-stored-bytes/evaluate-over-rows/evaluate-over-rows_bg.wasm', import.meta.url)) });
await filter.load();
const NOW = Date.parse('2026-10-08T12:00:00Z');
const inputs = { ...provenSetup(), accountId: 'member-a', computers: [], now: NOW,
  devices: ['iphone', 'watch', 'desktop', 'extension'].map(id => ({ id, installed: id === 'desktop', get: [{ available: null, state: 'unknown',
    source_id: `${id}-source`, recovery: { label: 'Check access', href: '/devices' } }] })), filterRows: filter.filterRowsByRulesNow };
const tree = (...rules) => ({ kind: 'group', combinator: 'and', negate: false, rules });
const condition = (field, operator, params) => ({ kind: 'rule', field, operator, params });
const is = (field, value) => condition(field, 'is_any_of', { values: [value] });
const policy = (id, when, fields, extra = {}) => ({ id, subject: 'setup-step', effect: 'change', when,
  set: Object.entries(fields).map(([field, value]) => ({ path: [field], value })), ...extra });
const step = (result, id) => result.requirements.find(row => row.id === id);

test('the shipped assignment rule requires only the device IDs in this account’s trusted context record', async () => {
  assert.equal((await setupStepsWithRules(inputs)).complete, true, 'an empty known assignment preserves optional device defaults');
  const own = { fetch: async () => Response.json({ rules: [], records: { 'setup-context': { required_devices: { watch: true }, account_id: 'other' } } }) };
  let assigned = { accounts: { 'member-a': { required_devices: { iphone: true } }, other: { required_devices: { watch: true } } } };
  const operator = { workspaceRecord: async label => label === 'setup-context' ? assigned : null };
  const read = () => readSetupPolicy({ own, operator, accountId: inputs.accountId });
  const first = await setupStepsWithRules({ ...inputs, ...await read() });
  assert.equal(step(first, 'iphone').required, true);
  assert.equal(step(first, 'watch'), undefined);
  assert.equal(first.complete, false);
  assert.ok(first.policy.applied.some(row => row.rule === 'setup-require-assigned-devices' && row.source === 'defaults'));
  assigned = { accounts: { 'member-a': { required_devices: { iphone: true, watch: true } } } };
  const second = await setupStepsWithRules({ ...inputs, ...await read() });
  assert.equal(step(second, 'watch').required, true);
  assert.notEqual(second.policy.source_version, first.policy.source_version);
  const complete = await setupStepsWithRules({ ...inputs, ...await read(), devices: inputs.devices.map(row => ({ ...row, installed: true })) });
  assert.equal(complete.complete, true, 'only factual installation readback completes assigned devices');
});

test('cohort and individual rules select different steps, and personal rules cannot remove a mandate', async () => {
  const sharedRules = { rules: [
    policy('watch-pilot', tree(is('step', 'watch'), condition('cohorts', 'has_any_of', { values: ['pilot'] })), { required: true, applicable: true }),
    policy('iphone-for-one', tree(is('step', 'iphone'), is('account_id', 'member-a')), { required: true, applicable: true, title: 'Install on your iPhone' }),
  ] };
  const one = await setupStepsWithRules({ ...inputs, sharedRules, context: { cohorts: ['pilot'] }, ownRules: {
    starting: { 'setup-require-assigned-devices': { on: false } }, rules: [policy('self-waive', null, { applicable: false, required: false })] } });
  assert.equal(step(one, 'watch').required, true);
  assert.equal(step(one, 'iphone').required, true);
  assert.equal(one.complete, false);
  const other = await setupStepsWithRules({ ...inputs, sharedRules, accountId: 'member-b', context: { cohorts: [] } });
  assert.equal(step(other, 'watch'), undefined);
  assert.equal(step(other, 'iphone'), undefined);
  assert.equal(other.complete, true);
});

test('an explicitly selected control cohort has a resolved empty requirement set', async () => {
  const sharedRules = { rules: [policy('control-cohort', tree(condition('cohorts', 'has_any_of', { values: ['control'] })), { required: false })] };
  const control = await setupStepsWithRules({ ...inputs, aiConnected: false, context: { cohorts: ['control'] }, sharedRules });
  assert.equal(control.complete, false, 'the full runtime proof remains false');
  assert.equal(control.requirements_complete, true);
  assert.equal(control.workspace_ready, true);
  assert.equal(control.workspace_mode, 'configured');
  assert.equal(control.policy.requirements_resolved, true);
  assert.equal(control.policy.required_count, 0);
  assert.equal(step(control, 'ai-connection').done, false, 'removing a requirement never invents completion');
  const comparison = await setupStepsWithRules({ ...inputs, aiConnected: false, context: { cohorts: [] }, sharedRules });
  assert.equal(comparison.complete, false);
  assert.equal(comparison.policy.requirements_resolved, true);
  assert.equal(comparison.policy.required_count, 13);
  const unreadable = await setupStepsWithRules({ ...inputs, contextKnown: false, sharedRules });
  assert.equal(unreadable.complete, false);
  assert.equal(unreadable.policy.requirements_resolved, false);
});

test('time-bounded rules expire and explicit applicability exclusions retain their provenance', async () => {
  const until = NOW + 60_000;
  const sharedRules = { rules: [
    policy('temporary-requirement', tree(is('step', 'iphone')), { required: true, applicable: true }, { until: new Date(until).toISOString() }),
    policy('watch-not-for-this-account', tree(is('step', 'watch')), { applicable: false }),
  ] };
  const before = await setupStepsWithRules({ ...inputs, sharedRules });
  assert.equal(step(before, 'iphone').required, true);
  assert.equal(before.policy.next_change_at, until);
  assert.ok(before.policy.excluded.some(row => row.step === 'watch' && row.rules.some(rule => rule.rule === 'watch-not-for-this-account')));
  const after = await setupStepsWithRules({ ...inputs, sharedRules, now: until + 1 });
  assert.equal(step(after, 'iphone'), undefined);
  assert.equal(after.complete, true);
});

test('stable experiment buckets and trusted assignments customize steps while edited identity and bucket facts have no effect', async () => {
  const ownBucket = observerBucket(`setup-v1:${inputs.accountId}`, 100);
  const sharedRules = { rules: [policy('bucket-words', tree(is('step', 'ai-connection'), condition('bucket', 'between', { min: ownBucket, max: ownBucket }),
    condition('experiments', 'has_any_of', { values: ['setup-copy-v2'] })), { title: 'Your assigned connection step' })] };
  const input = { ...inputs, sharedRules, context: { account_id: 'forged', bucket: -1, experiments: ['setup-copy-v2'] },
    personalContext: { account_id: 'other', bucket: 999, experiments: [] } };
  const first = await setupStepsWithRules(input);
  const repeat = await setupStepsWithRules(input);
  assert.equal(step(first, 'ai-connection').title, 'Your assigned connection step');
  assert.equal(step(repeat, 'ai-connection').title, step(first, 'ai-connection').title);
  assert.equal(first.policy.source_version, repeat.policy.source_version);
});

test('missing facts stay unresolved under negation and unfinished rules cannot waive requirements', async () => {
  const cases = [
    policy('unknown-availability', tree(is('step', 'iphone'), condition('available', 'is_false', {})), { required: false }),
    policy('unfinished', tree(is('step', 'iphone'), condition('bucket', 'less_than', {})), { required: false }),
    policy('unknown-inventory', tree(is('step', 'watch'), condition('owned_devices', 'has_none_of', { values: ['watch'] })), { applicable: false }),
  ];
  for (const rule of cases) {
    const result = await setupStepsWithRules({ ...inputs, context: { required_devices: { iphone: true, watch: true } }, sharedRules: { rules: [rule] } });
    assert.equal(result.complete, false);
    assert.ok(result.policy.problems.some(row => row.rule === rule.id && row.blocking));
    assert.ok(!result.policy.applied.some(row => row.rule === rule.id));
    assert.equal(step(result, 'iphone').required, true);
  }
});

test('missing or malformed trusted context cannot become an empty assignment, and a repaired read recovers', async () => {
  for (const context of [{ required_devices: ['iphone'] }, { required_devices: { iphone: 'true' } }]) {
    const malformed = await setupStepsWithRules({ ...inputs, context });
    assert.equal(malformed.complete, false);
    assert.ok(malformed.policy.problems.some(row => row.reason === 'invalid-context-record'));
  }
  const unknown = await setupStepsWithRules({ ...inputs, contextKnown: false });
  assert.equal(unknown.complete, false);
  assert.equal(unknown.notice?.id, 'setup-policy', 'an unresolved policy is a status line, not a step');
  assert.equal((await setupStepsWithRules({ ...inputs, contextKnown: true, context: {} })).complete, true);
  for (const id of ['unregistered-app', 'notifications']) {
    const missing = await setupStepsWithRules({ ...inputs, context: { required_devices: { [id]: true } } });
    assert.equal(missing.complete, false);
    assert.ok(missing.policy.problems.some(row => row.reason === 'unknown-required-step' && row.step === id));
  }
});

test('rules select an expanded computer switch while its report owns completion and its pane address', async () => {
  const computers = ['mac-a', 'mac-b'].map(computer_id => ({ computer_id, name: computer_id,
    reported_at: new Date(NOW).toISOString(),
    sources: [{ id: 'notes', label: 'Notes', state: 'needs_switch', gate: 'full-disk-access' }],
    gates: { 'full-disk-access': { label: 'Full Disk Access' } } }));
  const selectedId = 'computer-switches:mac-a:full-disk-access';
  const sharedRules = { rules: [policy('selected-computer', tree(is('step', selectedId)),
    { required: true, title: 'Allow Notes on this Mac', action: 'Open the Mac setting' })] };
  const selected = await setupStepsWithRules({ ...inputs, computers, sharedRules });
  assert.equal(selected.complete, false);
  assert.equal(step(selected, selectedId).required, true);
  assert.equal(step(selected, selectedId).title, 'Allow Notes on this Mac');
  assert.equal(step(selected, selectedId).done, false);
  assert.deepEqual(step(selected, selectedId).action, { label: 'Open the Mac setting', tone: 'primary', href: computerRows.gates['full-disk-access'].open });
  assert.equal(step(selected, 'computer-switches:mac-b:full-disk-access').required, false);
  assert.equal(selected.policy.next_change_at, NOW + 72 * 3600_000 + 1);
  const forbidden = await setupStepsWithRules({ ...inputs, computers, sharedRules, ownRules: { rules: [{
    ...policy('forge-report', null, {}), set: [{ path: ['owner_step', 'done'], value: true }],
  }] } });
  assert.equal(step(forbidden, selectedId).done, false);
  assert.ok(forbidden.policy.problems.some(row => row.rule === 'forge-report' && row.source === 'personal'));
  const readBack = await setupStepsWithRules({ ...inputs, sharedRules, computers: computers.map(computer => ({ ...computer,
    sources: computer.sources.map(source => ({ ...source, state: 'reading' })) })) });
  assert.equal(step(readBack, selectedId), undefined, 'the owner no longer reports that pending switch');
  assert.equal(step(readBack, 'computer-switches:mac-a').done, true);
  assert.equal(readBack.complete, true);
});

test('expired computer permission evidence preserves an operator requirement until fresh owner success', async () => {
  const id = 'computer-switches:mac-a:full-disk-access';
  const computer = { computer_id: 'mac-a', name: 'Mac A', reported_at: new Date(NOW).toISOString(),
    sources: [{ id: 'notes', label: 'Notes', state: 'needs_switch', gate: 'full-disk-access' }],
    gates: { 'full-disk-access': { label: 'Full Disk Access' } } };
  const sharedRules = { rules: [policy('required-source-permission', tree(is('step', id)), { required: true })] };
  const inspect = (patch = {}) => setupStepsWithRules({ ...inputs, sharedRules, computers: [computer], ...patch });
  const fresh = await inspect();
  assert.equal(step(fresh, id).required, true);
  assert.equal(step(fresh, id).done, false);
  assert.equal(fresh.workspace_ready, false);

  const later = NOW + 72 * 3600_000 + 1;
  const stale = await inspect({ now: later });
  assert.equal(step(stale, id).required, true, 'expiry cannot erase the selected persisted computer identity');
  assert.equal(step(stale, id).done, null, 'an expired unmet permission is unknown, never completion');
  assert.equal(step(stale, id).next_change_at, null, 'past expiry cannot create a refresh loop');
  assert.equal(stale.complete, false);
  assert.equal(stale.workspace_ready, false);

  const optional = await inspect({ now: later, sharedRules: null });
  assert.equal(step(optional, id).required, false);
  assert.equal(step(optional, id).done, null);
  assert.equal(optional.workspace_ready, true, 'an optional expired switch does not introduce a requirement');

  const recovered = await inspect({ now: later, computers: [{ ...computer, reported_at: new Date(later).toISOString(),
    sources: computer.sources.map(source => ({ ...source, state: 'reading' })) }] });
  assert.equal(step(recovered, id), undefined, 'the fresh owner reports that the required permission no longer waits');
  assert.equal(step(recovered, 'computer-switches:mac-a').done, true);
  assert.equal(recovered.complete, true);
  assert.equal(recovered.workspace_ready, true);
});

test('the next check follows the earliest future rule deadline or factual source expiry', async () => {
  const expires = NOW + 30_000;
  const until = NOW + 60_000;
  const sharedRules = { rules: [policy('temporary-copy', tree(is('step', 'ai-connection')), { title: 'Connect this week' }, { until: new Date(until).toISOString() })] };
  const devices = inputs.devices.map(device => ({ ...device, get: [{ ...device.get[0], expires_at: new Date(expires).toISOString() }] }));
  const before = await setupStepsWithRules({ ...inputs, sharedRules, devices });
  assert.equal(before.policy.next_change_at, expires);
  const afterExpiry = await setupStepsWithRules({ ...inputs, sharedRules, devices, now: expires });
  assert.equal(afterExpiry.policy.next_change_at, until, 'past factual deadlines cannot cause a refresh loop');
  const afterAll = await setupStepsWithRules({ ...inputs, sharedRules, devices, now: until });
  assert.equal(afterAll.policy.next_change_at, null);
});

test('intact admitted device discovery supplies factual prerequisites before final verification and survives a stop', async () => {
  const runtime = structuredClone(inputs.runtime);
  Object.assign(runtime.workflow, { verified: false, state: 'working', inventory_admitted_at: new Date(NOW).toISOString() });
  runtime.workflow.inventory.requirements.find(row => row.id === 'devices').device_ids = ['iphone'];
  const devices = inputs.devices.map(device => device.id !== 'iphone' ? device : { ...device, get: [{
    available: false, state: 'invitation-required', source_id: 'ios-beta', checked_at: new Date(NOW).toISOString(),
    expires_at: new Date(NOW + 60_000).toISOString(), recovery: { href: '/devices', label: 'Check access' },
    prerequisite: { owner: 'device-distribution', source_id: 'ios-beta', state: 'invitation-required', reason: 'Tester access must be confirmed.' },
  }] });
  const first = await setupStepsWithRules({ ...inputs, runtime, devices });
  assert.equal(first.complete, false);
  assert.equal(first.requirements_complete, false);
  assert.equal(step(first, 'iphone').required, true);
  assert.equal(step(first, 'iphone').done, false);
  assert.equal(step(first, 'iphone').source_id, 'ios-beta');
  assert.equal(step(first, 'iphone').blocked.owner, 'device-distribution');
  assert.ok(first.person_actions.some(row => row.id === 'iphone'));
  assert.ok(!first.steps.some(row => row.id === 'iphone'), 'native actions do not duplicate the capability progress list');
  assert.match(first.policy.discovery.inventory_identity, /^1f:[0-9a-f]{64}$/);
  runtime.checked_at = new Date(NOW + 1000).toISOString();
  const refreshed = await setupStepsWithRules({ ...inputs, runtime, devices });
  assert.equal(refreshed.policy.source_version, first.policy.source_version, 'a read timestamp does not change the admitted scope');
  runtime.workflow.withdrawn = true;
  const stopped = await setupStepsWithRules({ ...inputs, runtime, devices });
  assert.equal(step(stopped, 'iphone').required, true, 'stopping preparation does not erase an outstanding requirement');
  assert.equal(stopped.workflow.withdrawn, true);
  assert.equal(stopped.complete, false);
  assert.notEqual(stopped.policy.source_version, first.policy.source_version);
  runtime.workflow.withdrawn = false;
  runtime.workflow.run_id = 'run:restarted-setup';
  const restarted = await setupStepsWithRules({ ...inputs, runtime, devices });
  assert.notEqual(restarted.policy.source_version, first.policy.source_version);
});

test('malformed or unadmitted discovery stays unresolved even when a cohort waives all displayed capabilities', async () => {
  const sharedRules = { rules: [policy('control', null, { required: false })] };
  for (const ids of [['unknown-app'], ['iphone', 'iphone'], 'iphone']) {
    const runtime = structuredClone(inputs.runtime);
    runtime.workflow.inventory.requirements.find(row => row.id === 'devices').device_ids = ids;
    const result = await setupStepsWithRules({ ...inputs, runtime, sharedRules });
    assert.equal(result.policy.requirements_resolved, false);
    assert.equal(result.workspace_ready, false);
    assert.ok(result.policy.problems.some(row => row.reason === 'invalid-device-discovery'));
  }
  const runtime = structuredClone(inputs.runtime);
  runtime.workflow.verified = false;
  delete runtime.workflow.inventory_admitted_at;
  const unadmitted = await setupStepsWithRules({ ...inputs, runtime, sharedRules });
  assert.equal(unadmitted.workspace_ready, false);
  assert.ok(unadmitted.policy.problems.some(row => row.reason === 'workflow-inventory-unreadable'));
});

test('free admission preserves operator-native and explicit capability mandates without claiming full setup', async () => {
  const free = { ...inputs, runtime: null, access: { status: 402, upgrade_needed: true }, freeDecisionAccess: true };
  const base = await setupStepsWithRules(free);
  assert.equal(base.workspace_ready, true);
  assert.equal(base.workspace_mode, 'free');
  assert.equal(base.complete, false);
  const awaitingAi = await setupStepsWithRules({ ...free, aiConnected: false });
  assert.equal(awaitingAi.workspace_mode, 'free');
  assert.equal(awaitingAi.workspace_ready, false, 'confirmed free mode still needs positive MCP evidence');
  const blocked = await setupStepsWithRules({ ...free, context: { required_devices: { iphone: true } } });
  assert.equal(blocked.workspace_ready, false);
  assert.equal(blocked.workspace_mode, 'free', 'mode does not waive the required native step');
  assert.equal(step(blocked, 'iphone').required, true);
  const installed = await setupStepsWithRules({ ...free, context: { required_devices: { iphone: true } },
    devices: free.devices.map(row => row.id === 'iphone' ? { ...row, installed: true } : row) });
  assert.equal(installed.workspace_ready, true);
  assert.equal(installed.workspace_mode, 'free');
  assert.equal(installed.complete, false);
  const explicit = await setupStepsWithRules({ ...free, sharedRules: { rules: [policy('mandatory-loop', tree(is('step', 'first-result')), { required: true })] } });
  assert.equal(explicit.workspace_ready, false, 'free access cannot waive an explicit operator mandate');
  for (const input of [{ ...free, sharedRulesKnown: false }, { ...free, access: { status: 503 } }]) {
    const unresolved = await setupStepsWithRules(input);
    assert.equal(unresolved.workspace_ready, false);
    assert.equal(unresolved.workspace_mode, 'setup');
  }
});
