// The alias refusal before dispatch (src/input-alias-refusal.mjs): ported from the old tools-batch test "required inputs
// reject aliases before dispatch in single and batch calls, while exact Unicode identity passes". The old test ran the
// whole MCP path; this checks the pure rule on the same inputs, and a wiring test checks the owner calls it before dispatch.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { aliasProblems } from '../src/input-alias-refusal.mjs';
import { makeWorkshop, readToolData } from '../src/workshop.mjs';
import settings from '../src/workshop-settings.json' with { type: 'json' };

const schema = { type: 'object', required: ['name_or_identity'], properties: { name_or_identity: { type: 'string' } } };
const nfd = 'cafe\u0301.txt';
const nfc = 'caf\u00e9.txt';
const REFUSAL = 'Invalid input: missing required field: name_or_identity.';

test('a single call that names the required field by an alias is refused with the old words', () => {
  assert.deepEqual(aliasProblems({ path: nfd }, schema), [REFUSAL]);
  assert.deepEqual(aliasProblems({ file: nfd }, schema), [REFUSAL]);
});

test('the exact field name passes, and an exact Unicode identity is not changed by the check', () => {
  assert.deepEqual(aliasProblems({ name_or_identity: nfd }, schema), []);
  assert.deepEqual(aliasProblems({ name_or_identity: nfc }, schema), []);
  assert.notEqual(nfd, nfc, 'the two spellings are different identities');
});

test('a batch is checked item by item: the aliased item is refused, the exact one passes', () => {
  const items = [{ input: { file: nfd } }, { input: { name_or_identity: nfd } }];
  assert.deepEqual(items.map(item => aliasProblems(item.input, schema)), [[REFUSAL], []]);
});

test('an input with no alias key is left to the schema check, and a missing field with no alias is not an alias refusal', () => {
  assert.deepEqual(aliasProblems({}, schema), [], 'no extra key: the waiting-for-input path decides, not the alias check');
  assert.deepEqual(aliasProblems({ name_or_identity: nfd, note: 'extra' }, { ...schema, properties: { ...schema.properties, note: { type: 'string' } } }), []);
});

test('several missing required fields are named together, and a schema that refuses extra keys is left to schemaProblems', () => {
  const two = { type: 'object', required: ['a', 'b'], properties: { a: {}, b: {} } };
  assert.deepEqual(aliasProblems({ c: 1 }, two), ['Invalid input: missing required fields: a, b.']);
  assert.deepEqual(aliasProblems({ c: 1 }, { ...two, additionalProperties: false }), []);
});

test('non-object inputs and schemas give no alias words', () => {
  assert.deepEqual(aliasProblems(null, schema), []);
  assert.deepEqual(aliasProblems(['x'], schema), []);
  assert.deepEqual(aliasProblems({ path: nfd }, null), []);
});

test('the owner calls the alias check before each dispatch path', () => {
  const source = readFileSync(new URL('../src/workshop.mjs', import.meta.url), 'utf8');
  assert.match(source, /import \{ aliasProblems \} from '\.\/input-alias-refusal\.mjs';/);
  const calls = source.match(/aliasProblems\(/g) ?? [];
  assert.equal(calls.length, 3, 'three calls: the run path, the read-once path and the relay path');
});

// The owner's switch (src/workshop-settings.json, refuse_aliased_inputs). It is off by default: an aliased partial input
// then reaches the pending-input path, which asks the person for the missing field (src/workshop.mjs begin, the
// waiting_for_input branch). The switch on refuses it before dispatch with the old words.
const aliasTool = { kind: 'ai-tool-descriptor', id: 'tool:name-judge', label: 'Name judge', job: 'Judge a name',
  input_schema: { type: 'object', required: ['name_or_identity'], properties: { name_or_identity: { type: 'string', title: 'Name or identity' } } },
  output_schema: { type: 'object', required: ['answer'] }, invoke: { kind: 'model', model: 'local', input: { name_or_identity: { fill: { from: 'input', field: 'name_or_identity' } } } },
  licence_class: 'licence:open', placements: ['placement:here'] };
const aliasBase = [
  { kind: 'tool-placement', id: 'placement:here', label: 'Here', executor: 'model-runtime', reachable_from: ['hosted'] },
  { kind: 'tool-licence-class', id: 'licence:open', label: 'Open', licences: ['MIT'], allowed_placements: ['placement:here'], store_bytes: true },
  aliasTool,
];
function hostedWith(refuseAliasedInputs) {
  const tasks = new Map();
  const later = () => new Promise(resolve => setImmediate(resolve));
  const store = {
    readTask: async id => { await later(); return tasks.get(id) ?? null; },
    writeTask: async task => { await later(); tasks.set(task.task_id, task); },
    dueTasks: async () => [], nextDueAt: async () => null, lastCompleted: async () => null, taskCards: async () => [],
    readSavedTools: async () => [], writeSavedTool: async () => {}, putBytes: async () => {},
  };
  const workshop = makeWorkshop({
    host: 'hosted', data: async () => readToolData(aliasBase.map(payload => ({ payload }))),
    executors: { 'model-runtime': async ({ invocation }) => ({ answer: invocation.input.name_or_identity }) },
    pool: { recordRun: async () => {}, recordReport: async () => {}, stats: async () => ({}) },
    store, now: () => new Date('2026-11-20T11:00:00Z'), refuseAliasedInputs,
  });
  return { workshop, tasks };
}

test('the DATA switch is off by default, so an aliased partial input is not refused by the owner', () => {
  assert.equal(settings.refuse_aliased_inputs, false);
});

test('with the switch on, an aliased partial input is refused before dispatch with the old words', async () => {
  const { workshop, tasks } = hostedWith(true);
  await assert.rejects(workshop.run({ tool_id: 'tool:name-judge', input: { path: nfd }, request_key: 'alias-on-1' }), /missing required field: name_or_identity/);
  assert.equal(tasks.size, 0, 'nothing was recorded as a run');
});

test('with the switch off (the default), an aliased partial input is not refused and reaches the pending-input path', async () => {
  const { workshop, tasks } = hostedWith(false);
  const answer = await workshop.run({ tool_id: 'tool:name-judge', input: { path: nfd }, request_key: 'alias-off-1' });
  assert.equal(answer.state, 'waiting_for_input');
  assert.deepEqual(answer.pending_input.fields.map(field => field.name), ['name_or_identity']);
  assert.equal([...tasks.values()][0].state, 'waiting_for_input');
});
