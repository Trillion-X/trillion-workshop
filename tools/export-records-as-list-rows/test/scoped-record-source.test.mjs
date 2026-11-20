import { tempFolder } from '../../../test-helpers/temp-folder.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { makeHashCodeHexFromBytes } from '../../content-identity/read-data/identity.mjs';
import { answerOf as runRow, rowOf, said } from '../../../test-helpers/run-a-row.mjs';
import { runWorkflow } from '../../write-a-job-done-in-several-steps-have/read-data/run-a-workflow.mjs';

const tool = fileURLToPath(new URL('..', import.meta.url));
const builder = join(tool, 'do-work/build_record_write.py');

function mappingAt(root, type = 'shared', prefix = 'shared:') {
  writeFileSync(join(root, 'lists.json'), JSON.stringify({ lists: [
    { id: 'ideas', value: { label: 'Ideas', row_type: 'idea', fields: [{ id: 'name', label: 'Name', kind: 'text' }] } },
  ], views: [] }));
  writeFileSync(join(root, 'mapping.json'), JSON.stringify({
    lists_file: { root: 'here', path: 'lists.json' }, by: 'workflow:test', emit: ['ideas'],
    sources: [{
      name: 'shared-inputs', list: 'ideas', kind: 'records',
      records: { type, prefix },
      keys: { identity: { identity: { path: 'record.value.identity' } } },
      id: { text: 'idea-{identity}' },
      values: { name: { path: 'record.value.title' } },
    }],
  }));
}

function twoScopeMappingAt(root, { includeDenied = false } = {}) {
  const lists = ['fixture-a', 'fixture-b'].map(id => ({ id, value: { label: id, row_type: id, fields: [{ id: 'name', label: 'Name', kind: 'text' }] } }));
  const sources = ['a', 'b'].map(letter => ({
    name: `source-${letter}`, list: `fixture-${letter}`, kind: 'records',
    records: { type: `source-${letter}`, prefix: `source-${letter}:` },
    keys: { identity: { identity: { path: 'record.value.identity' } } },
    id: { text: `fixture-${letter}-{identity}` },
    values: { name: { path: 'record.value.title' } },
  }));
  if (includeDenied) sources.push({
    name: 'unlisted-source', list: 'fixture-a', kind: 'records',
    records: { type: 'unlisted', prefix: 'unlisted:' },
    keys: { identity: { identity: { path: 'record.value.identity' } } },
    id: { text: 'fixture-a-{identity}' }, values: { name: { path: 'record.value.title' } },
  });
  writeFileSync(join(root, 'lists.json'), JSON.stringify({ lists, views: [] }));
  writeFileSync(join(root, 'mapping.json'), JSON.stringify({
    lists_file: { root: 'here', path: 'lists.json' }, by: 'workflow:test', emit: ['fixture-a', 'fixture-b'], sources,
  }));
}

function runBuilder(root, records) {
  const args = ['-I', builder, '--mapping', join(root, 'mapping.json'), '--out', join(root, 'payload.json')];
  if (records !== undefined) {
    writeFileSync(join(root, 'held.json'), JSON.stringify({ records }));
    args.push('--records-from', join(root, 'held.json'));
  }
  return new Promise(resolve => {
    const child = spawn('python3', args, { stdio: ['ignore', 'pipe', 'pipe'] });
    const stdout = [], stderr = [];
    child.stdout.on('data', chunk => stdout.push(chunk));
    child.stderr.on('data', chunk => stderr.push(chunk));
    child.on('error', error => resolve({ status: null, stdout: Buffer.concat(stdout).toString(), stderr: Buffer.concat(stderr).toString(), error }));
    child.on('close', status => resolve({ status, stdout: Buffer.concat(stdout).toString(), stderr: Buffer.concat(stderr).toString() }));
  });
}

const sharedRecords = [
  { id: 'shared:one', type: 'shared', value: { identity: 'one', title: 'One' } },
  { id: 'shared:two', type: 'shared', value: { identity: 'two', title: 'Two' } },
  { id: 'other:three', type: 'shared', value: { identity: 'three', title: 'Three' } },
  { id: 'shared:four', type: 'secret', value: { identity: 'four', title: 'Four' } },
];

