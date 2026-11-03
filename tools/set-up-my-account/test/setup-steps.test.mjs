import assert from 'node:assert/strict';
import { test } from 'node:test';
import { personalHoldApplies, setupSteps } from '../read-data/setup-steps.mjs';
import { setupScreenComplete } from '../../hold-one-thing-until-done/read-data/required-cover.mjs';
import { getStartedFacts } from '../read-data/get-started-screen.mjs';
import { pendingSetup, provenSetup } from './setup-fixtures.mjs';
import computerRows from '../read-data/computer-sources.json' with { type: 'json' };
import setupSettings from '../read-data/setup-steps.json' with { type: 'json' };

const step = (result, id) => result.steps.find(row => row.id === id);

test('the setup gate covers the full policy and accepts a verified applicable setup without founder devices', () => {
  const input = provenSetup();
  const result = setupSteps(input);
  assert.equal(result.steps.length, 12);
  assert.equal(result.complete, true);
  assert.ok(result.steps.every(row => row.done === true));
  assert.equal(input.devices.find(row => row.id === 'iphone').installed, false);
});

test('the actual Get started screen and gate open after person-only setup while an AI-only result is unfinished', () => {
  const input = provenSetup();
  // Keep the complete runtime and inventory proof intact. This is a fresh current read from the record owner showing
  // that the AI's whole-flow result has not appeared yet.
  input.owned = { records: { finished: [] } };
  const facts = setupSteps(input);
  const firstResult = step(facts, 'first-result');
  assert.equal(firstResult.audience, 'ai');
  assert.equal(firstResult.done, false);
  assert.equal(facts.complete, false, 'the full setup remains incomplete until the AI result exists');
  assert.equal(facts.workspace_ready, true, 'AI-only work does not hold the person out of the workspace');

  const screen = getStartedFacts(facts);
  assert.equal(screen.ready, true, 'Get started carries the person-only readiness result');
  assert.equal(screen.setup_complete, false, 'workspace admission does not claim the whole setup finished');
  assert.equal(setupScreenComplete(screen), true, 'the actual gate accepts the screen readiness result');

  const unresolved = getStartedFacts({ ...facts, policy: { requirements_resolved: false,
    required_count: facts.requirements.filter(row => row.required).length } });
  assert.equal(unresolved.ready, false, 'an unresolved policy overrides a positive readiness projection');
  assert.equal(setupScreenComplete(unresolved), false, 'the actual gate remains closed while policy is unknown');
});

test('a component that only says it is ready is not a record: steps finish from what actually ran', () => {
  const input = pendingSetup();
  input.aiConnected = true;
  input.runtime.components.forEach(row => { row.ready = true; row.state = 'ready'; });
  const result = setupSteps(input);
  assert.deepEqual(result.steps.filter(row => row.done).map(row => row.id), ['ai-connection']);
  input.runtime.components.find(row => row.id === 'defaults').evidence = { rows: [{ id: 'hourly', kind: 'schedule', label: 'Hourly', last_run: { at: new Date().toISOString() } }] };
  assert.equal(step(setupSteps(input), 'automation').done, true, 'scheduled work that ran finishes the automation step');
  assert.equal(result.complete, false);
  assert.notEqual(step(result, 'first-result').done, true, 'no work came back done, so the whole flow is not proven');
  assert.ok(!result.steps.some(row => row.id === 'schedules' || row.id === 'mcp'));
  assert.equal(setupSteps({ ...input, schedules: [{ enabled: true }] }).complete, false);
});

test('a lost connection, revoked device, denied permission or unproven setup each close the gate, and held-back timed work does not', () => {
  const held = provenSetup();
  held.runtime.components.find(row => row.id === 'timed_work').state = 'blocked';
  assert.equal(setupSteps(held).complete, true, 'work the AI retries by itself is its own diagnostic, never the person\'s gate');
  const cases = [
    input => { input.aiConnected = false; },
    input => { input.devices[0].installed = false; },
    input => { input.notificationDevices[0].can_show = 'denied'; },
    input => { input.runtime.workflow.verified = false; },
  ];
  for (const change of cases) {
    const input = provenSetup();
    change(input);
    assert.equal(setupSteps(input).complete, false);
  }
});

