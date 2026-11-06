// Ported from old trillion test/native-carried-recovery.test.mjs (tag old-trillion-before-worker-retire, b6ae0ebf81),
// deleted by Trillion-X/trillion #243. The owners are src/native-carried-automation-owner.mjs here and
// tools/shared-code/src/carried-connections.mjs, on the record store of keep-and-wake-ai-sessions-on-this-computer and
// hand-work-to-ais/agent-records.mjs. The fixture's input identity is a stand-in for old src/database-resource-composition.mjs
// databaseInputIdentity (the owner only compares it). The test of the cold native journal (old src/resource-behavior-commands.mjs)
// is left out: no running code keeps that journal (trillion-rust only reads its old table, src/storage/old_record_tables.rs).
import test from 'node:test';
import assert from 'node:assert/strict';
import { sqliteHost } from '../../keep-and-wake-ai-sessions-on-this-computer/src/local-store.mjs';
import { decisionStore } from '../../keep-and-wake-ai-sessions-on-this-computer/src/decision-store.mjs';
import { agentRecordStore } from '../../hand-work-to-ais/agent-records.mjs';
import { makeAgents } from '../../shared-code/src/agents.mjs';
import { makeCarriedConnections } from '../../shared-code/src/carried-connections.mjs';
import { nativeCarriedAutomationOwners, nativeCarriedRequestReceipts } from '../src/native-carried-automation-owner.mjs';
// The admitted input's identity, opaque to the owner under test (old src/database-resource-composition.mjs made it).
const databaseInputIdentity = input => `input:${JSON.stringify(input)}`;

function fixture(t) {
  const host = sqliteHost(':memory:'); t.after(() => host.db.close());
  const records = decisionStore(host.sql, { transaction: host.transaction }).eeaf;
  const store = agentRecordStore({ records, transaction: host.transaction });
  const agents = makeAgents({ store });
  agents.publish({ agent_id: 'fixture-computer', name: 'Original computer', where: 'Test Mac', description: 'Carries fixture messages',
    skills: [{ id: 'connection:whatsapp', name: 'WhatsApp' }], capacity: { max_concurrent: 1, ttl_minutes: 10 } });
  let writes = 0;
  let context = { permit_id: 'original-native-permit', input_identity: databaseInputIdentity(request(body)), owner: 'fixture-account', resource: '@own-records', generation: 'original-generation', operation: 'carried:request', request_key: 'actual-native-command', recorder: { reader: 'fixture-reader' }, claims: { sign_in: 'fixture-sign-in' } };
  host.sql.exec('CREATE TABLE fixture_resource_facts (entity TEXT PRIMARY KEY, value TEXT NOT NULL)');
  const receipts = nativeCarriedRequestReceipts({ transaction: host.transaction,
    read: key => { const row = host.sql.exec('SELECT value FROM fixture_resource_facts WHERE entity=?', key).toArray()[0]; return row ? JSON.parse(row.value) : null; },
    write: (key, value) => host.sql.exec('INSERT INTO fixture_resource_facts VALUES (?, ?)', key, JSON.stringify(value)), context: () => context });
  const counted = { ...agents, handOff: input => { writes++; return agents.handOff(input); } };
  const supplies = { agents: counted, services: async () => [{ vendor: 'whatsapp', name: 'WhatsApp' }], readHandoff: id => store.handoff(id), commitHandoff: receipts.commit, sleep: async () => {} };
  const carried = makeCarriedConnections(supplies);
  let allowed = true, gates = 0;
  const mount = owner => nativeCarriedAutomationOwners({ automations: { listRules: () => ({ rules: [] }) }, carried: owner,
    actions: { 'rules:set': () => {}, 'schedules:set': () => {} }, context: () => context, receipts,
    current: async () => { gates++; if (!allowed) throw Object.assign(new Error('Current sign-in revoked'), { status: 403 }); } });
  return { host, records, store, agents, carried, supplies, mount, receipts, context: () => context, setContext: next => { context = { ...context, ...next }; }, writes: () => writes, gates: () => gates, revoke: () => { allowed = false; } };
}
const body = { service: 'whatsapp', to: '+15550000001', text: 'Original message', request_key: 'original-send', wait_seconds: 0 };
const request = input => ({ path: '/carried/send', method: 'POST', body: input });

