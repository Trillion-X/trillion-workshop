// Ported from old trillion test/event-route-members.test.mjs (tag old-trillion-before-worker-retire, b6ae0ebf81),
// deleted by Trillion-X/trillion #243. routeBook, eventRouteStores, receiveEvents and makeEventRules (src/events.mjs) and
// makeRouteListeners (src/event-route-listeners.mjs) are this tool's, moved here from old trillion. The EVENT_INBOX
// Durable Object that kept one route's members (old src/event-inbox.mjs changeEventRoute/eventRouteStores over
// src/event-route-members.mjs) is retired with no running successor (searched changeEventRoute, event_route_members,
// makeEventRouteMembers, EventInbox and event-route across trillion-workshop tools, trillion-rust src and trillion-apps:
// only events.mjs, which calls it, and from-old-trillion copies), so the harness stands in for it with that object's
// two methods over the old members table, read from the old tree's own SQL below. Event source rows are read from
// tools/start-a-new-account-with-the-rules-and-catalog-items/from-old-trillion/records/workshop-event-source-records.json
// instead of through the retired workshop.mjs readToolData. Every assertion is kept.
import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readFile } from 'node:fs/promises';
import { createHmac } from 'node:crypto';
import { routeBook, eventRouteStores, receiveEvents, makeEventRules } from '../src/events.mjs';
import { makeRouteListeners } from '../src/event-route-listeners.mjs';

const published = JSON.parse(await readFile(new URL('../../start-a-new-account-with-the-rules-and-catalog-items/from-old-trillion/records/workshop-event-source-records.json', import.meta.url))).records
  .map(row => row.payload).filter(row => row?.kind === 'tool-event-source');
const source = published.find(row => row.id === 'events:whatsapp-business');

// Stand-in for the retired EVENT_INBOX route object: old src/event-route-members.mjs makeEventRouteMembers and old
// src/event-inbox.mjs eventRouteStores (legacy KV list read first, SQL after, so a stop finished meanwhile stays final).
function routeOwner(sql, kv) {
  sql.exec('CREATE TABLE IF NOT EXISTS event_route_members (store_id TEXT PRIMARY KEY, active INTEGER NOT NULL, generation INTEGER NOT NULL)');
  return {
    changeEventRoute({ store_id, active, generation = 0 }) {
      if (typeof store_id !== 'string' || !store_id || typeof active !== 'boolean' || !Number.isSafeInteger(generation) || generation < 0)
        throw new TypeError('An event route needs an account store, listening state, and nonnegative control revision.');
      sql.exec(`INSERT INTO event_route_members (store_id, active, generation) VALUES (?, ?, ?)
        ON CONFLICT (store_id) DO UPDATE SET active = excluded.active, generation = excluded.generation
        WHERE excluded.generation >= event_route_members.generation
          AND (excluded.active != event_route_members.active OR excluded.generation != event_route_members.generation)`, store_id, active ? 1 : 0, generation);
      const row = sql.exec('SELECT active, generation FROM event_route_members WHERE store_id = ?', store_id).toArray()[0];
      return { active: row.active === 1, generation: row.generation };
    },
    async eventRouteStores({ source_id, route_key }) {
      const legacy = JSON.parse((await kv.get(`event-route:${source_id}:${route_key}`)) ?? '[]');
      const rows = sql.exec('SELECT store_id, active FROM event_route_members ORDER BY store_id').toArray();
      const changed = new Set(rows.map(row => row.store_id));
      return [...new Set([...legacy.filter(id => typeof id === 'string' && id && !changed.has(id)),
        ...rows.filter(row => row.active === 1).map(row => row.store_id)])].sort();
    },
  };
}
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };

function fixture(t, { legacy = [], get = null } = {}) {
  const databases = [], objects = new Map();
  t.after(() => databases.forEach(db => db.close()));
  const kv = { get: get ?? (async () => JSON.stringify(legacy)),
    put: async () => { throw new Error('Production membership must not overwrite a KV recipient list'); },
    delete: async () => { throw new Error('Production membership must not delete a KV recipient list'); } };
  const namespace = { idFromName: name => name, get: name => {
    if (!objects.has(name)) {
      const db = new DatabaseSync(':memory:'); databases.push(db);
      const sql = { exec(query, ...args) {
        const statement = db.prepare(query);
        if (statement.columns().length) { const rows = statement.all(...args); return { toArray: () => rows }; }
        statement.run(...args); return { toArray: () => [] };
      } };
      objects.set(name, routeOwner(sql, kv));
    }
    return objects.get(name);
  } };
  return { kv, namespace, book: id => routeBook(kv, id, namespace),
    stores: () => eventRouteStores(kv, namespace, source.id, '100') };
}

const payload = () => ({ object: 'whatsapp_business_account', entry: [{ id: '100', changes: [{ field: 'messages', value: {
  messaging_product: 'whatsapp', metadata: { phone_number_id: '900' }, messages: [{ id: 'message-one', from: '441111111111', type: 'text', text: { body: 'hello' } }],
} }] }] });
async function signedDelivery(f, recipients, options = {}) {
  const body = JSON.stringify(payload()), key = 'synthetic-app-secret';
  const signature = createHmac('sha256', key).update(body).digest('hex');
  return receiveEvents(new Request('https://trillion.test/events/whatsapp-business', { method: 'POST', body, headers: { 'x-hub-signature-256': `sha256=${signature}` } }), {
    sourceId: source.id, sources: async () => [source], kv: f.kv, routeNamespace: f.namespace,
    sign: async () => signature,
    storeFor: id => ({ fetch: async () => { recipients.push(id); return new Response('{}'); } }), ...options,
  });
}

