// A real PostgreSQL realization for independently addressed customer work.
// PGlite supplies the PostgreSQL engine; placement and durable snapshot storage
// are injected by the customer execution host. This module has no vendor switch,
// caller-selected filesystem path, second task queue, or credential value path.
import { PGlite } from '@electric-sql/pglite';
import { makeAddressedOperation } from '../../address-installed-capabilities/src/addressed-operation.mjs';

const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const fail = (message, code = 'database_supply_invalid', status = 400) => {
  throw Object.assign(new Error(message), { code, status });
};
const copy = value => structuredClone(value);
const addressKey = address => {
  if (typeof address === 'string' && address.trim()) return address;
  if (object(address) && typeof address.resource === 'string' && address.resource.trim()) return address.resource;
  fail('An opaque addressed resource identity is required.');
};
const json = value => {
  const encoded = JSON.stringify(value);
  if (encoded === undefined) fail('Database operation values must be JSON serializable.');
  return encoded;
};
const resultOf = result => ({ rows: result.rows ?? [], fields: result.fields ?? [], affected_rows: result.affectedRows ?? 0 });
const assertCustomerSql = sql => {
  // Count statement separators outside SQL strings, quoted identifiers,
  // comments and dollar-quoted bodies. This keeps a caller from escaping the
  // transaction that owns the snapshot commit with a batched COMMIT statement.
  let state = 'normal';
  let dollarTag = null;
  let statements = 0;
  let statementHasContent = false;
  let visible = '';
  for (let i = 0; i < sql.length; i += 1) {
    const char = sql[i];
    const next = sql[i + 1];
    if (state === 'line-comment') { if (char === '\n') { state = 'normal'; visible += ' '; } continue; }
    if (state === 'block-comment') { if (char === '*' && next === '/') { state = 'normal'; i += 1; visible += ' '; } continue; }
    if (state === 'single' || state === 'double') {
      if (char === (state === 'single' ? "'" : '"')) {
        if (next === char) { i += 1; continue; }
        state = 'normal'; visible += ' ';
      }
      continue;
    }
    if (state === 'dollar') {
      if (sql.startsWith(dollarTag, i)) { i += dollarTag.length - 1; state = 'normal'; visible += ' '; }
      continue;
    }
    if (char === '-' && next === '-') { state = 'line-comment'; i += 1; continue; }
    if (char === '/' && next === '*') { state = 'block-comment'; i += 1; continue; }
    if (char === "'") { state = 'single'; continue; }
    if (char === '"') { state = 'double'; continue; }
    if (char === '$') {
      const match = sql.slice(i).match(/^\$[a-zA-Z_][a-zA-Z_0-9]*\$|^\$\$/);
      if (match) { dollarTag = match[0]; state = 'dollar'; i += dollarTag.length - 1; continue; }
    }
    if (char === ';') { if (statementHasContent) statements += 1; statementHasContent = false; visible += ' '; continue; }
    if (!/\s/.test(char)) statementHasContent = true;
    visible += char;
  }
  if (statementHasContent) statements += 1;
  if (statements > 1) fail('One PostgreSQL statement is allowed per operation.');
  if (/^\s*(BEGIN|COMMIT|END|ABORT|ROLLBACK|START\s+TRANSACTION|SET\s+TRANSACTION|PREPARE\s+TRANSACTION|CREATE\s+DATABASE|DROP\s+DATABASE)\b/i.test(visible))
    fail('Transaction and database lifecycle commands belong to the supply owner.');
};

/**
 * Contract for an authoritative EEAF implementation. A physical SQL engine
 * does not meet this contract merely by supporting tables and transactions.
 */
export const EEAF_TRANSACTION_AUTHORITY_CONTRACT = Object.freeze({
  id: 'trillion.eeaf-transaction-authority',
  revision: '1',
  atomicity: 'all-or-none-with-durable-receipt',
  semantics: Object.freeze([
    'dynamic-schema-and-record-model', 'record-identity-and-relationships',
    'current-state-and-version-history', 'optimistic-conflict-detection',
    'current-rights-and-policy-at-commit', 'attributed-erasures-and-retention',
    'idempotent-reconciliation-and-recovery',
  ]),
});

const validCredentialInjections = injections => injections === undefined || Array.isArray(injections)
  && injections.every(item => object(item) && typeof item.secret_name === 'string' && item.secret_name.trim()
    && object(item.placement));

/**
 * Generic addressed caller for external provider tools and operations. The
 * installed tool owns connection binding, vault placement, transport and rights.
 */
