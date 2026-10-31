// The order checker: the old package's three cases (a live order needs no permission lease, the policy's limits
// still refuse an oversized order, an unknown route fails closed) and every other skip, with synthetic orders.
import test from 'node:test';
import assert from 'node:assert/strict';
import { contentKey, decide } from '../read-data/decide-orders.mjs';
import { LIVE_ROUTE, PAPER_ROUTE, order, policy } from './fixtures.mjs';

const ROUTES = { 'paper-route': PAPER_ROUTE, 'live-route': LIVE_ROUTE };
const run = (given, more = {}) => decide({ mode: 'paper', policy: given, routes: ROUTES, prices: { BREAD: 100 }, ...more });
const liveOrder = order({ live: true, route_ref: 'live-route' });

test('a live order in a live run is accepted with live true, and no permission lease is asked for', () => {
  const result = decide({ mode: 'live', policy: policy({ orders: [liveOrder] }), routes: ROUTES, prices: { BREAD: 100 } });
  assert.equal(result.orders.length, 1);
  assert.equal(result.orders[0].live, true);
  assert.equal(result.orders[0].mode, 'live');
  assert.ok(!('lease_check' in result));
});

test('the policy\'s own max_order_notional refuses an oversized order, which is skipped and never made smaller', () => {
  const result = run(policy({ orders: [order({ qty: 11 })], maxOrder: 1000 }));
  assert.deepEqual(result.orders, []);
  assert.match(result.skipped[0].reason, /policy max_order_notional/);
});

test('an order whose route was not given fails closed', () => {
  const result = decide({ mode: 'paper', policy: policy(), routes: {}, prices: { BREAD: 100 } });
  assert.deepEqual(result.orders, []);
  assert.match(result.skipped[0].reason, /no route config/);
});

test('the content key is the BLAKE3 identity the old package gave the same order', () => {
  const sample = { instrument: { symbol: 'BREAD', kind: 'equity' }, side: 'buy', qty: 2, order_type: 'limit', limit_price: 12.5, time_in_force: 'day', live: false, route_ref: 'example-paper' };
  assert.equal(contentKey(sample), '8f521895989c55c8');
  assert.equal(contentKey({ ...sample, instrument: { symbol: 'CRÈME', kind: 'equity' } }), '7cf72157c80e2537');
});

test('an accepted order keeps every decision field and gains its id, key, notional and reference price', () => {
  const [placed] = run(policy({ orders: [order({ order_type: 'limit', limit_price: 90 })] })).orders;
  assert.equal(placed.order_id, `paper-v1-${contentKey(order({ order_type: 'limit', limit_price: 90 }))}`);
  assert.equal(placed.idempotency_key, `v1::${contentKey(order({ order_type: 'limit', limit_price: 90 }))}`);
  assert.equal(placed.notional, 180);
  assert.equal(placed.reference_price, 100);
  assert.equal(placed.qty, 2);
  assert.equal(placed.time_in_force, 'day');
  assert.equal(placed.decided_at, '2026-01-01T09:00:00Z');
});

test('the same order twice in one policy version is sent once, and an order already sent is skipped', () => {
  const twice = run(policy({ orders: [order(), order()] }));
  assert.equal(twice.orders.length, 1);
  assert.match(twice.skipped[0].reason, /idempotent/);
  const again = run(policy(), { existing: [twice.orders[0].idempotency_key] });
  assert.deepEqual(again.orders, []);
});

test('the daily limit counts the day\'s earlier spend and the orders accepted earlier in the same run', () => {
  const result = run(policy({ orders: [order(), order({ qty: 3 }), order({ qty: 1 })], maxDaily: 600 }), { dayUsed: 100 });
  assert.deepEqual(result.orders.map(item => item.qty), [2, 3]);
  assert.match(result.skipped[0].reason, /max_daily_notional/);
});

test('paper and live never mix: the order must say the run\'s mode and its route must be of that mode', () => {
  assert.match(run(policy({ orders: [order({ live: true })] })).skipped[0].reason, /this run places paper orders/);
  assert.match(run(policy({ orders: [order({ route_ref: 'live-route' })] })).skipped[0].reason, /is a live route/);
  assert.match(run(policy({ orders: [order({ live: undefined })] })).skipped[0].reason, /live: true or false/);
  assert.match(run(policy({ orders: [order({ live: 'false' })] })).skipped[0].reason, /live: true or false/);
});

test('every malformed order is skipped with its reason', () => {
  const cases = [
    [{ instrument: {} }, /no instrument/],
    [{ side: '' }, /side missing/],
    [{ qty: 0 }, /positive number/],
    [{ qty: 'two' }, /positive number/],
    [{ order_type: null }, /order_type missing/],
    [{ order_type: 'limit' }, /positive limit_price/],
    [{ route_ref: '' }, /route_ref/],
  ];
  for (const [changes, reason] of cases) assert.match(run(policy({ orders: [order(changes)] })).skipped[0].reason, reason, JSON.stringify(changes));
});

test('a market order with no price for its symbol cannot be checked against the limits and is skipped', () => {
  assert.match(run(policy(), { prices: {} }).skipped[0].reason, /without a price/);
  assert.match(run(policy(), { prices: { BREAD: 0 } }).skipped[0].reason, /without a price/);
});

test('a contract multiplier counts in the notional', () => {
  const contract = order({ instrument: { kind: 'option', symbol: 'BREAD-C-10', contract_multiplier: 100 }, order_type: 'limit', limit_price: 1.5 });
  assert.equal(run(policy({ orders: [contract] })).orders[0].notional, 300);
});
