// Ported from old trillion test/ai-space-projection-queue.test.mjs (tag old-trillion-before-worker-retire, b6ae0ebf81),
// deleted by Trillion-X/trillion #243. The queue is this tool's src/ai-space-projection.mjs (old src/person-spaces.mjs
// exported it); the AI list is tools/see-and-limit-what-each-ai-can-reach makeAis, the store and relate come from
// tools/keep-and-wake-ai-sessions-on-this-computer, and countingHost is rebuilt below over sqliteHost.
// Left out: four tests that drove the retired PersonStore (its alarm arming, aisOf, setFact, aiSpaceProjectionWakePending
// and its outer transaction): no running code arms a store alarm from this queue (searched the three repos for
// aiSpaceProjectionWakePending, aiSpaceProjections and ai_space_projection: only this queue and a table name in
// trillion-rust src/storage/record_store_resources.json). The other seven tests are the old ones.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { aiSpaceProjectionQueue, initAiSpaceProjectionQueue } from '../src/ai-space-projection.mjs';
import { makeAis } from '../../see-and-limit-what-each-ai-can-reach/src/ais.mjs';
import { sqliteHost } from '../../keep-and-wake-ai-sessions-on-this-computer/src/local-store.mjs';
import { decisionStore } from '../../keep-and-wake-ai-sessions-on-this-computer/src/decision-store.mjs';
import { recordLogStore } from '../../keep-and-wake-ai-sessions-on-this-computer/parts/record-log/do-work/record-log-store.mjs';
import { relate } from '../../keep-and-wake-ai-sessions-on-this-computer/src/record-model-tools.mjs';

// What each statement hands back, counted (old test/person-store-reads-for-tests.mjs countingHost).
function countingHost() {
  const host = sqliteHost(':memory:');
  const reads = [];
  const sql = { exec(query, ...params) {
    const cursor = host.sql.exec(query, ...params);
    reads.push({ query, params, rows: cursor.toArray().length });
    return cursor;
  } };
  return { host, sql, take: () => reads.splice(0) };
}

function owner(file = ':memory:', { now = () => 1_000, network = async () => ({ ok: true }) } = {}) {
  const host = sqliteHost(file);
  initAiSpaceProjectionQueue(host.sql);
  let projections;
  const store = decisionStore(host.sql, {
    transaction: host.transaction,
    written: rows => projections.queue(rows),
  });
  const person = { store, relay: () => 'member-relay', network: () => ({ spaceAgents: network }) };
  projections = aiSpaceProjectionQueue({ sql: host.sql, eeaf: store.eeaf, person, now });
  return { ...host, store, person, projections, ais: makeAis({ eeaf: store.eeaf, now: () => new Date(now()).toISOString() }) };
}

const addMembership = (records, aiId, spaceId) => relate(records, {
  relations: [{ subject: aiId, role: 'in space', object: `space:${spaceId}` }],
});

test('empty projection planning stays SQL-free and new or rolled-back AI writes retain durable deadlines', async () => {
  const fixture = countingHost();
  initAiSpaceProjectionQueue(fixture.sql);
  let now = 1000;
  let label = 'First';
  const projections = aiSpaceProjectionQueue({ sql: fixture.sql, now: () => now,
    eeaf: { read: () => ({ label }), holdersOf: () => ({ holders: [], complete: true }) }, person: {} });
  assert.equal(projections.nextAt(), null);
  fixture.take();
  for (let i = 0; i < 20; i++) assert.equal(projections.nextAt(), null);
  assert.equal(fixture.take().length, 0, 'planning an unchanged empty queue performs no SQL');

  assert.throws(() => fixture.host.transaction(() => {
    projections.queue([{ id: 'ai:deadline-fixture', type: 'ai' }]);
    throw new Error('abort projection write');
  }), /abort projection write/);
  assert.equal(projections.nextAt(), null, 'a rolled-back insert creates no deadline');
  projections.queue([{ id: 'ai:deadline-fixture', type: 'ai' }]);
  assert.equal(projections.nextAt(), now, 'a committed insert invalidates the empty answer');
  now = 2000; label = 'Second';
  projections.queue([{ id: 'ai:deadline-fixture', type: 'ai' }]);
  assert.equal(projections.nextAt(), now, 'a changed durable deadline is read again');
  await projections.runDue();
  assert.equal(projections.nextAt(), null, 'a settled queue can be planned as empty');
  fixture.take();
  assert.equal(projections.nextAt(), null);
  assert.equal(fixture.take().length, 0);
  now = 3000; label = 'Third';
  projections.queue([{ id: 'ai:deadline-fixture', type: 'ai' }]);
  assert.equal(projections.nextAt(), now, 'a later AI edit still schedules after the queue settled');
  fixture.host.db.close();
});

