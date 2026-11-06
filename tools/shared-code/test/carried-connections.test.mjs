// Ported from old trillion test/carried-connections.test.mjs (tag old-trillion-before-worker-retire, b6ae0ebf81),
// deleted by Trillion-X/trillion #243. The hosted owner is src/carried-connections.mjs here, the computer's helper
// tools/run-on-a-persons-computer/carry-connections.mjs, and the shipped service descriptors (old
// parts/service-connections/records.json) tools/connect-a-service-and-seal-its-key/records.json. Its last test drew the
// Connections screen through old src/account-screens.mjs connectionsFacts with src/workshop.mjs and scripts/workshop-rows.mjs;
// no running code exports connectionsFacts (searched trillion-workshop tools/, trillion-apps web/, trillion-rust src/), so it
// is left out.
// Connections a person's own computer carries: the hosted owner (src/carried-connections.mjs) and the helper on the
// computer (computer/carry-connections.mjs) meeting over the real agents road, with fake message modules.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { makeAgents } from '../src/agents.mjs';
import { agentStoreForTests } from './agent-store-for-tests.mjs';
import { carriedServicesFrom, carriedTools, handleCarriedRequest, makeCarriedConnections } from '../src/carried-connections.mjs';
import { makeCarrier } from '../../run-on-a-persons-computer/carry-connections.mjs';

const settings = JSON.parse(readFileSync(new URL('../../run-on-a-persons-computer/carry-connections.json', import.meta.url), 'utf8'));
const services = async () => [{ vendor: 'imessage', name: 'iMessage' }, { vendor: 'whatsapp', name: 'WhatsApp' }];

function world({ now = () => new Date(), carries = ['imessage'] } = {}) {
  let carried;
  const agents = makeAgents({ store: agentStoreForTests(), now, onFinished: item => carried.finished(item) });
  carried = makeCarriedConnections({ agents, services, ownerIdentity: async () => 'me@example.com', sleep: () => new Promise(() => {}) });
  const sent = [];
  const fake = vendor => ({ start: async () => ({ carried: carries.includes(vendor), account: 'me@example.com', why: 'not here' }), send: async input => { sent.push({ vendor, ...input }); return { sent: true, to: input.to, at: now().toISOString() }; }, read: async () => ({ messages: [{ from: 'me', text: 'hi' }] }) });
  const connections = new Map(settings.connections.map(row => [row.vendor, { row, module: fake(row.vendor) }]));
  const routes = { '/agents/publish': agents.publish, '/agents/presence': agents.presence, '/handoffs/take': agents.take, '/handoffs/finish': agents.finish };
  const kept = new Map();
  const carrier = makeCarrier({ settings, connections, call: async (path, body) => routes[path](body), computer: 'Avery’s MacBook Pro', kept: { get: id => kept.get(id) ?? null, put: (id, value) => kept.set(id, value) }, now: () => now().getTime() });
  return { agents, carried, carrier, sent };
}

test('a computer that is running shows each connection it carries as connected, and only those', async () => {
  const { carried, carrier } = world();
  assert.deepEqual(await carried.rows(), []);
  await carrier.start();
  await carrier.publish();
  const rows = await carried.rows();
  assert.equal(rows.length, 1);
  assert.equal(rows[0].vendor, 'imessage');
  assert.equal(rows[0].status, 'connected');
  assert.equal(rows[0].account_label, 'Avery’s MacBook Pro');
  assert.equal(rows[0].connection_id, `carried:${carrier.agent_id}:imessage`);
});

test('listing carried connections reads work only for computer cards', async () => {
  const base = agentStoreForTests();
  const inspected = { held: [], waiting: [] };
  let counting = false;
  const store = {
    ...base,
    heldBy: id => { if (counting) inspected.held.push(id); return base.heldBy(id); },
    waitingCount: id => { if (counting) inspected.waiting.push(id); return base.waitingCount(id); },
  };
  const agents = makeAgents({ store });
  for (let index = 0; index < 120; index += 1) {
    agents.publish({ agent_id: `chat-${index}`, name: `Chat ${index}`, description: 'Helps with work' });
  }
  agents.publish({ agent_id: 'computer', name: 'My computer', description: 'Carries local accounts',
    skills: [{ id: 'connection:imessage', name: 'iMessage' }], capacity: { max_concurrent: 1, ttl_minutes: 10 } });
  counting = true;
  const carried = makeCarriedConnections({ agents, services });
  assert.deepEqual((await carried.rows()).map(row => row.connection_id), ['carried:computer:imessage']);
  assert.deepEqual(inspected.held, ['computer']);
  assert.deepEqual(inspected.waiting, []);
});

test('a computer whose capacity ran out is away, and a send is refused in words instead of queued', async () => {
  let clock = new Date('2026-09-30T10:00:00Z');
  const { carried, carrier } = world({ now: () => clock });
  await carrier.start();
  await carrier.publish();
  clock = new Date(clock.getTime() + (settings.capacity.ttl_minutes + 1) * 60_000);
  assert.equal((await carried.rows())[0].status, 'away');
  await assert.rejects(carried.ask('send', { service: 'imessage', to: 'me', text: 'hello', request_key: 'k1' }), /last seen/);
});

