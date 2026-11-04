import test from 'node:test';
import assert from 'node:assert/strict';
import { makeCreationResourceMount } from '../src/creation-resource-mount.mjs';

const supplies = () => Object.fromEntries(['storage', 'tool', 'renderer', 'file'].map(role => [role, {
  resolve: async address => address === `${role}:installed` ? { invoke: async envelope => ({ role, operation: envelope.operation }) } : null,
}]));
const common = () => {
  const records = new Map();
  return { resource: 'project:one',
  store: { read: id => records.get(id) ?? null, write: row => records.set(row.id, structuredClone(row)), transaction: fn => fn() },
  authority: { capture: async () => ({}), assert: async () => {}, assertCurrent: () => {} },
  placement: { ensure: async () => ({ state: 'ready' }), reconcile: async () => ({ state: 'ready' }), release: async () => ({ state: 'released' }) },
  policy: { id: 'live-placement-policy', select: () => null },
}; };
const pins = ['storage', 'tool', 'renderer', 'file'].map(role => ({ role, id: `${role}:one`, revision: 'r1' }));

test('mount composes four independent installed callable supplies without provider-kind selection', async () => {
  const mount = makeCreationResourceMount({ ...common(), supplies: supplies() });
  const behavior = await (await mount.owner.create({ id: 'c1', request_key: 'create-c1', capability: {
    address: 'tool:installed', id: 'create', revision: 'r1' }, dependencies: pins, input: {}, requirements: {}, budget: {}, lifetime: {} }));
  assert.deepEqual(behavior, { role: 'tool', operation: 'create' });
  assert.equal(mount.resource, 'project:one');
  assert.deepEqual(Object.keys(mount.supplies).sort(), ['file', 'renderer', 'storage', 'tool']);
});

test('an address resolving to multiple independently installed behaviors fails closed', async () => {
  const all = supplies();
  all.storage = { resolve: async () => ({ invoke: async () => ({ role: 'storage' }) }) };
  all.file = { resolve: async () => ({ invoke: async () => ({ role: 'file' }) }) };
  const mount = makeCreationResourceMount({ ...common(), supplies: all });
  await assert.rejects(mount.owner.create({ id: 'c1', request_key: 'create-c1', capability: {
    address: 'tool:installed', id: 'create', revision: 'r1' }, dependencies: pins, input: {}, requirements: {}, budget: {}, lifetime: {} }),
  error => error.code === 'creation_resource_ambiguous_address');
});

test('a mount cannot substitute descriptors for actual callable role supplies', () => {
  assert.throws(() => makeCreationResourceMount({ ...common(), supplies: {
    storage: { id: 'sqlite' }, tool: { id: 'tool' }, renderer: { id: 'renderer' }, file: { id: 'file' },
  } }), /callable storage, tool, renderer and file supplies/);
});