test('outbox survives a cold owner reopen and retries a failed space withdrawal before deleting the relation', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'trillion-ai-space-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const file = join(dir, 'person.sqlite');
  let now = 1_000;
  let rejectWithdraw = true;
  const calls = [];
  const network = async call => {
    calls.push(call);
    if (call.verb === 'withdraw' && rejectWithdraw) { rejectWithdraw = false; throw new Error('temporary failure'); }
    return { ok: true };
  };
  const first = owner(file, { now: () => now, network });
  first.ais.upsert({ key: 'take-open-work-mini', label: 'Codex Mini', kind: 'cli' });
  const relation = addMembership(first.store.eeaf, 'ai:take-open-work-mini', 'space_abc123').relations[0];
  first.ais.remove('take-open-work-mini');
  first.db.close();

  now = 2_000;
  const reopened = owner(file, { now: () => now, network });
  assert.equal(reopened.projections.nextAt(), 1_000, 'pending deletion is present after reopening');
  await reopened.projections.runDue({ budget_ms: 1_500 });
  assert.equal(calls.at(-1).verb, 'withdraw');
  assert.equal(reopened.store.eeaf.read(relation.id)?.role, 'in space', 'failed withdrawal retains relation for retry');
  const retryAt = reopened.projections.nextAt();
  assert.ok(retryAt > now, 'failed withdrawal retains a bounded retry time');

  now = retryAt;
  await reopened.projections.runDue({ budget_ms: 1_500 });
  assert.equal(calls.filter(call => call.verb === 'withdraw').length, 2);
  assert.equal(reopened.projections.nextAt(), null);
  assert.equal(reopened.store.eeaf.holdersOf('ai:take-open-work-mini').holders.length, 0);
  reopened.db.close();
});

test('a newer AI edit survives an in-flight projection and receives its own projection', async () => {
  const calls = [];
  let release;
  const app = owner(':memory:', { network: async call => {
    calls.push(call);
    if (calls.length === 1) await new Promise(resolve => { release = resolve; });
    return { ok: true };
  } });
  app.ais.upsert({ key: 'take-open-work-mini', label: 'Codex', kind: 'cli', can: ['code'] });
  addMembership(app.store.eeaf, 'ai:take-open-work-mini', 'space_abc123');
  const firstRun = app.projections.runDue({ budget_ms: 1_500 });
  while (!release) await new Promise(resolve => setImmediate(resolve));
  app.ais.upsert({ key: 'take-open-work-mini', label: 'Codex renamed', kind: 'cli', can: ['code', 'files'] });
  release();
  await firstRun;
  await app.projections.runDue({ budget_ms: 1_500 });
  assert.equal(calls.at(-1).input.name, 'Codex renamed');
  assert.equal(app.projections.nextAt(), null);
  app.db.close();
});

test('a type move away from ai schedules withdrawal and does not silently drop the relation', async () => {
  const calls = [];
  const app = owner(':memory:', { network: async call => { calls.push(call); return { ok: true }; } });
  app.ais.upsert({ key: 'take-open-work-mini', label: 'Codex', kind: 'cli' });
  addMembership(app.store.eeaf, 'ai:take-open-work-mini', 'space_abc123');
  app.transaction(() => app.store.eeaf.write([{ id: 'ai:take-open-work-mini', type: 'device', value: { label: 'Moved record' } }]));
  await app.projections.runDue({ budget_ms: 1_500 });
  assert.equal(calls.at(-1).verb, 'withdraw');
  assert.equal(app.projections.nextAt(), null);
  app.db.close();
});


