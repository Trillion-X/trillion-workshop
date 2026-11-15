// Source-facade and actual records fd controls, with made-up accounts and URLs only.
import test from 'node:test';
import assert from 'node:assert/strict';
import { accountToolSources, accountToolSourcesFromDoor, accountToolSourcesFromTask } from '../../describe-the-workshop/do-work/sources.mjs';
import { openRecordsDoor } from '../../records-door/read-data/records-door.mjs';
import { startFakeDoor } from '../../records-door/test/fake-door.mjs';
import { makeHashCodeHexFromJson } from '../../content-identity/read-data/identity.mjs';
import { config } from './source-consumer.mjs';

const RIGHTS = [
  { kind: 'tool-source', prefix: 'tool-source:', operations: ['records:read', 'records:list', 'records:write'] },
  { kind: 'tool-source-change', prefix: 'tool-source-change:', operations: ['records:read', 'records:write'] },
];
const SOURCE = { id: 'sample', kind: 'openapi', url: 'https://sample.example.com/spec.json', name: 'Sample' };
const NOW = '2026-01-02T03:04:05.000Z';
const record = (value = SOURCE) => ({ type: 'tool-source', id: `tool-source:${value.id}`, value });
const run = (input, sourced) => accountToolSources(input, { sourced, now: () => new Date(NOW) });

function original({ rows = [], defaults = [] } = {}) {
  const state = { config: { ...structuredClone(config), sources: structuredClone(defaults) }, rows: structuredClone(rows), writes: [], receipts: new Map() };
  const owner = {
    config: async () => structuredClone(state.config),
    own: async () => structuredClone(state.rows),
    reads: async mine => mine.map(row => ({ source_id: row.id, scope: 'account', state: 'ready', version: 'sample-version', tools: [`tool:${row.id}:read`] })),
    async mutationResult({ request_key, command_identity }) {
      const old = state.receipts.get(request_key);
      if (old && old !== command_identity) throw Object.assign(new Error('Key conflict'), { code: 'source_request_conflict' });
      return { found: Boolean(old) };
    },
    async compareAndPut(change) {
      assert.deepEqual(change.expected, state.rows.find(row => row.id === change.row.id) ?? null);
      assert.deepEqual(change.configuration, state.config);
      state.rows = [...state.rows.filter(row => row.id !== change.row.id), structuredClone(change.row)];
      state.writes.push(change);
      state.receipts.set(change.request_key, change.command_identity);
    },
  };
  return { state, owner };
}

test('original family, generated id, edit timestamps, tombstone and semantic retries', async () => {
  const { owner, state } = original();
  const add = { add: { kind: SOURCE.kind, url: SOURCE.url }, request_key: 'add-sample' };
  const added = await run(add, owner), id = added.yours[0].id;
  assert.equal(id, 'sample.example.com-openapi');
  assert.equal(state.writes[0].entity, `tool-source:${id}`);
  await run(add, owner);
  assert.equal(state.writes.length, 1);
  await run({ edit: { id, name: 'Changed' }, request_key: 'edit-sample' }, owner);
  assert.equal(state.rows[0].added_at, NOW);
  assert.equal(state.rows[0].updated_at, NOW);
  const remove = { remove: id, request_key: 'remove-sample' };
  assert.deepEqual((await run(remove, owner)).yours, []);
  await run(remove, owner);
  assert.equal(state.rows[0].status, 'deleted');
  assert.equal(state.rows[0].removed_at, NOW);
  assert.equal(state.writes.length, 3);
  await assert.rejects(run({ ...add, add: { ...add.add, name: 'Different' } }, owner), { code: 'source_request_conflict' });
});

test('current defaults cannot be added or removed; an existing private override wins', async () => {
  const { owner, state } = original({ defaults: [SOURCE] });
  await assert.rejects(run({ add: SOURCE, request_key: 'add-default' }, owner), /already read for every account/);
  await assert.rejects(run({ remove: SOURCE.id, request_key: 'remove-default' }, owner), /not an active source/);
  assert.equal(state.writes.length, 0);
  state.rows = [{ ...SOURCE, name: 'Private replacement' }];
  const shown = await run({}, owner);
  assert.equal(shown.every_account[0].overridden_by_account, true);
  assert.equal(shown.yours[0].name, 'Private replacement');
});

