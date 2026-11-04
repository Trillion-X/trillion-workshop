import test from 'node:test';
import assert from 'node:assert/strict';
import { addressedCapabilityAnnotations, addressedCapabilityTools, handleAddressedCapabilityRequest } from '../src/addressed-capability-tools.mjs';

const makeOwner = calls => Object.fromEntries([
  'list', 'read', 'save', 'remove', 'restore', 'describe', 'resolve', 'bind',
  'readBinding', 'updateBinding', 'removeBinding', 'restoreBinding', 'resolveBinding', 'run',
].map(name => [name, async args => { calls.push([name, args]); return { method: name, args }; }]));

const request = (path, { method = 'POST', body, headers } = {}) => new Request(`https://trillion.test${path}`, {
  method,
  ...(body === undefined ? {} : { body: typeof body === 'string' ? body : JSON.stringify(body) }),
  headers,
});

test('the endpoint lists a bounded page with normalized query values', async () => {
  const calls = [];
  const response = await handleAddressedCapabilityRequest(makeOwner(calls), request('/capabilities?kind=resource-binding&before=abc&limit=20&deleted=true', { method: 'GET' }));
  assert.equal(response.status, 200);
  assert.deepEqual(calls, [['list', { kind: 'resource-binding', before: 'abc', limit: 20, deleted: true }]]);
  assert.deepEqual(await response.json(), { method: 'list', args: calls[0][1] });
});

test('every capability and binding lifecycle action dispatches its exact owner method and arguments', async () => {
  const calls = [];
  const owner = makeOwner(calls);
  const rows = [
    ['save', { descriptor: { id: 'cap', methods: { extendable: { input_schema: { type: 'object' } } } }, expected_revision: null }],
    ['read', { id: 'cap', deleted: true }],
    ['describe', { id: 'cap' }],
    ['remove', { id: 'cap', expected_revision: 'r1' }],
    ['restore', { id: 'cap', expected_revision: 'r2' }],
    ['resolve', { requirements: { media: ['read', 'write'], custom: { region: 'west' } } }],
    ['bind', { id: 'binding', resource_ref: { kind: 'document', id: 'doc-1' }, requirements: { read: true }, capability_id: 'cap', expected_revision: null }],
    ['readBinding', { id: 'binding', deleted: true }],
    ['updateBinding', { id: 'binding', requirements: { write: true }, capability_id: 'cap2', expected_revision: 'r3' }],
    ['removeBinding', { id: 'binding', expected_revision: 'r4' }],
    ['restoreBinding', { id: 'binding', expected_revision: 'r5' }],
    ['resolveBinding', { id: 'binding', method: 'an-open-method-name' }],
    ['run', { id: 'binding', method: 'an-open-method-name', input: { nested: ['unchanged'] }, request_key: 'retry-key', wait_seconds: 4, execution: { mode: 'selected' } }],
  ];
  for (const [action, args] of rows) {
    const response = await handleAddressedCapabilityRequest(owner, request('/capabilities', { body: { action, ...args } }));
    assert.equal(response.status, 200, action);
    assert.deepEqual((await response.json()).args, args, action);
  }
  assert.deepEqual(calls, rows);
});

test('unknown paths return null and unknown or inherited action names are refused', async () => {
  const calls = [];
  const owner = makeOwner(calls);
  assert.equal(await handleAddressedCapabilityRequest(owner, request('/elsewhere')), null);
  const unknown = await handleAddressedCapabilityRequest(owner, request('/capabilities', { body: { action: 'toString' } }));
  assert.equal(unknown.status, 404);
  assert.deepEqual(await unknown.json(), { code: 'not-found', message: 'Unknown capability action.' });
  const inherited = Object.create({ list: async () => ({ compromised: true }) });
  const inheritedList = await handleAddressedCapabilityRequest(inherited, request('/capabilities', { method: 'GET' }));
  assert.equal(inheritedList.status, 404);
  assert.equal(calls.length, 0);
});

test('the endpoint bounds request bytes and refuses caller-selected host storage or secrets', async () => {
  const calls = [];
  const owner = makeOwner(calls);
  const large = await handleAddressedCapabilityRequest(owner, request('/capabilities', { body: { action: 'save', descriptor: { content: 'x'.repeat(256_100) }, expected_revision: null } }));
  assert.equal(large.status, 413);
  assert.equal((await large.json()).code, 'request-too-large');
  const hostFields = await handleAddressedCapabilityRequest(owner, request('/capabilities', { body: { action: 'read', id: 'cap', physical_store: 'chosen-by-caller' } }));
  assert.equal(hostFields.status, 400);
  assert.equal(calls.length, 0);
});

test('the MCP tools use the same endpoint actions and preserve open method inputs and retry keys', async () => {
  const calls = [];
  const ownerCalls = [];
  const owner = makeOwner(ownerCalls);
  const tools = addressedCapabilityTools(async (path, body, method) => {
    calls.push([path, body, method]);
    const response = await handleAddressedCapabilityRequest(owner, request(path, { method, body }));
    return response.json();
  });
  const byName = Object.fromEntries(tools.map(tool => [tool.name, tool]));
  await byName.manage_capabilities.run({ action: 'save', descriptor: { id: 'cap' }, expected_revision: null });
  await byName.resolve_capability.run({ requirements: { custom: { key: 'value' } } });
  const operation = { nested: ['preserve'], optional: null };
  await byName.run_resource_operation.run({ id: 'binding', method: 'provider-added-method', input: operation, request_key: 'same-key', execution: { place: 'customer' } });
  assert.deepEqual(calls, [
    ['/capabilities', { descriptor: { id: 'cap' }, expected_revision: null, action: 'save' }, 'POST'],
    ['/capabilities', { requirements: { custom: { key: 'value' } }, action: 'resolve' }, 'POST'],
    ['/capabilities', { id: 'binding', method: 'provider-added-method', input: operation, request_key: 'same-key', execution: { place: 'customer' }, action: 'run' }, 'POST'],
  ]);
  assert.deepEqual(ownerCalls, [
    ['save', { descriptor: { id: 'cap' }, expected_revision: null }],
    ['resolve', { requirements: { custom: { key: 'value' } } }],
    ['run', { id: 'binding', method: 'provider-added-method', input: operation, request_key: 'same-key', execution: { place: 'customer' } }],
  ]);
  assert.equal(byName.run_resource_operation.inputSchema.properties.method.enum, undefined);
  assert.deepEqual(addressedCapabilityAnnotations.run_resource_operation, { title: 'Run a resource operation', readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true });
  assert.equal(addressedCapabilityAnnotations.read_capabilities.readOnlyHint, true);
});


test('the same MCP operation tool preserves an independent address, installed method and retry identity', async () => {
  const calls = [];
  const tool = addressedCapabilityTools(async (...args) => { calls.push(args); return { created: true }; }).find(row => row.name === 'run_resource_operation');
  const result = await tool.run({ address: 'project:client/foo', method: 'resource:create', input: { name: 'Client work' }, request_key: 'same-create' });
  assert.deepEqual(result, { created: true });
  assert.deepEqual(calls, [['/resources/project%3Aclient%2Ffoo/command', { operation: 'resource:create', input: { name: 'Client work' }, request_key: 'same-create' }, 'POST']]);
  assert.throws(() => tool.run({ address: 'project:one', id: 'second-owner', method: 'resource:create', request_key: 'key' }), /one resource/);
  assert.throws(() => tool.run({ address: 'project:one', method: 'resource:create' }), /stable request_key/);
  assert.equal(calls.length, 1);
});
