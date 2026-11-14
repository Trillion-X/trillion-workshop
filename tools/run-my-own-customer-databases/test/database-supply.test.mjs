import test from 'node:test';
import assert from 'node:assert/strict';
import {
  EEAF_TRANSACTION_AUTHORITY_CONTRACT,
  makeDatabaseSupply,
  makeEeaFTransactionAuthority,
  makePgliteDatabaseSupply,
  pgliteDatabaseToolDescriptors,
} from '../src/database-supply.mjs';

function durableSnapshots({ fenceIsCurrent = () => true } = {}) {
  const rows = new Map();
  const commitments = new Map();
  const commitmentKey = (address, requestKey) => `${address}\u0000${requestKey}`;
  return {
    rows,
    commitments,
    async read(address) { const row = rows.get(address); return row && { revision: row.revision, snapshot: row.snapshot.slice() }; },
    async readCommitment(address, requestKey) { const row = commitments.get(commitmentKey(address, requestKey)); return row ? structuredClone(row) : null; },
    async compareAndSwap(address, expected, revision, snapshot, { permit_fence, commitment } = {}) {
      if (!permit_fence || permit_fence.resource !== address || !permit_fence.actor || !permit_fence.permit_id
        || permit_fence.request_key !== commitment?.request_key || !fenceIsCurrent(permit_fence, address, commitment))
        throw Object.assign(new Error('current permit fence rejected'), { code: 'database_permit_revoked', status: 403 });
      if ((rows.get(address)?.revision ?? null) !== expected) return false;
      const key = commitmentKey(address, commitment.request_key);
      if (commitments.has(key)) throw Object.assign(new Error('request key already committed'), { code: 'database_request_conflict', status: 409 });
      rows.set(address, { revision, snapshot: snapshot.slice() });
      commitments.set(key, structuredClone(commitment));
      return true;
    },
    async delete(address, expected, { permit_fence } = {}) {
      if (!permit_fence || permit_fence.resource !== address || !permit_fence.actor || !permit_fence.permit_id
        || !permit_fence.request_key || !fenceIsCurrent(permit_fence, address, { request_key: permit_fence?.request_key }))
        throw Object.assign(new Error('current permit fence rejected'), { code: 'database_permit_revoked', status: 403 });
      if ((rows.get(address)?.revision ?? null) !== expected) return false;
      for (const key of commitments.keys()) if (key.startsWith(`${address}\u0000`)) commitments.delete(key);
      return rows.delete(address);
    },
  };
}

function cleanupSupplies(t, supplies) {
  t.after(async () => { await Promise.all(supplies.map(supply => supply.close({ address: 'resource:customer-db' }))); });
}

const fence = ({ address, actor, permit_id, request_key }) => ({
  resource: address, actor, permit_id, request_key, generation: 1,
});

const task = (request_key, revision = null, extra = {}) => ({
  task_id: `task:${request_key}`, resource_address: 'resource:customer-db', actor: 'account:one',
  request_key, permit_id: `permit:${request_key}`, revision, ...extra,
});

test('PGlite provisions PostgreSQL and executes arbitrary schema and row operations', async t => {
  const storage = durableSnapshots();
  const supplies = [];
  cleanupSupplies(t, supplies);
  const checks = [];
  const implementation = makePgliteDatabaseSupply({ storage, authorize: async input => { checks.push(input); return input.at_commit ? fence(input) : undefined; } });
  supplies.push(implementation);
  const call = (operation, input, command) => implementation.invoke({ tool: { invoke: { operation } }, input, task: command });

  const provisioned = await call('provision', { name: 'Sales data' }, task('provision'));
  assert.deepEqual(provisioned, { resource: 'resource:customer-db', name: 'Sales data', state: 'provisioned', engine: 'PostgreSQL', revision: 'revision:1' });
  assert.equal(storage.rows.get('resource:customer-db').revision, 'revision:1');
  await call('transaction', { expected_revision: 'revision:1', statements: [
    { sql: 'CREATE SCHEMA sales' },
    { sql: 'CREATE TABLE sales.deals (id text PRIMARY KEY, stage text NOT NULL, amount numeric)' },
    { sql: 'INSERT INTO sales.deals(id, stage, amount) VALUES ($1, $2, $3)', params: ['o-1', 'open', 1250] },
  ] }, task('schema-and-first-row'));

  const shape = await call('schema', { expected_revision: 'revision:2', schema: 'sales' }, task('read-schema', 'revision:2'));
  assert.deepEqual(shape.columns.map(row => row.column_name), ['id', 'stage', 'amount']);
  const result = await call('read', { expected_revision: 'revision:2', sql: 'SELECT stage, amount FROM sales.deals WHERE id = $1', params: ['o-1'] }, task('read-row', 'revision:2'));
  assert.deepEqual(result.rows, [{ stage: 'open', amount: '1250' }]);
  assert.equal(checks.length, 8, 'current resource rights are checked before each dispatch and again at each commit');
});

