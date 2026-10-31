// From an order to a broker request and from a broker answer to the order's real state. Carries the old package's
// assembler cases (JSON by default, form bodies by data, a content type the route pins is kept, no body, a payment-
// shaped venue, an address with a hole, an address with none), its four assemble-send-read pipeline cases, its
// options-discovery checks as a route lookup, and the header merge rules; every route and answer is synthetic.
import test from 'node:test';
import assert from 'node:assert/strict';
import { encodeBody, lookupRequest, mergeHeaders, orderRequest, readLookupAnswer, readOrderAnswer, resolveTemplate, statusRequest, withCredentials } from '../read-data/broker-requests.mjs';
import { HELD, PAPER_ROUTE } from './fixtures.mjs';

const bodyText = request => request.body;
const signed = (request, route, held = HELD) => withCredentials(request, route, held, { heldName: 'paper-broker-credentials', now: 1767225600000 });

test('JSON is the default body, in the route template\'s key order, with its content type', () => {
  const order = { order_id: 'o1', instrument: { kind: 'equity', symbol: 'BREAD' }, qty: '16', side: 'buy', type: 'market', time_in_force: 'day' };
  const route = { instrument_requests: { equity: { url: 'https://broker.example/v1/orders', method: 'POST', body_template: { symbol: '{instrument.symbol}', qty: '{qty}', side: '{side}', type: '{type}', time_in_force: '{time_in_force}' } } } };
  const request = orderRequest(order, route);
  assert.equal(request.headers['content-type'], 'application/json');
  assert.equal(bodyText(request), '{"symbol":"BREAD","qty":"16","side":"buy","type":"market","time_in_force":"day"}');
});

const PAYMENT_ROUTE = {
  body_encoding: 'form',
  instrument_requests: { payment: { url: 'https://pay.example/v1/charges', method: 'POST', body_template: { amount: '{amount}', currency: '{currency}', token: '{token}', confirm: true, methods: { enabled: 'true', redirects: 'never' } } } },
  credential_injections: [{ field: 'restricted_key', placement: { kind: 'header', name: 'Authorization', prefix: 'Bearer ' } }],
  response_map: { broker_order_id: 'id', broker_status: 'status' },
  status_map: { succeeded: 'succeeded', requires_action: 'requires_action', processing: 'processing', requires_payment_method: 'rejected', canceled: 'canceled', __default__: 'rejected' },
};
const PAYMENT = { order_id: 'charge-001', instrument: { kind: 'payment' }, amount: '2700', currency: 'usd', token: 'tok_test_abc123' };

test('a form body is bracket pairs, chosen by the route\'s body_encoding, never by code for one venue', () => {
  const request = orderRequest(PAYMENT, PAYMENT_ROUTE);
  assert.equal(request.headers['content-type'], 'application/x-www-form-urlencoded');
  assert.equal(bodyText(request), 'amount=2700&currency=usd&token=tok_test_abc123&confirm=true&methods%5Benabled%5D=true&methods%5Bredirects%5D=never');
  assert.equal(encodeBody({ a: { b: [1, null, 'x y'] } }, 'form').text, 'a%5Bb%5D%5B0%5D=1&a%5Bb%5D%5B2%5D=x+y');
});

test('a content type the route pins is kept', () => {
  const route = { body_encoding: 'form', instrument_requests: { default: { url: 'https://pay.example/v1/charges', headers: { 'content-type': 'application/x-custom' }, body_template: { amount: '{amount}' } } } };
  assert.equal(orderRequest(PAYMENT, route).headers['content-type'], 'application/x-custom');
});

test('no body template sends no body and adds no content type', () => {
  const request = orderRequest({ order_id: 'x', instrument: { kind: 'equity' } }, { instrument_requests: { equity: { url: 'https://broker.example/u', method: 'GET' } } });
  assert.equal(request.body, null);
  assert.ok(!('content-type' in request.headers));
});

