import assert from 'node:assert/strict';
import test from 'node:test';

import {
  CarrierHttpEffectError,
  decodeTargetPayload,
  encodeBrowserTargetResponse,
  encodeTargetPayload,
  executeCarrierHttpEffect,
  resolveCheckoutTransport,
  validateCarrierHttpEffect,
} from '../processes/carrier-http-effect.mjs';

const environment = {
  BITFIELD_CARRIER_CREDENTIAL_BINDINGS_JSON: JSON.stringify({
    'credential-class:stripe-restricted-key': 'STRIPE_SECRET_KEY',
  }),
  BITFIELD_CARRIER_HTTP_ALLOWED_HOSTS: 'api.stripe.com',
  STRIPE_SECRET_KEY: 'sealed-test-secret',
};

function effect() {
  return {
    kind: 'carrier-http-effect',
    operationId: 'stripe-checkout-session:create:attempt-1:quote-1',
    request: {
      auth: {
        credentialRef: 'credential-class:stripe-restricted-key',
        scheme: 'bearer',
      },
      body: 'mode=subscription',
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
        'idempotency-key': 'stripe-checkout-session:create:attempt-1:quote-1',
      },
      method: 'POST',
      timeoutMs: 15_000,
      url: 'https://api.stripe.com/v1/checkout/sessions',
    },
    finalizeInput: { session: { payment_mode: 'subscription' } },
    finalizeTarget: 'stripe-payment-provider.create-hosted-session',
  };
}

test('target envelope carries only response bytes', () => {
  const encoded = encodeTargetPayload({ redirectUrl: 'https://checkout.stripe.com/c/pay/test' });
  assert.deepEqual(decodeTargetPayload(encoded), {
    redirectUrl: 'https://checkout.stripe.com/c/pay/test',
  });
});

test('browser target response is the raw target result, not a second envelope', () => {
  const result = {
    providerSessionId: 'cs_live_123',
    redirectUrl: 'https://checkout.stripe.com/c/pay/cs_live_123',
  };
  const body = JSON.parse(encodeBrowserTargetResponse(result));
  assert.deepEqual(body, result);
  assert.equal(Object.hasOwn(body, 'payload_base64'), false);
});

test('returns an admitted completed free checkout without inventing a provider effect', async () => {
  const materialization = {
    amountDueTodayCents: '0',
    customerId: 'bitfield-account-free-test',
    gate: {
      checkoutAttemptId: 'attempt-free-test',
      quoteReservationId: 'quote-reserved-attempt-free-test',
    },
    paymentMode: 'free',
    provider_ref: 'checkout-free',
    providerSessionId: 'quote-reserved-attempt-free-test',
    status: 'succeeded',
  };
  let providerCalls = 0;
  const completed = await resolveCheckoutTransport(materialization, {
    executeEffect: async () => {
      providerCalls += 1;
      throw new Error('a free checkout must not call a payment provider');
    },
  });

  assert.equal(providerCalls, 0);
  assert.equal(completed.transport, 'direct');
  assert.equal(completed.operationId, 'quote-reserved-attempt-free-test');
  assert.deepEqual(completed.output, materialization);
});

test('does not treat an incomplete free-shaped reply as checkout success', async () => {
  await assert.rejects(
    resolveCheckoutTransport({ paymentMode: 'free', status: 'succeeded' }),
    /completed checkout or an admitted carrier effect/,
  );
});

test('executes an admitted generic effect and returns the provider finalizer result', async () => {
  let outbound;
  let finalized;
  const result = await executeCarrierHttpEffect(effect(), {
    environment,
    fetchImpl: async (url, init) => {
      outbound = { init, url: String(url) };
      return new Response(JSON.stringify({
        id: 'cs_live_123',
        status: 'open',
        url: 'https://checkout.stripe.com/c/pay/cs_live_123',
      }), { status: 200 });
    },
    invokeTarget: async (target, payload) => {
      finalized = { payload, target };
      return {
        providerSessionId: 'cs_live_123',
        redirectUrl: 'https://checkout.stripe.com/c/pay/cs_live_123',
      };
    },
  });

  assert.equal(outbound.url, 'https://api.stripe.com/v1/checkout/sessions');
  assert.equal(outbound.init.headers.Authorization, 'Bearer sealed-test-secret');
  assert.equal(outbound.init.headers['idempotency-key'], effect().operationId);
  assert.equal(finalized.target, 'stripe-payment-provider.create-hosted-session');
  assert.equal(finalized.payload.carrier_transport, 'finalize');
  assert.equal(finalized.payload.transport_response.statusCode, 200);
  assert.match(finalized.payload.transport_response.bodyText, /cs_live_123/);
  assert.equal(Object.hasOwn(finalized.payload.transport_response, 'body'), false);
  assert.equal(JSON.stringify(finalized).includes('sealed-test-secret'), false);
  assert.equal(result.providerSessionId, 'cs_live_123');
});

test('passes provider rejection to provider-owned finalization', async () => {
  let statusCode;
  await executeCarrierHttpEffect(effect(), {
    environment,
    fetchImpl: async () => new Response('{"error":{"message":"bad key"}}', { status: 401 }),
    invokeTarget: async (_target, payload) => {
      statusCode = payload.transport_response.statusCode;
      return { error: 'Payment provider authentication failed.', status: 401 };
    },
  });
  assert.equal(statusCode, 401);
});

test('rejects destinations outside deployment DATA', () => {
  const changed = effect();
  changed.request.url = 'https://example.com/collect';
  assert.throws(
    () => validateCarrierHttpEffect(changed, environment),
    (error) => error instanceof CarrierHttpEffectError
      && /not admitted by deployment DATA/.test(error.message),
  );
});

test('rejects any authorization value materialized by the engine', () => {
  const changed = effect();
  changed.request.headers.Authorization = 'Bearer leaked';
  assert.throws(
    () => validateCarrierHttpEffect(changed, environment),
    /must not contain browser-visible credentials/,
  );
});
