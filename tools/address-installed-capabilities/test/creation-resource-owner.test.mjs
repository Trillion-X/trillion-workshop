import test from 'node:test';
import assert from 'node:assert/strict';
import { makeCreationResourceOwner } from '../src/creation-resource-owner.mjs';

const clone = value => structuredClone(value);
function fixture({ unknown = false } = {}) {
  const state = { rows: new Map(), currentChecks: 0, calls: [], released: 0, recovered: { state: 'unknown' } };
  const store = {
    read: id => clone(state.rows.get(id) ?? null),
    write: row => state.rows.set(row.id, clone(row)),
    transaction: fn => {
      const snapshot = clone(state.rows);
      try { return fn(); } catch (error) { state.rows = snapshot; throw error; }
    },
  };
  const authority = {
    capture: async command => ({ generation: 'g1', command }),
    assert: async claim => { assert.equal(claim.generation, 'g1'); },
    assertCurrent: claim => { assert.equal(claim.generation, 'g1'); state.currentChecks++; },
  };
  const behavior = { invoke: async envelope => {
    state.calls.push(envelope.operation);
    if (envelope.operation === 'recover') return state.recovered;
    if (unknown && envelope.operation === 'run') throw new Error('response lost after dispatch');
    return { accepted: true, metadata: { label: 'Current creation' }, operation: envelope.operation };
  } };
  const placement = {
    ensure: async request => { state.placementRequest = request; return { state: 'ready', host_address: 'opaque-host', implementation: 'opaque-impl' }; },
    reconcile: async () => ({ state: 'ready' }),
    release: async () => { state.released++; return { state: 'released' }; },
  };
  const owner = makeCreationResourceOwner({ resource: 'account:private-resource', store, authority,
    installed: async address => address === 'capability:creation' ? behavior : null, placement,
    policy: { id: 'installed-policy', select: candidates => candidates[0] },
    now: () => new Date('2026-10-13T12:00:00.000Z') });
  const command = (operation, request_key = `key:${operation}`) => ({ id: 'creation-1', request_key,
    capability: { address: 'capability:creation', id: 'creation-capability', revision: 'rev-7' },
    dependencies: [{ role: 'tool', id: 'tool-1', revision: 'tool-r2' }, { role: 'renderer', id: 'renderer-1', revision: 'renderer-r4' },
      { role: 'file', id: 'file-1', revision: 'file-r1' }, { role: 'storage', id: 'storage-1', revision: 'storage-r3' }],
    requirements: { locality: 'customer-selected' }, budget: {}, lifetime: { kind: 'creation' }, input: { value: operation } });
  return { owner, state, command };
}

test('creation lifecycle uses installed behavior, durable placement and fresh authority at local commit', async () => {
  const f = fixture();
  assert.equal((await f.owner.create(f.command('create'))).accepted, true);
  assert.equal(f.state.placementRequest.resource_address, 'account:private-resource');
  assert.deepEqual(f.state.placementRequest.dependencies.map(row => row.revision), ['tool-r2', 'renderer-r4', 'file-r1', 'storage-r3']);
  assert.equal((await f.owner.update(f.command('update'))).accepted, true);
  assert.equal((await f.owner.disable(f.command('disable'))).accepted, true);
  assert.equal((await f.owner.metadata({ id: 'creation-1' })).state, 'disabled');
  assert.equal((await f.owner.restore(f.command('restore'))).accepted, true);
  const opened = await f.owner.open(f.command('open'));
  assert.equal(opened.accepted, true);
  assert.equal((await f.owner.run(f.command('run'))).accepted, true);
  assert.equal((await f.owner.read({ id: 'creation-1', request_key: 'read-key' })).result.accepted, true);
  assert.equal((await f.owner.erase(f.command('erase'))).accepted, true);
  assert.equal(f.state.released, 1);
  assert.equal((await f.owner.metadata({ id: 'creation-1' })).state, 'erased');
  assert.ok(f.state.currentChecks >= 7, 'mutations revalidate captured authority inside their transaction');
});

test('an unknown external outcome is recovered at the same operation key and never resent', async () => {
  const f = fixture({ unknown: true });
  await f.owner.create(f.command('create'));
  await assert.rejects(f.owner.run(f.command('run', 'stable-run-key')), /response lost/);
  const callsAfterDispatch = f.state.calls.length;
  assert.equal((await f.owner.run(f.command('run', 'stable-run-key'))).state, 'unknown');
  assert.deepEqual(f.state.calls.slice(callsAfterDispatch), ['recover']);
  f.state.recovered = { state: 'completed', result: { accepted: true, output: 'real-provider-result' } };
  assert.deepEqual(await f.owner.run(f.command('run', 'stable-run-key')), { accepted: true, output: 'real-provider-result' });
  assert.equal(f.state.calls.filter(name => name === 'run').length, 1);
});

test('a request key cannot be reused for another operation or immutable dependency pin', async () => {
  const f = fixture();
  await f.owner.create(f.command('create'));
  await f.owner.update(f.command('update', 'shared-key'));
  await assert.rejects(f.owner.update(f.command('different-update', 'shared-key')), error => error.code === 'creation_resource_conflict');
  const changed = f.command('read', 'read-2'); changed.dependencies[0].revision = 'tool-r3';
  await assert.rejects(f.owner.read(changed), error => error.code === 'creation_resource_conflict');
});

test('disabled and erased creations cannot be reopened or run, while later edits have independent effect identities', async () => {
  const f = fixture(); await f.owner.create(f.command('create'));
  await f.owner.run(f.command('run', 'run-1'));
  await f.owner.run({ ...f.command('run', 'run-2'), input: { value: 'run-again' } });
  await f.owner.disable(f.command('disable'));
  await assert.rejects(f.owner.open(f.command('open')), error => error.code === 'creation_resource_state_conflict');
  await assert.rejects(f.owner.run(f.command('run', 'run-3')), error => error.code === 'creation_resource_state_conflict');
  await f.owner.restore(f.command('restore'));
  await f.owner.erase(f.command('erase'));
  await assert.rejects(f.owner.open(f.command('open')), error => error.code === 'creation_resource_state_conflict');
});