test('a payment-shaped route is the same assembler: form body, held key as a Bearer header, never in what is kept', () => {
  const { send, shown } = signed(orderRequest(PAYMENT, PAYMENT_ROUTE), PAYMENT_ROUTE, { restricted_key: 'rk_test_0001' });
  assert.equal(send.url, 'https://pay.example/v1/charges');
  assert.equal(send.headers.Authorization, 'Bearer rk_test_0001');
  assert.ok(!JSON.stringify(shown).includes('rk_test_0001'));
  assert.deepEqual(shown.header_names, ['Authorization', 'accept', 'content-type']);
});

test('an address hole is read from the order and escaped for an address; an address with no hole is unchanged', () => {
  const route = { instrument_requests: { default: { url: 'https://pay.example/v1/charges/{session_id}', method: 'GET' } } };
  assert.equal(orderRequest({ session_id: 'ch_<1>@a/b' }, route).url, 'https://pay.example/v1/charges/ch_%3C1%3E%40a/b');
  assert.equal(orderRequest({}, { instrument_requests: { default: { url: 'https://pay.example/v1/charges' } } }).url, 'https://pay.example/v1/charges');
});

const answer = (body, status = 200) => ({ status_code: status, body: JSON.stringify(body) });

test('pipeline: the route builds the charge, and the broker\'s answer reads back through status_map', () => {
  const request = orderRequest(PAYMENT, PAYMENT_ROUTE);
  assert.equal(request.method, 'POST');
  assert.ok(bodyText(request).startsWith('amount=2700&currency=usd'));
  const read = readOrderAnswer(answer({ id: 'ch_confirmed', status: 'succeeded', amount: 2700 }), PAYMENT_ROUTE);
  assert.equal(read.broker_order_id, 'ch_confirmed');
  assert.equal(read.broker_status, 'succeeded');
  assert.equal(read.status, 'succeeded');
  assert.equal(read.http_status, 200);
});

test('pipeline: requires_action maps through, an unmapped status falls to __default__, a declined method is rejected', () => {
  assert.equal(readOrderAnswer(answer({ id: 'a', status: 'requires_action' }), PAYMENT_ROUTE).status, 'requires_action');
  assert.equal(readOrderAnswer(answer({ id: 'b', status: 'something_new' }), PAYMENT_ROUTE).status, 'rejected');
  assert.equal(readOrderAnswer(answer({ id: 'c', status: 'requires_payment_method' }), PAYMENT_ROUTE).status, 'rejected');
});

test('fills are only the broker\'s: a queued order reads 0 filled, an unmapped status with a fill reads filled', () => {
  const queued = readOrderAnswer(answer({ id: 'b1', status: 'accepted', filled_qty: '0', filled_avg_price: null }), PAPER_ROUTE);
  assert.deepEqual([queued.status, queued.filled_qty, queued.filled_avg_price], ['submitted', 0, null]);
  const route = { ...PAPER_ROUTE, status_map: {} };
  const filled = readOrderAnswer(answer({ id: 'b2', status: 'done', filled_qty: '2', filled_avg_price: '99.5', filled_at: '2026-01-01T15:00:00Z', client_order_id: 'c-1' }), route);
  assert.deepEqual([filled.status, filled.filled_qty, filled.filled_avg_price, filled.filled_at, filled.client_order_id], ['filled', 2, 99.5, '2026-01-01T15:00:00Z', 'c-1']);
  assert.equal(readOrderAnswer({ status_code: 200, body: 'not json' }, PAPER_ROUTE).status, 'submitted');
});

test('a string hole that does not resolve refuses the request; optional and otherwise leaves say what absence means', () => {
  assert.throws(() => resolveTemplate({ id: '{missing}' }, {}), /did not resolve, and a string hole is always required/);
  assert.throws(() => resolveTemplate({ id: { from: 'missing' } }, {}), /neither optional nor given a fallback/);
  assert.deepEqual(resolveTemplate({ a: { from: 'x', optional: true }, b: { from: 'x', otherwise: { const: 'd' } }, c: '{n}', d: 'n={n}' }, { n: 3 }), { b: 'd', c: 3, d: 'n=3' });
  assert.deepEqual(resolveTemplate(['{n}', { from: 'x', optional: true }], { n: 1 }), [1]);
});

