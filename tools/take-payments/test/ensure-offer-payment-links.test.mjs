// Offer rows become lasting Stripe payment links through the package's own operation rows: every call is a
// request built from DATA and handed to the caller's `send`, a second setup changes nothing that already
// matches, and a retired option's link stops taking payments.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ensureOfferPaymentLinks, pricedOptions } from '../do-work/ensure-offer-payment-links.mjs';
import { buildStripeHttpRequest } from '../do-work/build-stripe-http-request.mjs';

// A small Stripe: objects kept in memory, answering the built requests by method and address.
function fakeStripe() {
  const state = { prices: [], products: [], payment_links: [], coupons: [], promotion_codes: [], portals: [], calls: [] };
  let n = 0;
  const id = prefix => `${prefix}_${n += 1}`;
  const form = body => {
    const out = {};
    for (const [key, value] of new URLSearchParams(body ?? '')) {
      const path = key.split(/\[|\]\[|\]/).filter(Boolean);
      let cursor = out;
      path.slice(0, -1).forEach((part, index) => { cursor = cursor[part] ??= /^\d+$/.test(path[index + 1]) ? [] : {}; });
      cursor[path.at(-1)] = value;
    }
    return out;
  };
  const send = async request => {
    assert.equal(request.auth.credential_ref, 'stripe-api-key', 'no key in the request, only its name');
    const url = new URL(request.url);
    const query = form(url.search.slice(1));
    const body = form(request.body);
    state.calls.push(`${request.method} ${url.pathname}`);
    const route = url.pathname.replace('/v1/', '');
    if (request.method === 'GET' && route === 'prices') return { data: state.prices.filter(price => (query.lookup_keys ?? []).includes(price.lookup_key)) };
    if (request.method === 'POST' && route === 'products') { const product = { id: id('prod'), ...body }; state.products.push(product); return product; }
    if (request.method === 'POST' && route === 'prices') {
      for (const price of state.prices) if (price.lookup_key === body.lookup_key) price.lookup_key = null;
      const price = { id: id('price'), unit_amount: Number(body.unit_amount), currency: body.currency, recurring: body.recurring ?? null, lookup_key: body.lookup_key, metadata: body.metadata };
      state.prices.push(price); return price;
    }
    if (request.method === 'GET' && route === 'payment_links') return { data: state.payment_links.filter(link => link.active) };
    if (request.method === 'POST' && route === 'payment_links') { const link = { id: id('plink'), url: `https://buy.example/${n}`, active: true, ...body }; state.payment_links.push(link); return link; }
    if (request.method === 'POST' && route.startsWith('payment_links/')) { const link = state.payment_links.find(item => item.id === route.split('/')[1]); if (body.active === 'false') link.active = false; return link; }
    if (request.method === 'GET' && route === 'promotion_codes') return { data: state.promotion_codes.filter(code => code.code === query.code) };
    if (request.method === 'POST' && route === 'coupons') { const coupon = { id: id('coupon'), ...body }; state.coupons.push(coupon); return coupon; }
    if (request.method === 'POST' && route === 'promotion_codes') { const code = { id: id('promo'), code: body.code, active: true, times_redeemed: 0, max_redemptions: Number(body.max_redemptions), promotion: body.promotion }; state.promotion_codes.push(code); return code; }
    if (request.method === 'GET' && route === 'billing_portal/configurations') return { data: state.portals };
    if (request.method === 'POST' && route === 'billing_portal/configurations') { const portal = { id: id('bpc'), metadata: body.metadata, login_page: { url: 'https://billing.example/p' } }; state.portals.push(portal); return portal; }
    throw new Error(`unexpected ${request.method} ${route}`);
  };
  return { state, send };
}

const offers = [
  { id: 'offer:free', label: 'Free', price_options: [] },
  { id: 'offer:member', label: 'Member', summary: 'Monthly bread box', post_purchase_route_path: '/account?paid=1', price_options: [{ id: 'price:member-monthly', amount_cents: 4000, currency: 'usd', payment_timing: 'subscription', interval: 'month' }] },
  { id: 'offer:session', label: 'Session', post_purchase_route_path: '/account?paid=1', price_options: [{ id: 'price:session', amount_cents: 60000, currency: 'usd', payment_timing: 'one_time' }] },
];
const setup = (send, extra = {}) => ensureOfferPaymentLinks({ offers, adjustments: [{ id: 'adj:review', kind: 'checkout-code-adjustment', code: 'REVIEW', adjustment: { kind: 'percent', percent: 100 }, max_redemptions: 10 }], owner: 'bakery-a', afterPaymentUrl: 'https://app.example/', send, ...extra });