test('failed owner reads stay unknown and recover from later actual observations', () => {
  const result = setupSteps();
  assert.equal(result.complete, false);
  assert.ok(result.steps.every(row => row.done === null));
  const input = provenSetup();
  input.notificationDevices = null;
  assert.equal(step(setupSteps(input), 'notifications').done, null);
  assert.match(step(setupSteps(input), 'notifications').body, /Trillion is checking this/);
  assert.equal(setupSteps(provenSetup()).complete, true);
});

test('not applicable requires discovered scope and verified evidence and cannot exclude a core capability', () => {
  const input = provenSetup();
  const inventory = input.runtime.workflow.inventory.requirements;
  const proof = input.runtime.workflow.verification.verified;
  const declaration = inventory.find(row => row.id === 'devices');
  const evidence = proof.find(row => row.id === 'devices');
  declaration.applicability = 'not-applicable';
  declaration.device_ids = [];
  evidence.state = 'not-applicable';
  input.devices = [];
  assert.equal(step(setupSteps(input), 'devices').done, true);
  assert.equal(step(setupSteps(input), 'devices').not_applicable, true);
  declaration.applicability = 'applicable';
  assert.equal(step(setupSteps(input), 'devices').done, false);
  declaration.applicability = 'not-applicable';
  evidence.evidence_refs = [];
  assert.equal(step(setupSteps(input), 'devices').done, false);
  inventory.find(row => row.id === 'agent-delivery').applicability = 'not-applicable';
  proof.find(row => row.id === 'agent-delivery').state = 'not-applicable';
  // Its live checks cannot be read here, so it is unknown (null): never done, and never excluded on a claim alone.
  assert.equal(step(setupSteps(input), 'agent-delivery').done, null);
});

test('a malformed earlier not-applicable claim cannot suppress a declared device or notification denial', () => {
  for (const [id, field] of [['devices', 'device_ids'], ['notifications', 'notification_routes']]) {
    const input = provenSetup();
    const declaration = input.runtime.workflow.inventory.requirements.find(row => row.id === id);
    declaration.applicability = 'not-applicable';
    input.runtime.workflow.verification.verified.find(row => row.id === id).state = 'not-applicable';
    input.devices = []; input.notificationDevices = [];
    assert.ok(declaration[field].length);
    const denied = setupSteps(input);
    assert.equal(step(denied, id).done, false, id); assert.equal(denied.complete, false);
    assert.equal(step(denied, id).not_applicable, undefined);
    declaration[field] = [];
    assert.equal(step(setupSteps(input), id).done, true, 'empty web-only scope remains available');
  }
});

test('one-click dispatch requires current agent readiness as well as live delivery', () => {
  const input = pendingSetup();
  input.runtime.components.push({ id: 'agents', ready: false, evidence: { live_delivery: 1 } });
  assert.equal(setupSteps(input).can_dispatch, false);
  input.runtime.components.at(-1).ready = true;
  assert.equal(setupSteps(input).can_dispatch, true);
});

test('an established setup preserves deliberate pauses without hiding outages or exempting first setup', () => {
  const input = provenSetup();
  const defaults = input.runtime.components.find(row => row.id === 'defaults');
  Object.assign(defaults, { state: 'blocked', ready: false, evidence: {
    stopped_by_choice: ['schedule:baseline'], missing: [], rows: [{ id: 'schedule:baseline', state: 'off' }],
  } });
  assert.equal(setupSteps(input).complete, true);
  assert.match(step(setupSteps(input), 'automation').body, /pauses are preserved/);
  defaults.evidence.problem = 'Could not read the current schedule.';
  assert.equal(setupSteps(input).complete, false);
  delete defaults.evidence.problem;
  input.runtime.workflow.verified = false;
  assert.equal(step(setupSteps(input), 'automation').done, false);
});

