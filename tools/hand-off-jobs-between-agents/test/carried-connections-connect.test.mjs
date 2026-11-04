import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { makeCarrier } from '../../run-on-a-persons-computer/carry-connections.mjs';
import { carriedAnnotations, carriedTools, connectableVendorsOf, handleCarriedRequest, isCarriedPath, makeCarriedConnections } from '../../shared-code/src/carried-connections.mjs';

const carrierSettings = JSON.parse(readFileSync(new URL('../../run-on-a-persons-computer/carry-connections.json', import.meta.url), 'utf8'));
const serviceRows = async () => [{ vendor: 'whatsapp', name: 'WhatsApp' }];

test('the local helper advertises an unlinked connection and returns a one-time pairing result without caching it', async () => {
  const row = carrierSettings.connections.find(item => item.vendor === 'whatsapp');
  let connectInput;
  let saved = 0;
  let published;
  const module = {
    start: async () => ({ carried: false, why: row.words.not_linked }),
    carried: () => false,
    connect: async input => { connectInput = input; return { state: 'pairing_required', code: 'AB12-CD34', expires_after_seconds: row.code_seconds }; },
  };
  const carrier = makeCarrier({
    settings: carrierSettings,
    connections: new Map([['whatsapp', { row, module }]]),
    computer: 'Proof Mac',
    call: async (path, body) => { if (path === '/agents/publish') published = body; return {}; },
    kept: { get: () => null, put: () => { saved += 1; } },
  });
  await carrier.publish();
  assert.deepEqual(connectableVendorsOf(published), ['whatsapp']);
  assert.deepEqual(await carrier.run({ handoff_id: 'pairing-1', handed_at: new Date().toISOString(), input: { connection: 'whatsapp', verb: 'connect', phone: '(555) 555-9561' } }), {
    state: 'pairing_required', code: 'AB12-CD34', expires_after_seconds: row.code_seconds,
  });
  assert.deepEqual(connectInput, { phone: '(555) 555-9561' });
  assert.equal(saved, 0, 'one-time pairing codes are not written to the helper result cache');
});

test('Trillion routes connect requests to an awake computer with a connectable skill even before the service is linked', async () => {
  let received;
  const pending = new Map();
  const agents = {
    find: () => ({ agents: [{ agent_id: 'computer-proof-mac', ready_now: true, where: 'Proof Mac', skills: [{ id: 'connectable:whatsapp' }] }] }),
    handOff: input => {
      received = input;
      const handoff = { handoff_id: 'handoff-pairing-1', state: 'pending', handed_at: new Date().toISOString() };
      pending.set(handoff.handoff_id, handoff);
      return { handoff };
    },
    read: ({ handoff_id }) => ({ handoff: pending.get(handoff_id) }),
  };
  const carried = makeCarriedConnections({ agents, services: serviceRows, sleep: async () => {} });
  const result = await carried.ask('connect', { service: 'whatsapp', phone: '+15551234567', request_key: 'proof-pairing', wait_seconds: 0 });
  assert.equal(result.state, 'waiting');
  assert.equal(received.to_agent, 'computer-proof-mac');
  assert.deepEqual(received.input, { connection: 'whatsapp', verb: 'connect', phone: '+15551234567' });
});

test('connect_carried_service calls the generic route and the route is registered', async () => {
  let call;
  const tool = carriedTools(async (path, input) => { call = { path, input }; return { state: 'waiting' }; })[0];
  assert.equal(tool.name, 'connect_carried_service');
  assert.equal(carriedAnnotations.connect_carried_service.idempotentHint, true);
  assert.deepEqual(await tool.run({ service: 'whatsapp', phone: '+15551234567', request_key: 'proof-key' }), { state: 'waiting' });
  assert.deepEqual(call, { path: '/carried/connect', input: { service: 'whatsapp', phone: '+15551234567', request_key: 'proof-key' } });
  assert.equal(isCarriedPath('/carried/connect'), true);
  let requested;
  const response = await handleCarriedRequest({ ask: async (verb, input) => { requested = { verb, input }; return { state: 'waiting' }; } }, new Request('https://trillion.test/carried/connect', { method: 'POST', body: JSON.stringify({ service: 'whatsapp', request_key: 'proof-key' }) }));
  assert.equal(response.status, 200);
  assert.deepEqual(requested, { verb: 'connect', input: { service: 'whatsapp', request_key: 'proof-key' } });
});
