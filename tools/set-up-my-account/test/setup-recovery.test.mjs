// The Get started screen's recovery, from the retired repository test/setup-recovery.test.mjs (b6ae0ebf81): the two tests that need only the setup
// steps and the screen's facts, assertions unchanged. The other 24 of that file drove the old account routes (handleAccountApi),
// the Origin guard, the native workflow mount and the plan/allowance owners: their decisions are tested in setup-actions.test.mjs
// (stop, restart, retry, complete), setup-steps.test.mjs (free access, plan refusal) and read-setup.test.mjs; their routes are not
// on the engine (see verify-every-port/set-up-my-account).
import test from 'node:test';
import assert from 'node:assert/strict';
import { setupSteps } from '../read-data/setup-steps.mjs';
import { getStartedFacts } from '../read-data/get-started-screen.mjs';
import { setupScreenComplete } from '../../hold-one-thing-until-done/read-data/required-cover.mjs';
import { pendingSetup, provenSetup } from './setup-fixtures.mjs';

const ORIGIN = 'https://setup.example';
const section = (screen, id) => screen.sections.find(item => item.id === id);
const actions = screen => screen.sections.flatMap(item => [...(item.actions ?? []), ...(item.rows ?? []).flatMap(row => row.actions ?? [])]);

test('stopped setup has an explicit restart and no default continuation, and a finished run is not offered stop', () => {
  const input = pendingSetup();
  input.runtime.workflow = { exists: true, run_id: 'run:setup', state: 'failed', withdrawn: true, verified: false };
  let screen = getStartedFacts({ ...setupSteps(input), can_dispatch: true, origin: ORIGIN });
  assert.equal(section(screen, 'setup-run').heading, 'Setup is stopped');
  assert.equal(section(screen, 'setup-run').actions[0].send.path, '/work/api/setup/restart');
  assert.ok(!actions(screen).some(action => action.queue || action.copy?.includes('start_setup')));
  assert.equal(section(screen, 'setup-with-ai'), undefined);
  input.runtime.workflow = { exists: true, run_id: 'run:setup', state: 'working', verified: false };
  screen = getStartedFacts({ ...setupSteps(input), origin: ORIGIN });
  assert.ok(!actions(screen).some(action => action.label === 'Stop setup' || action.send?.path === '/work/api/setup/stop'), 'a running setup is the AI\'s; the person is not offered a stop');
  input.runtime.workflow.state = 'finished';
  screen = getStartedFacts({ ...setupSteps(input), origin: ORIGIN });
  assert.ok(!actions(screen).some(action => action.send?.path === '/work/api/setup/stop'));
});

test('explicit workspace readiness controls the gate while full completion stays separate', async () => {
  const all = setupSteps(provenSetup());
  const full = getStartedFacts({ ...all, origin: ORIGIN });
  assert.equal(full.ready, true);
  assert.equal(full.setup_complete, true);
  const refused = getStartedFacts({ ...all, workspace_ready: false, origin: ORIGIN });
  assert.equal(refused.ready, false);
  assert.equal(setupScreenComplete(refused), false, 'explicit false overrides all-done progress');
  assert.equal(refused.setup_complete, true, 'full evidence and workspace activation are distinct fields');
});
