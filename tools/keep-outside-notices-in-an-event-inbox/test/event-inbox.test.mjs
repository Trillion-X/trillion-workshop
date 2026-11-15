import assert from 'node:assert/strict';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { EventInbox } from '../read-data/event-inbox.mjs';
import { createInboxHandlers } from '../read-data/inbox-handlers.mjs';

function setup(reply = () => new Response('done')) {
  const db = new DatabaseSync(':memory:');
  const sql = { exec(query, ...args) { const statement = db.prepare(query); return { toArray: () => statement.all(...args) }; } };
  // Durable SQL applies writes eagerly, including statements without a cursor read.
  sql.exec = (query, ...args) => { const statement = db.prepare(query); const rows = statement.all(...args); return { toArray: () => rows }; };
  let alarm = null;
  const storage = { sql, getAlarm: async () => alarm, setAlarm: async at => { alarm = at; } };
  const waiting = new Map();
  const env = { APP_KV: { put: async (k,v) => waiting.set(k,v), delete: async k => waiting.delete(k), list: async ({prefix}) => ({ keys: [...waiting.keys()].filter(k => k.startsWith(prefix)).map(name => ({name})) }) } };
  const calls = [];
  const inbox = new EventInbox({storage}, env, { inboxHandlers: { apply: { sample: async (...args) => { calls.push(args); return reply(); } }, tend: {} } });
  return { inbox, db, calls, waiting, storage, env, sql, alarm: () => alarm, row: () => sql.exec('SELECT * FROM notices').toArray()[0] };
}
const notice = { key: 'one', source: 'sample', body: 'exact notice', header: 'signed', origin: 'https://service.example' };

test('notice delivery is kept once, answered before apply, and alarm settles it', async () => {
  const s = setup();
  assert.deepEqual(await s.inbox.take(notice), {state:'waiting'});
  assert.equal(s.calls.length, 0);
  assert.ok(s.alarm() <= Date.now());
  assert.equal(s.waiting.size, 1);
  await s.inbox.alarm();
  assert.equal(s.row().state, 'done');
  assert.equal(s.row().tries, 1);
  assert.equal(s.waiting.size, 0);
  assert.deepEqual(await s.inbox.take({...notice, body:'another body'}), {state:'done'});
  await s.inbox.alarm();
  assert.equal(s.calls.length, 1);
  assert.equal(s.row().body, 'exact notice');
});

test('temporary errors wait with bounded backoff, known permanent refusals stay refused', async () => {
  for (const status of [401, 403, 408, 429, 500, 503]) {
    const s = setup(() => new Response('temporary', {status}));
    await s.inbox.take(notice);
    await s.inbox.alarm();
    assert.equal(s.row().state, 'waiting');
    assert.equal(s.row().tries, 1);
    assert.ok(s.row().next_at > Date.now());
    assert.equal(s.alarm(), s.row().next_at);
  }
  for (const status of [400, 404, 409]) {
    const s = setup(() => new Response('refused', {status}));
    await s.inbox.take(notice); await s.inbox.alarm();
    assert.equal(s.row().state, 'refused'); assert.equal(s.waiting.size, 0);
  }
});

test('out-of-order dependency wake makes waiting notices due again', async () => {
  const s = setup();
  await s.inbox.take(notice);
  s.db.prepare("UPDATE notices SET next_at = ?").run(Date.now()+60000);
  await s.inbox.nudge();
  assert.ok(s.row().next_at <= Date.now());
  await s.inbox.alarm();
  assert.equal(s.row().state,'done');
});