test('credentials go where the route says, by field name; the kept copy has the address before them', () => {
  const route = { ...PAPER_ROUTE, credential_injections: [{ field: 'key_id', placement: { kind: 'query', name: 'key' } }, { field: 'secret', placement: { kind: 'header', name: 'X-Example-Secret' } }] };
  const { send, shown } = signed(statusRequest({ order_id: 'paper-v1-a' }, route), route);
  assert.equal(send.url, 'https://broker.example/v1/orders/by-client-id/paper-v1-a?key=held-key-id-0001');
  assert.equal(send.headers['X-Example-Secret'], 'held-secret-0001');
  assert.equal(shown.url, 'https://broker.example/v1/orders/by-client-id/paper-v1-a');
  assert.ok(!JSON.stringify(shown).includes('held-'));
  assert.throws(() => signed(statusRequest({ order_id: 'x' }, route), route, { key_id: 'k' }), /field "secret" of the held value paper-broker-credentials, and it has no such field/);
});

test('an hmac-sha256 signed header is the RFC 4231 value, and its companion headers carry the signed time', () => {
  const route = {
    signed_headers: [{ header: 'X-Sig', scheme: 'hmac-sha256', key_field: 'hmac_key', message: 'what do ya want for nothing?' }],
    credential_injections: [],
  };
  const { send } = signed({ url: 'https://broker.example/v1/orders', method: 'POST', headers: {}, body: null, facts: {} }, route, { hmac_key: 'Jefe' });
  assert.equal(send.headers['X-Sig'], '5bdcc146bf60754e6a042426089575c75a003f089d2739839dec58b964ec3843');
  const timed = { signed_headers: [{ header: 'X-Sig', scheme: 'hmac-sha256', key_field: 'hmac_key', key_encoding: 'base64', output_encoding: 'base64url', message: '{now.seconds}{request.method}{request.path}{request.body}', with_headers: { 'X-Time': '{now.seconds}' } }] };
  const second = signed({ url: 'https://broker.example/v1/orders?x=1', method: 'POST', headers: {}, body: '{"a":1}', facts: {} }, timed, { hmac_key: Buffer.from('k').toString('base64') });
  assert.equal(second.send.headers['X-Time'], '1767225600');
  assert.equal(second.send.headers['X-Sig'].length, 43);
  assert.throws(() => signed({ url: 'https://broker.example/', method: 'GET', headers: {}, body: null, facts: {} }, { signed_headers: [{ header: 'X', scheme: 'secp256k1', key_field: 'hmac_key', message: 'm' }] }, { hmac_key: 'k' }), /signs hmac-sha256 only/);
});

test('header merge: no computed entries leaves the base, computed wins on a clash, empty values are never set', () => {
  const base = { 'content-type': 'application/json', 'X-Sig': 'old' };
  assert.deepEqual(mergeHeaders(base, []), base);
  assert.deepEqual(mergeHeaders(base, null), base);
  assert.deepEqual(mergeHeaders(base, [{ header_name: 'X-Sig', signature: 'new', with_headers: { 'X-Time': '1700', 'X-Empty': '' } }, { header_name: 'X-None', signature: null }, 'junk']),
    { 'content-type': 'application/json', 'X-Sig': 'new', 'X-Time': '1700' });
});