test('cold carried recovery reads the original durable handoff without another dispatch or carrier selection', async t => {
  const f = fixture(t), original = await f.carried.ask('send', body);
  assert.equal(original.state, 'waiting'); assert.equal(f.writes(), 1);
  // Capacity can disappear after dispatch. Recovery follows the retained
  // target and does not require an awake replacement carrier.
  f.agents.setCapacity({ agent_id: 'fixture-computer', max_concurrent: 0 });
  const cold = makeCarriedConnections({ ...f.supplies, agents: { ...f.supplies.agents, find: () => { throw new Error('Recovery must not discover another carrier'); } } });
  const reply = await f.mount(cold).reconcileCarried(request(body));
  assert.equal(reply.state, 'committed');
  assert.equal(reply.result.body.handoff_id, original.handoff_id);
  assert.equal(reply.result.body.state, 'waiting');
  assert.equal(reply.result.body.computer, 'Test Mac');
  assert.equal(f.writes(), 1); assert.equal(f.gates(), 2);
});

test('carried recovery returns the actually finished original result and never repeats its external work', async t => {
  const f = fixture(t), original = await f.carried.ask('send', body);
  const taken = f.agents.take({ agent_id: 'fixture-computer', handoff_id: original.handoff_id }).handoff;
  f.agents.finish({ agent_id: 'fixture-computer', handoff_id: original.handoff_id, generation: taken.generation, result: { sent: true, provider_id: 'original-provider-receipt' } });
  const reply = await f.mount(makeCarriedConnections(f.supplies)).reconcileCarried(request(body));
  assert.equal(reply.result.body.state, 'finished');
  assert.deepEqual(reply.result.body.result, { sent: true, provider_id: 'original-provider-receipt' });
  assert.equal(f.writes(), 1);
});

test('missing, changed and erased original carried requests remain unknown without dispatch', async t => {
  const f = fixture(t), original = await f.carried.ask('send', body), owner = f.mount(f.carried);
  const originalContext = f.context();
  for (const changed of [{ ...body, request_key: 'never-dispatched' }, { ...body, to: '+15550000002' }, { ...body, text: 'Changed message' }]) {
    f.setContext({ input_identity: databaseInputIdentity(request(changed)) });
    assert.deepEqual(await owner.reconcileCarried(request(changed)), { state: 'unknown' });
  }
  f.setContext(originalContext);
  f.records.write([{ id: `agent-handoff:${original.handoff_id}`, type: 'agent-handoff', value: null }]);
  assert.deepEqual(await owner.reconcileCarried(request(body)), { state: 'unknown' });
  assert.equal(f.writes(), 1);
});

test('current revocation refuses carried recovery before original result disclosure', async t => {
  const f = fixture(t); await f.carried.ask('send', body); f.revoke();
  await assert.rejects(f.mount(f.carried).reconcileCarried(request(body)), { status: 403 });
  assert.equal(f.writes(), 1);
});


test('a conflicting prior handoff never becomes the changed native command outcome', async t => {
  const f = fixture(t); await f.carried.ask('send', body);
  const changed = { ...body, text: 'Changed request under prior send key' };
  f.setContext({ permit_id: 'changed-native-permit', input_identity: databaseInputIdentity(request(changed)) });
  await assert.rejects(f.carried.ask('send', changed), /different work/);
  assert.equal(f.receipts.original(), null);
  assert.deepEqual(await f.mount(f.carried).reconcileCarried(request(changed)), { state: 'unknown' });
  assert.equal(f.store.newestHandoffs(10).length, 1);
});

test('revocation during original carried result lookup is checked before disclosure', async t => {
  const f = fixture(t); await f.carried.ask('send', body);
  const cold = makeCarriedConnections({ ...f.supplies, services: async () => { f.revoke(); return [{ vendor: 'whatsapp', name: 'WhatsApp' }]; } });
  await assert.rejects(f.mount(cold).reconcileCarried(request(body)), { status: 403 });
  assert.equal(f.writes(), 1);
});

test('native handoff and its original-command binding commit atomically', async t => {
  const f = fixture(t);
  const broken = nativeCarriedRequestReceipts({ transaction: f.host.transaction, context: f.context, read: () => null,
    write: () => { throw new Error('Original receipt storage interrupted'); } });
  const carried = makeCarriedConnections({ ...f.supplies, commitHandoff: broken.commit });
  await assert.rejects(carried.ask('send', body), /receipt storage interrupted/);
  assert.deepEqual(f.records.ids('agent-handoff'), []);
  assert.equal(f.receipts.original(), null);
});
