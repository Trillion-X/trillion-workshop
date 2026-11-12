// Tests for tool:walk-a-new-person-through-first-setup. The inputs are made-up accounts, not anyone's records: what a test
// checks is the plan the tool answers from what the caller hands over.

import assert from 'node:assert/strict';
import test from 'node:test';

import { walkAPersonThroughFirstSetup } from '../do-work/walk-a-new-person-through-first-setup.mjs';

const ORIGIN = 'https://app.example.test';
const notStarted = { workflow: { exists: false, state: 'not_started' } };
const lens = { opening: 'Sample opening.', parts: [{ name: 'Pursuits', about: 'What they chase.' }], closing: 'Sample closing.', rows: [] };

test('a state view answers the run and its next call, with no installs', () => {
  const plan = walkAPersonThroughFirstSetup({ origin: ORIGIN, view: 'state', runtime: notStarted });
  assert.equal(plan.schema, 'trillion.setup-plan/v1');
  assert.deepEqual(plan.next_call, { tool: 'start_setup', arguments: {} });
  assert.deepEqual(plan.guidance_call, { tool: 'read_setup', arguments: { view: 'full' } });
  assert.equal(plan.install, undefined);
});

test('a full view with an https origin offers the harness download and each host command', () => {
  const plan = walkAPersonThroughFirstSetup({ origin: ORIGIN, runtime: notStarted, native: { computers: [], cards: {} } });
  const harness = plan.install.harness_setup;
  assert.equal(harness.status, 'not_inspected');
  assert.ok(harness.download_command.includes('https://app.example.test/'), 'download files come from the origin');
  assert.ok(harness.hosts.length > 0, 'at least one supported AI host');
  assert.ok(harness.hosts.every(host => typeof host.commands.inspect === 'string' && typeof host.commands.apply === 'string'));
  assert.ok(plan.install.devices_step, 'the device apps step is included');
});

test('a plain http origin serves no harness files and says so', () => {
  const plan = walkAPersonThroughFirstSetup({ origin: 'http://localhost:8788', runtime: notStarted });
  assert.equal(plan.install.harness_setup.status, 'not_served');
  assert.equal(plan.install.harness_setup.files, undefined);
});

test('the pursuit lens appears only when the caller hands one in', () => {
  const without = walkAPersonThroughFirstSetup({ origin: ORIGIN, runtime: notStarted });
  assert.equal(without.see_what_they_pursue, undefined);
  const withLens = walkAPersonThroughFirstSetup({ origin: ORIGIN, runtime: notStarted, lens });
  assert.equal(withLens.see_what_they_pursue.how, 'Sample opening.');
});

test('a stopped setup is not restarted by the plan', () => {
  const plan = walkAPersonThroughFirstSetup({
    origin: ORIGIN, view: 'state', runtime: notStarted, prerequisites: { setup_paused: true, requirements: [], setup_access: [], next_calls: [], setup_complete: false, workspace_ready: false },
  });
  assert.equal(plan.next_call, undefined);
  assert.equal(plan.prerequisites.setup_paused, true);
});

test('a named entry point is answered with its persona and opening message', () => {
  const plan = walkAPersonThroughFirstSetup({ origin: ORIGIN, view: 'state', runtime: notStarted, entry: 'default' });
  assert.equal(plan.entry_point.id, 'default');
  assert.equal(plan.entry_point.source, 'named');
});

test('an entry point that does not exist is refused', () => {
  assert.throws(() => walkAPersonThroughFirstSetup({ origin: ORIGIN, entry: 'no-such-entry' }), /no-such-entry/);
});

test('a request without an origin is refused', () => {
  assert.throws(() => walkAPersonThroughFirstSetup({ runtime: notStarted }), /origin/);
  assert.throws(() => walkAPersonThroughFirstSetup(['not', 'an', 'object']), /one JSON object/);
});
