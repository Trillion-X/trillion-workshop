// Resource-local owner for creations whose tools, renderers, files and storage
// are independently supplied installed capabilities. This records lifecycle
// metadata only; the supplied behavior remains the authority for opaque content.
import { makeAddressedOperation } from './addressed-operation.mjs';
import { blake3 } from '@noble/hashes/blake3.js';
import { bytesToHex } from '@noble/hashes/utils.js';

const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const copy = value => structuredClone(value);
const fail = (message, code = 'creation_resource_invalid', status = 400) => {
  throw Object.assign(new Error(message), { code, status });
};
const thenable = value => value && typeof value.then === 'function';
const canonical = value => Array.isArray(value) ? value.map(canonical) : object(value)
  ? Object.fromEntries(Object.keys(value).sort().map(name => [name, canonical(value[name])])) : value;
const fingerprint = value => `1f:${bytesToHex(blake3(new TextEncoder().encode(JSON.stringify(canonical(value)))))}`;

/**
 * store is private to this logical resource and provides read/write/transaction.
 * installed resolves opaque addresses to executable invoke behavior. Each action
 * is an addressed operation on the actual installed capability. authority
 * captures fresh rights for every command and rechecks them in the state
 * transaction. placement is the durable resource placement owner (ensure,
 * reconcile, release), never a provider selector.
 */
