// The trading runs against the stand-in records door (with exactly the rows' rights) and a fake broker: what is
// sent, what is kept, and what is never sent or kept.
import test from 'node:test';
import assert from 'node:assert/strict';
import { startFakeDoor } from 'trillion-workshop/tools/records-door/test/fake-door.mjs';
import { runRow, rowOf } from 'trillion-workshop/tools/records-door/test/run-row.mjs';
import { openRecordsDoor } from 'trillion-workshop/tools/records-door/read-data/records-door.mjs';
import rows from '../tool-rows.json' with { type: 'json' };
import { checkPaperOrders, lookUpLiveInstruments, lookUpPaperInstruments, placeLiveOrders, placePaperOrders } from '../read-data/trading.mjs';
import { HELD, LIVE_ROUTE, PAPER_ROUTE, fakeBroker, order, policy } from './fixtures.mjs';

const ROUTES = { 'paper-route': PAPER_ROUTE, 'live-route': LIVE_ROUTE };
const NOW = Date.parse('2026-01-02T15:00:00Z');
const placeRow = rowOf(rows, 'tool:place-paper-orders-from-a-trading-policy');

async function withDoor(records, body) {
  const fake = await startFakeDoor({ rights: placeRow.invoke.records.rights, mostWrites: placeRow.invoke.records.most_writes, records });
  try { return await body(openRecordsDoor({ descriptor: fake.descriptor, wait: async () => {} }), fake); } finally { await fake.close(); }
}
const context = (door, broker, more = {}) => ({ door, held: HELD, fetchImpl: broker.fetchImpl, now: () => NOW, ...more });
const accepted = (id = 'b-1', extra = {}) => ({ status: 200, body: { id, status: 'accepted', filled_qty: '0', filled_avg_price: null, ...extra } });
const keptOf = (fake, type) => [...fake.kept.values()].filter(record => record.type === type);