test('the builder maps only the records handed in that match a source\'s type and prefix, and reads no account', async () => {
  const root = tempFolder(join(tmpdir(), 'scoped-record-source-'));
  try {
    mappingAt(root);
    const result = await runBuilder(root, sharedRecords);
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
    assert.deepEqual(JSON.parse(readFileSync(join(root, 'payload.json'), 'utf8')).commands.flatMap(command => command.input.records)
      .filter(record => record.type === 'record:idea').map(record => record.id).sort(), [
      `record:idea:idea-${makeHashCodeHexFromBytes(Buffer.from('one'))}`,
      `record:idea:idea-${makeHashCodeHexFromBytes(Buffer.from('two'))}`,
    ].sort());
    assert.ok(!result.stdout.includes('One') && !result.stdout.includes('Two'), 'private source values stay out of the builder answer');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('a mapping that reads records but is given none stops, and no store is consulted', async () => {
  const root = tempFolder(join(tmpdir(), 'scoped-record-source-refused-'));
  try {
    mappingAt(root, 'secret', 'secret:');
    const result = await runBuilder(root);
    assert.equal(result.status, 2, `${result.stdout}\n${result.stderr}`);
    assert.match(result.stderr, /hands them in with --records-from/);
    assert.ok(!existsSync(join(root, 'payload.json')));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('the Workshop COMPUTER row returns its payload from the records handed in, with no records door', async () => {
  const root = tempFolder(join(tmpdir(), 'scoped-record-source-row-'));
  try {
    mappingAt(root);
    const toolRows = JSON.parse(readFileSync(join(tool, 'tool-rows.json'), 'utf8'));
    const row = rowOf(toolRows, 'tool:build-records-to-write');
    assert.equal(row.invoke.records, undefined, 'the row declares no records door');
    const answer = await runRow(row, { mapping: join(root, 'mapping.json'), records: sharedRecords });
    assert.equal(answer.status, 0, JSON.stringify(answer));
    assert.equal(answer.result.counts.rows.ideas, 2);
    assert.deepEqual(answer.result.commands.flatMap(command => command.input.records)
      .filter(record => record.type === 'record:idea').map(record => record.id).sort(), [
      `record:idea:idea-${makeHashCodeHexFromBytes(Buffer.from('one'))}`,
      `record:idea:idea-${makeHashCodeHexFromBytes(Buffer.from('two'))}`,
    ].sort());
    assert.deepEqual(answer.calls, [], 'no records call was made');
    const refused = await runRow(row, { mapping: join(root, 'mapping.json') });
    assert.notEqual(refused.status, 0);
    assert.match(refused.error, /hands them in with --records-from/);
    const malformed = await runRow(row, { mapping: join(root, 'mapping.json'), records: [{ id: 'x' }] });
    assert.notEqual(malformed.status, 0);
    assert.match(malformed.error, /records are the records the mapping reads/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

const plannerConfig = { per_command: 4, command_bytes: 4000, request_key_prefix: 'fixture-load' };
const canon = value => JSON.stringify(value, (_key, item) => item && typeof item === 'object' && !Array.isArray(item)
  ? Object.fromEntries(Object.keys(item).sort().map(key => [key, item[key]])) : item);

// The caller's own store, as a map of id to record. heldOf reads the target records the way the caller's AI hands them in.
function heldOf(store, type, prefix) {
  return [...store.values()].filter(record => record.type === type && record.id.startsWith(prefix)).map(({ id, type: kind, value }) => ({ id, type: kind, value }));
}

// Writes commands the way a store does: a record that carries expected must find exactly that value (or none), else the store refuses.
function writeCommands(store, commands) {
  for (const command of commands) for (const record of command.input.records) {
    if (Object.hasOwn(record, 'expected')) {
      const current = store.get(record.id);
      const refused = record.expected === null ? current !== undefined : !current || canon(current.value) !== canon(record.expected.value);
      if (refused) throw new Error(`The store refused ${record.id}: it no longer holds the expected value.`);
    }
    if (record.value === null) store.delete(record.id);
    else store.set(record.id, { id: record.id, type: record.type, value: record.value });
  }
}

test('a synthetic wake run plans the builder records for each kind, the caller writes each plan, and a readback matches', async () => {
  const root = tempFolder(join(tmpdir(), 'scoped-record-source-two-kinds-'));
  try {
    twoScopeMappingAt(root);
    const toolRows = JSON.parse(readFileSync(join(tool, 'tool-rows.json'), 'utf8'));
    const builderRow = rowOf(toolRows, 'tool:build-records-to-write');
    const sources = [
      { id: 'source-a:one', type: 'source-a', value: { identity: 'one', title: 'From A' } },
      { id: 'source-b:two', type: 'source-b', value: { identity: 'two', title: 'From B' } },
    ];
    const workflowId = 'workflow:synthetic-scoped-record-flow';
    const slug = workflowId.slice('workflow:'.length);
    const steps = [
      { id: 'make-rows', tool_id: 'tool:build-records-to-write', input: { mapping: join(root, 'mapping.json') } },
      { id: 'write-a', tool_id: 'tool:put-records-into-my-account', input: { payload: { from: ['steps', 'make-rows'] }, target_type: 'record:fixture-a', target_prefix: 'record:fixture-a:fixture-a-', config: plannerConfig } },
      { id: 'write-b', tool_id: 'tool:put-records-into-my-account', input: { payload: { from: ['steps', 'make-rows'] }, target_type: 'record:fixture-b', target_prefix: 'record:fixture-b:fixture-b-', config: plannerConfig } },
    ];
    const workflowRows = [
      { id: `record:workflow-recipe:${slug}`, type: 'record:workflow-recipe', value: {
        recipe: workflowId, title: 'Synthetic scoped record flow', job: 'Build records, then plan their writes.', input_schema: JSON.stringify({ type: 'object' }),
      } },
      ...steps.map((step, position) => ({
        id: `record:workflow-step:${slug}--${step.id}`, type: 'record:workflow-step', value: {
          recipe: [slug], position: position + 1, step: step.id, title: step.id,
          do: `Run ${step.tool_id}.`, submit: JSON.stringify({ type: 'object', additionalProperties: true }),
          run_tool: JSON.stringify({ tool_id: step.tool_id, input: step.input }),
        },
      })),
    ];
    // The person's workflow rows run on the workflow engine, from the step a wake names: it asks each tool in order.
    const started = await runWorkflow({ row: workflowRows[0], steps: workflowRows.slice(1), input: { start_at: 'make-rows' } });
    assert.equal(started.status, 'paused', started.error_message);
    assert.deepEqual(started.waiting.map(wait => [wait.step_id, wait.asks]), [['make-rows', 'tool:build-records-to-write']]);
    assert.deepEqual(started.definition.steps.filter(step => step.kind === 'ask').map(step => step.config.name), ['tool:build-records-to-write', 'tool:put-records-into-my-account', 'tool:put-records-into-my-account']);
    const job = { value: { job: steps.map(step => ({ run_tool: { tool_id: step.tool_id, input: step.input } })) } };

    const built = await runRow(builderRow, { ...job.value.job[0].run_tool.input, records: sources });
    assert.equal(built.status, 0, JSON.stringify(built));
    assert.deepEqual(built.calls, [], 'the builder made no records call');
    const writer = rowOf(toolRows, 'tool:put-records-into-my-account');
    const store = new Map(sources.map(record => [record.id, record]));
    const stepA = job.value.job[1].run_tool.input;
    const planA = await runRow(writer, { ...stepA, payload: built.result, held: heldOf(store, stepA.target_type, stepA.target_prefix) });
    assert.equal(planA.status, 0, JSON.stringify(planA));
    assert.equal(planA.result.state, 'to_write');
    assert.equal(planA.result.to_write, 1);
    assert.equal(planA.result.commands.length, 1);
    assert.equal(planA.result.out_of_scope, 3, 'the other list and source records are counted, never written');
    writeCommands(store, planA.result.commands);
    const checkA = await runRow(writer, { ...stepA, mode: 'readback', payload: built.result, held: heldOf(store, stepA.target_type, stepA.target_prefix) });
    assert.equal(checkA.status, 0, JSON.stringify(checkA));
    assert.deepEqual(checkA.result.readback, { 'record:fixture-a': { payload: 1, held: 1, equal: 1, missing: [], differing: [] } });
    const stepB = job.value.job[2].run_tool.input;
    const planB = await runRow(writer, { ...stepB, payload: built.result, held: heldOf(store, stepB.target_type, stepB.target_prefix) });
    assert.equal(planB.status, 0, JSON.stringify(planB));
    assert.equal(planB.result.out_of_scope, 3);
    writeCommands(store, planB.result.commands);
    const repeated = await runRow(writer, { ...stepB, payload: built.result, held: heldOf(store, stepB.target_type, stepB.target_prefix) });
    assert.equal(repeated.status, 0, JSON.stringify(repeated));
    assert.equal(repeated.result.to_write, 0);
    assert.equal(repeated.result.state, 'nothing_to_write', 'a repeated build plans nothing and leaves the held values as they are');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});


test('a records source with no matching record builds no row, and a missing folder path fails before anything is built', async () => {
  const root = tempFolder(join(tmpdir(), 'scoped-record-source-denied-kind-'));
  try {
    twoScopeMappingAt(root, { includeDenied: true });
    const toolRows = JSON.parse(readFileSync(join(tool, 'tool-rows.json'), 'utf8'));
    const row = rowOf(toolRows, 'tool:build-records-to-write');
    const records = [
      { id: 'source-a:one', type: 'source-a', value: { identity: 'one', title: 'A' } },
      { id: 'source-b:two', type: 'source-b', value: { identity: 'two', title: 'B' } },
      { id: 'unlisted:three', type: 'unlisted', value: { identity: 'three', title: 'C' } },
    ];
    const built = await runRow(row, { mapping: join(root, 'mapping.json'), records: records.slice(0, 2) });
    assert.equal(built.status, 0, JSON.stringify(built));
    assert.deepEqual(built.result.counts.rows, { 'fixture-a': 1, 'fixture-b': 1 }, 'the unlisted source matched no record handed in');
    const missing = await runRow(row, { mapping: join(root, 'no-folder-grant', 'mapping.json'), records });
    assert.notEqual(missing.status, 0);
    assert.deepEqual(missing.calls, []);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('the write planner refreshes through the same baseline, keeps live edits and deletions, and a store refuses a value that changed', async () => {
  const rows = JSON.parse(readFileSync(join(tool, 'tool-rows.json'), 'utf8'));
  const writer = rowOf(rows, 'tool:put-records-into-my-account');
  const record = (id, value) => ({ id: `record:fixture:${id}`, type: 'record:fixture', value });
  const payload = records => ({ commands: [{ input: { records } }] });
  const original = { name: 'Imported', note: 'Original', _basis: { name: { by: 'source' } } };
  const baseline = payload([record('one', original), record('deleted', { name: 'Deleted' }), record('remove', { name: 'Original' })]);
  const desired = payload([record('one', { name: 'New source name', note: 'Improved', mechanism: ['cause'], _basis: { name: { by: 'new-source' } } }),
    record('deleted', { name: 'Source changed' }), record('remove', null)]);
  const live = () => new Map([
    record('one', { name: 'Person edit', note: 'Original', custom: 'Keep', _basis: { name: { by: 'person' } } }),
    record('remove', { name: 'Peer edit' }),
  ].map(entry => [entry.id, entry]));
  const input = (store) => ({ payload: desired, baseline, target_type: 'record:fixture', target_prefix: 'record:fixture:', config: plannerConfig,
    held: heldOf(store, 'record:fixture', 'record:fixture:') });
  const store = live();
  const planned = await runRow(writer, input(store));
  assert.equal(planned.status, 0, JSON.stringify(planned));
  assert.equal(planned.result.state, 'to_write');
  assert.deepEqual(planned.result.conflicts.map(c => [c.id, c.path, c.reason]), [
    ['record:fixture:one', ['name'], 'live_changed'], ['record:fixture:deleted', [], 'live_deleted'],
    ['record:fixture:remove', [], 'unsafe_removal'],
  ]);
  writeCommands(store, planned.result.commands);
  assert.deepEqual(store.get('record:fixture:one').value,
    { name: 'Person edit', note: 'Improved', custom: 'Keep', mechanism: ['cause'], _basis: { name: { by: 'person' } } });
  assert.ok(!store.has('record:fixture:deleted'));
  assert.equal(store.get('record:fixture:remove').value.name, 'Peer edit');
  const repeated = await runRow(writer, input(store));
  assert.equal(repeated.status, 0, JSON.stringify(repeated));
  assert.equal(repeated.result.commands.length, 0, 'the same baseline plans nothing more');
  const stale = live();
  const plannedAgain = await runRow(writer, input(stale));
  stale.set('record:fixture:one', record('one', { name: 'Someone else wrote this' }));
  assert.throws(() => writeCommands(stale, plannedAgain.result.commands), /The store refused record:fixture:one/);
  const invalid = await runRow(writer, { ...input(store), config: { ...plannerConfig, keep_held: true } });
  assert.notEqual(invalid.status, 0);
  assert.match(invalid.error, /cannot be combined/);
});

test('a readback that lacks a target record is readback_differs, and a held record outside the target is refused', async () => {
  const rows = JSON.parse(readFileSync(join(tool, 'tool-rows.json'), 'utf8'));
  const writer = rowOf(rows, 'tool:put-records-into-my-account');
  const record = { id: 'record:fixture:one', type: 'record:fixture', value: { name: 'One' } };
  const input = { payload: { commands: [{ input: { records: [record] } }] }, target_type: record.type, target_prefix: 'record:fixture:', config: plannerConfig };
  const readback = await runRow(writer, { ...input, mode: 'readback', held: [] });
  assert.equal(readback.status, 0, JSON.stringify(readback));
  assert.equal(readback.result.state, 'readback_differs');
  assert.deepEqual(readback.result.readback['record:fixture'].missing, [record.id]);
  const refused = await runRow(writer, { ...input, mode: 'readback', held: [{ id: record.id, type: 'record:other', value: {} }] });
  assert.notEqual(refused.status, 0);
  assert.match(refused.error, /outside the target type and prefix/);
});