test('PGlite commands are atomic, request-key replay is stable, and reopened databases retain rows', async t => {
  const storage = durableSnapshots();
  const supplies = [];
  cleanupSupplies(t, supplies);
  let implementation = makePgliteDatabaseSupply({ storage, authorize: async input => input.at_commit ? fence(input) : undefined });
  supplies.push(implementation);
  const invoke = (operation, input, key, revision) => implementation.invoke({ tool: { invoke: { operation } }, input, task: task(key, revision) });
  await invoke('provision', {}, 'create');
  await invoke('query', { expected_revision: 'revision:1', sql: 'CREATE TABLE public.people (id integer PRIMARY KEY, name text)' }, 'make-table');
  const input = { expected_revision: 'revision:2', sql: 'INSERT INTO public.people VALUES($1,$2) RETURNING *', params: [1, 'Ada'] };
  const inserted = await invoke('write', input, 'insert-person');
  const duplicate = await invoke('write', input, 'insert-person');
  assert.deepEqual(duplicate, inserted, 'replay returns the receipt instead of running the INSERT twice');
  await assert.rejects(invoke('transaction', { expected_revision: 'revision:3', statements: [
    { sql: 'INSERT INTO public.people VALUES($1,$2)', params: [2, 'Grace'] },
    { sql: 'INSERT INTO public.people VALUES($1,$2)', params: [1, 'conflict'] },
  ] }, 'rollback-batch'), /duplicate key/i);
  assert.equal(storage.rows.get('resource:customer-db').revision, 'revision:3', 'failed transaction leaves durable revision unchanged');

  await implementation.close({ address: 'resource:customer-db' });
  implementation = makePgliteDatabaseSupply({ storage, authorize: async () => {} });
  supplies.push(implementation);
  const rows = await invoke('read', { expected_revision: 'revision:3', sql: 'SELECT id, name FROM public.people' }, 'read-after-reopen', 'revision:3');
  assert.deepEqual(rows.rows, [{ id: 1, name: 'Ada' }]);
});

test('current-rights revocation at commit discards the uncommitted PGlite image', async t => {
  const supplies = [];
  let allowed = true;
  const storage = durableSnapshots({ fenceIsCurrent: () => allowed });
  const implementation = makePgliteDatabaseSupply({ storage, authorize: async input => {
    const { at_commit, operation } = input;
    if (operation === 'query' && at_commit) allowed = false;
    if (!allowed) throw Object.assign(new Error('current rights revoked'), { status: 403 });
    return at_commit ? fence(input) : undefined;
  } });
  supplies.push(implementation);
  cleanupSupplies(t, supplies);
  const call = (operation, input, command) => implementation.invoke({ tool: { invoke: { operation } }, input, task: command });
  await call('provision', {}, task('create'));
  await assert.rejects(call('query', { expected_revision: 'revision:1', sql: 'CREATE TABLE public.revoke_test (id integer)' }, task('revoked-write')), /current rights revoked/);
  assert.equal(storage.rows.get('resource:customer-db').revision, 'revision:1');
  allowed = true;
  await implementation.close({ address: 'resource:customer-db' });
  const reopened = makePgliteDatabaseSupply({ storage, authorize: async () => {} });
  supplies.push(reopened);
  const shape = await reopened.invoke({ tool: { invoke: { operation: 'schema' } }, input: { expected_revision: 'revision:1', schema: 'public' }, task: task('schema-after-revoke', 'revision:1') });
  assert.equal(shape.columns.some(column => column.table_name === 'revoke_test'), false);
});

test('expected revision compare-and-swap refuses concurrent stale work', async t => {
  const storage = durableSnapshots();
  const implementation = makePgliteDatabaseSupply({ storage, authorize: async input => input.at_commit ? fence(input) : undefined });
  cleanupSupplies(t, [implementation]);
  const call = (operation, input, command) => implementation.invoke({ tool: { invoke: { operation } }, input, task: command });
  await call('provision', {}, task('create'));
  await call('query', { expected_revision: 'revision:1', sql: 'CREATE TABLE public.cas_test (id integer)' }, task('first-change'));
  await assert.rejects(call('query', { expected_revision: 'revision:1', sql: 'CREATE TABLE public.stale_test (id integer)' }, task('stale-change')),
    { code: 'database_revision_conflict', status: 409 });
  assert.equal(storage.rows.get('resource:customer-db').revision, 'revision:2');
});