test('an AI send reaches the computer, is sent once, and the same request_key never sends twice', async () => {
  const { carried, carrier, sent } = world();
  await carrier.start();
  await carrier.publish();
  const asked = carried.ask('send', { service: 'iMessage', to: 'me', text: 'hello', request_key: 'once' });
  await new Promise(resolve => setTimeout(resolve, 0));
  await carrier.takeAll();
  const answer = await asked;
  assert.equal(answer.state, 'finished');
  assert.equal(answer.result.sent, true);
  assert.deepEqual(sent.map(item => [item.vendor, item.to, item.text]), [['imessage', 'me', 'hello']]);
  assert.equal(sent[0].owner_identity, 'me@example.com', 'the verified account identity reaches the Mac for the self check');
  const again = carried.ask('send', { service: 'imessage', to: 'me', text: 'hello', request_key: 'once' });
  await carrier.takeAll();
  assert.equal((await again).handoff_id, answer.handoff_id);
  assert.equal(sent.length, 1);
});

test('reading recent messages comes back from the computer', async () => {
  const { carried, carrier } = world();
  await carrier.start();
  await carrier.publish();
  const asked = carried.ask('read', { service: 'imessage', limit: 5 });
  await new Promise(resolve => setTimeout(resolve, 0));
  await carrier.takeAll();
  assert.deepEqual((await asked).result.messages, [{ from: 'me', text: 'hi' }]);
});

test('a service nobody carries, a missing field and an unknown service are refused with what to do', async () => {
  const { carried, carrier } = world();
  await carrier.start();
  await carrier.publish();
  await assert.rejects(carried.ask('send', { service: 'whatsapp', to: 'me', text: 'x', request_key: 'a' }), /No computer carries WhatsApp/);
  await assert.rejects(carried.ask('send', { service: 'imessage', text: 'x', request_key: 'b' }), /to is needed/);
  await assert.rejects(carried.ask('send', { service: 'imessage', to: 'me', request_key: 'c' }), /Give text or link/);
  await assert.rejects(carried.ask('send', { service: 'imessage', to: 'me', text: 'x' }), /request_key is needed/);
  await assert.rejects(carried.ask('send', { service: 'fax', to: 'me', text: 'x', request_key: 'd' }), /not a service a computer can carry/);
  const answer = await handleCarriedRequest(carried, new Request('https://person/carried/send', { method: 'POST', body: JSON.stringify({ service: 'fax' }) }));
  assert.equal(answer.status, 400);
});

test('the computer never runs a verb its connection lacks, work for another service, or a request that waited too long', async () => {
  let clock = new Date('2026-09-30T10:00:00Z');
  const { carrier, sent } = world({ now: () => clock });
  await carrier.start();
  assert.match((await carrier.run({ handoff_id: 'h1', handed_at: clock.toISOString(), input: { connection: 'imessage', verb: 'link' } })).error, /cannot do link/);
  assert.match((await carrier.run({ handoff_id: 'h2', handed_at: clock.toISOString(), input: { connection: 'whatsapp', verb: 'send', to: 'me', text: 'x' } })).error, /does not carry whatsapp/);
  const old = clock.toISOString();
  clock = new Date(clock.getTime() + (settings.stale_after_minutes + 1) * 60_000);
  assert.match((await carrier.run({ handoff_id: 'h3', handed_at: old, input: { connection: 'imessage', verb: 'send', to: 'me', text: 'x' } })).error, /was not sent/);
  assert.equal(sent.length, 0);
});

test('services a computer can carry come from service-connections descriptors that say carriedBy', () => {
  const rows = { tools: [
    { label: 'iMessage', invoke: { provider: 'imessage', connects: { carried_by: { steps: [] } } } },
    { label: 'GitHub', invoke: { provider: 'github', connects: {} } },
  ] };
  assert.deepEqual(carriedServicesFrom(rows), [{ vendor: 'imessage', name: 'iMessage' }]);
  assert.deepEqual(carriedTools(async () => ({})).map(tool => tool.name), ['connect_carried_service', 'pause_carried_service', 'resume_carried_service', 'read_carried_service_state', 'disconnect_carried_service', 'revoke_carried_service', 'read_carried_incoming_copies', 'erase_carried_incoming_copy', 'send_message', 'read_recent_messages']);
});

test('the shipped descriptors mark iMessage and WhatsApp as carried by a computer, and WhatsApp has no Bitfield process left', () => {
  const things = JSON.parse(readFileSync(new URL('../../connect-a-service-and-seal-its-key/records.json', import.meta.url), 'utf8')).things;
  const payload = vendor => things.find(thing => thing.address === `package::service-connections::published-record::${vendor}`).payload;
  for (const vendor of ['imessage', 'whatsapp']) assert.ok(payload(vendor).carriedBy.steps.length > 0, vendor);
  assert.equal(payload('whatsapp').acquire, undefined);
});