test('withdrawn templates never become bootstrap defaults; unknown kinds refuse mutation', async () => {
  const { owner, state } = original();
  state.config = { kinds: {}, sources: [] };
  assert.deepEqual((await run({}, owner)).kinds, []);
  await assert.rejects(run({ add: SOURCE, request_key: 'add-withdrawn' }, owner), /kind must be one of/);
  assert.equal(state.writes.length, 0);
});

test('changed config or a private source deleted during reads refuses stale disclosure', async () => {
  const item = original({ rows: [SOURCE] });
  item.owner.reads = async () => { item.state.config.sources.push({ ...SOURCE, id: 'other' }); return []; };
  await assert.rejects(run({}, item.owner), { code: 'source_configuration_changed' });
  const removed = original({ rows: [SOURCE] });
  removed.owner.reads = async () => { removed.state.rows = []; return []; };
  await assert.rejects(run({}, removed.owner), { code: 'source_definitions_changed' });
});

test('raw keys, auth headers, URL credentials, query tokens and nested credentials refuse', async () => {
  const { owner, state } = original();
  for (const add of [
    { ...SOURCE, key: 'synthetic-value' }, { ...SOURCE, headers: { Authorization: 'synthetic-value' } },
    { ...SOURCE, url: 'https://sample:synthetic-value@example.com/spec' },
    { ...SOURCE, url: 'https://sample.example.com/spec?token=synthetic-value' },
    { ...SOURCE, connection: { connection_id: 'sample', field_id: 'token', connection: { token: 'synthetic-value' } } },
  ]) await assert.rejects(run({ add, request_key: `reject:${makeHashCodeHexFromJson(add)}` }, owner));
  await run({ add: { ...SOURCE, headers: { Accept: 'application/json' }, connection: { connection_id: 'sample', field_id: 'token' } }, request_key: 'reference' }, owner);
  assert.equal(state.writes.length, 1);
  await run({ edit: { id: 'sample', headers: null, connection: null }, request_key: 'remove-connection-reference' }, owner);
  assert.equal(Object.hasOwn(state.rows[0], 'headers'), false);
  assert.equal(Object.hasOwn(state.rows[0], 'connection'), false);
  assert.equal(state.rows[0].added_at, NOW);
});

test('old put without conditional owner and a records fd without config both fail closed', async () => {
  const { owner } = original();
  delete owner.compareAndPut;
  await assert.rejects(run({ add: SOURCE, request_key: 'missing-cas' }, owner), { code: 'source_mutation_owner_unavailable' });
  await assert.rejects(accountToolSourcesFromDoor({ add: SOURCE }, { door: {} }), { code: 'source_owner_unavailable' });
});

async function fixture(records = [], rights = RIGHTS) {
  const fake = await startFakeDoor({ records, rights });
  const native = openRecordsDoor({ descriptor: fake.descriptor });
  // Monotonic stand-in for the native root stamp: restoring equal content still changes this witness.
  const door = { ...native, async readRecord(...args) {
    const held = await native.readRecord(...args);
    return held && { ...held, identity: `root-${fake.calls.filter(call => call.method === 'records:write').length}` };
  } };
  const sourceConfig = { config: async () => structuredClone(config), reads: async rows => rows.map(row => ({ source_id: row.id, scope: 'account', state: 'pending', tools: [] })) };
  return { fake, native, door, sourceConfig };
}