export function makeDatabaseSupply({ resolve } = {}) {
  if (typeof resolve !== 'function') throw new TypeError('An installed capability resolver is required.');
  const dispatch = makeAddressedOperation({ resolve });
  const invoke = async (address, operation, input = {}, context = {}) => {
    if (typeof operation !== 'string' || !operation.trim() || operation.length > 200 || !object(input) || !object(context))
      fail('An addressed operation, object input and command context are required.');
    if (typeof context.actor !== 'string' || !context.actor.trim()
      || typeof context.permit_id !== 'string' || !context.permit_id.trim()
      || typeof context.request_key !== 'string' || !context.request_key.trim())
      fail('The current actor, command permit and request key are required.', 'database_supply_context_invalid', 403);
    if (!validCredentialInjections(context.credential_injections))
      fail('Credentials must use named vault references and their declared placement.');
    const { credential_injections = [], ...executionContext } = context;
    const result = await dispatch({ address: copy(address), operation, input: copy(input) }, {
      ...copy(executionContext), credential_injections: copy(credential_injections),
    });
    if (result === undefined) fail('The installed database behavior returned no result.', 'database_supply_empty_result', 502);
    return result;
  };
  const simple = operation => (address, input = {}, context = {}) => invoke(address, operation, input, context);
  return Object.freeze({
    invoke, provision: simple('provision'), inspect: simple('inspect'), schema: simple('schema'),
    read: simple('read'), write: simple('write'), query: simple('query'),
    lifecycle: (address, action, input = {}, context = {}) => {
      if (typeof action !== 'string' || !action.trim()) fail('A provider lifecycle action is required.');
      return invoke(address, `lifecycle:${action}`, input, context);
    },
  });
}

/**
 * Make one callable PostgreSQL implementation for the current addressed typed
 * operation host. The storage owner supplies atomic read/CAS/delete by opaque
 * resource address. Snapshot bytes are produced by PostgreSQL itself and held
 * only by that owner; callers never choose a path or see credentials.
 *
 * The snapshot owner must implement readCommitment(address, requestKey) and
 * compareAndSwap(address, expected, revision, bytes, { permit_fence, commitment }).
 * It validates the opaque fence against current rights and durably stores the
 * commitment atomically with the snapshot. SQL never has access to that metadata.
 */