test('the workspace lock accepts only explicit non-empty all-done progress', () => {
  assert.equal(setupScreenComplete({ ready: true, progress: { done: 1, total: 12 } }), true);
  assert.equal(setupScreenComplete({ ready: false, progress: { done: 12, total: 12 } }), false);
  assert.equal(setupScreenComplete({ progress: { done: 12, total: 12 } }), true);
  assert.equal(setupScreenComplete({ progress: { done: 11, total: 12 } }), false);
  assert.equal(setupScreenComplete({ progress: { done: 0, total: 0 } }), false);
  assert.equal(setupScreenComplete({ error: 'temporarily unavailable' }), false);
});

test('confirmed free access opens its workspace after real AI use without claiming full setup', () => {
  const input = { access: { status: 402, upgrade_needed: true }, freeDecisionAccess: true, aiConnected: true };
  const result = setupSteps(input);
  assert.equal(result.workspace_ready, true);
  assert.equal(result.workspace_mode, 'free');
  assert.equal(result.complete, false);
  assert.deepEqual(result.steps.filter(row => row.done).map(row => row.id), ['ai-connection']);
  assert.equal(step(result, 'automation').done, null);
  const awaitingAi = setupSteps({ ...input, aiConnected: false });
  assert.equal(awaitingAi.workspace_ready, false);
  assert.equal(awaitingAi.workspace_mode, 'free', 'the mode describes confirmed access before activation is ready');
  for (const freeDecisionAccess of [null, false, 'true']) {
    assert.equal(setupSteps({ ...input, freeDecisionAccess }).workspace_ready, false);
  }
  for (const status of [200, 403, 429, 500, 502]) {
    assert.equal(setupSteps({ ...input, access: { status, upgrade_needed: true } }).workspace_ready, false);
  }
});

test('optional computer recovery uses each exact live switch once and never claims source intake', () => {
  const now = Date.parse('2026-10-08T04:30:00Z');
  const computer = { computer_id: 'mac-1', name: 'Studio Mac', reported_at: '2026-10-08T04:20:00Z',
    gates: { 'full-disk-access': { label: 'Full Disk Access for Trillion' } }, sources: [
      { id: 'apple-notes', label: 'Apple Notes', state: 'needs_switch', gate: 'full-disk-access' },
      { id: 'voice-memos', label: 'Voice Memos', state: 'needs_switch', gate: 'full-disk-access' },
    ] };
  const input = { ...provenSetup(), computers: [computer], now };
  let result = setupSteps(input);
  assert.equal(result.person_actions.length, 1);
  assert.equal(result.person_actions[0].action.href, computerRows.gates['full-disk-access'].open);
  assert.equal(result.person_actions[0].required, false);
  assert.match(result.person_actions[0].body, /Apple Notes and Voice Memos/);
  assert.equal(result.workspace_ready, true, 'this diagnostic does not invent a new mandatory capability');
  computer.sources.forEach(source => { source.state = 'found'; });
  result = setupSteps(input);
  assert.equal(result.person_actions[0].done, true);
  assert.match(result.person_actions[0].title, /No permission switches waiting/);
  assert.doesNotMatch(result.person_actions[0].title, /reads.*by itself/);
  computer.sources[0].state = 'could_not_check';
  assert.equal(setupSteps(input).person_actions[0].done, null);
  computer.reported_at = '2026-10-01T00:00:00Z';
  result = setupSteps(input);
  assert.deepEqual(result.person_actions.map(({ id, done, required, next_change_at }) => ({ id, done, required, next_change_at })), [
    { id: 'computer-switches:mac-1', done: null, required: false, next_change_at: null },
  ], 'expired evidence keeps the known computer visible as unknown');
  assert.equal(result.workspace_ready, true, 'an optional expired observation does not invent a new admission requirement');
  assert.equal(setupSteps({ computers: null }).person_actions[0].done, null);
});