test('a refused projection remains pending, and an edit during withdrawal preserves membership', async () => {
  let now = 1000;let mode = 'refuse';let release;
  const calls = [];
  const app = owner(':memory:', { now: () => now, network: async call => {
    calls.push(call);
    if (mode === 'refuse') return { projected: false };
    if (mode === 'withdraw') await new Promise(resolve => { release = resolve; });
    return { projected: true, withdrawn: true };
  } });
  app.ais.upsert({ key: 'fixture', label: 'Codex', kind: 'cli' });
  const relation = addMembership(app.store.eeaf, 'ai:fixture', 'space_abc123').relations[0];
  await app.projections.runDue();
  assert.equal(app.projections.nextAt(), 6000, 'a false projection answer cannot clear the queue');
  mode = 'withdraw';app.ais.remove('fixture');
  const old = app.projections.runDue();
  while (!release) await new Promise(resolve => setImmediate(resolve));
  app.ais.upsert({ key: 'fixture', label: 'Codex restored', kind: 'cli' });
  release();await old;
  assert.equal(app.store.eeaf.read(relation.id)?.role, 'in space', 'newer state keeps its membership');
  mode = 'ok';await app.projections.runDue();
  assert.equal(calls.at(-1).input.name, 'Codex restored');
  assert.equal(app.projections.nextAt(), null);
  app.db.close();
});


test('bounded slices deliver every membership beyond the first holder page', async () => {
  let now = 1000;const seen = [];
  const app = owner(':memory:', { now: () => now, network: async call => { seen.push(call.space_id);now += 10;return { projected: true }; } });
  app.ais.upsert({ key: 'many-spaces', label: 'Codex', kind: 'cli' });
  for (let i = 0; i < 60; i++) addMembership(app.store.eeaf, 'ai:many-spaces', 'space_' + String(i).padStart(6, '0'));
  await app.projections.runDue({ budget_ms: 20 });
  assert.equal(seen.length, 2, 'the time slice stops after two deliveries');
  assert.notEqual(app.projections.nextAt(), null);
  for (let i = 0; app.projections.nextAt() !== null; i++) {
    assert.ok(i < 40, 'all pages eventually settle');
    await app.projections.runDue({ budget_ms: 20 });
  }
  assert.equal(seen.length, 60);assert.equal(new Set(seen).size, 60, 'every distinct space gets one update');
  app.db.close();
});


test('a real incomplete cold membership index cannot discard an AI update before its retained relations are found', async () => {
  const host = sqliteHost(':memory:');
  initAiSpaceProjectionQueue(host.sql);
  const kinds = [{ type: 'ai', properties: {} }, { type: 'relation', properties: {} }];
  const old = recordLogStore(host.sql, { transaction: host.transaction, model: { kinds } });
  old.write([{ id: 'ai:cold', type: 'ai', value: { label: 'Cold AI' } }, { id: 'relation:old', type: 'relation', value: { subject: 'ai:cold', role: 'in space', object: 'space:old' } }]);
  old.checkpoint();
  const eeaf = recordLogStore(host.sql, { transaction: host.transaction, model: { kinds: [kinds[0], { ...kinds[1], parts: [{ role: 'subject', path: ['subject'] }] }] } });
  const calls = [];let now = 1000;
  const projections = aiSpaceProjectionQueue({ sql: host.sql, eeaf, now: () => now, person: { relay: () => 'member', network: () => ({ spaceAgents: async call => { calls.push(call);return { projected: true }; } }) } });
  assert.equal(eeaf.holdersOf('ai:cold').complete, false);
  assert.equal(eeaf.holdersOf('ai:cold').holders.length, 0);
  projections.queue([{ id: 'ai:cold', type: 'ai' }]);
  await projections.runDue();
  assert.notEqual(projections.nextAt(), null, 'unknown earlier memberships keep the update pending');
  assert.equal(calls.length, 0);
  for (let pass = 0; !eeaf.holdersOf('ai:cold').complete; pass++) { assert.ok(pass < 20);eeaf.maintain({ most_pages: 2 }); }
  now = projections.nextAt();
  await projections.runDue();
  assert.deepEqual(calls.map(call => call.space_id), ['old']);
  assert.equal(projections.nextAt(), null);
  host.db.close();
});
