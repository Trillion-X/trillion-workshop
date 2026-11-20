// Tests for tool:walk-a-new-person-through-first-setup. The inputs are made-up accounts, not anyone's records: what a test
// checks is the plan the tool answers from what the caller hands over.

import assert from 'node:assert/strict';
import test from 'node:test';

import { walkAPersonThroughFirstSetup } from '../do-work/walk-a-new-person-through-first-setup.mjs';
import { rows as shippedRows } from '../../../test-helpers/tool-rows.mjs';

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

// Rows as records:list returns them: { id, type, value }.
const toolkits = [
  { id: 'toolkit:sample-writer', type: 'record:toolkit', value: { title: 'Sample writer', description: 'Tools for drafting.', tools: ['tool:sample-draft', 'tool:sample-edit', 'tool:sample-draft'] } },
  { id: 'toolkit:sample-maker', type: 'record:toolkit', value: { tools: ['tool:sample-cut'] } },
];

const STARTERS = ['toolkit:answer-your-audience', 'toolkit:launch-and-sell-a-product', 'toolkit:keep-your-work-in-order'];

test('the plan names no store to read toolkits from: the starters travel with the tool, the person\'s own rows are handed in', () => {
  const plan = walkAPersonThroughFirstSetup({ origin: ORIGIN, view: 'state', runtime: notStarted });
  assert.equal(plan.read_toolkits_call, undefined);
  assert.equal(plan.toolkits, undefined, 'no toolkits are offered until they are asked for');
  const offered = walkAPersonThroughFirstSetup({ origin: ORIGIN, view: 'state', runtime: notStarted, toolkits: [] }).toolkits;
  assert.deepEqual(offered.offered.map(row => row.id), STARTERS);
  assert.deepEqual(offered.swaps.map(swap => swap.id), ['toolkit-swap:my-own-domain-and-sign-in', 'toolkit-swap:no-domain-of-my-own', 'toolkit-swap:a-machine-i-already-run']);
  assert.equal(offered.cart.toolkit, STARTERS[0]);
});

test('a person\'s row with a starter\'s id stands in its place, and their own default makes the starter default stand down', () => {
  const mine = { id: STARTERS[1], type: 'record:toolkit', value: { title: 'Mine', tools: ['tool:sample-cut'], default: true } };
  const { offered, cart } = walkAPersonThroughFirstSetup({ origin: ORIGIN, view: 'state', runtime: notStarted, toolkits: [mine] }).toolkits;
  assert.deepEqual(offered.map(row => row.id), [STARTERS[1], STARTERS[0], STARTERS[2]]);
  assert.equal(offered[0].title, 'Mine');
  assert.deepEqual(offered.filter(row => row.default).map(row => row.id), [STARTERS[1]]);
  assert.deepEqual(cart.tools, ['tool:sample-cut']);
});

test('a swap is picked by its row id, into the named toolkit or the default one, and run as a listed row by its id', () => {
  const into = walkAPersonThroughFirstSetup({ origin: ORIGIN, view: 'state', runtime: notStarted, toolkit_choice: { toolkit: STARTERS[1], swap: 'toolkit-swap:no-domain-of-my-own' } }).toolkits.cart;
  assert.equal(into.toolkit, STARTERS[1]);
  assert.deepEqual(into.swapped, ['domain']);
  assert.equal(into.stack.domain[0].label, 'tool:name_site');
  const byRow = walkAPersonThroughFirstSetup({ origin: ORIGIN, view: 'state', runtime: notStarted, row: 'toolkit-swap:a-machine-i-already-run' }).toolkits.cart;
  assert.equal(byRow.toolkit, STARTERS[0]);
  assert.equal(byRow.stack.hosting[0].id, 'adopt-my-machine');
  assert.equal(walkAPersonThroughFirstSetup({ origin: ORIGIN, view: 'state', runtime: notStarted, row: STARTERS[2] }).toolkits.cart.toolkit, STARTERS[2]);
  const mine = { id: 'toolkit-swap:my-own', type: 'record:toolkit-swap', value: { swap: { files: [{ id: 'sample-files', door: 'file:mine', speaks: 'files' }] } } };
  assert.equal(walkAPersonThroughFirstSetup({ origin: ORIGIN, view: 'state', runtime: notStarted, toolkit_swaps: [mine], toolkit_choice: { swap: 'toolkit-swap:my-own' } }).toolkits.cart.stack.files[0].id, 'sample-files');
  assert.throws(() => walkAPersonThroughFirstSetup({ origin: ORIGIN, runtime: notStarted, toolkit_choice: { swap: 'toolkit-swap:nope' } }), /not offered/);
});