test('a lookup builds its address from the route: the caller\'s query on the defaults, credentials by field', () => {
  const { send } = signed(lookupRequest(PAPER_ROUTE, 'contracts', { underlying: 'BREAD', type: 'call', expires_after: '2026-07-10', expires_before: '2026-07-31', strike_above: '200', strike_below: '220' }), PAPER_ROUTE);
  const address = new URL(send.url);
  assert.equal(address.pathname, '/v1/contracts');
  assert.equal(address.searchParams.get('underlying'), 'BREAD');
  assert.equal(address.searchParams.get('type'), 'call');
  assert.equal(address.searchParams.get('status'), 'active');
  assert.equal(address.searchParams.get('limit'), '100');
  assert.equal(address.searchParams.get('expires_after'), '2026-07-10');
  assert.equal(address.searchParams.get('strike_below'), '220');
  assert.equal(send.method, 'GET');
  assert.deepEqual([send.headers['X-Example-Key'], send.headers['X-Example-Secret']], ['held-key-id-0001', 'held-secret-0001']);
  const given = new URL(lookupRequest(PAPER_ROUTE, 'contracts', { underlying: 'BREAD', status: 'inactive' }).url);
  assert.equal(given.searchParams.get('status'), 'inactive');
  assert.throws(() => lookupRequest(PAPER_ROUTE, 'contracts', { password: 'x' }), /takes the query names/);
  assert.throws(() => lookupRequest(PAPER_ROUTE, 'quotes', {}), /no lookup named quotes; its lookups are contracts/);
});

const CHAIN = {
  contracts: [
    { symbol: 'BREAD260717C00210000', tradable: true, strike: '210', expires: '2026-07-17', type: 'call', close_price: '9.0', open_interest: '1500', size: '100', underlying: 'BREAD' },
    { symbol: 'BREAD260717C00215000', tradable: true, strike: '215', expires: '2026-07-17', type: 'call', close_price: '6.5', open_interest: '5000', size: '100', underlying: 'BREAD' },
    { symbol: 'BREAD260717C00220000', tradable: false, strike: '220', expires: '2026-07-17', type: 'call', close_price: '4.0', open_interest: '10', size: '100', underlying: 'BREAD' },
    { tradable: true, strike: '225' },
  ],
  next_page: 'tok123',
};

test('a lookup that says one_item reads an account answer as one item, with numbers and kept fields', () => {
  const lookup = { url: 'https://broker.example/v1/account', one_item: true, keep_fields: ['status', 'equity', 'buying_power'], numbers: ['equity', 'buying_power'] };
  const read = readLookupAnswer(answer({ status: 'ACTIVE', equity: '10250.5', buying_power: '20000', account_number: 'hidden' }), lookup);
  assert.deepEqual(read.items, [{ status: 'ACTIVE', equity: 10250.5, buying_power: 20000 }]);
  assert.equal(read.count, 1);
  assert.equal(readLookupAnswer({ status_code: 200, body: '' }, lookup).count, 0, 'an empty answer is no item');
  assert.equal(readLookupAnswer(answer([{ symbol: 'a' }, { symbol: 'b' }]), { ...lookup, keep_fields: undefined }).count, 2, 'a list answer is still a list');
});

test('a lookup answer keeps only tradable items with an id, reads numbers, sorts by open interest and names the next page', () => {
  const read = readLookupAnswer(answer(CHAIN), PAPER_ROUTE.lookups.contracts);
  assert.equal(read.count, 2);
  assert.ok(read.items.every(item => item.symbol !== 'BREAD260717C00220000'));
  assert.equal(read.items[0].symbol, 'BREAD260717C00215000');
  assert.equal(read.items[0].strike, 215);
  assert.equal(read.items[0].close_price, 6.5);
  assert.equal(read.items[0].open_interest, 5000);
  assert.equal(read.next, 'tok123');
  assert.deepEqual(Object.keys(read.items[0]), PAPER_ROUTE.lookups.contracts.keep_fields);
  assert.equal(readLookupAnswer(answer(CHAIN.contracts), PAPER_ROUTE.lookups.contracts).count, 2, 'a bare list answer is read too');
  assert.equal(readLookupAnswer({ status_code: 200, body: '' }, PAPER_ROUTE.lookups.contracts).count, 0);
  const missingLast = readLookupAnswer(answer({ contracts: [{ symbol: 'a', tradable: true }, { symbol: 'b', tradable: true, open_interest: '3' }] }), PAPER_ROUTE.lookups.contracts);
  assert.deepEqual(missingLast.items.map(item => item.symbol), ['b', 'a']);
});
