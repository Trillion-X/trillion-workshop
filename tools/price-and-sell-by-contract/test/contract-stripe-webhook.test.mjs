import test from 'node:test';
import assert from 'node:assert/strict';
import { handleContractStripeWebhook } from '../src/contract-stripe-webhook.mjs';

// The seller is the native owner's single notice entry (src/native-contract-stripe.mjs receive): it gets the Stripe object
// id and, for an invoice, the locators that name which of its own saved offers to check; it verifies everything itself.
const sellerOf = (record, handlers = {}) => ({ contractStripeNotice: async input => {
  if (handlers[input.method]) return handlers[input.method](input);
  record?.(input);
} });
const eventRequest = (type, object) => new Request('https://trillion.example/billing/contract-stripe/seller-ref', {
  method: 'POST', headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ id: 'evt_untrusted', type, data: { object } }),
});

test('a completed setup event wakes the seller with only the Checkout Session id', async () => {
  const calls = [];
  const seller = sellerOf(input => calls.push(input));
  const response = await handleContractStripeWebhook(eventRequest('checkout.session.completed', {
    id: 'cs_test_finite', mode: 'setup', client_reference_id: 'person:buyer', payment_status: 'unpaid',
  }), seller);
  assert.equal(response.status, 200);
  assert.deepEqual(calls, [{ method: 'completeFiniteSetup', object_id: 'cs_test_finite' }]);
});

test('a paid invoice wakes the seller with only the invoice id and its offer locators', async () => {
  const calls = [];
  const seller = sellerOf(input => calls.push(input));
  const response = await handleContractStripeWebhook(eventRequest('invoice.paid', {
    id: 'in_paid', subscription: 'sub_untrusted', metadata: { negotiated_offer_id: 'untrusted' },
  }), seller);
  assert.equal(response.status, 200);
  assert.deepEqual(calls, [{ method: 'reconcileFiniteInvoice', object_id: 'in_paid', offer_id: 'untrusted', subscription_id: 'sub_untrusted' }]);
});

test('duplicate deliveries are handed to the seller as the same stable object reference', async () => {
  const calls = [];
  const seller = sellerOf(input => calls.push(input));
  for (let i = 0; i < 2; i += 1) {
    const response = await handleContractStripeWebhook(eventRequest('checkout.session.completed', { id: 'cs_test_finite' }), seller);
    assert.equal(response.status, 200);
  }
  assert.deepEqual(calls, [{ method: 'completeFiniteSetup', object_id: 'cs_test_finite' }, { method: 'completeFiniteSetup', object_id: 'cs_test_finite' }]);
});

test('irrelevant events are acknowledged without asking the seller to mutate anything', async () => {
  let calls = 0;
  const seller = sellerOf(() => { calls += 1; });
  const response = await handleContractStripeWebhook(eventRequest('customer.subscription.created', { id: 'sub_1' }), seller);
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { received: true, ignored: 'This event does not wake a finite contract payment.' });
  assert.equal(calls, 0);
});

test('seller reconciliation failures remain retryable', async () => {
  const response = await handleContractStripeWebhook(eventRequest('invoice.paid', { id: 'in_paid' }),
    sellerOf(null, { reconcileFiniteInvoice: async () => { throw new Error('do not expose provider details'); } }));
  assert.equal(response.status, 503);
  assert.deepEqual(await response.json(), { error: 'The seller could not finish this payment notice. Stripe can retry it.' });
});

test('bad bodies and unsupported methods fail without reaching the seller', async () => {
  let calls = 0;
  const seller = sellerOf(() => { calls += 1; });
  const malformed = await handleContractStripeWebhook(new Request('https://trillion.example/hook', { method: 'POST', body: '{' }), seller);
  assert.equal(malformed.status, 400);
  const wrongMethod = await handleContractStripeWebhook(new Request('https://trillion.example/hook'), seller);
  assert.equal(wrongMethod.status, 405);
  const wrongId = await handleContractStripeWebhook(eventRequest('invoice.paid', { id: 'sub_1' }), seller);
  assert.equal(wrongId.status, 200);
  assert.equal(calls, 0);
});

test('oversized event bodies are rejected before dispatch', async () => {
  const seller = sellerOf(() => assert.fail('should not dispatch'));
  const response = await handleContractStripeWebhook(new Request('https://trillion.example/hook', {
    method: 'POST', headers: { 'content-length': '300000' }, body: '{}',
  }), seller);
  assert.equal(response.status, 413);
});
