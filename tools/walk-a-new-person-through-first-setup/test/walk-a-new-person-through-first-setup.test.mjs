// Tests for tool:walk-a-new-person-through-first-setup. The inputs are made-up accounts, not anyone's records: what a test
// checks is the plan the tool answers from what the caller hands over.

import assert from 'node:assert/strict';
import test from 'node:test';

import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { readToolkitRows } from '../do-work/choose-toolkit.mjs';
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

// Rows as records:list returns them: { id, type, value }.
const toolkits = [
  { id: 'toolkit:sample-writer', type: 'record:toolkit', value: { title: 'Sample writer', description: 'Tools for drafting.', items: ['tool:sample-draft', 'tool:sample-edit', 'tool:sample-draft'] } },
  { id: 'toolkit:sample-maker', type: 'record:toolkit', value: { items: ['tool:sample-cut'] } },
];

// Rows of the toolkits and toolkit_swaps tables as readToolkitRows answers them: { id, type, value }, in their order.
const sampleStack = { data: [{ id: 'sample-file', door: 'file:sample.db', speaks: 'sql' }], hosting: [{ id: 'sample-host', door: '@sample-host', speaks: 'tools:run' }] };
const tableToolkits = [
  { id: 'toolkit:sample-first', type: 'record:toolkit', value: { title: 'First', items: ['tool:sample-draft'], default: true, stack: sampleStack } },
  { id: 'toolkit:sample-second', type: 'record:toolkit', value: { title: 'Second', items: ['tool:sample-cut'], stack: sampleStack } },
];
const tableSwaps = [
  { id: 'toolkit-swap:sample-no-domain', type: 'record:toolkit-swap', value: { title: 'No domain', swap: { domain: [{ id: 'sample-name', door: '@sample-names', speaks: 'tools:run', label: 'tool:name_site' }] } } },
  { id: 'toolkit-swap:sample-my-machine', type: 'record:toolkit-swap', value: { swap: { hosting: [{ id: 'adopt-my-machine', door: '@my-machine', speaks: 'tools:run' }] } } },
];
const fromTables = { toolkits: tableToolkits, toolkit_swaps: tableSwaps };

test('the plan offers the rows of the toolkits tables and nothing else: no store is named and no row travels with the tool', () => {
  const plan = walkAPersonThroughFirstSetup({ origin: ORIGIN, view: 'state', runtime: notStarted });
  assert.equal(plan.read_toolkits_call, undefined);
  assert.equal(plan.toolkits, undefined, 'no toolkits are offered until they are read');
  const none = walkAPersonThroughFirstSetup({ origin: ORIGIN, view: 'state', runtime: notStarted, toolkits: [], toolkit_swaps: [] }).toolkits;
  assert.deepEqual(none.offered, []);
  assert.equal(none.cart, undefined);
  const offered = walkAPersonThroughFirstSetup({ origin: ORIGIN, view: 'state', runtime: notStarted, ...fromTables }).toolkits;
  assert.deepEqual(offered.offered.map(row => row.id), ['toolkit:sample-first', 'toolkit:sample-second']);
  assert.deepEqual(offered.swaps.map(swap => swap.id), ['toolkit-swap:sample-no-domain', 'toolkit-swap:sample-my-machine']);
  assert.equal(offered.cart.toolkit, 'toolkit:sample-first');
});

test('the toolkit rows are read from the two tables in their order, each row typed by its table', async () => {
  const asked = [];
  const query = async text => {
    asked.push(text);
    return text.includes('FROM toolkits ') ? [{ id: 'toolkit:sample-first', value: tableToolkits[0].value }] : [{ id: 'toolkit-swap:sample-no-domain', value: tableSwaps[0].value }];
  };
  assert.deepEqual(await readToolkitRows(query), { toolkits: [tableToolkits[0]], toolkit_swaps: [tableSwaps[0]] });
  assert.deepEqual(asked, ['SELECT id, value FROM toolkits ORDER BY position, id', 'SELECT id, value FROM toolkit_swaps ORDER BY position, id']);
});

