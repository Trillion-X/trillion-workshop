// The trading runs in process with a fake broker and NO records door: earlier state comes in the request as `records`,
// and what a run would have written comes back in its answer as `records` (what the person's AI keeps).
import test from 'node:test';
import assert from 'node:assert/strict';
import { answerOf, rowOf } from '../../../test-helpers/run-a-row.mjs';
import rows from '../tool-rows.json' with { type: 'json' };
import { checkPaperOrders, lookUpLiveInstruments, lookUpPaperInstruments, placeLiveOrders, placePaperOrders } from '../read-data/trading.mjs';
import { HELD, LIVE_ROUTE, PAPER_ROUTE, fakeBroker, order, policy } from './fixtures.mjs';

const ROUTES = { 'paper-route': PAPER_ROUTE, 'live-route': LIVE_ROUTE };
const NOW = Date.parse('2026-01-02T15:00:00Z');
const placeRow = rowOf(rows, 'tool:place-paper-orders-from-a-trading-policy');

const context = (broker, more = {}) => ({ held: HELD, fetchImpl: broker.fetchImpl, now: () => NOW, ...more });
const accepted = (id = 'b-1', extra = {}) => ({ status: 200, body: { id, status: 'accepted', filled_qty: '0', filled_avg_price: null, ...extra } });
const kind = (answer, type) => answer.records.filter(record => record.type === type);
/** The store the person's AI keeps: each answer's records replace those of the same id. */
function keeper() {
  const kept = new Map();
  return { kept, keep: answer => { for (const record of answer.records) kept.set(record.id, record); return answer; }, state: () => [...kept.values()] };
}