test('an expired required computer switch remains unknown and required until fresh owner success', () => {
  const now = Date.parse('2026-10-08T04:30:00Z');
  const computer = { computer_id: 'required-mac', name: 'Required Mac', reported_at: new Date(now).toISOString(),
    sources: [{ id: 'apple-notes', label: 'Apple Notes', state: 'needs_switch', gate: 'full-disk-access' }] };
  const input = { ...provenSetup(), computers: [computer], now,
    rows: [{ ...setupSettings.computer_switches, required: true, applicable: true }] };
  const fresh = setupSteps(input);
  assert.equal(fresh.person_actions[0].done, false);
  assert.equal(fresh.workspace_ready, false);
  const later = now + setupSettings.computer_switches.fresh_hours * 3600_000 + 1;
  const expired = setupSteps({ ...input, now: later });
  assert.deepEqual(expired.person_actions.map(({ id, done, required, next_change_at }) => ({ id, done, required, next_change_at })), [
    { id: 'computer-switches:required-mac:full-disk-access', done: null, required: true, next_change_at: null },
  ]);
  assert.equal(expired.person_actions[0].action.href, computerRows.gates['full-disk-access'].open);
  assert.equal(expired.complete, false);
  assert.equal(expired.workspace_ready, false);
  const recovered = setupSteps({ ...input, now: later, computers: [{ ...computer, reported_at: new Date(later).toISOString(),
    sources: computer.sources.map(source => ({ ...source, state: 'found' })) }] });
  assert.equal(recovered.person_actions[0].done, true);
  assert.equal(recovered.complete, true);
  assert.equal(recovered.workspace_ready, true);
});

test('only authenticated showcase and view-as facts exempt personal holds', () => {
  assert.equal(personalHoldApplies({ throwaway: true }), false);
  assert.equal(personalHoldApplies({ looking: { said: 'Read only' }, throwaway: false }), false);
  assert.equal(personalHoldApplies({ throwaway: false }), true);
  for (const viewer of [undefined, null, {}, { throwaway: 'true' }, { throwaway: 1 }, { showcase: 'workspace' }]) {
    assert.equal(personalHoldApplies(viewer), true);
  }
});


test('a resolved empty policy can open while empty or inconsistent checklist responses stay closed', () => {
  assert.equal(setupSteps({ rows: [], aiConnected: true }).complete, false, 'plain empty owner input is not a resolved policy');
  const resolved = { policy: { requirements_resolved: true, required_count: 0 }, requirements: [], sections: [{ heading: 'AI picker' }],
    progress: { done: 0, total: 0 } };
  assert.equal(setupScreenComplete(resolved), true);
  assert.equal(setupScreenComplete({ ...resolved, ready: false }), false);
  assert.equal(setupScreenComplete({ ...resolved, policy: { requirements_resolved: false, required_count: 0 } }), false);
  assert.equal(setupScreenComplete({ ...resolved, policy: { requirements_resolved: true, required_count: '0' } }), false);
  assert.equal(setupScreenComplete({ ...resolved, requirements: [{ required: true, done: false }] }), false);
  assert.equal(setupScreenComplete({ ...resolved, requirements: [{ done: true }] }), false);
  assert.equal(setupScreenComplete({ ...resolved, requirements: undefined }), false);
  assert.equal(setupScreenComplete({ policy: { requirements_resolved: false, required_count: 1 }, progress: { done: 5, total: 5 } }), false,
    'an unresolved new policy never falls through to legacy all-done progress');
});

test('a person step carries its own screen and the one action that opens it, and an unknown step carries neither', () => {
  const input = pendingSetup();
  input.aiConnected = false;
  assert.equal(step(setupSteps(input), 'ai-connection').place, '/ai');
  assert.deepEqual(step(setupSteps(input), 'ai-connection').action, { label: 'Connect an AI', tone: 'quiet', open: '/ai' });
  input.aiConnected = true;
  input.aiApps = ['Claude Code'];
  // Once done, its AIs are shown as items with one way to add another, instead of a button to their screen.
  assert.equal(step(setupSteps(input), 'ai-connection').action, undefined);
  assert.deepEqual(step(setupSteps(input), 'ai-connection').add, { label: 'Connect another AI', tone: 'quiet', open: '/ai' });
  input.aiConnected = null; input.aiApps = null;
  const unknown = step(setupSteps(input), 'ai-connection');
  assert.equal(unknown.done, null);
  assert.equal(unknown.place, undefined);
  assert.equal(unknown.action, undefined);
});