test('a row that is not a toolkit row, or has no value, is refused', () => {
  const offer = rows => () => walkAPersonThroughFirstSetup({ origin: ORIGIN, runtime: notStarted, toolkits: rows });
  assert.throws(offer([{ id: 'toolkit:x', type: 'record:note', value: { tools: [] } }]), /not record:toolkit/);
  assert.throws(offer([{ id: 'toolkit:x', type: 'record:toolkit' }]), /needs a value/);
  assert.throws(offer([{ id: 'toolkit:x', type: 'record:toolkit', value: { tools: ['sample-cut'] } }]), /tool ids/);
});

test('first setup offers the toolkit rows the caller hands in, each tool id once, and no choice until one is made', () => {
  const plan = walkAPersonThroughFirstSetup({ origin: ORIGIN, view: 'state', runtime: notStarted, toolkits });
  assert.deepEqual(plan.toolkits.offered.map(row => row.id), ['toolkit:sample-writer', 'toolkit:sample-maker', ...STARTERS]);
  assert.deepEqual(plan.toolkits.offered[0].tools, ['tool:sample-draft', 'tool:sample-edit']);
  assert.equal(plan.toolkits.choice, undefined);
});

test('the person picks a toolkit, drops one tool id and adds another: the answer is the ids to install', () => {
  const plan = walkAPersonThroughFirstSetup({
    origin: ORIGIN, view: 'state', runtime: notStarted, toolkits,
    toolkit_choice: { toolkit: 'toolkit:sample-writer', drop: ['tool:sample-edit'], add: ['tool:sample-cut', 'tool:sample-draft'] },
  });
  assert.deepEqual(plan.toolkits.choice, { toolkit: 'toolkit:sample-writer', tools: ['tool:sample-draft', 'tool:sample-cut'], dropped: ['tool:sample-edit'], added: ['tool:sample-cut'] });
});

test('a pick with nothing dropped or added installs the toolkit as it stands', () => {
  const plan = walkAPersonThroughFirstSetup({ origin: ORIGIN, view: 'state', runtime: notStarted, toolkits, toolkit_choice: { toolkit: 'toolkit:sample-maker' } });
  assert.deepEqual(plan.toolkits.choice.tools, ['tool:sample-cut']);
});

test('a choice the toolkit rows cannot honour is refused with the reason', () => {
  const ask = toolkit_choice => () => walkAPersonThroughFirstSetup({ origin: ORIGIN, runtime: notStarted, toolkits, toolkit_choice });
  assert.throws(ask({ toolkit: 'toolkit:nope' }), /not offered/);
  assert.throws(ask({ toolkit: 'toolkit:sample-maker', drop: ['tool:sample-draft'] }), /does not list it/);
  assert.throws(ask({ toolkit: 'toolkit:sample-writer', drop: ['tool:sample-edit'], add: ['tool:sample-edit'] }), /both dropped and added/);
  assert.throws(ask({ toolkit: 'toolkit:sample-writer', add: ['sample-cut'] }), /tool ids/);
  assert.throws(() => walkAPersonThroughFirstSetup({ origin: ORIGIN, runtime: notStarted, toolkit_choice: { toolkit: 'toolkit:sample-maker' } }), /not offered/);
});

test('an added tool id outside the installable list is refused when the caller hands that list in', () => {
  const ask = known_tools => () => walkAPersonThroughFirstSetup({ origin: ORIGIN, runtime: notStarted, toolkits, known_tools, toolkit_choice: { toolkit: 'toolkit:sample-maker', add: ['tool:sample-draft'] } });
  assert.throws(ask(['tool:sample-cut']), /no such tool is installable/);
  assert.deepEqual(ask(['tool:sample-cut', 'tool:sample-draft'])().toolkits.choice.tools, ['tool:sample-cut', 'tool:sample-draft']);
});

// The starter toolkits the Workshop ships (toolkits/, listed by source:starter-toolkits) as an account holds them.
const shipped = shippedRows().filter(({ payload }) => payload.kind === 'toolkit').map(({ payload }) => ({ id: payload.id, type: 'record:toolkit', value: payload }));

test('the starter toolkits are offered as they ship, and every tool id in them is a tool the Workshop offers', () => {
  assert.equal(shipped.length, 3);
  const offered = walkAPersonThroughFirstSetup({ origin: ORIGIN, view: 'state', runtime: notStarted, toolkits: shipped }).toolkits.offered;
  const tools = new Set(shippedRows().filter(({ payload }) => payload.kind === 'ai-tool-descriptor').map(({ payload }) => payload.id));
  for (const toolkit of offered) {
    assert.ok(toolkit.title && toolkit.description, `${toolkit.id} has its title and description`);
    assert.ok(toolkit.tools.length > 0, `${toolkit.id} lists tools`);
    assert.deepEqual(toolkit.tools.filter(id => !tools.has(id)), [], `${toolkit.id} lists only tools the Workshop offers`);
  }
});