test('with no policy nothing is sent, and the refusal says what to give', async () => {
  const broker = fakeBroker([]);
  await assert.rejects(placePaperOrders({ routes: ROUTES }, context(broker)), /No trading policy was given, so no order was placed\. Give policy: \{ policy_version.*live: false/);
  await assert.rejects(placePaperOrders({ policy: policy() }, context(broker)), /No broker routes were given/);
  const noLimits = policy();
  delete noLimits.risk.max_daily_notional;
  await assert.rejects(placePaperOrders({ policy: noLimits, routes: ROUTES }, context(broker)), /max_daily_notional must be a number/);
  await assert.rejects(placePaperOrders({ policy: policy({ zone: 'Mars/Olympus' }), routes: ROUTES }, context(broker)), /day_time_zone/);
  await assert.rejects(placePaperOrders({ policy: policy({ version: 'a/b' }), routes: ROUTES }, context(broker)), /policy_version/);
  const badSymbols = policy();
  badSymbols.risk.allowed_symbols = 'BREAD';
  await assert.rejects(placePaperOrders({ policy: badSymbols, routes: ROUTES }, context(broker)), /allowed_symbols, when given, must be a list/);
  await assert.rejects(placePaperOrders({ policy: policy(), routes: ROUTES, prices: { BREAD: 100 }, records: 'nope' }, context(broker)), /records must be a list of \{ id, type, value \}/);
  assert.equal(broker.seen.length, 0);
});

test('a paper order is sent with the held fields and the answer holds the records to keep: the order with the broker\'s answer, its trail and the day\'s spend', async () => {
  const broker = fakeBroker([(url, init) => accepted('b-1', { client_order_id: JSON.parse(init.body).client_order_id })]);
  const answer = await placePaperOrders({ policy: policy(), routes: ROUTES, prices: { BREAD: 100 } }, context(broker));
  assert.equal(answer.placed.length, 1);
  assert.equal(answer.placed[0].status, 'submitted');
  assert.equal(answer.placed[0].broker_order_id, 'b-1');
  assert.deepEqual(answer.day, { day: '2026-01-02', used: 200, limit: 5000 });
  const [sent] = broker.seen;
  assert.equal(sent.url, 'https://broker.example/v1/orders');
  assert.equal(sent.headers['X-Example-Key'], 'held-key-id-0001');
  assert.deepEqual(JSON.parse(sent.body), { symbol: 'BREAD', qty: 2, side: 'buy', type: 'market', time_in_force: 'day', client_order_id: answer.placed[0].order_id });
  const [record] = kind(answer, 'trade-order');
  assert.ok(record.id.startsWith('paper-v1-'));
  assert.deepEqual([record.value.status, record.value.broker_order_id, record.value.filled_qty, record.value.live, record.value.mode], ['submitted', 'b-1', 0, false, 'paper']);
  const [event] = kind(answer, 'trade-order-event');
  assert.equal(event.id, `${record.id}-sent`);
  assert.equal(event.value.http_status, 200);
  assert.deepEqual(event.value.request.header_names, ['X-Example-Key', 'X-Example-Secret', 'accept', 'content-type']);
  assert.deepEqual(kind(answer, 'trade-day-spend'), [{ id: 'paper-2026-01-02', type: 'trade-day-spend', value: { mode: 'paper', day: '2026-01-02', time_zone: 'UTC', notional: 200 } }]);
  assert.ok(!JSON.stringify(answer).includes(HELD.key_id) && !JSON.stringify(answer).includes(HELD.secret), 'no held value is answered');
});

test('records handed back make the same policy send nothing; a new policy version is a new decision set', async () => {
  const store = keeper();
  const broker = fakeBroker([accepted('b-1'), accepted('b-2')]);
  store.keep(await placePaperOrders({ policy: policy(), routes: ROUTES, prices: { BREAD: 100 } }, context(broker)));
  const again = await placePaperOrders({ policy: policy(), routes: ROUTES, prices: { BREAD: 100 }, records: store.state() }, context(broker));
  assert.equal(again.placed.length, 0);
  assert.match(again.skipped[0].reason, /idempotent/);
  assert.deepEqual(again.records, []);
  const next = await placePaperOrders({ policy: policy({ version: 'v2' }), routes: ROUTES, prices: { BREAD: 100 }, records: store.state() }, context(broker));
  assert.equal(next.placed.length, 1);
  assert.equal(broker.seen.length, 2);
  assert.equal(next.day.used, 400, 'the day\'s spend carries across runs through the records handed in');
});

test('the daily limit holds across runs on the same day in the policy\'s time zone', async () => {
  const records = [{ id: 'paper-2026-01-02', type: 'trade-day-spend', value: { mode: 'paper', day: '2026-01-02', time_zone: 'UTC', notional: 4900 } }];
  const answer = await placePaperOrders({ policy: policy(), routes: ROUTES, prices: { BREAD: 100 }, records }, context(fakeBroker([])));
  assert.equal(answer.placed.length, 0);
  assert.match(answer.skipped[0].reason, /max_daily_notional/);
  // 15:00 UTC is still the previous day at UTC-10, so that day's spend (none) is the one counted.
  const elsewhere = await placePaperOrders({ policy: policy({ zone: 'Pacific/Honolulu', version: 'v3' }), routes: ROUTES, prices: { BREAD: 100 }, records }, context(fakeBroker([accepted()])));
  assert.equal(elsewhere.day.day, '2026-01-02');
  const night = await placePaperOrders({ policy: policy({ zone: 'Pacific/Honolulu', version: 'v4' }), routes: ROUTES, prices: { BREAD: 100 }, records }, context(fakeBroker([accepted()]), { now: () => Date.parse('2026-01-02T05:00:00Z') }));
  assert.equal(night.day.day, '2026-01-01');
});

test('a 4xx answer is a refusal that gives the day\'s spend back; no answer is unknown and is never sent again once its record is handed back', async () => {
  const store = keeper();
  const refused = store.keep(await placePaperOrders({ policy: policy(), routes: ROUTES, prices: { BREAD: 100 } }, context(fakeBroker([{ status: 422, body: { message: 'insufficient buying power' } }]))));
  assert.equal(refused.placed[0].status, 'refused');
  assert.equal(refused.day.used, 0);
  assert.equal(kind(refused, 'trade-day-spend')[0].value.notional, 0);
  assert.deepEqual(kind(refused, 'trade-order-event')[0].value.answer, { message: 'insufficient buying power' });
  const lost = store.keep(await placePaperOrders({ policy: policy({ version: 'v2' }), routes: ROUTES, prices: { BREAD: 100 }, records: store.state() }, context(fakeBroker([new TypeError('fetch failed')]))));
  assert.equal(lost.placed[0].status, 'unknown');
  assert.equal(lost.day.used, 200, 'an unknown order keeps its spend');
  const broker = fakeBroker([]);
  const again = await placePaperOrders({ policy: policy({ version: 'v2' }), routes: ROUTES, prices: { BREAD: 100 }, records: store.state() }, context(broker));
  assert.equal(broker.seen.length, 0);
  assert.match(again.skipped[0].reason, /idempotent/);
  const busy = await placePaperOrders({ policy: policy({ version: 'v3' }), routes: ROUTES, prices: { BREAD: 100 }, records: store.state() }, context(fakeBroker([{ status: 503, body: 'busy' }])));
  assert.equal(busy.placed[0].status, 'unknown');
});

test('a paper run never sends a live order, and a run reads only the records of its own mode', async () => {
  const broker = fakeBroker([accepted('L-1')]);
  const mixed = policy({ orders: [order({ live: true, route_ref: 'live-route' }), order({ qty: 1 })] });
  const liveSpend = { id: 'paper-2026-01-02', type: 'trade-day-spend', value: { mode: 'paper', day: '2026-01-02', time_zone: 'UTC', notional: 4900 } };
  const answer = await placeLiveOrders({ policy: mixed, routes: ROUTES, prices: { BREAD: 100 }, records: [liveSpend] }, context(broker));
  assert.equal(answer.placed.length, 1);
  assert.match(answer.skipped[0].reason, /order says live: false, and this run places live orders/);
  assert.equal(broker.seen[0].url, 'https://live.broker.example/v1/orders');
  assert.ok(answer.records.every(record => record.id.startsWith('live-')), 'a live run answers only live records and does not count the paper spend');
  const paperBroker = fakeBroker([]);
  const paper = await placePaperOrders({ policy: policy({ orders: [order({ live: true, route_ref: 'live-route' }), order({ route_ref: 'live-route' })] }), routes: ROUTES, prices: { BREAD: 100 } }, context(paperBroker));
  assert.equal(paperBroker.seen.length, 0);
  assert.equal(paper.placed.length, 0);
  assert.match(paper.skipped[0].reason, /order says live: true, and this run places paper orders/);
  assert.match(paper.skipped[1].reason, /route live-route is a live route/);
});

test('a route that cannot build an order skips it before anything is sent; a held value of the wrong shape refuses', async () => {
  const route = { ...PAPER_ROUTE, instrument_requests: { equity: { url: 'https://broker.example/v1/orders', body_template: { account: '{account_id}' } } } };
  const broker = fakeBroker([]);
  const answer = await placePaperOrders({ policy: policy(), routes: { 'paper-route': route }, prices: { BREAD: 100 } }, context(broker));
  assert.match(answer.skipped[0].reason, /cannot build this order: template hole \{account_id\}/);
  assert.equal(broker.seen.length, 0);
  assert.deepEqual(answer.records, []);
  await assert.rejects(placePaperOrders({ policy: policy({ version: 'v9' }), routes: ROUTES, prices: { BREAD: 100 } }, context(broker, { held: 'not an object' })),
    /The held value paper-broker-credentials must be a JSON object of named fields/);
  assert.equal(broker.seen.length, 0);
});

test('checking reads the broker\'s real fill into open orders, leaves closed ones, and marks a never-placed order not-placed, all in the answer\'s records', async () => {
  const store = keeper();
  store.keep(await placePaperOrders({ policy: policy({ orders: [order(), order({ qty: 1 })] }), routes: ROUTES, prices: { BREAD: 100 } }, context(fakeBroker([accepted('b-1'), new TypeError('fetch failed')]))));
  const [unknownOrder, submitted] = [...store.kept.values()].filter(record => record.type === 'trade-order').map(record => record.value).sort((a, b) => a.qty - b.qty);
  assert.deepEqual([unknownOrder.status, submitted.status], ['unknown', 'submitted']);
  const filled = { status: 200, body: { id: 'b-1', status: 'filled', filled_qty: '2', filled_avg_price: '99.5', filled_at: '2026-01-02T15:01:00Z' } };
  const broker = fakeBroker([url => (url.endsWith(submitted.order_id) ? filled : { status: 404, body: { message: 'not found' } }), url => (url.endsWith(submitted.order_id) ? filled : { status: 404, body: { message: 'not found' } })]);
  const answer = store.keep(await checkPaperOrders({ routes: ROUTES, records: store.state() }, context(broker, { now: () => NOW + 60000 })));
  const byId = Object.fromEntries(answer.checked.map(item => [item.order_id, item]));
  assert.deepEqual([byId[submitted.order_id].status, byId[submitted.order_id].filled_qty, byId[submitted.order_id].filled_avg_price], ['filled', 2, 99.5]);
  assert.equal(byId[unknownOrder.order_id].status, 'not-placed');
  assert.equal(kind(answer, 'trade-day-spend')[0].value.notional, 200, 'the never-placed order\'s spend is given back in the answer');
  assert.equal(kind(answer, 'trade-order-event').filter(event => event.id.includes('-checked-')).length, 2);
  assert.equal(kind(answer, 'trade-order').find(record => record.id === submitted.order_id).value.status, 'filled');
  const quiet = fakeBroker([]);
  const next = await checkPaperOrders({ routes: ROUTES, records: store.state() }, context(quiet));
  assert.equal(quiet.seen.length, 0, 'filled and not-placed orders are not asked about again');
  assert.equal(next.checked.length, 0);
  assert.deepEqual(next.records, []);
  const named = await checkPaperOrders({ routes: ROUTES, order_ids: [submitted.order_id], records: store.state() }, context(fakeBroker([accepted('b-1', { status: 'filled', filled_qty: '2', filled_avg_price: '99.5' })])));
  assert.equal(named.checked.length, 1, 'an order named by id is checked whatever its status');
});

test('two never-placed orders of one day give back both spends in one spend record', async () => {
  const store = keeper();
  store.keep(await placePaperOrders({ policy: policy({ orders: [order(), order({ qty: 1 })] }), routes: ROUTES, prices: { BREAD: 100 } }, context(fakeBroker([new TypeError('fetch failed'), new TypeError('fetch failed')]))));
  assert.equal(store.kept.get('paper-2026-01-02').value.notional, 300);
  const answer = await checkPaperOrders({ routes: ROUTES, records: store.state() }, context(fakeBroker([{ status: 404, body: {} }, { status: 404, body: {} }])));
  assert.equal(answer.checked.length, 2);
  assert.equal(kind(answer, 'trade-day-spend').length, 1);
  assert.equal(kind(answer, 'trade-day-spend')[0].value.notional, 0);
});

test('an open order whose route was not given cannot be checked and says so', async () => {
  const placed = await placePaperOrders({ policy: policy(), routes: ROUTES, prices: { BREAD: 100 } }, context(fakeBroker([new TypeError('fetch failed')])));
  const answer = await checkPaperOrders({ routes: { other: PAPER_ROUTE }, records: placed.records }, context(fakeBroker([])));
  assert.match(answer.could_not_check[0].reason, /no paper route paper-route was given/);
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
  const answer = await answerOf(placeRow, {});
  assert.equal(answer.status, 1);
  assert.match(answer.error, /No trading policy was given/);
});

test('each broker row holds only its own mode\'s credentials, the account read holds none; no row declares a records door; each export exists', async () => {
  const modules = { 'read-data/trading.mjs': await import('../read-data/trading.mjs'), 'read-data/account-board.ts': await import('../read-data/account-board.ts') };
  for (const { payload } of rows.records) {
    const mode = payload.id.includes('-live-') ? 'live' : 'paper';
    if (payload.id === 'tool:read-my-trading-account-board') assert.equal(payload.invoke.credential_mounts, undefined, payload.id);
    else assert.deepEqual(payload.invoke.credential_mounts, [{ secret_name: `${mode}-broker-credentials`, fd: 4 }], payload.id);
    assert.equal(payload.invoke.records, undefined, `${payload.id} declares no records door`);
    const file = payload.invoke.argv.find(arg => arg.startsWith('/opt/trading/')).replace('/opt/trading/', '');
    assert.equal(typeof modules[file][payload.invoke.argv.at(-1)], 'function', payload.id);
    assert.equal(payload.maker, 'maker:trading');
  }
});
