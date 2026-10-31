import test from 'node:test';
import assert from 'node:assert/strict';
import { closeSync, mkdtempSync, openSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { startFakeDoor } from '../../records-door/test/fake-door.mjs';
import { makeHashCodeHexFromBytes } from '../../content-identity/read-data/identity.mjs';
import { rowOf, runRow } from '../../records-door/test/run-row.mjs';
import { sendBuiltRecordWrite } from '../do-work/send_built_record_write.mjs';

const tool = fileURLToPath(new URL('..', import.meta.url));
const workshop = fileURLToPath(new URL('../../..', import.meta.url));
const builder = join(tool, 'do-work/build_record_write.py');
const doorModule = join(workshop, 'tools/records-door/read-data/records-door.mjs');

function mappingAt(root, type = 'shared', prefix = 'shared:') {
  writeFileSync(join(root, 'lists.json'), JSON.stringify({ lists: [
    { id: 'ideas', value: { label: 'Ideas', row_type: 'idea', fields: [{ id: 'name', label: 'Name', kind: 'text' }] } },
  ], views: [] }));
  writeFileSync(join(root, 'mapping.json'), JSON.stringify({
    lists_file: { root: 'here', path: 'lists.json' }, by: 'workflow:test', emit: ['ideas'],
    sources: [{
      name: 'shared-inputs', list: 'ideas', kind: 'records',
      records: { type, prefix, config: { root: 'here', path: 'missing-sender-config.json' } },
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
    records: { type: `source-${letter}`, prefix: `source-${letter}:`, config: { root: 'here', path: 'missing-sender-config.json' } },
    keys: { identity: { identity: { path: 'record.value.identity' } } },
    id: { text: `fixture-${letter}-{identity}` },
    values: { name: { path: 'record.value.title' } },
  }));
  if (includeDenied) sources.push({
    name: 'unlisted-source', list: 'fixture-a', kind: 'records',
    records: { type: 'unlisted', prefix: 'unlisted:', config: { root: 'here', path: 'missing-sender-config.json' } },
    keys: { identity: { identity: { path: 'record.value.identity' } } },
    id: { text: 'fixture-a-{identity}' }, values: { name: { path: 'record.value.title' } },
  });
  writeFileSync(join(root, 'lists.json'), JSON.stringify({ lists, views: [] }));
  writeFileSync(join(root, 'mapping.json'), JSON.stringify({
    lists_file: { root: 'here', path: 'lists.json' }, by: 'workflow:test', emit: ['fixture-a', 'fixture-b'], sources,
  }));
}

function runBuilder(root, descriptorFd) {
  return new Promise(resolve => {
    const child = spawn('python3', ['-I', builder,
      '--mapping', join(root, 'mapping.json'),
      '--out', join(root, 'payload.json'),
      '--records-door-module', doorModule,
    ], { stdio: ['ignore', 'pipe', 'pipe', descriptorFd] });
    const stdout = [], stderr = [];
    child.stdout.on('data', chunk => stdout.push(chunk));
    child.stderr.on('data', chunk => stderr.push(chunk));
    child.on('error', error => resolve({ status: null, stdout: Buffer.concat(stdout).toString(), stderr: Buffer.concat(stderr).toString(), error }));
    child.on('close', status => resolve({ status, stdout: Buffer.concat(stdout).toString(), stderr: Buffer.concat(stderr).toString() }));
  });
}

function rowInRepository(row) {
  return { ...row, invoke: { ...row.invoke,
    argv: row.invoke.argv.map(argument => argument.replace('/opt/tools/export-records-as-list-rows', '/opt/export-records-as-list-rows')) } };
}

test('the builder maps only the records allowed on this run descriptor, pages the read, and never opens sender config', async () => {
  const fake = await startFakeDoor({
    rights: [{ kind: 'shared', prefix: 'shared:', operations: ['records:list'] }],
    pageCut: 1,
    records: [
      { id: 'shared:one', type: 'shared', value: { identity: 'one', title: 'One' } },
      { id: 'shared:two', type: 'shared', value: { identity: 'two', title: 'Two' } },
    ],
  });
  const root = mkdtempSync(join(tmpdir(), 'scoped-record-source-'));
  let descriptorFd;
  try {
    mappingAt(root);
    descriptorFd = openSync(fake.descriptor, 'r');
    const result = await runBuilder(root, descriptorFd);
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
    assert.deepEqual(JSON.parse(readFileSync(join(root, 'payload.json'), 'utf8')).commands.flatMap(command => command.input.records)
      .filter(record => record.type === 'record:idea').map(record => record.id).sort(), [
      `record:idea:idea-${makeHashCodeHexFromBytes(Buffer.from('one'))}`,
      `record:idea:idea-${makeHashCodeHexFromBytes(Buffer.from('two'))}`,
    ].sort());
    assert.ok(!result.stdout.includes('One') && !result.stdout.includes('Two'), 'private source values stay out of the builder answer');
    assert.equal(fake.calls.length, 2, 'the run-scoped records door pages the list');
    assert.ok(fake.calls.every(call => call.method === 'records:list' && call.input.type === 'shared' && call.input.prefix === 'shared:'));
    assert.ok(fake.calls.every(call => call.authorization === `Bearer ${fake.capability}`));
  } finally {
    if (descriptorFd !== undefined) closeSync(descriptorFd);
    rmSync(root, { recursive: true, force: true });
    await fake.close();
  }
});

test('an unauthorized source read stops without falling back to the sender config', async () => {
  const fake = await startFakeDoor({
    rights: [{ kind: 'shared', prefix: 'shared:', operations: ['records:list'] }],
  });
  const root = mkdtempSync(join(tmpdir(), 'scoped-record-source-refused-'));
  let descriptorFd;
  try {
    mappingAt(root, 'secret', 'secret:');
    descriptorFd = openSync(fake.descriptor, 'r');
    const result = await runBuilder(root, descriptorFd);
    assert.equal(result.status, 2, `${result.stdout}\n${result.stderr}`);
    assert.match(result.stderr, /may not reach those records|refused the request/);
    assert.ok(!readFileSync(join(root, 'mapping.json'), 'utf8').includes('Bearer'));
    assert.equal(fake.calls.length, 1);
    assert.equal(fake.calls[0].method, 'records:list');
    assert.equal(fake.calls[0].input.type, 'secret');
    assert.equal(fake.calls[0].input.prefix, 'secret:');
    assert.ok(!result.stdout.includes(fake.capability));
  } finally {
    if (descriptorFd !== undefined) closeSync(descriptorFd);
    rmSync(root, { recursive: true, force: true });
    await fake.close();
  }
});

test('the Workshop COMPUTER row returns its payload using only the fd 3 read capability', async () => {
  const root = mkdtempSync(join(tmpdir(), 'scoped-record-source-row-'));
  try {
    mappingAt(root);
    const toolRows = JSON.parse(readFileSync(join(tool, 'tool-rows.json'), 'utf8'));
    const sourceRow = rowOf(toolRows, 'tool:build-records-to-write');
    const row = { ...sourceRow, invoke: { ...sourceRow.invoke,
      argv: sourceRow.invoke.argv.map(argument => argument.replace('/opt/tools/export-records-as-list-rows', '/opt/export-records-as-list-rows')) } };
    const records = [
      { id: 'shared:one', type: 'shared', value: { identity: 'one', title: 'One' } },
      { id: 'shared:two', type: 'shared', value: { identity: 'two', title: 'Two' } },
    ];
    const answer = await runRow(row, { mapping: join(root, 'mapping.json'), source_type: 'shared', source_prefix: 'shared:' }, { records });
    assert.equal(answer.status, 0, JSON.stringify(answer));
    assert.equal(answer.result.counts.rows.ideas, 2);
    assert.deepEqual(answer.result.commands.flatMap(command => command.input.records)
      .filter(record => record.type === 'record:idea').map(record => record.id).sort(), [
      `record:idea:idea-${makeHashCodeHexFromBytes(Buffer.from('one'))}`,
      `record:idea:idea-${makeHashCodeHexFromBytes(Buffer.from('two'))}`,
    ].sort());
    assert.deepEqual(answer.calls.map(call => [call.method, call.input.type, call.input.prefix]), [
      ['records:list', 'shared', 'shared:'],
    ]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('a synthetic wake starts the COMPUTER builder and its result flows to a separately scoped two-kind writer', async () => {
  const root = mkdtempSync(join(tmpdir(), 'scoped-record-source-two-kinds-'));
  try {
    twoScopeMappingAt(root);
    const toolRows = JSON.parse(readFileSync(join(tool, 'tool-rows.json'), 'utf8'));
    const builderRow = rowOf(toolRows, 'tool:build-records-to-write');
    const reader = rowInRepository({ ...builderRow, invoke: { ...builderRow.invoke, records: { fd: 3, rights: [
      { kind: 'source-a', prefix: 'source-a:', operations: ['records:list'] },
      { kind: 'source-b', prefix: 'source-b:', operations: ['records:list'] },
    ] } } });
    const sources = [
      { id: 'source-a:one', type: 'source-a', value: { identity: 'one', title: 'From A' } },
      { id: 'source-b:two', type: 'source-b', value: { identity: 'two', title: 'From B' } },
    ];
    const workflowId = 'workflow:synthetic-scoped-record-flow';
    const slug = workflowId.slice('workflow:'.length);
    const steps = [
      { id: 'make-rows', tool_id: 'tool:build-records-to-write', input: { mapping: join(root, 'mapping.json'), source_type: 'source-a', source_prefix: 'source-a:' } },
      { id: 'write-a', tool_id: 'tool:put-records-into-my-account', input: { payload: { from: ['steps', 'make-rows'] }, target_type: 'record:fixture-a', target_prefix: 'record:fixture-a:fixture-a-' } },
      { id: 'write-b', tool_id: 'tool:put-records-into-my-account', input: { payload: { from: ['steps', 'make-rows'] }, target_type: 'record:fixture-b', target_prefix: 'record:fixture-b:fixture-b-' } },
    ];
    const workflowRows = [
      { id: `record:workflow-recipe:${slug}`, type: 'record:workflow-recipe', value: {
        recipe: workflowId, title: 'Synthetic scoped record flow', job: 'Build records, then write them.', input_schema: JSON.stringify({ type: 'object' }),
      } },
      ...steps.map((step, position) => ({
        id: `record:workflow-step:${slug}--${step.id}`, type: 'record:workflow-step', value: {
          recipe: [slug], position: position + 1, step: step.id, title: step.id,
          do: `Run ${step.tool_id}.`, submit: JSON.stringify({ type: 'object', additionalProperties: true }),
          run_tool: JSON.stringify({ tool_id: step.tool_id, input: step.input }),
        },
      })),
    ];
    const workflowRowsFile = JSON.parse(readFileSync(new URL('../../workflows/tool-rows.json', import.meta.url), 'utf8'));
    const starter = rowOf(workflowRowsFile, 'tool:start-a-recipe-run');
    const cause = { kind: 'time', tool: workflowId, wake: 'fixture', due_ms: 1800000000000 };
    const started = await runRow(starter, {
      input: { row: workflowId, start_at: 'make-rows' },
      task: { request_key: 'synthetic-wake-1', cause },
    }, { records: [...sources, ...workflowRows] });
    assert.equal(started.status, 0, JSON.stringify(started));
    const job = started.kept.find(record => record.type === 'ai-job');
    assert.deepEqual(job.value.cause, cause, 'the wake cause is retained in the waiting run');
    assert.deepEqual(job.value.job.map(step => step.run_tool.tool_id), ['tool:build-records-to-write', 'tool:put-records-into-my-account', 'tool:put-records-into-my-account']);
    assert.deepEqual(job.value.job[1].run_tool.input.payload, { from: ['steps', 'make-rows'] });

    const built = await runRow(reader, job.value.job[0].run_tool.input, { records: sources });
    assert.equal(built.status, 0, JSON.stringify(built));
    assert.deepEqual(built.calls.map(call => [call.method, call.input.type, call.input.prefix]), [
      ['records:list', 'source-a', 'source-a:'], ['records:list', 'source-b', 'source-b:'],
    ]);
    const writerBase = rowOf(toolRows, 'tool:put-records-into-my-account');
    const writer = rowInRepository(writerBase);
    const writeAInput = { ...job.value.job[1].run_tool.input, payload: built.result };
    const wroteA = await runRow(writer, writeAInput, { records: sources, doorOptions: { unknownFirst: 1 } });
    assert.equal(wroteA.status, 0, JSON.stringify(wroteA));
    assert.deepEqual(wroteA.result, {
      state: 'all_written', to_write: 1, commands: 1, written: 1, out_of_scope: 3,
      readback: { 'record:fixture-a': { payload: 1, held: 1, equal: 1, missing: [], differing: [] } },
    });
    const writeCalls = wroteA.calls.filter(call => call.method === 'records:write');
    assert.deepEqual(writeCalls.map(call => call.input.records.map(record => record.type)), [['record:fixture-a'], ['record:fixture-a']]);
    assert.equal(writeCalls[0].key, writeCalls[1].key, 'unknown outcome retries the same request key');
    assert.equal(wroteA.kept.length, 3, 'both source records remain and only the target rows are written');
    const writeBInput = { ...job.value.job[2].run_tool.input, payload: built.result };
    const wroteB = await runRow(writer, writeBInput, { records: wroteA.kept });
    assert.equal(wroteB.status, 0, JSON.stringify(wroteB));
    assert.equal(wroteB.result.out_of_scope, 3);
    assert.deepEqual(wroteB.result.readback, { 'record:fixture-b': { payload: 1, held: 1, equal: 1, missing: [], differing: [] } });
    assert.deepEqual(wroteB.calls.filter(call => call.method === 'records:write')[0].input.records.map(record => record.type), ['record:fixture-b']);
    assert.equal(wroteB.kept.length, 4, 'two source records and two target rows remain');
    const repeated = await runRow(writer, writeBInput, { records: wroteB.kept });
    assert.equal(repeated.status, 0, JSON.stringify(repeated));
    assert.equal(repeated.result.to_write, 0);
    assert.ok(!repeated.calls.some(call => call.method === 'records:write'), 'a repeated build leaves the already held values as they are');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('a configured builder scope refuses an unrelated source; a missing folder path fails before any door call', async () => {
  const root = mkdtempSync(join(tmpdir(), 'scoped-record-source-denied-kind-'));
  try {
    twoScopeMappingAt(root, { includeDenied: true });
    const toolRows = JSON.parse(readFileSync(join(tool, 'tool-rows.json'), 'utf8'));
    const base = rowOf(toolRows, 'tool:build-records-to-write');
    const row = rowInRepository({ ...base, invoke: { ...base.invoke, records: { fd: 3, rights: [
      { kind: 'source-a', prefix: 'source-a:', operations: ['records:list'] },
      { kind: 'source-b', prefix: 'source-b:', operations: ['records:list'] },
    ] } } });
    const records = [
      { id: 'source-a:one', type: 'source-a', value: { identity: 'one', title: 'A' } },
      { id: 'source-b:two', type: 'source-b', value: { identity: 'two', title: 'B' } },
    ];
    const refused = await runRow(row, { mapping: join(root, 'mapping.json'), source_type: 'source-a', source_prefix: 'source-a:' }, { records });
    assert.notEqual(refused.status, 0);
    assert.match(refused.error, /may not reach those records|refused the request/);
    assert.deepEqual(refused.calls.slice(-1).map(call => [call.method, call.input.type, call.input.prefix]), [['records:list', 'unlisted', 'unlisted:']]);
    assert.ok(!refused.error.includes('run_fake_capability'));

    const missing = await runRow(row, { mapping: join(root, 'no-folder-grant', 'mapping.json'), source_type: 'source-a', source_prefix: 'source-a:' }, { records });
    assert.notEqual(missing.status, 0);
    assert.deepEqual(missing.calls, [], 'a mapping path failure is distinct from a records-door rights refusal');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('the same writer code stops when a separately configured target scope omits write', async () => {
  const root = mkdtempSync(join(tmpdir(), 'scoped-record-writer-refused-'));
  try {
    twoScopeMappingAt(root);
    const toolRows = JSON.parse(readFileSync(join(tool, 'tool-rows.json'), 'utf8'));
    const builderBase = rowOf(toolRows, 'tool:build-records-to-write');
    const builderRow = rowInRepository({ ...builderBase, invoke: { ...builderBase.invoke, records: { fd: 3, rights: [
      { kind: 'source-a', prefix: 'source-a:', operations: ['records:list'] },
      { kind: 'source-b', prefix: 'source-b:', operations: ['records:list'] },
    ] } } });
    const sources = [
      { id: 'source-a:one', type: 'source-a', value: { identity: 'one', title: 'A' } },
      { id: 'source-b:two', type: 'source-b', value: { identity: 'two', title: 'B' } },
    ];
    const built = await runRow(builderRow, { mapping: join(root, 'mapping.json'), source_type: 'source-a', source_prefix: 'source-a:' }, { records: sources });
    assert.equal(built.status, 0, JSON.stringify(built));
    const writerBase = rowOf(toolRows, 'tool:put-records-into-my-account');
    const writer = rowInRepository({ ...writerBase, invoke: { ...writerBase.invoke, records: { fd: 3, rights: [{
      kind: { fill: { from: 'input', field: 'target_type' } },
      prefix: { fill: { from: 'input', field: 'target_prefix' } },
      operations: ['records:list'],
    }] } } });
    const refused = await runRow(writer, {
      payload: built.result, target_type: 'record:fixture-a', target_prefix: 'record:fixture-a:fixture-a-',
    }, { records: sources });
    assert.equal(refused.status, 0, JSON.stringify(refused));
    assert.equal(refused.result.state, 'stopped_on_refusal');
    assert.match(refused.result.last_refusal.reason, /may not reach those records|refused the request/);
    assert.ok(refused.calls.some(call => call.method === 'records:write'), 'the descriptor refuses write outside its declared operations');
    assert.equal(refused.kept.length, 2, 'only the original source records remain');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('the managed writer refreshes through the same baseline owner, retains edits and refuses unsafe removals', async () => {
  const rows = JSON.parse(readFileSync(join(tool, 'tool-rows.json'), 'utf8'));
  const writer = rowInRepository(rowOf(rows, 'tool:put-records-into-my-account'));
  const record = (id, value) => ({ id: `record:fixture:${id}`, type: 'record:fixture', value });
  const payload = records => ({ commands: [{ input: { records } }] });
  const original = { name: 'Imported', note: 'Original', _basis: { name: { by: 'source' } } };
  const baseline = payload([record('one', original), record('deleted', { name: 'Deleted' }), record('remove', { name: 'Original' })]);
  const desired = payload([record('one', { name: 'New source name', note: 'Improved', mechanism: ['cause'], _basis: { name: { by: 'new-source' } } }),
    record('deleted', { name: 'Source changed' }), record('remove', null)]);
  const input = { payload: desired, baseline, target_type: 'record:fixture', target_prefix: 'record:fixture:' };
  const result = await runRow(writer, input, { records: [
    record('one', { name: 'Person edit', note: 'Original', custom: 'Keep', _basis: { name: { by: 'person' } } }),
    record('remove', { name: 'Peer edit' }),
  ] });
  assert.equal(result.status, 0, JSON.stringify(result));
  assert.equal(result.result.state, 'written_with_conflicts');
  assert.deepEqual(result.result.conflicts.map(c => [c.id, c.path, c.reason]), [
    ['record:fixture:one', ['name'], 'live_changed'], ['record:fixture:deleted', [], 'live_deleted'],
    ['record:fixture:remove', [], 'unsafe_removal'],
  ]);
  assert.deepEqual(result.kept.find(r => r.id === 'record:fixture:one').value,
    { name: 'Person edit', note: 'Improved', custom: 'Keep', mechanism: ['cause'], _basis: { name: { by: 'person' } } });
  assert.ok(!result.kept.some(r => r.id === 'record:fixture:deleted'));
  assert.equal(result.kept.find(r => r.id === 'record:fixture:remove').value.name, 'Peer edit');
  const repeated = await runRow(writer, input, { records: result.kept });
  assert.equal(repeated.status, 0, JSON.stringify(repeated));
  assert.equal(repeated.result.to_write, 0);
  const invalid = await runRow(writer, { ...input, keep_held: true }, { records: result.kept });
  assert.notEqual(invalid.status, 0);
  assert.match(invalid.error, /cannot be combined/);
});

test('a write acknowledgement without a matching readback is not all_written', async () => {
  const record = { id: 'record:fixture:one', type: 'record:fixture', value: { name: 'One' } };
  const result = await sendBuiltRecordWrite({ payload: { commands: [{ input: { records: [record] } }] },
    target_type: record.type, target_prefix: 'record:fixture:' }, {
    door: { async *list() {}, async write() { return { changed: true }; } },
  });
  assert.equal(result.state, 'readback_differs');
  assert.deepEqual(result.readback['record:fixture'].missing, [record.id]);
  await assert.rejects(() => sendBuiltRecordWrite({ payload: { commands: [{ input: { records: [record] } }] },
    target_type: record.type, target_prefix: 'record:fixture:' }, {
    door: { async *list() { yield { id: record.id, type: record.type }; }, async write() { assert.fail('must not write after a malformed read'); } },
  }), /outside the granted target type\/prefix/);
});