test('a read that searches carries its subject as the query, and a delete carries no body', () => {
  const read = buildStripeHttpRequest({ operation_id: 'operation:find-prices', input_facts: { operation_subject: { lookup_keys: ['price:a'], active: true } } });
  assert.equal(read.url, 'https://api.stripe.com/v1/prices?lookup_keys%5B0%5D=price%3Aa&active=true');
  assert.equal(read.body, undefined);
  const removed = buildStripeHttpRequest({ operation_id: 'operation:cancel-subscription', input_facts: { provider_object_ref: 'sub_1' } });
  assert.deepEqual([removed.method, removed.url, removed.body], ['DELETE', 'https://api.stripe.com/v1/subscriptions/sub_1', undefined]);
});

test('every priced option gets a link carrying its offer and option, and free offers get none', async () => {
  const { state, send } = fakeStripe();
  const result = await setup(send);
  assert.deepEqual(result.links.map(link => [link.offer_id, link.price_option_id]), [['offer:member', 'price:member-monthly'], ['offer:session', 'price:session']]);
  const [member, session] = state.payment_links;
  assert.equal(member.managed_payments.enabled, 'false');
  assert.equal(session.managed_payments.enabled, 'false', 'in-person services cannot use Managed Payments');
  assert.deepEqual(member.metadata, { owner: 'bakery-a', offer_id: 'offer:member', price_option_id: 'price:member-monthly', price: state.prices[0].id });
  assert.equal(member.subscription_data.metadata.offer_id, 'offer:member');
  assert.equal(session.payment_intent_data.metadata.offer_id, 'offer:session');
  assert.equal(session.customer_creation, 'always');
  assert.equal(member.after_completion.redirect.url, 'https://app.example/account?paid=1');
  assert.equal(state.prices[0].recurring.interval, 'month');
  assert.equal(state.prices[1].recurring, null);
  assert.deepEqual(result.codes, [{ code: 'REVIEW', active: true, used: 0, max: 10 }]);
});

test('a second setup reuses every price, link, code and plan page', async () => {
  const { state, send } = fakeStripe();
  const first = await setup(send);
  const counts = () => [state.prices.length, state.payment_links.length, state.promotion_codes.length, state.portals.length];
  const before = counts();
  const second = await setup(send);
  assert.deepEqual(counts(), before);
  assert.deepEqual(second.links.map(link => link.url), first.links.map(link => link.url));
});

test('a changed amount gets a new price and link, and the old link and any retired pattern stop taking payments', async () => {
  const { state, send } = fakeStripe();
  state.payment_links.push({ id: 'plink_old', url: 'https://buy.example/old', active: true, metadata: { app: 'bakery-a' } });
  const first = await setup(send, { retireLinksWhere: [{ app: 'bakery-a' }] });
  assert.deepEqual(first.retired, ['https://buy.example/old']);
  offers[1].price_options[0].amount_cents = 4400;
  try {
    const second = await setup(send);
    assert.notEqual(second.links[0].url, first.links[0].url);
    assert.deepEqual(second.retired, [first.links[0].url]);
    assert.equal(state.prices.filter(price => price.lookup_key === 'price:member-monthly').length, 1);
  } finally {
    offers[1].price_options[0].amount_cents = 4000;
  }
});

test('a code without a percent adjustment is refused', async () => {
  const { send } = fakeStripe();
  await assert.rejects(ensureOfferPaymentLinks({ offers: [], adjustments: [{ id: 'a', code: 'X', adjustment: { kind: 'fixed', amount_cents: 500 } }], owner: 'bakery-a', afterPaymentUrl: 'https://app.example/', send }), /percent adjustment between 1 and 100/);
});

test('an option that cannot be sold is refused before any call', () => {
  assert.throws(() => pricedOptions([{ id: 'o', price_options: [{ id: 'p', amount_cents: 100, currency: 'usd', payment_timing: 'subscription', interval: 'fortnight' }] }]), /day, week, month or year/);
  assert.throws(() => pricedOptions([{ id: 'o', price_options: [{ amount_cents: 100 }] }]), /without an id or currency/);
});