test('warm supplies refresh snapshots before checking revisions and executing reads', async t => {
  const storage = durableSnapshots();
  const supplies = [
    makePgliteDatabaseSupply({ storage, authorize: async input => input.at_commit ? fence(input) : undefined }),
    makePgliteDatabaseSupply({ storage, authorize: async input => input.at_commit ? fence(input) : undefined }),
  ];
  cleanupSupplies(t, supplies);
  const invoke = (supply, operation, input, key, revision) => supply.invoke({
    tool: { invoke: { operation } }, input, task: task(key, revision),
  });
  await invoke(supplies[0], 'provision', {}, 'create');
  await invoke(supplies[1], 'read', { expected_revision: 'revision:1', sql: 'SELECT 1 AS value' }, 'warm-read', 'revision:1');
  await invoke(supplies[0], 'query', { expected_revision: 'revision:1', sql: 'CREATE TABLE public.refreshed (value integer)' }, 'change');
  await invoke(supplies[0], 'write', { expected_revision: 'revision:2', sql: 'INSERT INTO public.refreshed VALUES(7)' }, 'insert');
  const current = await invoke(supplies[1], 'read', { expected_revision: 'revision:3', sql: 'SELECT value FROM public.refreshed' }, 'fresh-read', 'revision:3');
  assert.deepEqual(current.rows, [{ value: 7 }], 'a cached PGlite instance reloads another supply’s durable commit');
});

test('read is transactionally read-only and does not create a revision or receipt', async t => {
  const storage = durableSnapshots();
  const implementation = makePgliteDatabaseSupply({ storage, authorize: async input => input.at_commit ? fence(input) : undefined });
  cleanupSupplies(t, [implementation]);
  const call = (operation, input, key, revision) => implementation.invoke({
    tool: { invoke: { operation } }, input, task: task(key, revision),
  });
  await call('provision', {}, 'create');
  const selected = await call('read', { expected_revision: 'revision:1', sql: 'SELECT 4 AS value' }, 'select');
  assert.deepEqual(selected.rows, [{ value: 4 }]);
  assert.equal(storage.rows.get('resource:customer-db').revision, 'revision:1');
  assert.equal(await storage.readCommitment('resource:customer-db', 'select'), null);
  await assert.rejects(call('read', { expected_revision: 'revision:1', sql: 'CREATE TABLE public.forbidden (id integer)' }, 'mutating-read'));
  assert.equal(storage.rows.get('resource:customer-db').revision, 'revision:1');
});

test('CAS validates the current permit fence while atomically storing the snapshot and receipt', async t => {
  let allowed = true;
  const storage = durableSnapshots({ fenceIsCurrent: () => allowed });
  const implementation = makePgliteDatabaseSupply({ storage, authorize: async input => {
    if (input.operation === 'query' && input.at_commit) allowed = false;
    return input.at_commit ? fence(input) : undefined;
  } });
  cleanupSupplies(t, [implementation]);
  const call = (operation, input, key) => implementation.invoke({ tool: { invoke: { operation } }, input, task: task(key, input.expected_revision ?? null) });
  await call('provision', {}, 'create');
  await assert.rejects(call('query', { expected_revision: 'revision:1', sql: 'CREATE TABLE public.rejected (id integer)' }, 'stale-permit'),
    { code: 'database_permit_revoked', status: 403 });
  assert.equal(storage.rows.get('resource:customer-db').revision, 'revision:1');
  assert.equal(await storage.readCommitment('resource:customer-db', 'stale-permit'), null);
});

test('reconciliation reads the original durable commitment without replaying SQL', async t => {
  const storage = durableSnapshots();
  const implementation = makePgliteDatabaseSupply({ storage, authorize: async input => input.at_commit ? fence(input) : undefined });
  cleanupSupplies(t, [implementation]);
  const input = { expected_revision: 'revision:1', sql: 'CREATE TABLE public.once (id integer)' };
  const command = task('original-command', 'revision:1', { input });
  await implementation.invoke({ tool: { invoke: { operation: 'provision' } }, input: {}, task: task('create') });
  await implementation.invoke({ tool: { invoke: { operation: 'query' } }, input, task: command });
  const reconciled = await implementation.reconcile({ task: command, tool: { invoke: { operation: 'query' } } });
  assert.deepEqual(reconciled, { state: 'completed', output: { rows: [], fields: [], affected_rows: 0 } });
  assert.equal(storage.rows.get('resource:customer-db').revision, 'revision:2');
});

