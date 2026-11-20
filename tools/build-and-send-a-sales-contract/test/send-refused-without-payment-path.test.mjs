import test from 'node:test';
import assert from 'node:assert/strict';
import { hasFixedPayments, ownStripeConnected, paymentPath } from '../read-data/send-refused-without-payment-path.mjs';

const never = () => { throw new Error('platform asked too early'); };

test('a free deal may be sent without asking the platform', () => {
  assert.deepEqual(paymentPath({ free: true, ownStripe: false, fixedPayments: false, platformReady: never }), { paid: true });
});

test('a deal with the own Stripe connected may be sent without asking the platform', () => {
  assert.deepEqual(paymentPath({ free: false, ownStripe: true, fixedPayments: false, platformReady: never }), { paid: true });
});

test('a deal with fixed payments asks for the own Stripe, and never the platform', () => {
  assert.deepEqual(paymentPath({ free: false, ownStripe: false, fixedPayments: true, platformReady: never }), {
    paid: false,
    refusal: 'Connect your own Stripe account in Connections to send a payment plan with a fixed number of payments.',
  });
});

test('a priced deal with no own Stripe may be sent when the platform is ready', () => {
  assert.deepEqual(paymentPath({ free: false, ownStripe: false, fixedPayments: false, platformReady: () => true }), { paid: true });
});

test('a priced deal with no payment path is refused with the payment words', () => {
  assert.deepEqual(paymentPath({ free: false, ownStripe: false, fixedPayments: false, platformReady: () => false }), {
    paid: false,
    refusal: 'Connect your Stripe account in Connections or set up Payments, so the person you send this to can pay you.',
  });
});

test('the own Stripe is connected only when its connection is connected', () => {
  assert.equal(ownStripeConnected([{ connection_id: 'service_connection:stripe', status: 'connected' }]), true);
  assert.equal(ownStripeConnected([{ connection_id: 'service_connection:stripe', status: 'pending' }]), false);
  assert.equal(ownStripeConnected([{ connection_id: 'service_connection:other', status: 'connected' }]), false);
});

test('a fixed number of payments is a commitment with a whole billing cycle count', () => {
  assert.equal(hasFixedPayments({ contract: { rules: [{ type: 'Commitment', metadata: { billing_cycles: 3 } }] } }), true);
  assert.equal(hasFixedPayments({ contract: { rules: [{ type: 'Commitment', metadata: { billing_cycles: 2.5 } }] } }), false);
  assert.equal(hasFixedPayments({ contract: { rules: [{ type: 'GrantAccess' }] } }), false);
});