export function makePgliteDatabaseSupply({ storage, authorize, PGliteClass = PGlite } = {}) {
  if (typeof storage?.read !== 'function' || typeof storage?.readCommitment !== 'function'
    || typeof storage?.compareAndSwap !== 'function'
    || typeof storage?.delete !== 'function') {
    throw new TypeError('An addressed durable snapshot owner with read, compareAndSwap and delete is required.');
  }
  if (typeof authorize !== 'function') throw new TypeError('A current resource rights owner is required.');
  if (typeof PGliteClass?.create !== 'function') throw new TypeError('A PostgreSQL PGlite implementation is required.');

  const databases = new Map();
  const locks = new Map();
  const lock = async (key, work) => {
    const prior = locks.get(key) ?? Promise.resolve();
    let unlock;
    const held = new Promise(resolve => { unlock = resolve; });
    const tail = prior.then(() => held);
    locks.set(key, tail);
    await prior;
    try { return await work(); }
    finally { unlock(); if (locks.get(key) === tail) locks.delete(key); }
  };
  const readSnapshot = async key => {
    const row = await storage.read(key);
    if (row === null || row === undefined) return { revision: null, snapshot: null };
    if (!object(row) || !(row.snapshot instanceof Uint8Array) || typeof row.revision !== 'string' || !row.revision)
      fail('The durable database snapshot owner returned an invalid state.', 'database_snapshot_invalid', 500);
    return row;
  };
  const restoreInstance = async (key, snapshot, revision = null) => {
    const previous = databases.get(key);
    if (previous) { databases.delete(key); await previous.db.close(); }
    if (!snapshot) return null;
    const db = await PGliteClass.create({ dataDir: 'memory://', loadDataDir: new Blob([snapshot]) });
    const instance = { db, revision };
    databases.set(key, instance);
    return instance;
  };
  const open = async (key, { create = false } = {}) => {
    const saved = await readSnapshot(key);
    if (!saved.snapshot && !create) fail('The PostgreSQL resource has not been provisioned.', 'database_not_found', 404);
    const current = databases.get(key);
    if (current && current.revision === saved.revision && saved.snapshot) return current;
    if (current) await restoreInstance(key, saved.snapshot, saved.revision);
    const refreshed = databases.get(key);
    if (refreshed) return refreshed;
    const db = saved.snapshot
      ? await PGliteClass.create({ dataDir: 'memory://', loadDataDir: new Blob([saved.snapshot]) })
      : await PGliteClass.create({ dataDir: 'memory://' });
    const instance = { db, revision: saved.revision };
    databases.set(key, instance);
    return instance;
  };
  const nextRevision = revision => revision === null ? 'revision:1' : `revision:${Number(revision.slice('revision:'.length)) + 1}`;
  const persist = async (key, instance, expectedRevision, permitFence, commitment) => {
    const revision = nextRevision(expectedRevision);
    const dump = await instance.db.dumpDataDir();
    const bytes = new Uint8Array(await dump.arrayBuffer());
    const committed = await storage.compareAndSwap(key, expectedRevision, revision, bytes, {
      permit_fence: copy(permitFence), commitment: copy({ ...commitment, revision }),
    });
    if (committed !== true) {
      const latest = await readSnapshot(key);
      await restoreInstance(key, latest.snapshot, latest.revision);
      fail('The database changed before its durable commit. Retry with the same command key and current revision.', 'database_revision_conflict', 409);
    }
    instance.revision = revision;
    return revision;
  };
  const identity = ({ actor, request_key, operation, input, expected_revision }) => json({ actor, request_key, operation, input, expected_revision: expected_revision ?? null });
  const legacyCommitmentStatus = async (instance, requestKey) => {
    try {
      const found = await instance.db.query("SELECT to_regclass('trillion_supply.command_receipts') AS relation");
      if (!found.rows[0]?.relation) return { found: false, uncertain: false };
      const receipt = await instance.db.query('SELECT 1 FROM trillion_supply.command_receipts WHERE request_key = $1 LIMIT 1', [requestKey]);
      return { found: receipt.rows.length > 0, uncertain: false };
    } catch {
      // Legacy in-database receipts cannot be trusted as commitment evidence.
      // If their state cannot be inspected, stop instead of repeating a command.
      return { found: false, uncertain: true };
    }
  };
  const commandContext = (task, input, operation) => {
    const claim = task?.resource_authorization?.command_claim ?? {};
    const address = task?.resource_address ?? task?.resource ?? claim.resource ?? input.resource_ref ?? input.resource_address;
    const key = addressKey(address);
    const actor = task?.actor ?? task?.execution?.actor ?? claim.actor ?? claim.principal;
    const requestKey = task?.request_key ?? task?.execution?.request_key;
    const permitId = task?.permit_id ?? task?.execution?.permit_id ?? claim.permit_id ?? task?.task_id;
    if (typeof actor !== 'string' || !actor || typeof requestKey !== 'string' || !requestKey
      || typeof permitId !== 'string' || !permitId) fail('The typed operation must supply its current actor, permit and request key.', 'database_supply_context_invalid', 403);
    return { key, actor, requestKey, permitId, operation };
  };
  const run = (operation, apply) => async (input, task) => {
    const { key, actor, requestKey, permitId } = commandContext(task, input, operation);
    const expected = input.expected_revision ?? null;
    return lock(key, async () => {
      await authorize({ address: key, actor, permit_id: permitId, request_key: requestKey, operation, input: copy(input), expected_revision: expected });
      const instance = await open(key, { create: operation === 'provision' });
      const binding = identity({ actor, request_key: requestKey, operation, input, expected_revision: expected });
      if (operation === 'read' || operation === 'inspect' || operation === 'schema') {
        if (expected !== instance.revision) fail('The current PostgreSQL revision differs from expected_revision.', 'database_revision_conflict', 409);
        const output = await instance.db.transaction(async tx => {
          await tx.query('SET TRANSACTION READ ONLY');
          return apply(tx, input, { address: key, actor, request_key: requestKey, permit_id: permitId, revision: instance.revision });
        });
        await authorize({ address: key, actor, permit_id: permitId, request_key: requestKey, operation, input: copy(input), expected_revision: expected, at_commit: true });
        return output;
      }
      const prior = await storage.readCommitment(key, requestKey);
      if (prior) {
        if (prior.actor !== actor || prior.input_identity !== binding) fail('This request key already names another PostgreSQL command.', 'database_request_conflict', 409);
        return copy(prior.result);
      }
      const legacy = await legacyCommitmentStatus(instance, requestKey);
      if (legacy.found || legacy.uncertain)
        fail('A legacy PostgreSQL receipt exists without trusted owner-side reconciliation. This request will not be replayed.', 'database_legacy_commitment_unverified', 409);
      if (operation !== 'provision' && expected !== instance.revision)
        fail('The current PostgreSQL revision differs from expected_revision.', 'database_revision_conflict', 409);
      if (operation === 'provision' && instance.revision !== null)
        fail('This PostgreSQL resource is already provisioned.', 'database_already_provisioned', 409);
      let output;
      let committedRevision;
      await instance.db.transaction(async tx => {
        output = await apply(tx, input, { address: key, actor, request_key: requestKey, permit_id: permitId, revision: instance.revision });
        committedRevision = nextRevision(instance.revision);
      });
      try {
        const permitFence = await authorize({ address: key, actor, permit_id: permitId, request_key: requestKey, operation, input: copy(input), expected_revision: expected, at_commit: true });
        const revision = await persist(key, instance, instance.revision, permitFence, { actor, request_key: requestKey, input_identity: binding, result: output });
        if (revision !== committedRevision) fail('The PostgreSQL revision receipt is inconsistent.', 'database_commit_unverified', 502);
      } catch (error) {
        // If rights changed or durable storage rejected the snapshot, discard the uncommitted image.
        if (error?.code !== 'database_revision_conflict') {
          const latest = await readSnapshot(key);
          await restoreInstance(key, latest.snapshot, latest.revision);
        }
        throw error;
      }
      return output;
    });
  };

  const provision = run('provision', async (_tx, input, context) => ({
    resource: context.address, name: input.name ?? null, state: 'provisioned', engine: 'PostgreSQL', revision: 'revision:1',
  }));
  const inspect = run('inspect', async tx => {
    const { rows } = await tx.query(`SELECT n.nspname AS schema_name, c.relname AS table_name,
      c.relkind AS relation_kind FROM pg_catalog.pg_class c
      JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname NOT IN ('pg_catalog','information_schema','trillion_supply')
        AND n.nspname NOT LIKE 'pg_toast%' ORDER BY n.nspname, c.relname`);
    return { engine: 'PostgreSQL', schemas: rows };
  });
  const schema = run('schema', async (tx, input) => {
    if (typeof input.schema !== 'string' || !input.schema.trim()) fail('Name a PostgreSQL schema to inspect.');
    if (input.schema.toLowerCase() === 'trillion_supply') fail('The PostgreSQL supply’s private commitment schema is owner-managed.');
    const { rows } = await tx.query(`SELECT table_schema, table_name, column_name, ordinal_position, data_type,
      is_nullable, column_default FROM information_schema.columns WHERE table_schema = $1
      ORDER BY table_name, ordinal_position`, [input.schema]);
    return { schema: input.schema, columns: rows };
  });
  const query = run('query', async (tx, input) => {
    if (typeof input.sql !== 'string' || !input.sql.trim()) fail('A PostgreSQL statement is required.');
    assertCustomerSql(input.sql);
    if (input.params !== undefined && !Array.isArray(input.params)) fail('PostgreSQL query parameters must be an array.');
    return resultOf(await tx.query(input.sql, input.params ?? []));
  });
  const transact = run('transaction', async (tx, input) => {
    if (!Array.isArray(input.statements) || !input.statements.length) fail('A PostgreSQL transaction needs one or more statements.');
    const results = [];
    for (const statement of input.statements) {
      if (!object(statement) || typeof statement.sql !== 'string' || !statement.sql.trim())
        fail('Each transaction item must be one PostgreSQL statement.');
      assertCustomerSql(statement.sql);
      if (statement.params !== undefined && !Array.isArray(statement.params)) fail('PostgreSQL query parameters must be arrays.');
      results.push(resultOf(await tx.query(statement.sql, statement.params ?? [])));
    }
    return { results };
  });
  const read = run('read', async (tx, input) => {
    if (typeof input.sql !== 'string' || !input.sql.trim()) fail('A PostgreSQL read statement is required.');
    assertCustomerSql(input.sql);
    if (input.params !== undefined && !Array.isArray(input.params)) fail('PostgreSQL query parameters must be an array.');
    return resultOf(await tx.query(input.sql, input.params ?? []));
  });
  const write = (input, task) => query(input, task);
  const lifecycle = async (input, task) => {
    const action = input.action;
    const context = commandContext(task, input, `lifecycle:${action}`);
    const { key, actor, requestKey, permitId } = context;
    if (action === 'close') return lock(key, async () => {
      await authorize({ address: key, actor, permit_id: permitId, request_key: requestKey, operation: 'close', input: copy(input) });
      const instance = databases.get(key);
      if (!instance) return { resource: key, state: 'closed' };
      await instance.db.close(); databases.delete(key);
      return { resource: key, state: 'closed', revision: instance.revision };
    });
    if (action === 'delete') return lock(key, async () => {
      const saved = await readSnapshot(key);
      const permitFence = await authorize({ address: key, actor, permit_id: permitId, request_key: requestKey, operation: 'delete', input: copy(input), at_commit: true });
      if (saved.revision !== (input.expected_revision ?? null)) fail('The PostgreSQL resource changed before deletion.', 'database_revision_conflict', 409);
      const removed = await storage.delete(key, saved.revision, { permit_fence: copy(permitFence) });
      if (removed !== true) fail('The durable snapshot owner did not confirm deletion.', 'database_delete_unverified', 409);
      const instance = databases.get(key); if (instance) await instance.db.close(); databases.delete(key);
      return { resource: key, state: 'deleted' };
    });
    fail('Supported lifecycle actions are close and delete.');
  };

  const implementation = Object.freeze({
    admit({ placements = [] } = {}) {
      const eligible = placements.filter(place => place === 'placement:customer-local' || place === 'resource-local');
      return eligible.length ? { placements: eligible, entrypoint: 'invoke', atomic: false } : { placements: [], entrypoint: 'invoke', atomic: false };
    },
    async invoke({ tool, input, task }) {
      const operation = tool?.invoke?.operation;
      switch (operation) {
        case 'provision': return provision(input, task);
        case 'inspect': return inspect(input, task);
        case 'schema': return schema(input, task);
        case 'read': return read(input, task);
        case 'write': return write(input, task);
        case 'query': return query(input, task);
        case 'transaction': return transact(input, task);
        case 'lifecycle': return lifecycle(input, task);
        default: fail('The PostgreSQL typed operation is not installed.', 'capability_operation_unavailable', 404);
      }
    },
    async reconcile({ task, tool }) {
      const input = task?.input;
      if (!object(input) || typeof tool?.invoke?.operation !== 'string')
        fail('Reconciliation requires the original typed operation and retained input.', 'database_reconcile_invalid', 400);
      const { key, actor, requestKey, permitId } = commandContext(task, input, tool.invoke.operation);
      await authorize({ address: key, actor, permit_id: permitId, request_key: requestKey,
        operation: 'reconcile', original_operation: tool.invoke.operation, input: copy(input) });
      const receipt = await storage.readCommitment(key, requestKey);
      if (!receipt) {
        const instance = await open(key);
        const legacy = await legacyCommitmentStatus(instance, requestKey);
        return legacy.found || legacy.uncertain ? { state: 'unknown' } : { state: 'not_sent' };
      }
      const binding = identity({ actor, request_key: requestKey, operation: tool.invoke.operation, input,
        expected_revision: input.expected_revision ?? null });
      if (receipt.actor !== actor || receipt.input_identity !== binding)
        fail('The original request key is committed to different input.', 'database_request_conflict', 409);
      return { state: 'completed', output: copy(receipt.result) };
    },
    async close({ address }) {
      const key = addressKey(address);
      return lock(key, async () => { const instance = databases.get(key); if (instance) { await instance.db.close(); databases.delete(key); } });
    },
  });
  return implementation;
}

