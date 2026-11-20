// The Automations screens' read (do-work/list-my-automations.mjs) over the engine's own rows. It carries the assertions of old
// test/work-workflows-edits.test.mjs of the old repository that still describe the job (a trigger previews as what sets it off, then what it
// does, and its editor carries the input schema of what it runs) and the words of record-kind-words. "Edit with your AI" asked the
// person's AIs through a hand-off store that is gone (one kind of task now); the part that is still true is held here: a read
// changes nothing. Every value is made up.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { listMyAutomations } from '../do-work/list-my-automations.mjs';
import { recordedWords } from '../read-data/record-kind-words.mjs';

const folder = resolve(import.meta.dirname, '..');
const daily = { kind: 'due-time', from: ['run'], watch: { schedules: [{ cadence: { unit: 'day' }, local_window: { start: '09:00' }, timezone: 'UTC' }] } };
const invoices = { fact: { kind: 'message', from: ['sender'], match: { topic: 'invoice' } } };
const wake = (tool, id, on, switched_on = true, mark = {}) => ({ tool, id, on, budget: { steps: 1 }, switched_on, mark });
const tools = [{ id: 'tool:file-a-note', label: 'File a note', input_schema: { type: 'object', properties: { note: { type: 'string' }, folder: { type: 'string' } } } }];
const recipe = {
  id: 'workflow:keep-invoices', label: 'Keep invoices', job: 'Keep each invoice that arrives.',
  steps: JSON.stringify([{ id: 'read', title: 'Read it', do: 'Read the invoice.' }, { id: 'keep', do: 'Keep it.' }]),
  fires_when: JSON.stringify([{ label: 'an invoice arrives', condition: { fields: [], tree: {} }, made_by: 'person', state: 'On' }, { label: 'old way', condition: { fields: [], tree: {} }, made_by: 'person', state: 'Off' }]),
  input_schema: JSON.stringify({ type: 'object', properties: { invoice: { type: 'string' } } }),
};

test('a trigger says what sets it off, then what it does, and opens as when then, with the input schema of what it runs', () => {
  const input = { wakes: [wake('tool:file-a-note', 'on-invoice', invoices)], tools };
  const [row] = listMyAutomations(input).automations;
  assert.equal(row.kind, 'trigger');
  assert.equal(row.when, "When a message is recorded whose topic is 'invoice'");
  assert.equal(row.does, 'File a note');
  assert.equal(row.enabled, true);
  const opened = listMyAutomations({ ...input, open: row.open_id });
  assert.equal(opened.label, 'File a note: On invoice');
  assert.deepEqual(opened.graph.steps.map(step => step.id), ['when', 'then']);
  assert.equal(opened.graph.steps[0].title, row.when);
  assert.equal(opened.graph.steps[1].title, 'File a note');
  assert.deepEqual(opened.graph.edges, [{ from: 'when', to: 'then' }]);
  assert.equal(opened.graph.steps[0].state.label, 'On');
  assert.deepEqual(Object.keys(opened.input_schema.properties), ['note', 'folder']);
  assert.deepEqual(opened.then, { tool_id: 'tool:file-a-note' });
});

test('a schedule says its due time, a kept-running program says so, and a failed run is red first with its cause', () => {
  const answer = listMyAutomations({ wakes: [
    wake('tool:file-a-note', 'morning', { fact: daily }, true, { ran_ms: 1_800_000_000_000, outcome: 'ran' }),
    wake('tool:file-a-note', 'keep', { running: {} }, true, { running: 'k' }),
    wake('tool:file-a-note', 'broken', invoices, true, { ran_ms: 1_800_000_100_000, outcome: 'failed', outcome_cause: 'no key' }),
    wake('tool:file-a-note', 'stopped', invoices, false),
  ] });
  assert.deepEqual(answer.automations.map(row => [row.id.split('/')[1], row.kind, row.enabled]).sort(), [['broken', 'trigger', true], ['keep', 'running', true], ['morning', 'schedule', true], ['stopped', 'trigger', false]]);
  const by = id => answer.automations.find(row => row.id.endsWith(`/${id}`));
  assert.equal(by('morning').when, 'Every day at 09:00 UTC');
  assert.equal(by('morning').last_run_at, '2027-01-15T08:00:00.000Z');
  assert.match(by('keep').when, /^Kept running/);
  assert.equal(by('broken').red, true);
  assert.match(by('broken').last_problem, /no key/);
  assert.equal(by('stopped').state, 'off');
  assert.deepEqual([answer.red, answer.on, answer.off], [1, 3, 1]);
});

test('a workflow row, with its fields kept as JSON text, lists with the words of the conditions it fires on and the trigger that starts it', () => {
  const input = { wakes: [wake('workflow:keep-invoices', 'chosen--invoice', { fact: { kind: 'workflow-chosen', from: ['run'] } }, true)], recipes: [{ id: 'row-1', values: recipe }].map(row => ({ ...row.values })) };
  const answer = listMyAutomations(input);
  assert.deepEqual(answer.workflows, [{ workflow_id: 'workflow:keep-invoices', label: 'Keep invoices', job: 'Keep each invoice that arrives.', made_by: null, steps: 2, fires_when: ['an invoice arrives'], enabled: true }]);
  assert.equal(answer.automations[0].starts, 'workflow:keep-invoices');
  assert.equal(answer.automations[0].does, 'Keep invoices');
  const opened = listMyAutomations({ ...input, open: 'workflow:keep-invoices' });
  assert.deepEqual(opened.graph.steps.map(step => step.title), ['Read it', 'Keep']);
  assert.deepEqual(opened.graph.edges, [{ from: 'read', to: 'keep' }]);
  assert.equal(opened.says, 'an invoice arrives');
  assert.deepEqual(Object.keys(opened.input_schema.properties), ['invoice']);
});

test('record kinds read in their own words, else as a sentence with a or an; reading changes nothing; bad input is refused by name', () => {
  assert.equal(recordedWords('file-arrival'), 'a file arrives');
  assert.equal(recordedWords('arrival'), 'something arrives from elsewhere');
  assert.equal(recordedWords('invoice-paid'), 'an invoice paid is recorded');
  assert.equal(recordedWords('booking'), 'a booking is recorded');
  const input = { wakes: [wake('tool:file-a-note', 'on-invoice', invoices)], recipes: [recipe], tools };
  const before = JSON.stringify(input);
  listMyAutomations(input);
  assert.equal(JSON.stringify(input), before);
  assert.throws(() => listMyAutomations({}), /Send wakes/);
  assert.throws(() => listMyAutomations({ wakes: [], open: 'nothing' }), /There is no automation or workflow nothing/);
  assert.throws(() => listMyAutomations({ wakes: [], recipes: [{ label: 'x' }] }), /with an id/);
  assert.throws(() => listMyAutomations({ wakes: [], recipes: [{ id: 'workflow:x', steps: '{not json' }] }), /not JSON/);
});

test('run as the tool container runs it, the program answers the same', () => {
  const input = { wakes: [wake('tool:file-a-note', 'on-invoice', invoices)], tools };
  const run = spawnSync('node', ['do-work/list-my-automations.mjs'], { cwd: folder, input: JSON.stringify(input), encoding: 'utf8' });
  assert.equal(run.status, 0, run.stderr);
  assert.deepEqual(JSON.parse(run.stdout.trim().split('\n').at(-1)).result, listMyAutomations(input));
});