test('with no policy nothing is sent, and the refusal says what to give', async () => {
  await withDoor([], async (door, fake) => {
    const broker = fakeBroker([]);
    await assert.rejects(placePaperOrders({ routes: ROUTES }, context(door, broker)), /No trading policy was given, so no order was placed\. Give policy: \{ policy_version.*live: false/);
    await assert.rejects(placePaperOrders({ policy: policy() }, context(door, broker)), /No broker routes were given/);
    const noLimits = policy();
    delete noLimits.risk.max_daily_notional;
    await assert.rejects(placePaperOrders({ policy: noLimits, routes: ROUTES }, context(door, broker)), /max_daily_notional must be a number/);
    await assert.rejects(placePaperOrders({ policy: policy({ zone: 'Mars/Olympus' }), routes: ROUTES }, context(door, broker)), /day_time_zone/);
    await assert.rejects(placePaperOrders({ policy: policy({ version: 'a/b' }), routes: ROUTES }, context(door, broker)), /policy_version/);
    assert.equal(broker.seen.length, 0);
    assert.equal(fake.calls.length, 0);
  });
});

test('a paper order is kept before it is sent, sent with the held fields, and kept with the broker\'s answer and its trail', async () => {
  await withDoor([], async (door, fake) => {
    const broker = fakeBroker([(url, init) => {
      assert.equal(keptOf(fake, 'trade-order')[0].value.status, 'sending', 'the record is written before the request leaves');
      return accepted('b-1', { client_order_id: JSON.parse(init.body).client_order_id });
    }]);
    const answer = await placePaperOrders({ policy: policy(), routes: ROUTES, prices: { BREAD: 100 } }, context(door, broker));
    assert.equal(answer.placed.length, 1);
    assert.equal(answer.placed[0].status, 'submitted');
    assert.equal(answer.placed[0].broker_order_id, 'b-1');
    assert.deepEqual(answer.day, { day: '2026-01-02', used: 200, limit: 5000 });
    const [sent] = broker.seen;
    assert.equal(sent.url, 'https://broker.example/v1/orders');
    assert.equal(sent.headers['X-Example-Key'], 'held-key-id-0001');
    assert.deepEqual(JSON.parse(sent.body), { symbol: 'BREAD', qty: 2, side: 'buy', type: 'market', time_in_force: 'day', client_order_id: answer.placed[0].order_id });
    const [record] = keptOf(fake, 'trade-order');
    assert.ok(record.id.startsWith('paper-v1-'));
    assert.deepEqual([record.value.status, record.value.broker_order_id, record.value.filled_qty, record.value.live, record.value.mode], ['submitted', 'b-1', 0, false, 'paper']);
    const [event] = keptOf(fake, 'trade-order-event');
    assert.equal(event.id, `${record.id}-sent`);
    assert.equal(event.value.http_status, 200);
    assert.deepEqual(event.value.request.header_names, ['X-Example-Key', 'X-Example-Secret', 'accept', 'content-type']);
    assert.deepEqual(keptOf(fake, 'trade-day-spend')[0], { id: 'paper-2026-01-02', type: 'trade-day-spend', value: { mode: 'paper', day: '2026-01-02', time_zone: 'UTC', notional: 200 } });
    const everything = JSON.stringify([...fake.kept.values(), answer, fake.calls]);
    assert.ok(!everything.includes(HELD.key_id) && !everything.includes(HELD.secret), 'no held value is kept, answered or sent to the door');
  });
});

test('running the same policy again sends nothing; a new policy version is a new decision set', async () => {
  await withDoor([], async door => {
    const broker = fakeBroker([accepted('b-1'), accepted('b-2')]);
    await placePaperOrders({ policy: policy(), routes: ROUTES, prices: { BREAD: 100 } }, context(door, broker));
    const again = await placePaperOrders({ policy: policy(), routes: ROUTES, prices: { BREAD: 100 } }, context(door, broker));
    assert.equal(again.placed.length, 0);
    assert.match(again.skipped[0].reason, /idempotent/);
    const next = await placePaperOrders({ policy: policy({ version: 'v2' }), routes: ROUTES, prices: { BREAD: 100 } }, context(door, broker));
    assert.equal(next.placed.length, 1);
    assert.equal(broker.seen.length, 2);
    assert.equal(next.day.used, 400, 'the day\'s spend carries across runs');
  });
});

test('the daily limit holds across runs on the same day in the policy\'s time zone', async () => {
  await withDoor([{ id: 'paper-2026-01-02', type: 'trade-day-spend', value: { mode: 'paper', day: '2026-01-02', time_zone: 'UTC', notional: 4900 } }], async door => {
    const broker = fakeBroker([]);
    const answer = await placePaperOrders({ policy: policy(), routes: ROUTES, prices: { BREAD: 100 } }, context(door, broker));
    assert.equal(answer.placed.length, 0);
    assert.match(answer.skipped[0].reason, /max_daily_notional/);
    // 15:00 UTC is still the previous day at UTC-10, so that day's spend (none) is the one counted.
    const elsewhere = await placePaperOrders({ policy: policy({ zone: 'Pacific/Honolulu', version: 'v3' }), routes: ROUTES, prices: { BREAD: 100 } }, context(door, fakeBroker([accepted()])));
    assert.equal(elsewhere.day.day, '2026-01-02');
    const night = await placePaperOrders({ policy: policy({ zone: 'Pacific/Honolulu', version: 'v4' }), routes: ROUTES, prices: { BREAD: 100 } }, context(door, fakeBroker([accepted()]), { now: () => Date.parse('2026-01-02T05:00:00Z') }));
    assert.equal(night.day.day, '2026-01-01');
  });
});

test('a 4xx answer is a refusal that gives the day\'s spend back; no answer is unknown and is never sent again', async () => {
  await withDoor([], async (door, fake) => {
    const refused = await placePaperOrders({ policy: policy(), routes: ROUTES, prices: { BREAD: 100 } }, context(door, fakeBroker([{ status: 422, body: { message: 'insufficient buying power' } }])));
    assert.equal(refused.placed[0].status, 'refused');
    assert.equal(refused.day.used, 0);
    assert.equal(keptOf(fake, 'trade-day-spend')[0].value.notional, 0);
    assert.deepEqual(keptOf(fake, 'trade-order-event')[0].value.answer, { message: 'insufficient buying power' });
    const lost = await placePaperOrders({ policy: policy({ version: 'v2' }), routes: ROUTES, prices: { BREAD: 100 } }, context(door, fakeBroker([new TypeError('fetch failed')])));
    assert.equal(lost.placed[0].status, 'unknown');
    assert.equal(lost.day.used, 200, 'an unknown order keeps its spend');
    const broker = fakeBroker([]);
    const again = await placePaperOrders({ policy: policy({ version: 'v2' }), routes: ROUTES, prices: { BREAD: 100 } }, context(door, broker));
    assert.equal(broker.seen.length, 0);
    assert.match(again.skipped[0].reason, /idempotent/);
    const busy = await placePaperOrders({ policy: policy({ version: 'v3' }), routes: ROUTES, prices: { BREAD: 100 } }, context(door, fakeBroker([{ status: 503, body: 'busy' }])));
    assert.equal(busy.placed[0].status, 'unknown');
  });
});

test('a paper run never sends a live order, and a live run reaches only live records with live routes', async () => {
  await withDoor([], async () => {
    const liveFake = await startFakeDoor({ rights: rowOf(rows, 'tool:place-live-orders-from-a-trading-policy').invoke.records.rights });
    try {
      const door = openRecordsDoor({ descriptor: liveFake.descriptor });
      const broker = fakeBroker([accepted('L-1')]);
      const mixed = policy({ orders: [order({ live: true, route_ref: 'live-route' }), order({ qty: 1 })] });
      const answer = await placeLiveOrders({ policy: mixed, routes: ROUTES, prices: { BREAD: 100 } }, context(door, broker));
      assert.equal(answer.placed.length, 1);
      assert.match(answer.skipped[0].reason, /order says live: false, and this run places live orders/);
      assert.equal(broker.seen[0].url, 'https://live.broker.example/v1/orders');
      assert.ok([...liveFake.kept.keys()].every(id => id.startsWith('live-')));
      const paperBroker = fakeBroker([]);
      await assert.rejects(placePaperOrders({ policy: policy(), routes: ROUTES, prices: { BREAD: 100 } }, context(door, paperBroker)), /may not reach those records/,
        'a paper run handed the live row\'s door reaches no record');
      assert.equal(paperBroker.seen.length, 0);
    } finally { await liveFake.close(); }
  });
  await withDoor([], async door => {
    const broker = fakeBroker([]);
    const paper = await placePaperOrders({ policy: policy({ orders: [order({ live: true, route_ref: 'live-route' }), order({ route_ref: 'live-route' })] }), routes: ROUTES, prices: { BREAD: 100 } }, context(door, broker));
    assert.equal(broker.seen.length, 0);
    assert.equal(paper.placed.length, 0);
    assert.match(paper.skipped[0].reason, /order says live: true, and this run places paper orders/);
    assert.match(paper.skipped[1].reason, /route live-route is a live route/);
  });
});

test('a route that cannot build an order skips it before anything is kept or sent; a held value of the wrong shape refuses', async () => {
  await withDoor([], async (door, fake) => {
    const route = { ...PAPER_ROUTE, instrument_requests: { equity: { url: 'https://broker.example/v1/orders', body_template: { account: '{account_id}' } } } };
    const broker = fakeBroker([]);
    const answer = await placePaperOrders({ policy: policy(), routes: { 'paper-route': route }, prices: { BREAD: 100 } }, context(door, broker));
    assert.match(answer.skipped[0].reason, /cannot build this order: template hole \{account_id\}/);
    assert.equal(broker.seen.length, 0);
    assert.equal(keptOf(fake, 'trade-order').length, 0);
    await assert.rejects(placePaperOrders({ policy: policy({ version: 'v9' }), routes: ROUTES, prices: { BREAD: 100 } }, context(door, broker, { held: 'not an object' })),
      /The held value paper-broker-credentials must be a JSON object of named fields/);
    assert.equal(broker.seen.length, 0);
    assert.equal(keptOf(fake, 'trade-order').length, 0);
  });
});

test('checking reads the broker\'s real fill into open orders, leaves closed ones, and marks a never-placed order not-placed', async () => {
  await withDoor([], async (door, fake) => {
    await placePaperOrders({ policy: policy({ orders: [order(), order({ qty: 1 })] }), routes: ROUTES, prices: { BREAD: 100 } }, context(door, fakeBroker([accepted('b-1'), new TypeError('fetch failed')])));
    const [unknownOrder, submitted] = keptOf(fake, 'trade-order').map(record => record.value).sort((a, b) => a.qty - b.qty);
    assert.deepEqual([unknownOrder.status, submitted.status], ['unknown', 'submitted']);
    const broker = fakeBroker([
      url => (url.endsWith(submitted.order_id) ? { status: 200, body: { id: 'b-1', status: 'filled', filled_qty: '2', filled_avg_price: '99.5', filled_at: '2026-01-02T15:01:00Z' } } : { status: 404, body: { message: 'not found' } }),
      url => (url.endsWith(submitted.order_id) ? { status: 200, body: { id: 'b-1', status: 'filled', filled_qty: '2', filled_avg_price: '99.5', filled_at: '2026-01-02T15:01:00Z' } } : { status: 404, body: { message: 'not found' } }),
    ]);
    const answer = await checkPaperOrders({ routes: ROUTES }, context(door, broker, { now: () => NOW + 60000 }));
    const byId = Object.fromEntries(answer.checked.map(item => [item.order_id, item]));
    assert.deepEqual([byId[submitted.order_id].status, byId[submitted.order_id].filled_qty, byId[submitted.order_id].filled_avg_price], ['filled', 2, 99.5]);
    assert.equal(byId[unknownOrder.order_id].status, 'not-placed');
    assert.equal(fake.kept.get('paper-2026-01-02').value.notional, 200, 'the never-placed order\'s spend is given back');
    assert.equal(keptOf(fake, 'trade-order-event').filter(event => event.id.includes('-checked-')).length, 2);
    const quiet = fakeBroker([]);
    const next = await checkPaperOrders({ routes: ROUTES }, context(door, quiet));
    assert.equal(quiet.seen.length, 0, 'filled and not-placed orders are not asked about again');
    assert.equal(next.checked.length, 0);
    const named = await checkPaperOrders({ routes: ROUTES, order_ids: [submitted.order_id] }, context(door, fakeBroker([accepted('b-1', { status: 'filled', filled_qty: '2', filled_avg_price: '99.5' })])));
    assert.equal(named.checked.length, 1, 'an order named by id is checked whatever its status');
  });
});

test('an open order whose route was not given cannot be checked and says so', async () => {
  await withDoor([], async door => {
    await placePaperOrders({ policy: policy(), routes: ROUTES, prices: { BREAD: 100 } }, context(door, fakeBroker([new TypeError('fetch failed')])));
    const answer = await checkPaperOrders({ routes: { other: PAPER_ROUTE } }, context(door, fakeBroker([])));
    assert.match(answer.could_not_check[0].reason, /no paper route paper-route was given/);
  });
});

test('a lookup reads the listed items through the route, and refuses a route of the other mode', async () => {
  const broker = fakeBroker([{ status: 200, body: { contracts: [{ symbol: 'C1', tradable: true, open_interest: '5' }, { symbol: 'C2', tradable: false }], next_page: null } }, { status: 500, body: '' }]);
  const read = await lookUpPaperInstruments({ route: PAPER_ROUTE, lookup: 'contracts', query: { underlying: 'BREAD' } }, { held: HELD, fetchImpl: broker.fetchImpl, now: () => NOW });
  assert.deepEqual([read.state, read.count, read.items[0].symbol, read.next], ['live', 1, 'C1', null]);
  assert.match(broker.seen[0].url, /underlying=BREAD/);
  const failed = await lookUpPaperInstruments({ route: PAPER_ROUTE, lookup: 'contracts' }, { held: HELD, fetchImpl: broker.fetchImpl, now: () => NOW });
  assert.deepEqual([failed.state, failed.http_status, failed.count], ['error', 500, 0]);
  await assert.rejects(lookUpLiveInstruments({ route: PAPER_ROUTE, lookup: 'contracts' }, { held: HELD }), /paper route, and this tool reads the live broker account/);
  await assert.rejects(lookUpPaperInstruments({ lookup: 'contracts' }, { held: HELD }), /No broker route was given/);
});

test('the place row runs through its export and refuses an empty request with the words for what to give', async () => {
  const answer = await runRow(placeRow, {});
  assert.equal(answer.status, 1);
  assert.match(answer.error, /No trading policy was given/);
});

test('each row holds only its own mode\'s credentials and reaches only its own mode\'s records, through an export that exists', async () => {
  const exports = await import('../read-data/trading.mjs');
  for (const { payload } of rows.records) {
    const mode = payload.id.includes('-live-') ? 'live' : 'paper';
    assert.deepEqual(payload.invoke.credential_mounts, [{ secret_name: `${mode}-broker-credentials`, fd: 4 }], payload.id);
    for (const right of payload.invoke.records?.rights ?? []) assert.equal(right.prefix, `${mode}-`, payload.id);
    assert.equal(typeof exports[payload.invoke.argv.at(-1)], 'function', payload.id);
    assert.equal(payload.maker, 'maker:trading');
  }
});