/** Current typed-operation descriptors that make the same engine callable from
 * every installed interface (including MCP and the customer's local CLI). The
 * owner binds each descriptor's resource_ref before execution. */
export function pgliteDatabaseToolDescriptors() {
  const input = (properties, required = []) => ({ type: 'object', properties: {
    resource_ref: { type: 'string', minLength: 1 }, expected_revision: { type: ['string', 'null'] }, ...properties,
  }, required: ['resource_ref', ...required], additionalProperties: false });
  const output = { type: 'object', additionalProperties: true };
  const definitions = [
    ['provision', input({ name: { type: 'string' } }), 'Provision one isolated local PostgreSQL database.'],
    ['inspect', input({}), 'List the PostgreSQL schemas and relations.'],
    ['schema', input({ schema: { type: 'string', minLength: 1 } }, ['schema']), 'Read the columns of any PostgreSQL schema.'],
    ['read', input({ sql: { type: 'string', minLength: 1 }, params: { type: 'array', items: {} } }, ['sql']), 'Run one parameterized PostgreSQL statement.'],
    ['write', input({ sql: { type: 'string', minLength: 1 }, params: { type: 'array', items: {} } }, ['sql']), 'Run one PostgreSQL statement that changes schema or rows.'],
    ['query', input({ sql: { type: 'string', minLength: 1 }, params: { type: 'array', items: {} } }, ['sql']), 'Run one parameterized PostgreSQL statement.'],
    ['transaction', input({ statements: { type: 'array', minItems: 1, items: { type: 'object', required: ['sql'], properties: {
      sql: { type: 'string', minLength: 1 }, params: { type: 'array', items: {} },
    }, additionalProperties: false } } }, ['statements']), 'Commit multiple PostgreSQL statements atomically.'],
    ['lifecycle', input({ action: { enum: ['close', 'delete'] } }, ['action']), 'Close or permanently delete this PostgreSQL resource.'],
  ];
  return definitions.map(([operation, input_schema, description]) => ({
    id: `tool:database-postgresql-${operation}`,
    label: `PostgreSQL ${operation}`,
    description,
    input_schema,
    output_schema: output,
    placements: ['placement:customer-local', 'resource-local'],
    invoke: { implementation_ref: 'native:pglite', operation },
  }));
}

