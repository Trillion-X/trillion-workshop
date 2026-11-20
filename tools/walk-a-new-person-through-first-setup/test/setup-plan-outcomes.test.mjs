// tools/walk-a-new-person-through-first-setup: the setup plan's outcomes that the current owners can express. The old
// test (held at from-an-older-version/test/setup-plan.test.mjs.held, commit b6ae0ebf81) drove a setupTools surface
// (read_setup, start_setup, the requirements and connection reads) that is not on this repository; those assertions stay
// held. The ones over the plan itself and over the copied AI guides are checked here, with the same assertions.
import test from 'node:test';
import assert from 'node:assert/strict';
import { setupPlan } from '../do-work/setup-plan.mjs';
import { aiAppGuides } from '../../set-up-my-account/read-data/ai-app-guides.mjs';
import { pendingSetup } from '../../set-up-my-account/test/setup-fixtures.mjs';

const origin = 'https://setup.example';
const prerequisites = patch => ({ schema: 'setup-prerequisites/v1',
  requirements: [{ id: 'iphone', owner: 'device', source_id: 'native-ios', required: true, done: false }],
  policy: { requirements_resolved: true, source_version: 'fixture-current-requirements' },
  setup_complete: false, workspace_ready: false, setup_paused: false,
  setup_access: [{ source_id: 'native-ios', state: 'queued', request_id: 'request:fixture' }],
  next_calls: [{ tool: 'read_setup_access', arguments: { source_id: 'native-ios' } }], ...patch });

test('readback never resumes a withdrawn workflow or erases current failures after an old result', () => {
  const runtime = pendingSetup().runtime;
  runtime.workflow = { exists: true, run_id: 'run:stopped', state: 'failed', withdrawn: true, verified: false };
  runtime.next_calls = [];
  const result = setupPlan({ runtime, origin });
  assert.equal(result.next_call, undefined);
  assert.equal(result.runtime.ready, false);
});

test('an observed not-started setup exposes its start action first without performing it on read', () => {
  const runtime = pendingSetup().runtime;
  runtime.next_calls = [{ tool: 'source_health', arguments: {} }, { tool: 'start_setup', arguments: {} }];
  const plan = setupPlan({ runtime, prerequisites: prerequisites(), origin });
  assert.deepEqual(plan.next_call, { tool: 'start_setup', arguments: {} });
  assert.deepEqual(plan.next_calls[0], plan.next_call);
  assert.equal(plan.runtime.ready, false);
  assert.equal(plan.workflow.exists, false);
});

test('setup continuation preserves stops, completed runs and unknown workflow state', () => {
  for (const workflow of [null, { exists: false }, { exists: true, state: 'finished', verified: true },
    { exists: false, state: 'not_started', withdrawn: true }]) {
    const runtime = { ...pendingSetup().runtime, workflow, next_calls: [] };
    assert.equal(setupPlan({ runtime, origin }).next_call, undefined);
  }
  assert.equal(setupPlan({ runtime: pendingSetup().runtime, prerequisites: prerequisites({ setup_paused: true }), origin }).next_call, undefined);
});

test('each copied AI path continues full setup, including terminal-specific prompts and direct connect links', () => {
  const guides = aiAppGuides(origin);
  assert.ok(guides.setup_prompt.length < 900);
  for (const tab of guides.tabs) {
    assert.match(tab.copy.text, /start_setup/, tab.id);
    assert.match(tab.copy.text, /read_setup/, tab.id);
    assert.doesNotMatch(tab.copy.text, /\{setup_continuation\}/, tab.id);
    if (tab.open && !tab.open.paste && !tab.open.href.includes('add-mcp')) {
      assert.ok(tab.copy.text.length > 0);
    }
  }
});