test('missing durable or payment owners refuse, and payment factory preserves exact request', async () => {
  assert.throws(() => new EventInbox({}, {}), error => error.code === 'event_host_unavailable');
  assert.throws(() => createInboxHandlers({}), error => error.code === 'payment_notice_owner_unavailable');
  const personFor = () => null;
  const handlers = createInboxHandlers({ personFor, keepPricesCurrent: async () => 'current', receivePaymentEvent: async (request,env,person) => {
    assert.equal(request.url,'https://service.example/billing/stripe');
    assert.equal(request.headers.get('stripe-signature'),'signed');
    assert.equal(await request.text(),'exact notice'); assert.equal(person,personFor);
    return new Response('done');
  } });
  assert.equal((await handlers.apply.stripe({},notice)).status,200);
  assert.equal(await handlers.tend.stripe({},notice.origin),'current');
});

test('a thrown handler retries and repeated failures stop increasing the wait after one hour', async () => {
  const s = setup(() => { throw new Error('store busy'); });
  await s.inbox.take(notice);
  s.db.prepare('UPDATE notices SET tries = 20').run();
  const before = Date.now();
  await s.inbox.alarm();
  const row = s.row();
  assert.equal(row.state, 'waiting');
  assert.equal(row.tries, 21);
  assert.equal(row.said, 'store busy');
  assert.ok(row.next_at >= before + 3600000);
  assert.ok(row.next_at <= Date.now() + 3600000);
  assert.equal(s.alarm(), row.next_at);
});

test('landing a notice wakes only its source through the declared inbox name', async () => {
  const s = setup();
  const nudged = [];
  s.waiting.set('inbox-waiting:sample:dependent', '0');
  s.waiting.set('inbox-waiting:other:unrelated', '0');
  s.env.EVENT_INBOX = { idFromName: name => name, get: id => ({ nudge: async () => nudged.push(id) }) };
  await s.inbox.take(notice);
  await s.inbox.alarm();
  assert.deepEqual(nudged, ['notice:dependent']);
  assert.equal(s.waiting.has('inbox-waiting:sample:one'), false);
  assert.equal(s.waiting.has('inbox-waiting:other:unrelated'), true);
});

test('upkeep is rate limited, stays scheduled on failure, and stale unowned upkeep stops', async () => {
  const s = setup();
  let calls = 0;
  s.inbox.inboxHandlers.tend.sample = async (env, origin) => {
    assert.equal(env, s.env);
    assert.equal(origin, notice.origin);
    calls += 1;
    throw new Error('price owner busy');
  };
  const first = await s.inbox.tend(notice);
  assert.deepEqual(first, { ran: true, said: 'failed: price owner busy' });
  assert.ok(s.alarm() > Date.now());
  assert.deepEqual(await s.inbox.tend(notice), { ran: false, said: first.said });
  assert.equal(calls, 1);
  s.db.prepare('UPDATE upkeep SET ran_at = ?').run(Date.now() - 3600001);
  await s.inbox.alarm();
  assert.equal(calls, 2);
  s.db.prepare('DELETE FROM upkeep_owned').run();
  s.db.prepare('UPDATE upkeep SET ran_at = 0').run();
  await s.inbox.alarm();
  assert.equal(calls, 2);
  assert.deepEqual(s.sql.exec('SELECT * FROM upkeep').toArray(), []);
});

test('route membership is supplied by its owner and read after legacy lookup finishes', async () => {
  const s = setup();
  assert.throws(() => s.inbox.changeEventRoute({}), error => error.code === 'event_route_owner_unavailable');
  let release;
  let stopped = false;
  s.env.APP_KV.get = async key => {
    assert.equal(key, 'event-route:source:route');
    await new Promise(resolve => { release = resolve; });
    return '["legacy"]';
  };
  const routeMembership = {
    change: input => { stopped = input.stop; return { stopped }; },
    list: legacy => { assert.deepEqual(legacy, ['legacy']); return stopped ? [] : legacy; },
  };
  const inbox = new EventInbox({ storage: s.storage }, s.env, { inboxHandlers: s.inbox.inboxHandlers, routeMembership });
  const reading = inbox.eventRouteStores({ source_id: 'source', route_key: 'route' });
  assert.deepEqual(inbox.changeEventRoute({ stop: true }), { stopped: true });
  release();
  assert.deepEqual(await reading, []);
});