test('a set-up account passes the gate from its real records alone, and a new account does not', () => {
  const now = Date.parse('2026-10-10T07:00:00Z');
  const ago = hours => new Date(now - hours * 3600_000).toISOString();
  const records = { finished: [{ name: 'Codex', count: 2, at: ago(1) }], recorded: [{ name: 'Codex', count: 9, at: ago(1) }], arrived: [{ name: 'Files', count: 4, at: ago(2) }] };
  const input = {
    aiConnected: true, aiApps: ['Claude Code', 'Codex'], now,
    devices: [{ id: 'iphone', title: 'iPhone', installed: true }, { id: 'watch', title: 'Apple Watch', installed: false }],
    notificationDevices: [{ id: 'iphone', route: 'apns', can_show: 'allowed' }],
    owned: { profile: { name: 'Sam Rivera', given_name: 'Sam', family_name: 'Rivera' }, pursuits: [{ title: 'Ship', status: 'active' }],
      connections: [{ label: 'Gmail', status: 'connected' }], records },
    runtime: { schema: 'trillion.setup-runtime/v1', components: [
      { id: 'defaults', state: 'ready', ready: true, evidence: { rows: [{ id: 'hourly', kind: 'schedule', label: 'Hourly', last_run: { at: ago(1) } }] } },
      { id: 'timed_work', state: 'blocked', ready: false, evidence: { failed: [{ id: 'x', error: 'y' }] } },
      { id: 'event_intake', state: 'pending', ready: false, evidence: { sources: [{ label: 'Gmail', state: 'listening' }, { label: 'Calendar', state: 'pending' }] } },
      { id: 'agents', state: 'ready', ready: true, evidence: { agents: [{ name: 'Codex', takes_work: true, reach: { live: false } }] } },
    ], workflow: { exists: true, run_id: 'run:1', state: 'working', verified: false, inventory_admitted_at: ago(48),
      inventory: { requirements: [{ id: 'devices', applicability: 'applicable', device_ids: ['iphone', 'watch'] }] } } },
  };
  const result = setupSteps(input);
  assert.deepEqual(result.steps.filter(row => row.done !== true).map(row => row.id), [], 'every step reads done from its records, with no saved proof');
  assert.equal(result.workspace_ready, true);
  assert.equal(step(result, 'devices').done, true, 'an optional watch that is not installed is not unfinished');
  assert.equal(setupSteps({ now }).workspace_ready, false, 'a new account sees onboarding');

  // A member with nothing connected yet: a discovered step does not hold them until discovery finds it applies.
  const { connections: _connections, ...ownedWithout } = input.owned;
  const member = { ...input, owned: ownedWithout };
  const open = setupSteps(member);
  assert.notEqual(step(open, 'connections').done, true, 'the step still shows as not done, so it can be done');
  assert.equal(open.workspace_ready, true, 'a member with no account to connect reaches their workspace');
  const applies = structuredClone(member);
  applies.runtime.workflow.inventory.requirements.push({ id: 'connections', applicability: 'applicable' });
  assert.equal(setupSteps(applies).workspace_ready, false, 'once discovery finds accounts to connect, the step holds the person');
});

test('a member with nothing to connect is not held by a discovered connections step, in every reader of the same requirements', () => {
  const input = provenSetup();
  const inventory = input.runtime.workflow.inventory.requirements;
  const verified = input.runtime.workflow.verification.verified;
  inventory.find(row => row.id === 'connections').applicability = 'not-applicable';
  verified.find(row => row.id === 'connections').state = 'pending';
  const result = setupSteps(input);
  const connections = step(result, 'connections');
  assert.equal(connections.awaiting_discovery, true, 'the step is shown, awaiting discovery, and not counted');
  assert.equal(connections.required, false);
  assert.equal(result.workspace_ready, true);
  assert.equal(result.requirements.filter(row => row.required).every(row => row.done === true), true);
  assert.equal(setupScreenComplete({ requirements: result.requirements, policy: { requirements_resolved: true,
    required_count: result.requirements.filter(row => row.required).length } }), true, 'the gate opens on the required steps alone');
});