test('the tool run with database but no held connection says so, and names no rows', () => {
  const ran = spawnSync(process.execPath, [fileURLToPath(new URL('../do-work/walk-a-new-person-through-first-setup.mjs', import.meta.url))], { input: JSON.stringify({ origin: ORIGIN, database: 'sample_db' }), encoding: 'utf8' });
  assert.equal(ran.status, 1);
  assert.match(JSON.parse(ran.stdout.trim().split('\n').pop()).error, /No connection to the toolkits database/);
});

test('a swap is picked by its row id, into the named toolkit or the default one, and a row id alone is the pick', () => {
  const into = walkAPersonThroughFirstSetup({ origin: ORIGIN, view: 'state', runtime: notStarted, ...fromTables, toolkit_choice: { toolkit: 'toolkit:sample-second', swap: 'toolkit-swap:sample-no-domain' } }).toolkits.cart;
  assert.equal(into.toolkit, 'toolkit:sample-second');
  assert.deepEqual(into.swapped, ['domain']);
  assert.equal(into.stack.domain[0].label, 'tool:name_site');
  const byRow = walkAPersonThroughFirstSetup({ origin: ORIGIN, view: 'state', runtime: notStarted, ...fromTables, row: 'toolkit-swap:sample-my-machine' }).toolkits.cart;
  assert.equal(byRow.toolkit, 'toolkit:sample-first');
  assert.equal(byRow.stack.hosting[0].id, 'adopt-my-machine');
  assert.equal(walkAPersonThroughFirstSetup({ origin: ORIGIN, view: 'state', runtime: notStarted, ...fromTables, row: 'toolkit:sample-second' }).toolkits.cart.toolkit, 'toolkit:sample-second');
  assert.throws(() => walkAPersonThroughFirstSetup({ origin: ORIGIN, runtime: notStarted, ...fromTables, toolkit_choice: { swap: 'toolkit-swap:nope' } }), /not offered/);
});

test('a row that is not a toolkit row, or has no value, is refused', () => {
  const offer = rows => () => walkAPersonThroughFirstSetup({ origin: ORIGIN, runtime: notStarted, toolkits: rows });
  assert.throws(offer([{ id: 'toolkit:x', type: 'record:note', value: { items: [] } }]), /not record:toolkit/);
  assert.throws(offer([{ id: 'toolkit:x', type: 'record:toolkit' }]), /needs a value/);
  assert.throws(offer([{ id: 'toolkit:x', type: 'record:toolkit', value: { items: ['sample-cut'] } }]), /marketplace item ids/);
});

test('first setup offers the toolkit rows the caller hands in, each tool id once, and no choice until one is made', () => {
  const plan = walkAPersonThroughFirstSetup({ origin: ORIGIN, view: 'state', runtime: notStarted, toolkits });
  assert.deepEqual(plan.toolkits.offered.map(row => row.id), ['toolkit:sample-writer', 'toolkit:sample-maker']);
  assert.deepEqual(plan.toolkits.offered[0].tools, ['tool:sample-draft', 'tool:sample-edit']);
  assert.equal(plan.toolkits.choice, undefined);
});

test('the person picks a toolkit, drops one tool id and adds another: the answer is the ids to install', () => {
  const plan = walkAPersonThroughFirstSetup({
    origin: ORIGIN, view: 'state', runtime: notStarted, toolkits,
    toolkit_choice: { toolkit: 'toolkit:sample-writer', drop: ['tool:sample-edit'], add: ['tool:sample-cut', 'tool:sample-draft'] },
  });
  assert.deepEqual(plan.toolkits.choice, { toolkit: 'toolkit:sample-writer', tools: ['tool:sample-draft', 'tool:sample-cut'], items: ['tool:sample-draft', 'tool:sample-cut'], dropped: ['tool:sample-edit'], added: ['tool:sample-cut'] });
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