test('actual durable routeBook keeps both concurrent registrations and signed fan-out reaches both', async t => {
  const f = fixture(t), first = f.book('A'), second = f.book('B');
  await Promise.all([first.add(source.id, '100', { revision: 1 }), second.add(source.id, '100', { revision: 1 })]);
  assert.deepEqual(await f.stores(), ['A', 'B']);
  const recipients = [], response = await signedDelivery(f, recipients);
  assert.equal(response.status, 200); assert.deepEqual(recipients.sort(), ['A', 'B']);
  assert.equal((await response.json()).delivered_to_accounts, 2);
});

test('removing A while adding B preserves B, masks stale legacy A, and retains untouched legacy C', async t => {
  const f = fixture(t, { legacy: ['A', 'C'] }), first = f.book('A'), second = f.book('B');
  await first.add(source.id, '100', { revision: 1 });
  await Promise.all([first.remove(source.id, '100', { revision: 2 }), second.add(source.id, '100', { revision: 1 })]);
  assert.deepEqual(await f.stores(), ['B', 'C']);
  const recipients = []; assert.equal((await signedDelivery(f, recipients)).status, 200);
  assert.deepEqual(recipients.sort(), ['B', 'C']);
  await first.add(source.id, '100', { revision: 3 });
  await first.remove(source.id, '100', { revision: 2 });
  const resumed = []; await signedDelivery(f, resumed); assert.deepEqual(resumed.sort(), ['A', 'B', 'C']);
});

test('a late or omitted revision cannot revive a versioned stop or report registration success', async t => {
  const f = fixture(t, { legacy: ['A'] }), first = f.book('A');
  await first.add(source.id, '100', { revision: 3 });
  await first.remove(source.id, '100', { revision: 4 });
  await assert.rejects(first.add(source.id, '100', { revision: 3 }), /newer start or stop/);
  await assert.rejects(first.add(source.id, '100'), /newer start or stop/);
  assert.deepEqual(await f.stores(), []);
  await first.add(source.id, '100', { revision: 5 });
  await first.remove(source.id, '100');
  assert.deepEqual(await f.stores(), ['A']);
});

test('a stop finishing during a legacy lookup still excludes the stopped account', async t => {
  const held = deferred(), entered = deferred();
  const f = fixture(t, { get: async () => { entered.resolve(); await held.promise; return JSON.stringify(['A', 'C']); } });
  await f.book('A').add(source.id, '100', { revision: 1 });
  const reading = f.stores(); await entered.promise;
  await f.book('A').remove(source.id, '100', { revision: 2 }); held.resolve();
  assert.deepEqual(await reading, ['C']);
});

test('registry lookup failure cannot acknowledge signed delivery as having no recipients', async t => {
  const f = fixture(t, { get: async () => { throw new Error('registry unavailable'); } });
  await f.book('A').add(source.id, '100', { revision: 1 });
  const recipients = [];
  await assert.rejects(signedDelivery(f, recipients), /registry unavailable/);
  assert.deepEqual(recipients, []);
});

test('scalar listener start, stop and resume carry their actual control revisions to durable membership', async t => {
  const f = fixture(t), old = published.find(row => row.id === 'events:instagram');
  const kept = new Map();
  const scalar = { ...old, listen_tool_id: undefined, route_key_proof: { tool_id: 'tool:proof', output_selector: '$.id' } };
  const rules = makeEventRules({ facts: { read: async key => kept.get(key) ?? null, write: async (key, value) => { kept.set(key, value); }, list: async () => [] },
    sources: async () => [scalar], routes: f.book('A'), now: () => new Date('2026-10-08T00:00:00Z'), rearm: async () => {},
    workshop: { run: async () => ({ task_id: 'proof', state: 'completed', output: { id: '100' } }), read: async () => ({ task_id: 'proof', state: 'completed', output: { id: '100' } }) } });
  assert.equal((await rules.listen({ source_id: scalar.id })).listening, true);
  await rules.listen({ source_id: scalar.id, stop: true });
  assert.equal(kept.get(`event-listen:${scalar.id}`).control_revision, 1);
  await assert.rejects(f.book('A').add(scalar.id, '100'), /newer start or stop/);
  assert.equal((await rules.listen({ source_id: scalar.id })).listening, true);
  assert.equal(kept.get(`event-listen:${scalar.id}`).control_revision, 2);
  assert.deepEqual(await eventRouteStores(f.kv, f.namespace, scalar.id, '100'), ['A']);
  await f.book('A').remove(scalar.id, '100', { revision: 3 });
  await assert.rejects(rules.listen({ source_id: scalar.id }), /newer start or stop/);
});

test('a stale multi-route setup cannot claim readiness after its durable membership was stopped', async t => {
  const f = fixture(t), kept = new Map(), connection = { connection_id: source.connects_with.connection_id,
    vendor: source.connects_with.vendor, status: 'connected', connected_at: '2026-10-07T20:00:00Z' };
  await f.book('A').remove(source.id, '100', { revision: 9 });
  const owner = makeRouteListeners({ facts: { read: async key => kept.get(key) ?? null, write: async (key, value) => { kept.set(key, value); } },
    routes: f.book('A'), connections: async () => [connection], now: () => new Date('2026-10-08T00:00:00Z'), rearm: async () => {},
    workshop: { run: async ({ tool_id }) => ({ state: 'completed', output: {
      data: tool_id.endsWith('list-business-portfolios') ? [{ id: '10' }] : tool_id.endsWith('list-owned-whatsapp-accounts') ? [{ id: '100' }] : [],
      paging: { has_next: false },
    } }) } });
  await assert.rejects(owner.listen(source), /newer start or stop/);
  assert.equal((await owner.state(source)).ready, false);
  assert.deepEqual(kept.get(`event-listen:${source.id}`).route_keys, []);
  assert.deepEqual(await f.stores(), []);
});
