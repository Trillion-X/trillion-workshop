// node --test tools/price-and-sell-by-contract/test/buy-route.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { offerIdOf, chargedOption, sellableOffer, attributionOf, checkoutForm, answerBuy } from '../src/buy-route.mjs';
import { createBuyServer } from '../on-a-computer/serve-buy.mjs';

const ORIGIN = 'https://app.example.test';
const SUCCESS = '/welcome';
const KEY = 'sk_test_synthetic_key';
const offers = [
  { id: 'offer:spot-50', label: 'Spot', price_options: [{ id: 'price:spot-50', label: '$50/month per spot', currency: 'usd', payment_timing: 'subscription', interval: 'month', amount_cents: 5000, trial_days: 7 }] },
  { id: 'offer:one-time', label: 'One time', price_options: [{ id: 'price:one-time', label: '$20 once', currency: 'usd', payment_timing: 'one_time', amount_cents: 2000, trial_days: 0 }] },
  { id: 'offer:free', label: 'Free', price_options: [{ id: 'price:free', label: 'Free', currency: 'usd', payment_timing: 'one_time', amount_cents: 0 }] },
];

// A Stripe transport that records each call and answers with a Checkout address.
function stripeStub(reply = { status: 200, body: { url: 'https://checkout.stripe.test/c/pay/cs_1' } }) {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, init, form: new URLSearchParams(init.body) });
    return { ok: reply.status >= 200 && reply.status < 300, status: reply.status, json: async () => reply.body };
  };
  return { calls, fetchImpl };
}

test('an address names its offer, encoded or plain', () => {
  assert.equal(offerIdOf('/buy/offer%3Aspot-50'), 'offer:spot-50');
  assert.equal(offerIdOf('/buy/offer:spot-50'), 'offer:spot-50');
  assert.equal(offerIdOf('/buy/'), null);
  assert.equal(offerIdOf('/buy/%E0%A4%A'), null);
  assert.equal(offerIdOf('/welcome'), null);
});

test('only an offer that is for sale and has a charged price is sellable', () => {
  assert.equal(sellableOffer(offers, 'offer:spot-50').id, 'offer:spot-50');
  assert.equal(sellableOffer(offers, 'offer:free'), null);
  assert.equal(sellableOffer(offers, 'offer:unknown'), null);
  assert.equal(chargedOption(offers[2]), null);
  const withdrawn = [{ ...offers[0], id: 'offer:withdrawn', for_sale: false }];
  assert.equal(sellableOffer(withdrawn, 'offer:withdrawn'), null);
});

test('an unknown offer gets the plain 404 page and no Stripe call', async () => {
  const stripe = stripeStub();
  const answer = await answerBuy({ pathname: '/buy/offer%3Ano-such', searchParams: new URLSearchParams(), offers, key: KEY, origin: ORIGIN, successPath: SUCCESS, fetchImpl: stripe.fetchImpl });
  assert.equal(answer.status, 404);
  assert.equal(answer.headers['content-type'], 'text/plain; charset=utf-8');
  assert.equal(answer.body, 'Not found.\n');
  assert.equal(stripe.calls.length, 0);
});

test('a free offer gets the same 404 page and no Stripe call', async () => {
  const stripe = stripeStub();
  const answer = await answerBuy({ pathname: '/buy/offer:free', searchParams: new URLSearchParams(), offers, key: KEY, origin: ORIGIN, successPath: SUCCESS, fetchImpl: stripe.fetchImpl });
  assert.equal(answer.status, 404);
  assert.equal(stripe.calls.length, 0);
});

test('a repeating price becomes a subscription line with its free days first, returning to the success path', () => {
  const form = checkoutForm({ offer: offers[0], searchParams: new URLSearchParams(), origin: ORIGIN, successPath: SUCCESS });
  assert.equal(form.get('mode'), 'subscription');
  assert.equal(form.get('success_url'), `${ORIGIN}/welcome`);
  assert.equal(form.get('line_items[0][quantity]'), '1');
  assert.equal(form.get('line_items[0][price_data][currency]'), 'usd');
  assert.equal(form.get('line_items[0][price_data][unit_amount]'), '5000');
  assert.equal(form.get('line_items[0][price_data][product_data][name]'), '$50/month per spot');
  assert.equal(form.get('line_items[0][price_data][recurring][interval]'), 'month');
  assert.equal(form.get('subscription_data[trial_period_days]'), '7');
  assert.equal(form.get('metadata[offer_id]'), 'offer:spot-50');
  assert.equal(form.get('subscription_data[metadata][offer_id]'), 'offer:spot-50');
});

test('a price paid once is a payment with no recurring line', () => {
  const form = checkoutForm({ offer: offers[1], searchParams: new URLSearchParams(), origin: ORIGIN, successPath: SUCCESS });
  assert.equal(form.get('mode'), 'payment');
  assert.equal(form.get('line_items[0][price_data][unit_amount]'), '2000');
  assert.equal(form.has('line_items[0][price_data][recurring][interval]'), false);
  assert.equal(form.has('subscription_data[trial_period_days]'), false);
});

test('a repeating price with no interval Stripe can bill is refused', () => {
  const broken = { id: 'offer:broken', price_options: [{ currency: 'usd', payment_timing: 'subscription', amount_cents: 500 }] };
  assert.throws(() => checkoutForm({ offer: broken, searchParams: new URLSearchParams(), origin: ORIGIN, successPath: SUCCESS }), /no interval/);
});