test('legacy in-database receipts are surfaced as unknown and never silently replayed', async t => {
  const storage = durableSnapshots();
  const implementation = makePgliteDatabaseSupply({ storage, authorize: async input => input.at_commit ? fence(input) : undefined });
  cleanupSupplies(t, [implementation]);
  const call = (operation, input, key, revision = null) => implementation.invoke({
    tool: { invoke: { operation } }, input, task: task(key, revision),
  });
  await call('provision', {}, 'create');
  await call('transaction', { expected_revision: 'revision:1', statements: [
    { sql: 'CREATE SCHEMA trillion_supply' },
    { sql: 'CREATE TABLE trillion_supply.command_receipts (request_key text, actor text, input_identity text, result jsonb, revision text)' },
  ] }, 'legacy-table');
  const legacyInput = { expected_revision: 'revision:2', sql: 'CREATE TABLE public.was_already_run (id integer)' };
  await call('query', { expected_revision: 'revision:2', sql: 'INSERT INTO trillion_supply.command_receipts VALUES ($1,$2,$3,$4::jsonb,$5)',
    params: ['legacy-request', 'account:one', 'untrusted', '{"rows":[]}', 'revision:4'] }, 'seed-legacy-row');
  const legacyTask = task('legacy-request', 'revision:4', { input: legacyInput });
  await assert.rejects(implementation.invoke({ tool: { invoke: { operation: 'query' } }, input: legacyInput, task: legacyTask }),
    { code: 'database_legacy_commitment_unverified', status: 409 });
  assert.deepEqual(await implementation.reconcile({ task: legacyTask, tool: { invoke: { operation: 'query' } } }), { state: 'unknown' });
  assert.equal(storage.rows.get('resource:customer-db').revision, 'revision:3');
});

test('lifecycle derives the current actor, permit and request from the original task', async t => {
  const storage = durableSnapshots();
  const authorizations = [];
  const implementation = makePgliteDatabaseSupply({ storage, authorize: async input => {
    authorizations.push(input);
    return input.at_commit ? fence(input) : undefined;
  } });
  cleanupSupplies(t, [implementation]);
  const call = (operation, input, command) => implementation.invoke({ tool: { invoke: { operation } }, input, task: command });
  await call('provision', {}, task('create'));
  await call('lifecycle', { action: 'close' }, task('close-resource'));
  assert.equal(authorizations.at(-1).actor, 'account:one');
  assert.equal(authorizations.at(-1).permit_id, 'permit:close-resource');
  assert.equal(authorizations.at(-1).request_key, 'close-resource');
  await call('lifecycle', { action: 'delete', expected_revision: 'revision:1' }, task('delete-resource', 'revision:1'));
  assert.equal(storage.rows.has('resource:customer-db'), false);
});

test('typed descriptors expose one PostgreSQL implementation to MCP and CLI operation hosts', () => {
  const descriptors = pgliteDatabaseToolDescriptors();
  assert.deepEqual(descriptors.map(item => item.invoke.operation), ['provision', 'inspect', 'schema', 'read', 'write', 'query', 'transaction', 'lifecycle']);
  assert.ok(descriptors.every(item => item.invoke.implementation_ref === 'native:pglite'));
  assert.ok(descriptors.every(item => item.input_schema.required.includes('resource_ref')));
  assert.ok(descriptors.find(item => item.invoke.operation === 'transaction').input_schema.properties.statements);
});

test('an external CRUD capability cannot self-grant EEAF authority from metadata', async () => {
  const supply = makeDatabaseSupply({ resolve: async () => ({ invoke: async () => ({ state: 'committed' }) }) });
  const descriptorClaim = { eeaf_transaction_authority: {
    contract_id: EEAF_TRANSACTION_AUTHORITY_CONTRACT.id,
    contract_revision: EEAF_TRANSACTION_AUTHORITY_CONTRACT.revision,
    atomicity: EEAF_TRANSACTION_AUTHORITY_CONTRACT.atomicity,
    semantics: [...EEAF_TRANSACTION_AUTHORITY_CONTRACT.semantics],
  } };
  assert.equal(makeEeaFTransactionAuthority({ supply, capabilities: descriptorClaim }).available, false);
  const absentVerifier = makeEeaFTransactionAuthority({ supply });
  assert.equal(absentVerifier.available, false);
  assert.throws(() => absentVerifier.transact('resource:customer-db', {}, task('no-authority')), { code: 'eeaf_authority_unavailable' });
  const authority = makeEeaFTransactionAuthority({ supply, verifyAuthority: async () => ({ authoritative: false }) });
  await assert.rejects(authority.transact('resource:customer-db', {}, { ...task('untrusted-verifier'), actor: 'account:one' }), { code: 'eeaf_authority_unavailable' });
});