const verifiedContract = result => object(result) && result.authoritative === true && result.current === true
  && result.contract_id === EEAF_TRANSACTION_AUTHORITY_CONTRACT.id
  && result.contract_revision === EEAF_TRANSACTION_AUTHORITY_CONTRACT.revision
  && result.atomicity === EEAF_TRANSACTION_AUTHORITY_CONTRACT.atomicity
  && Array.isArray(result.semantics)
  && EEAF_TRANSACTION_AUTHORITY_CONTRACT.semantics.every(semantic => result.semantics.includes(semantic));

/**
 * The injected verifier must be a trusted installed resource-authority owner.
 * A capability's self-declared metadata is never sufficient to grant this path.
 */
export function makeEeaFTransactionAuthority({ supply, verifyAuthority } = {}) {
  if (!supply || typeof supply.invoke !== 'function') throw new TypeError('An addressed database supply is required.');
  const available = typeof verifyAuthority === 'function';
  const unavailable = Object.freeze({ available: false, contract: EEAF_TRANSACTION_AUTHORITY_CONTRACT,
    transact() { fail('No trusted current EEAF authority verifier is installed.', 'eeaf_authority_unavailable', 409); } });
  if (!available) return unavailable;
  return Object.freeze({
    available: true,
    contract: EEAF_TRANSACTION_AUTHORITY_CONTRACT,
    async transact(address, transaction, context = {}) {
      if (!object(context) || typeof context.actor !== 'string' || !context.actor
        || typeof context.permit_id !== 'string' || !context.permit_id
        || typeof context.request_key !== 'string' || !context.request_key)
        fail('The current actor, permit and request key are required.', 'database_supply_context_invalid', 403);
      const current = await verifyAuthority({ address: copy(address), actor: context.actor, permit_id: context.permit_id,
        request_key: context.request_key, operation: 'eeaf:transaction:commit', requirements: copy(context.requirements ?? {}) });
      if (!verifiedContract(current)) fail('The trusted owner did not verify current authoritative EEAF requirements.', 'eeaf_authority_unavailable', 409);
      if (!object(transaction) || !Array.isArray(transaction.operations) || transaction.operations.length === 0
        || transaction.operations.some(item => !object(item) || typeof item.operation !== 'string' || !object(item.input))
        || !object(transaction.expected) || !object(transaction.current_rights)
        || !object(transaction.policy) || !object(transaction.retention))
        fail('An EEAF transaction must include expected state, current rights, policy, retention and operations.');
      const result = await supply.invoke(address, 'eeaf:transaction:commit', {
        contract: EEAF_TRANSACTION_AUTHORITY_CONTRACT, expected: copy(transaction.expected),
        current_rights: copy(transaction.current_rights), policy: copy(transaction.policy),
        retention: copy(transaction.retention), operations: copy(transaction.operations),
      }, context);
      if (!object(result) || result.state !== 'committed' || typeof result.revision !== 'string'
        || typeof result.receipt !== 'string' || result.request_key !== context.request_key || !Array.isArray(result.events))
        fail('The provider did not return a request-bound durable EEAF commitment.', 'eeaf_commit_unverified', 502);
      return result;
    },
  });
}