test('attribution: jv becomes the client reference; utm_* and ref become metadata; other keys do not reach Stripe', () => {
  const params = new URLSearchParams('jv=visitor-42&utm_source=school&utm_medium=email&utm_campaign=fall&ref=alex&from=extension&return=https%3A%2F%2Fevil.example');
  const attribution = attributionOf(params);
  assert.equal(attribution.client_reference_id, 'visitor-42');
  assert.deepEqual(attribution.metadata, { utm_source: 'school', utm_medium: 'email', utm_campaign: 'fall', ref: 'alex' });
  const form = checkoutForm({ offer: offers[0], searchParams: params, origin: ORIGIN, successPath: SUCCESS });
  assert.equal(form.get('client_reference_id'), 'visitor-42');
  assert.equal(form.get('metadata[utm_source]'), 'school');
  assert.equal(form.get('metadata[ref]'), 'alex');
  assert.equal(form.get('subscription_data[metadata][utm_campaign]'), 'fall');
  assert.equal(form.has('metadata[from]'), false);
  assert.equal(form.has('metadata[return]'), false);
  assert.equal(form.has('metadata[jv]'), false);
});

test('attribution values are cut to Stripe limits and control characters are removed', () => {
  const long = 'x'.repeat(600);
  const attribution = attributionOf(new URLSearchParams(`jv=${'j'.repeat(300)}&ref=a%0Ab&utm_term=${long}&utm_content=`));
  assert.equal(attribution.client_reference_id.length, 200);
  assert.equal(attribution.metadata.ref, 'ab');
  assert.equal(attribution.metadata.utm_term.length, 500);
  assert.equal(attribution.metadata.utm_content, undefined);
});

test('an address with no attribution sends no client reference and only the offer in metadata', () => {
  const form = checkoutForm({ offer: offers[0], searchParams: new URLSearchParams(), origin: ORIGIN, successPath: SUCCESS });
  assert.equal(form.has('client_reference_id'), false);
  assert.deepEqual([...form.keys()].filter(key => key.startsWith('metadata[')), ['metadata[offer_id]']);
});

test('a buy makes one authorised Stripe call carrying the attribution and redirects to its session', async () => {
  const stripe = stripeStub();
  const answer = await answerBuy({ pathname: '/buy/offer%3Aspot-50', searchParams: new URLSearchParams('jv=visitor-42&utm_source=school'), offers, key: KEY, origin: ORIGIN, successPath: SUCCESS, fetchImpl: stripe.fetchImpl });
  assert.equal(answer.status, 303);
  assert.equal(answer.headers.location, 'https://checkout.stripe.test/c/pay/cs_1');
  assert.equal(stripe.calls.length, 1);
  assert.equal(stripe.calls[0].url, 'https://api.stripe.com/v1/checkout/sessions');
  assert.equal(stripe.calls[0].init.method, 'POST');
  assert.equal(stripe.calls[0].init.headers.authorization, `Bearer ${KEY}`);
  assert.equal(stripe.calls[0].url.includes(KEY), false);
  assert.equal(stripe.calls[0].form.get('client_reference_id'), 'visitor-42');
  assert.equal(stripe.calls[0].form.get('metadata[utm_source]'), 'school');
});

test('a refused or address-less Stripe answer gets the plain 502 page, logged by message only', async () => {
  const logged = [];
  const refused = await answerBuy({ pathname: '/buy/offer:spot-50', searchParams: new URLSearchParams(), offers, key: KEY, origin: ORIGIN, successPath: SUCCESS, fetchImpl: stripeStub({ status: 402, body: {} }).fetchImpl, log: line => logged.push(line) });
  assert.equal(refused.status, 502);
  const noAddress = await answerBuy({ pathname: '/buy/offer:spot-50', searchParams: new URLSearchParams(), offers, key: KEY, origin: ORIGIN, successPath: SUCCESS, fetchImpl: stripeStub({ status: 200, body: {} }).fetchImpl, log: line => logged.push(line) });
  assert.equal(noAddress.status, 502);
  assert.deepEqual(logged, ['buy offer:spot-50: Stripe answered 402.', 'buy offer:spot-50: Stripe gave no Checkout address.']);
  assert.equal(logged.join('').includes(KEY), false);
});

test('the server answers readyz, the buy address, an unknown offer and other methods over HTTP', async () => {
  const stripe = stripeStub();
  const server = createBuyServer({ settings: { origin: ORIGIN, success_path: SUCCESS, offers }, key: KEY, fetchImpl: stripe.fetchImpl });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    assert.equal((await fetch(`${base}/readyz`)).status, 200);
    const bought = await fetch(`${base}/buy/offer%3Aspot-50?jv=visitor-42`, { redirect: 'manual' });
    assert.equal(bought.status, 303);
    assert.equal(bought.headers.get('location'), 'https://checkout.stripe.test/c/pay/cs_1');
    const missing = await fetch(`${base}/buy/offer:nope`);
    assert.equal(missing.status, 404);
    assert.equal(await missing.text(), 'Not found.\n');
    const posted = await fetch(`${base}/buy/offer:spot-50`, { method: 'POST' });
    assert.equal(posted.status, 405);
    assert.equal(stripe.calls.length, 1);
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
});
