// tools/take-payments/test/checkout-answers.test.mjs
//
// What the buyer checkout screen's three targets answer with: each answer is the tool's, a free choice never reaches
// Stripe, a redirect never grants (only Stripe's own paid status completes), and only the fields a tool takes are sent.
// The run is a fake that records what it was asked.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { completeAnswer, heldRefsAnswer, prepareAnswer, startAnswer } from '../web/src/workspace/checkout-answers.ts';

const paid = { amountDueTodayCents: '4900', recurringAmountCents: '4900', accessRefs: ['access:a'] };
const free = { amountDueTodayCents: '0', recurringAmountCents: '0', accessRefs: ['access:a'] };

function fakeRun(answers) {
  const calls = [];
  const run = async (tool, input) => {
    calls.push({ tool, input });
    const answer = answers[tool];
    if (typeof answer === 'function') return { result: answer(input) };
    return { result: answer };
  };
  return { run, calls };
}

const stored = new Map();
const context = {
  sellerConnection: 'service_connection:stripe',
  origin: 'https://sell.example',
  path: '/checkout',
  store: { getItem: key => stored.get(key) ?? null, setItem: (key, value) => stored.set(key, value) },
  routeOf: async offerId => (offerId === 'offer:one' ? '/welcome' : undefined),
};

const choice = { checkoutAttemptId: 'attempt-0001-abcdef', checkoutStartedAt: '2026-01-01T00:00:00Z', offerId: 'offer:one', priceOptionId: 'price:one', checkoutCode: 'SAVE', consent: { billing: true, legal: true }, returnUrlBase: 'https://sell.example', unrelated: 1 };

test('prepare answers the quote tool\'s material and sends only the fields that tool takes', async () => {
  const { run, calls } = fakeRun({ 'tool:price-a-sale': { quote: {}, material: paid } });
  assert.deepEqual(await prepareAnswer(choice, run), paid);
  assert.equal(calls.length, 1);
  assert.deepEqual(Object.keys(calls[0].input).sort(), ['checkoutAttemptId', 'checkoutCode', 'checkoutStartedAt', 'offerId', 'priceOptionId']);
});

test('prepare refuses an answer with no material', async () => {
  const { run } = fakeRun({ 'tool:price-a-sale': { quote: {} } });
  await assert.rejects(prepareAnswer(choice, run), /no material/);
});

test('a paid start sends the buyer to the Stripe checkout the tool made, naming the return and the seller connection', async () => {
  stored.clear();
  const { run, calls } = fakeRun({
    'tool:price-a-sale': { quote: {}, material: paid },
    'tool:start-a-stripe-checkout': { redirectUrl: 'https://pay.example/c/1', providerSessionId: 'cs_1', amountDueTodayCents: '4900' },
  });
  const answer = await startAnswer(choice, run, context);
  assert.equal(answer.redirectUrl, 'https://pay.example/c/1');
  assert.equal(answer.providerSessionId, 'cs_1');
  assert.equal(answer.amountDueTodayCents, '4900');
  const started = calls.find(call => call.tool === 'tool:start-a-stripe-checkout').input;
  assert.equal(started.seller_connection, 'service_connection:stripe');
  assert.equal(started.success_url, 'https://sell.example/checkout?checkout=success&session_id={CHECKOUT_SESSION_ID}');
  assert.equal(started.cancel_url, 'https://sell.example/checkout');
  assert.deepEqual(started.consent, { billing: true, legal: true });
  assert.equal('unrelated' in started, false);
  assert.equal(stored.get('checkout-route:cs_1'), '/welcome');
});

test('a choice that asks for nothing today and nothing later completes without Stripe', async () => {
  const { run, calls } = fakeRun({ 'tool:price-a-sale': { quote: {}, material: free } });
  const answer = await startAnswer(choice, run, context);
  assert.equal(answer.status, 'completed');
  assert.equal(calls.some(call => call.tool === 'tool:start-a-stripe-checkout'), false);
});

test('a trial that asks for nothing today but money later still goes to Stripe', async () => {
  const { run, calls } = fakeRun({
    'tool:price-a-sale': { quote: {}, material: { ...paid, amountDueTodayCents: '0' } },
    'tool:start-a-stripe-checkout': { redirectUrl: 'https://pay.example/c/2', providerSessionId: 'cs_2' },
  });
  assert.equal((await startAnswer(choice, run, context)).redirectUrl, 'https://pay.example/c/2');
  assert.equal(calls.some(call => call.tool === 'tool:start-a-stripe-checkout'), true);
});

test('a start whose Stripe answer has no address to open is refused', async () => {
  const { run } = fakeRun({ 'tool:price-a-sale': { quote: {}, material: paid }, 'tool:start-a-stripe-checkout': { providerSessionId: 'cs_3' } });
  await assert.rejects(startAnswer(choice, run, context), /no checkout to open/);
});

test('a return completes only when Stripe says the checkout was paid, and carries the offer\'s route', async () => {
  stored.clear();
  stored.set('checkout-route:cs_1', '/welcome');
  const { run, calls } = fakeRun({ 'tool:look-up-a-stripe-checkout': input => ({ provider_session_id: input.provider_session_id, payment_status: input.provider_session_id === 'cs_1' ? 'paid' : 'unpaid' }) });
  assert.deepEqual(await completeAnswer({ session_id: 'cs_1' }, run, context), { completed: true, granted: false, grantedCount: 0, status: 'completed', paymentRecorded: false, postPurchaseRoutePath: '/welcome' });
  assert.deepEqual(await completeAnswer({ session_id: 'cs_9' }, run, context), { completed: false, status: 'unpaid' });
  assert.equal(calls[0].input.seller_connection, 'service_connection:stripe');
});

test('a paid return with no route to open is recorded and stays', async () => {
  stored.clear();
  const { run } = fakeRun({ 'tool:look-up-a-stripe-checkout': { payment_status: 'paid' } });
  const answer = await completeAnswer({ session_id: 'cs_4' }, run, context);
  assert.equal(answer.paymentRecorded, true);
  assert.equal('postPurchaseRoutePath' in answer, false);
});

test('a return with no session id is refused', async () => {
  await assert.rejects(completeAnswer({}, fakeRun({}).run, context), /session id/);
});

test('what the buyer holds is asked only for a named buyer', async () => {
  const { run, calls } = fakeRun({ 'tool:see-who-holds-paid-access': { held_access_refs: ['access:a', 7] } });
  assert.deepEqual(await heldRefsAnswer(run, { ...context, subject: 'buyer@example.com' }), ['access:a']);
  assert.deepEqual(calls[0].input, { subject: 'buyer@example.com' });
  assert.deepEqual(await heldRefsAnswer(run, context), []);
  assert.equal(calls.length, 1);
});