export function makeCreationResourceOwner({ resource, store, installed, authority, placement,
  policy, now = () => new Date().toISOString() } = {}) {
  if (typeof resource !== 'string' || !resource || typeof store?.read !== 'function'
    || typeof store?.write !== 'function' || typeof store?.transaction !== 'function')
    throw new TypeError('A resource address and resource-local transactional store are required.');
  if (typeof installed !== 'function') throw new TypeError('An installed addressed capability resolver is required.');
  if (!['capture', 'assert', 'assertCurrent'].every(key => typeof authority?.[key] === 'function'))
    throw new TypeError('Fresh resource command authority is required.');
  if (!['ensure', 'reconcile', 'release'].every(key => typeof placement?.[key] === 'function'))
    throw new TypeError('Durable resource placement is required.');
  if (!object(policy) || typeof policy.id !== 'string' || typeof policy.select !== 'function')
    throw new TypeError('An executable placement policy is required.');
  const invoke = makeAddressedOperation({ resolve: installed });
  const stamp = () => { const value = now(); return value instanceof Date ? value.toISOString() : value; };
  const sync = value => { if (thenable(value)) throw new TypeError('Resource transactions and current authority checks must be synchronous.'); return value; };
  const read = id => copy(sync(store.read(id)));
  const write = row => { sync(store.write(copy(row))); return copy(row); };
  const transact = fn => sync(store.transaction(fn));
  const get = id => {
    if (typeof id !== 'string' || !id) fail('A creation id is required.');
    const row = read(id);
    if (!row) fail('The creation was not found.', 'creation_resource_not_found', 404);
    return row;
  };
  const checked = input => {
    if (!object(input) || typeof input.id !== 'string' || !input.id || typeof input.request_key !== 'string' || !input.request_key.trim())
      fail('A creation id and request key are required.');
    if (!object(input.capability) || typeof input.capability.address !== 'string' || !input.capability.address
      || typeof input.capability.id !== 'string' || typeof input.capability.revision !== 'string'
      || input.capability.role !== undefined && !['storage', 'tool', 'renderer', 'file'].includes(input.capability.role)
      || !object(input.input ?? {}))
      fail('An installed capability address, immutable pin and input are required.');
    if (!Array.isArray(input.dependencies) || input.dependencies.some(pin => !object(pin)
      || typeof pin.id !== 'string' || typeof pin.revision !== 'string'))
      fail('Creation dependencies must be immutably pinned.');
    const dependencyRoles = input.dependencies.map(pin => pin.role).filter(role => role !== undefined);
    if (new Set(dependencyRoles).size !== dependencyRoles.length)
      fail('Each supplied creation dependency role may be pinned only once.');
    if (!object(input.requirements ?? {}) || !object(input.budget ?? {}) || !object(input.lifetime ?? {}))
      fail('Placement requirements, budget and lifetime are required.');
    return input;
  };
  const capture = async (input, operation) => authority.capture({ resource_address: resource, creation_id: input.id,
    operation, request_key: input.request_key, capability: copy(input.capability), context: input.command_context });
  const runInstalled = async (input, operation, extra = {}) => {
    const claim = await capture(input, operation);
    await authority.assert(claim, { resource_address: resource, creation_id: input.id, operation, request_key: input.request_key });
    const result = await invoke({ address: input.capability.address, operation, input: { ...copy(input.input ?? {}), ...extra },
      request_key: input.request_key, creation_id: input.id, capability: copy(input.capability), dependencies: copy(input.dependencies ?? []) },
    { resource_address: resource, command_claim: claim,
      capability_role: input.capability.role });
    return { result, claim };
  };
  const prepare = async (raw, operation) => {
    const input = checked(raw);
    const existing = read(input.id);
    const row = existing ?? { id: input.id, resource_address: resource, request_key: input.request_key,
      capability: copy(input.capability), dependencies: copy(input.dependencies), lifetime: copy(input.lifetime),
      state: 'pending', revision: 0, created_at: stamp(), effects: {} };
    if (existing && (existing.capability.address !== input.capability.address || existing.capability.id !== input.capability.id || existing.capability.revision !== input.capability.revision
      || JSON.stringify(existing.dependencies) !== JSON.stringify(input.dependencies)))
      fail('The creation request conflicts with its immutable capability or dependency pins.', 'creation_resource_conflict', 409);
    const claim = await capture(input, operation);
    await authority.assert(claim, { resource_address: resource, creation_id: input.id, operation, request_key: input.request_key });
    transact(() => {
      sync(authority.assertCurrent(claim, { resource_address: resource, creation_id: input.id, operation, request_key: input.request_key }));
      const current = read(input.id);
      if (current && current.revision !== row.revision) fail('Creation state changed concurrently.', 'creation_resource_conflict', 409);
      if (!current) write(row);
    });
    return { input, row: read(input.id), claim };
  };
  const placementInput = input => ({ request_key: input.request_key, resource_address: resource,
    capability: { id: input.capability.id, revision: input.capability.revision }, requirements: copy(input.requirements),
    budget: copy(input.budget ?? {}), lifetime: copy(input.lifetime ?? {}),
    dependencies: copy(input.dependencies), policy });
  const effect = async (raw, operation, mode) => {
    const { input, row, claim: commandClaim } = await prepare(raw, operation);
    if (['open', 'run'].includes(operation) && ['disabled', 'erased'].includes(row.state))
      fail(`A ${row.state} creation cannot ${operation}.`, 'creation_resource_state_conflict', 409);
    const inputIdentity = fingerprint({ operation, input: input.input ?? {}, capability: input.capability,
      dependencies: input.dependencies, requirements: input.requirements ?? {}, budget: input.budget ?? {}, lifetime: input.lifetime ?? {} });
    const prior = Object.values(row.effects ?? {}).find(effect => effect.request_key === input.request_key);
    if (prior && (prior.operation !== operation || prior.input_identity !== inputIdentity))
      fail('This request key already names a different command.', 'creation_resource_conflict', 409);
    if (prior?.state === 'completed') return copy(prior.result);
    if (prior && ['dispatching', 'unknown'].includes(prior.state)) {
      const recoveryClaim = await capture(input, `${operation}-recovery`);
      await authority.assert(recoveryClaim, { resource_address: resource, creation_id: input.id, operation: `${operation}-recovery`, request_key: input.request_key });
      const recovered = await invoke({ address: input.capability.address, operation: 'recover',
        input: { original_operation: operation, original_request_key: input.request_key, original_input: copy(prior.input),
          original_identity: prior.input_identity, creation_id: input.id },
        request_key: input.request_key, creation_id: input.id, capability: copy(input.capability) },
      { resource_address: resource, recovery_of: operation, capability_role: input.capability.role });
      if (recovered?.state !== 'completed') return { state: 'unknown', creation_id: input.id, operation };
      const saved = commitEffect(input, operation, recovered.result, 'completed', recoveryClaim);
      return copy(saved.effects[prior.effect_id].result);
    }
    if (mode === 'create') {
      const placed = await placement.ensure(placementInput({ ...input, request_key: row.request_key,
        requirements: input.requirements ?? {}, budget: input.budget ?? {}, lifetime: input.lifetime ?? row.lifetime }));
      if (placed?.state !== 'ready') return { state: placed?.state ?? 'placement_pending', creation_id: input.id, placement: placed };
      transact(() => {
        sync(authority.assertCurrent(commandClaim, { resource_address: resource, creation_id: input.id, operation, request_key: input.request_key }));
        const current = read(input.id);
        write({ ...current, placement: { request_key: input.request_key, state: placed.state,
          host_address: placed.host_address ?? null, capability: copy(placed.capability ?? input.capability),
          implementation: placed.implementation ?? null, placement: placed.placement ?? null }, revision: current.revision + 1, updated_at: stamp() });
      });
    }
    const effectId = fingerprint({ operation, request_key: input.request_key });
    transact(() => {
      sync(authority.assertCurrent(commandClaim, { resource_address: resource, creation_id: input.id, operation, request_key: input.request_key }));
      const latest = get(input.id);
      write({ ...latest, effects: { ...latest.effects, [effectId]: { effect_id: effectId, operation, state: 'dispatching', request_key: input.request_key,
        input: copy(input.input ?? {}), input_identity: inputIdentity, started_at: stamp() } }, revision: latest.revision + 1, updated_at: stamp() });
    });
    let dispatched;
    try { dispatched = await runInstalled(input, operation, mode === 'update' ? { expected_revision: row.revision } : {}); }
    catch (error) {
      // A thrown transport can follow an accepted external effect; preserve it as unknown.
      transact(() => {
        sync(authority.assertCurrent(commandClaim, { resource_address: resource, creation_id: input.id, operation, request_key: input.request_key }));
        const latest = get(input.id);
        const old = latest.effects[effectId];
        write({ ...latest, effects: { ...latest.effects, [effectId]: { ...old, state: 'unknown',
          error: String(error?.message ?? 'unknown'), updated_at: stamp() } }, revision: latest.revision + 1, updated_at: stamp() });
      });
      throw error;
    }
    const { result, claim } = dispatched;
    // If rights changed after dispatch, preserve the durable dispatching record.
    // Reconciliation may inspect this same target; no duplicate effect is sent.
    await authority.assert(claim, { resource_address: resource, creation_id: input.id, operation, request_key: input.request_key, result });
    const saved = commitEffect(input, operation, result, 'completed', claim);
    return copy(saved.effects[effectId].result);
  };
  const commitEffect = (input, operation, result, state, claim = null) => transact(() => {
    if (claim) sync(authority.assertCurrent(claim, { resource_address: resource, creation_id: input.id, operation, request_key: input.request_key, result }));
    const current = get(input.id);
    const effectId = fingerprint({ operation, request_key: input.request_key });
    const effects = { ...current.effects, [effectId]: { ...current.effects[effectId], effect_id: effectId, operation, state,
      request_key: input.request_key, input: copy(input.input ?? {}), input_identity: fingerprint({ operation, input: input.input ?? {}, capability: input.capability,
        dependencies: input.dependencies, requirements: input.requirements ?? {}, budget: input.budget ?? {}, lifetime: input.lifetime ?? {} }),
      result: copy(result), completed_at: stamp() } };
    const nextState = operation === 'create' ? 'active' : operation === 'disable' ? 'disabled'
      : operation === 'erase' ? 'erased' : operation === 'restore' ? 'active' : current.state;
    return write({ ...current, effects, state: nextState, revision: current.revision + 1, updated_at: stamp() });
  });

  const owner = {
    create: input => effect(input, 'create', 'create'),
    read: async input => {
      const row = get(input.id); const claim = await capture({ ...input, capability: input.capability ?? row.capability }, 'read');
      if ((input.capability && (input.capability.address !== row.capability.address || input.capability.id !== row.capability.id || input.capability.revision !== row.capability.revision))
        || (input.dependencies && JSON.stringify(input.dependencies) !== JSON.stringify(row.dependencies)))
        fail('The read request conflicts with this creation’s immutable pins.', 'creation_resource_conflict', 409);
      await authority.assert(claim, { resource_address: resource, creation_id: input.id, operation: 'read' });
      const result = await invoke({ address: row.capability.address, operation: 'read', input: copy(input.input ?? {}),
        request_key: input.request_key ?? `read:${row.revision}`, creation_id: row.id, capability: copy(row.capability) },
      { resource_address: resource, command_claim: claim, capability_role: row.capability.role ?? 'storage' });
      sync(authority.assertCurrent(claim, { resource_address: resource, creation_id: input.id, operation: 'read', result }));
      return { metadata: { id: row.id, state: row.state, revision: row.revision, dependencies: copy(row.dependencies), lifetime: copy(row.lifetime) }, result };
    },
    update: input => effect(input, 'update', 'update'),
    disable: input => effect(input, 'disable', 'update'),
    restore: input => effect(input, 'restore', 'update'),
    erase: async input => {
      const result = await effect(input, 'erase', 'update');
      if (result?.state === 'unknown') return result;
      const released = await placement.release({ resource_address: resource, request_key: get(input.id).request_key });
      if (released?.state !== 'released') return { state: 'erase_completed_release_pending', result, released };
      return result;
    },
    open: input => effect(input, 'open', 'open'),
    run: input => effect(input, 'run', 'run'),
    reconcile: async ({ id, request_key, operation }) => {
      const row = get(id); const pending = Object.values(row.effects ?? {}).find(effect => effect.operation === operation && effect.request_key === request_key);
      if (!pending || !['dispatching', 'unknown'].includes(pending.state)) return pending ?? null;
      const claim = await authority.capture({ resource_address: resource, creation_id: id,
        operation: `${operation}-recovery`, request_key, capability: copy(row.capability) });
      await authority.assert(claim, { resource_address: resource, creation_id: id, operation: `${operation}-recovery`, request_key });
      const reconciled = await placement.reconcile({ resource_address: resource, request_key });
      if (operation === 'create' && reconciled?.state !== 'ready') return reconciled;
      const result = await invoke({ address: row.capability.address, operation: 'recover', input: { original_operation: operation,
        original_request_key: request_key, creation_id: id }, request_key, creation_id: id, capability: copy(row.capability) },
      { resource_address: resource, recovery_of: operation, capability_role: row.capability.role });
      if (result?.state !== 'completed') return result;
      return commitEffect({ id, request_key, capability: row.capability, dependencies: row.dependencies,
        input: pending.input ?? {}, requirements: {}, budget: {}, lifetime: row.lifetime }, operation, result.result, 'completed', claim);
    },
    metadata: async ({ id, request_key = `metadata:${id}` }) => {
      const row = get(id); const claim = await authority.capture({ resource_address: resource, creation_id: id,
        operation: 'metadata', request_key, capability: copy(row.capability) });
      await authority.assert(claim, { resource_address: resource, creation_id: id, operation: 'metadata', request_key });
      return { id: row.id, state: row.state, revision: row.revision, dependencies: copy(row.dependencies),
        lifetime: copy(row.lifetime), placement: copy(row.placement ?? null) };
    },
  };
  return Object.freeze(owner);
}