test('the records fd keeps source+receipt atomically and isolates account retries', async () => {
  const a = await fixture(), b = await fixture();
  try {
    const input = { add: SOURCE, request_key: 'same-key-in-two-accounts' };
    const call = (given, f = a) => accountToolSourcesFromDoor(given, { door: f.door, sourceConfig: f.sourceConfig, now: () => new Date(NOW) });
    assert.equal((await call(input)).yours[0].id, 'sample');
    const write = a.fake.calls.find(call => call.method === 'records:write');
    assert.equal(write.input.records.length, 2);
    assert.deepEqual(write.input.records.map(row => row.type), ['tool-source', 'tool-source-change']);
    assert.equal(write.input.records[0].id, 'tool-source:sample');
    assert.equal(write.input.records[0].expected, null);
    await call(input);
    assert.equal(a.fake.calls.filter(call => call.method === 'records:write').length, 1);
    await assert.rejects(call({ ...input, add: { ...SOURCE, name: 'Different' } }), { code: 'source_request_conflict' });
    assert.deepEqual((await call({}, b)).yours, []);
    await call(input, b);
    await call({ edit: { id: 'sample', name: 'Updated' }, request_key: 'edit' });
    assert.equal(a.fake.kept.get('tool-source:sample').value.added_at, NOW);
    await call({ remove: 'sample', request_key: 'remove' });
    assert.equal(a.fake.kept.get('tool-source:sample').value.status, 'deleted');
    assert.equal(b.fake.kept.get('tool-source:sample').value.status, undefined);
  } finally { await Promise.all([a.fake.close(), b.fake.close()]); }
});

test('CAS conflict preserves the other writer; current rights refusal keeps no receipt', async () => {
  const f = await fixture([record()]);
  try {
    const racing = { ...f.door, async write(rows, options) {
      await f.native.write([{ ...record(), value: { ...SOURCE, name: 'Other writer' } }], { key: 'other' });
      return f.door.write(rows, options);
    } };
    await assert.rejects(accountToolSourcesFromDoor({ edit: { id: 'sample', name: 'Lost edit' }, request_key: 'edit' }, { door: racing, sourceConfig: f.sourceConfig }), { code: 'original_command_conflict' });
    assert.equal(f.fake.kept.get('tool-source:sample').value.name, 'Other writer');
    assert.equal([...f.fake.kept.values()].filter(row => row.type === 'tool-source-change').length, 0);
  } finally { await f.fake.close(); }
  const denied = await fixture([], RIGHTS.map(right => ({ ...right, operations: right.operations.filter(op => op !== 'records:write') })));
  try {
    await assert.rejects(accountToolSourcesFromDoor({ add: SOURCE, request_key: 'denied' }, { door: denied.door, sourceConfig: denied.sourceConfig }), { code: 'current_workspace_rights_refused' });
    assert.equal(denied.fake.kept.size, 0);
  } finally { await denied.fake.close(); }
});

test('a private source ABA is rejected by root stamp even when values match', async () => {
  const f = await fixture([record()]);
  try {
    f.sourceConfig.reads = async () => {
      await f.native.write([{ ...record(), value: { ...SOURCE, name: 'Temporary' } }], { key: 'aba-1' });
      await f.native.write([record()], { key: 'aba-2' });
      return [];
    };
    await assert.rejects(accountToolSourcesFromDoor({}, f), { code: 'source_definitions_changed' });
    assert.deepEqual(f.fake.kept.get('tool-source:sample').value, SOURCE);
  } finally { await f.fake.close(); }
});

test('a native task read is reused only for the exact current private source definition', async () => {
  const f = await fixture([record()]);
  try {
    const read = { source_id: 'sample', scope: 'account', state: 'ready', version: 'sample-version', tools: ['tool:sample:read'] };
    const envelope = { input: {}, source_data: { config: structuredClone(config), reads: [read] } };
    const pending = await accountToolSourcesFromTask(envelope, { door: f.door });
    assert.equal(pending.yours[0].state, 'pending');
    assert.deepEqual(pending.yours[0].tools, []);
    read.definition_identity = makeHashCodeHexFromJson(SOURCE);
    assert.deepEqual((await accountToolSourcesFromTask(envelope, { door: f.door })).yours[0].tools, ['tool:sample:read']);
    await f.native.write([{ ...record(), value: { ...SOURCE, name: 'Different definition' } }], { key: 'edit-since-snapshot' });
    const changed = await accountToolSourcesFromTask(envelope, { door: f.door });
    assert.equal(changed.yours[0].state, 'pending');
    assert.deepEqual(changed.yours[0].tools, []);
    await assert.rejects(accountToolSourcesFromTask({ ...envelope, input: { source_data: envelope.source_data } }, { door: f.door }), /Supply add, edit or remove/);
  } finally { await f.fake.close(); }
});
