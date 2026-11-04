import test from 'node:test';
import assert from 'node:assert/strict';
import { forPlatformSeller, makePlatformOperator, platformOf, withPlatformFee } from '../../shared-code/src/payment-platform.mjs';

test('platform fees follow declared payment and subscription placements', () => {
  const platform = platformOf();
  const payment = { operation_id: 'operation:create-session', input_facts: { operation_subject: { mode: 'payment', line_items: [{ price_data: { unit_amount: 999 }, quantity: 1 }] } } };
  assert.equal(withPlatformFee(platform, 500)(payment).input_facts.operation_subject.payment_intent_data.application_fee_amount, 49);
  const subscription = { operation_id: 'operation:create-session', input_facts: { operation_subject: { mode: 'subscription' } } };
  assert.equal(withPlatformFee(platform, 300)(subscription).input_facts.operation_subject.subscription_data.application_fee_percent, 3);
  const own = { operation_id: 'operation:read-session', input_facts: { operation_subject: { mode: 'payment' } } };
  assert.deepEqual(withPlatformFee(platform, 500)(own), own);
});

test('seller facade fixes the seller identity and operator actions keep one account per mode', async () => {
  const platform = platformOf();
  const values = new Map();
  const requests = [];
  let accountNumber = 0;
  const operator = makePlatformOperator({
    platform,
    connections: async () => [{ connection_id: 'operator-stripe-live', vendor: 'stripe', status: 'connected' }],
    read: key => values.get(key), write: (key, value) => values.set(key, value),
    send: async (built, connectionId) => {
      requests.push({ built, connectionId });
      if (built.operation_id === 'operation:read-balance') return { livemode: true };
      if (built.operation_id === platform.account.create) return { id: `acct_${++accountNumber}` };
      if (built.operation_id === platform.account.onboarding_link) return { url: 'https://connect.stripe.com/onboarding' };
      return {};
    },
  });
  const seller = forPlatformSeller(operator, 'seller-17');
  const input = { mode: 'live', return_url: 'https://seller.example/return', refresh_url: 'https://seller.example/refresh' };
  const first = await seller.start(input);
  const again = await seller.start(input);
  assert.equal(first.account, again.account);
  assert.equal(accountNumber, 1);
  assert.ok(requests.every(row => row.connectionId === 'operator-stripe-live'));
  await assert.rejects(operator.act({ seller_ref: 'another-seller', mode: 'live', request: {
    operation_id: 'operation:create-session', input_facts: { operation_subject: {} },
  } }), /has no Stripe account/i);
});

test('platform operator accepts named Stripe operations only and overwrites the acting account', async () => {
  const values = new Map([['platform-seller:stripe:live:seller-17', { seller_ref: 'seller-17', mode: 'live', account: 'acct_seller17' }]]);
  const requests = [];
  const operator = makePlatformOperator({
    platform: platformOf(), connections: async () => [{ connection_id: 'stripe-live', vendor: 'stripe' }],
    read: key => values.get(key), write: (key, value) => values.set(key, value),
    send: async (built, connectionId) => {
      requests.push({ built, connectionId });
      return built.url === 'https://api.stripe.com/v1/balance' ? { livemode: true } : { id: 'cs_test' };
    },
  });
  await operator.act({ seller_ref: 'seller-17', mode: 'live', request: { operation_id: 'operation:create-session', input_facts: { operation_subject: { mode: 'payment' } } } });
  const checkout = requests.find(row => row.built.url === 'https://api.stripe.com/v1/checkout/sessions');
  assert.equal(checkout.built.headers['Stripe-Account'], 'acct_seller17');
  assert.equal(checkout.built.url, 'https://api.stripe.com/v1/checkout/sessions');
  const prepared = {
    operation_id: 'operation:create-session', prepared: true, method: 'POST', url: 'https://api.stripe.com/v1/checkout/sessions',
    headers: { 'Stripe-Version': '2026-05-27.dahlia', 'Content-Type': 'application/x-www-form-urlencoded' }, body: 'mode=payment',
  };
  await operator.act({ seller_ref: 'seller-17', mode: 'live', request: prepared });
  const preparedCheckout = requests.find(row => row.built.url === prepared.url);
  assert.equal(preparedCheckout.built.headers['Stripe-Account'], 'acct_seller17');
  await assert.rejects(operator.act({ seller_ref: 'seller-17', mode: 'live', request: { ...prepared, url: 'https://api.stripe.com/v1/refunds' } }), /declared address/i);
  await assert.rejects(operator.act({ seller_ref: 'seller-17', mode: 'live', request: { url: 'https://attacker.example/', method: 'POST' } }), /operation/i);
});

test('seller facade discards any caller-selected seller reference', async () => {
  const calls = [];
  const facade = forPlatformSeller({ start: args => calls.push(args), status: args => calls.push(args), act: args => calls.push(args) }, 'seller-fixed');
  facade.start({ mode: 'test', seller_ref: 'seller-other' });
  facade.status({ mode: 'test', seller_ref: 'seller-other' });
  facade.act({ mode: 'test', request: { operation_id: 'operation:read-session', input_facts: {} }, seller_ref: 'seller-other' });
  assert.deepEqual(calls.map(args => args.seller_ref), ['seller-fixed', 'seller-fixed', 'seller-fixed']);
});
