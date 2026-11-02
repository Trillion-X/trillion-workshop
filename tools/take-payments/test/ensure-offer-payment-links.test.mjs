// Offer rows become lasting Stripe payment links through the package's own operation rows: every call is a
// request built from DATA and handed to the caller's `send`, a second setup changes nothing that already
// matches, a retired option's link stops taking payments, and a reworded offer rewords the product buyers see.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ensureOfferCodes, ensureOfferPaymentLinks, pricedOptions } from '../do-work/ensure-offer-payment-links.mjs';
import { buildStripeHttpRequest } from '../do-work/build-stripe-http-request.mjs';

// A small Stripe: objects kept in memory, answering the built requests by method and address.
function fakeStripe() {
  const state = { prices: [], products: [], payment_links: [], coupons: [], promotion_codes: [], portals: [], calls: [], pageSize: 100, repeatCursor: false, duplicateCursor: false, failPromotionCreate: false, losePromotionCreateResponse: false, idempotentReplies: new Map() };
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
    const page = rows => {
      const start = query.starting_after ? (state.duplicateCursor ? 0 : rows.findIndex(row => row.id === query.starting_after) + 1) : 0;
      const size = Math.min(Number(query.limit ?? 100), state.pageSize);
      return { data: rows.slice(start, start + size), has_more: state.repeatCursor ? true : start + size < rows.length };
    };
    const expanded = price => ((query.expand ?? []).includes('data.product') ? { ...price, product: state.products.find(product => product.id === price.product) } : price);
    if (request.method === 'GET' && route === 'prices') return { data: state.prices.filter(price => (query.lookup_keys ?? []).includes(price.lookup_key)).map(expanded) };
    if (request.method === 'POST' && route === 'products') { const product = { id: id('prod'), ...body }; state.products.push(product); return product; }
    if (request.method === 'POST' && route.startsWith('products/')) { const product = state.products.find(item => item.id === route.split('/')[1]); Object.assign(product, body); return product; }
    if (request.method === 'POST' && route === 'prices') {
      for (const price of state.prices) if (price.lookup_key === body.lookup_key) price.lookup_key = null;
      const price = { id: id('price'), product: body.product, unit_amount: Number(body.unit_amount), currency: body.currency, recurring: body.recurring ?? null, lookup_key: body.lookup_key, metadata: body.metadata };
      state.prices.push(price); return price;
    }
    if (request.method === 'GET' && route === 'payment_links') return page(state.payment_links.filter(link => link.active));
    if (request.method === 'POST' && route === 'payment_links') { const link = { id: id('plink'), url: `https://buy.example/${n}`, active: true, ...body }; state.payment_links.push(link); return link; }
    if (request.method === 'POST' && route.startsWith('payment_links/')) { const link = state.payment_links.find(item => item.id === route.split('/')[1]); Object.assign(link, body); if (body.active !== undefined) link.active = body.active === 'true'; link.updates = [...(link.updates ?? []), body]; return link; }
    const withCoupon = code => ((query.expand ?? []).includes('data.promotion.coupon.applies_to') ? { ...code, restrictions: { first_time_transaction: false, minimum_amount: null, minimum_amount_currency: null, ...code.restrictions }, promotion: { ...code.promotion, coupon: state.coupons.find(coupon => coupon.id === code.promotion?.coupon) ?? null } } : code);
    if (request.method === 'GET' && route === 'promotion_codes') return page(state.promotion_codes.filter(code => (query.code === undefined || code.code === query.code) && (query.active === undefined || String(code.active) === query.active)).reverse().map(withCoupon));
    if (request.method === 'POST' && route.startsWith('promotion_codes/')) { const code = state.promotion_codes.find(item => item.id === route.split('/')[1]); code.active = body.active === 'true'; return code; }
    if (request.method === 'POST' && route === 'coupons') {
      const key = request.idempotency_key;
      if (key && state.idempotentReplies.has(key)) return state.idempotentReplies.get(key);
      const coupon = { id: id('coupon'), ...body }; state.coupons.push(coupon);
      if (key) state.idempotentReplies.set(key, coupon);
      return coupon;
    }
    if (request.method === 'POST' && route === 'promotion_codes') {
      if (state.failPromotionCreate) { state.failPromotionCreate = false; throw new Error('simulated promotion-code create refusal'); }
      const key = request.idempotency_key;
      if (key && state.idempotentReplies.has(key)) return state.idempotentReplies.get(key);
      const code = { id: id('promo'), code: body.code, active: true, times_redeemed: 0, max_redemptions: body.max_redemptions === undefined ? null : Number(body.max_redemptions), restrictions: body.restrictions, promotion: body.promotion, metadata: body.metadata };
      state.promotion_codes.push(code);
      if (key) state.idempotentReplies.set(key, code);
      if (state.losePromotionCreateResponse) { state.losePromotionCreateResponse = false; throw new Error('simulated lost promotion-code response'); }
      return code;
    }
    if (request.method === 'GET' && route === 'billing_portal/configurations') return { data: state.portals };
    if (request.method === 'POST' && route === 'billing_portal/configurations') { const portal = { id: id('bpc'), metadata: body.metadata, login_page: { url: 'https://billing.example/p' } }; state.portals.push(portal); return portal; }
    throw new Error(`unexpected ${request.method} ${route}`);
  };
  return { state, send };
}

const offers = [
  { id: 'offer:free', label: 'Free', price_options: [] },
  { id: 'offer:member', label: 'Member', summary: 'Monthly bread box', post_purchase_route_path: '/account?paid=1', price_options: [{ id: 'price:member-monthly', amount_cents: 4000, currency: 'usd', payment_timing: 'subscription', interval: 'month' }] },
  { id: 'offer:session', label: 'Session', price_options: [{ id: 'price:session', amount_cents: 60000, currency: 'usd', payment_timing: 'one_time' }] },
];
const setup = (send, extra = {}) => ensureOfferPaymentLinks({ offers, adjustments: [{ id: 'adj:review', kind: 'checkout-code-adjustment', code: 'REVIEW', scope: { offer_ids: ['offer:member'] }, adjustment: { kind: 'percent', percent: 100 }, max_redemptions: 10 }], owner: 'bakery-a', afterPaymentUrl: 'https://app.example/', send, ...extra });

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
  assert.equal(member.payment_method_collection, 'always', 'a free trial still collects a card for renewal');
  assert.equal(session.managed_payments.enabled, 'false', 'in-person services cannot use Managed Payments');
  assert.deepEqual(member.metadata, { owner: 'bakery-a', offer_id: 'offer:member', price_option_id: 'price:member-monthly', price: state.prices[0].id });
  assert.equal(member.subscription_data.metadata.offer_id, 'offer:member');
  assert.equal(session.payment_intent_data.metadata.offer_id, 'offer:session');
  assert.equal(session.customer_creation, 'always');
  assert.equal(member.after_completion.redirect.url, 'https://app.example/account?paid=1', 'a row that names its page is sent there');
  assert.equal(session.after_completion.redirect.url, 'https://app.example/', 'a row that names none returns to the address');
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
  assert.equal(state.payment_links[0].updates.at(-1).payment_method_collection, 'always', 'an existing trial link is repaired');
});

test('reconciliation reads past provider page limits and refuses a collection cursor that cannot advance', async () => {
  const { state, send } = fakeStripe();
  state.pageSize = 2;
  for (let index = 0; index < 5; index += 1) state.promotion_codes.push({ id: `promo_${index}`, code: `OLD${index}`, active: true, times_redeemed: 0, metadata: { owner: 'bakery-a', adjustment_id: `old:${index}` } });
  const result = await ensureOfferCodes({ adjustments: [], offers, owner: 'bakery-a', send });
  assert.equal(result.retired.length, 5);
  assert.ok(state.calls.filter(call => call === 'GET /v1/promotion_codes').length >= 3);

  state.repeatCursor = true;
  await assert.rejects(ensureOfferCodes({ adjustments: [], offers, owner: 'bakery-a', send }), /cursor did not advance/);
  state.repeatCursor = false;
  state.duplicateCursor = true;
  for (let n = 0; n < 3; n++) state.promotion_codes.push({ id: `promo_extra_${n}`, code: 'EXTRA', active: true, metadata: { owner: 'bakery-a', adjustment_id: 'old:extra' } });
  state.promotion_codes.push({ id: 'promo_duplicate', code: 'DUP', active: true, times_redeemed: 0, metadata: { owner: 'bakery-a', adjustment_id: 'old:duplicate' } });
  await assert.rejects(ensureOfferCodes({ adjustments: [], offers, owner: 'bakery-a', send }), /cursor did not advance/);
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

test('a changed or removed seat range retires the old checkout and makes the current range reusable', async () => {
  const { state, send } = fakeStripe();
  const seatOffer = { id: 'offer:seats', label: 'Seats', price_options: [{ id: 'price:seats', amount_cents: 2000, currency: 'usd', payment_timing: 'one_time', seats: { minimum: 2, maximum: 8 } }] };
  const run = offersToSell => ensureOfferPaymentLinks({ offers: offersToSell, adjustments: [], owner: 'bakery-a', afterPaymentUrl: 'https://app.example/', send });
  const first = await run([seatOffer]);
  assert.deepEqual(state.payment_links[0].line_items[0].adjustable_quantity, { enabled: 'true', minimum: '2', maximum: '8' });
  seatOffer.price_options[0].seats = { minimum: 3, maximum: 5 };
  const changed = await run([seatOffer]);
  assert.notEqual(changed.links[0].url, first.links[0].url);
  assert.equal(state.payment_links.find(link => link.url === first.links[0].url).active, false);
  const currentId = changed.links[0].url;
  await run([seatOffer]);
  assert.equal(state.payment_links.filter(link => link.active && link.url === currentId).length, 1);
  delete seatOffer.price_options[0].seats;
  const removed = await run([seatOffer]);
  assert.notEqual(removed.links[0].url, currentId);
  assert.equal(state.payment_links.find(link => link.url === currentId).active, false);
});

test('a reworded offer rewords the product on its existing price, and an unchanged one sends no update', async () => {
  const { state, send } = fakeStripe();
  await setup(send);
  const calls = state.calls.length;
  await setup(send);
  assert.equal(state.calls.slice(calls).filter(call => call.startsWith('POST /v1/products/')).length, 0);
  const [label, summary] = [offers[1].label, offers[1].summary];
  offers[1].label = 'Member box';
  offers[1].summary = 'Monthly bread box, and the baker\'s notes';
  try {
    await setup(send);
    assert.deepEqual([state.products[0].name, state.products[0].description], ['Member box', 'Monthly bread box, and the baker\'s notes']);
    assert.equal(state.prices.length, 2, 'the price is reused');
  } finally {
    [offers[1].label, offers[1].summary] = [label, summary];
  }
});

test('a code is a percent or an amount; anything else is refused', async () => {
  const { send } = fakeStripe();
  const refused = adjustment => ensureOfferPaymentLinks({ offers: [], adjustments: [{ id: 'a', code: 'X', adjustment }], owner: 'bakery-a', afterPaymentUrl: 'https://app.example/', send });
  for (const adjustment of [{ kind: 'fixed', amount_cents: 500 }, { kind: 'amount_cents', amount_cents: 500 }, { kind: 'amount_cents', amount_cents: 0, currency: 'usd' }, { kind: 'percent', percent: 0 }]) {
    await assert.rejects(refused(adjustment), /percent adjustment between 1 and 100, or an amount_cents adjustment/);
  }
});

test('an amount code takes a fixed sum off; a code made from a row no row lists stops working, and comes back when listed again', async () => {
  const { state, send } = fakeStripe();
  await setup(send, { adjustments: [] });
  const friend = { id: 'adj:friend', code: 'FRIEND25', label: '$25 off', scope: { offer_ids: ['offer:member'] }, adjustment: { kind: 'amount_cents', amount_cents: 2500, currency: 'USD' }, duration: 'once', restrictions: { first_time_transaction: true } };
  const old = { id: 'adj:old', code: 'FRIEND', scope: { offer_ids: ['offer:member'] }, adjustment: { kind: 'percent', percent: 100 }, duration: 'once' };
  const sync = adjustments => ensureOfferCodes({ adjustments, offers, owner: 'bakery-a', send });

  await sync([old]);
  // A code made some other way (no row behind it) is never touched.
  state.promotion_codes.push({ id: 'promo_proof', code: 'PROOF', active: true, metadata: { owner: 'bakery-a', purpose: 'proof' } });
  const first = await sync([friend]);
  const coupon = state.coupons.at(-1);
  assert.deepEqual([coupon.amount_off, coupon.currency, coupon.duration, coupon.percent_off], ['2500', 'usd', 'once', undefined]);
  assert.deepEqual(first.retired, ['FRIEND']);
  assert.deepEqual(state.promotion_codes.map(code => [code.code, code.active]), [['FRIEND', false], ['PROOF', true], ['FRIEND25', true]]);

  // Again: nothing new is made and nothing more is retired.
  const again = await sync([friend]);
  assert.deepEqual([state.coupons.length, state.promotion_codes.length, again.retired], [2, 3, []]);

  // Listed again, the old code is made usable again rather than made twice.
  await sync([friend, old]);
  assert.deepEqual(state.promotion_codes.map(code => [code.code, code.active]), [['FRIEND', true], ['PROOF', true], ['FRIEND25', true]]);
});

test('a code comes off only the offers its row names; an unscoped code made earlier is replaced with the uses it had left', async () => {
  const { state, send } = fakeStripe();
  await setup(send, { adjustments: [] });
  const member = state.prices.find(price => price.lookup_key === 'price:member-monthly').product;
  // A 100% code made before codes were scoped: its coupon comes off every product, the $600 session too.
  state.coupons.push({ id: 'coupon_old', percent_off: '100' });
  state.promotion_codes.push({ id: 'promo_old', code: 'REVIEW', active: true, times_redeemed: 3, max_redemptions: 10, promotion: { type: 'coupon', coupon: 'coupon_old' }, metadata: { owner: 'bakery-a', adjustment_id: 'adj:review' } });
  const review = { id: 'adj:review', code: 'REVIEW', scope: { offer_ids: ['offer:member'] }, adjustment: { kind: 'percent', percent: 100 }, max_redemptions: 10 };
  const sync = adjustments => ensureOfferCodes({ adjustments, offers, owner: 'bakery-a', send });
  const { codes } = await sync([review]);
  assert.deepEqual(state.coupons.at(-1).applies_to, { products: [member] }, 'the new coupon comes off the member plan alone');
  assert.deepEqual(state.promotion_codes.map(code => [code.id, code.active]), [['promo_old', false], [state.promotion_codes.at(-1).id, true]]);
  assert.deepEqual(codes, [{ code: 'REVIEW', active: true, used: 0, max: 7 }], 'the seven uses left carry over');
  const before = [state.coupons.length, state.promotion_codes.length];
  await sync([review]);
  assert.deepEqual([state.coupons.length, state.promotion_codes.length], before, 'a scoped code is kept as it is');
  // A row naming no offer, or only offers with nothing on sale, would come off everything, so it is refused.
  await assert.rejects(sync([{ ...review, scope: {} }]), /names no offer/);
  await assert.rejects(sync([{ ...review, scope: { offer_ids: ['offer:free'] } }]), /no price on sale/);
});

test('coupon terms and promotion restrictions are reconciled while redemptions and remaining caps carry forward', async () => {
  const { state, send } = fakeStripe();
  await setup(send, { adjustments: [] });
  const base = { id: 'adj:terms', code: 'TERMS', scope: { offer_ids: ['offer:member'] }, adjustment: { kind: 'percent', percent: 20 }, duration: 'repeating', duration_in_months: 3, max_redemptions: 10, restrictions: { first_time_transaction: true } };
  const sync = row => ensureOfferCodes({ adjustments: [row], offers, owner: 'bakery-a', send });
  await sync(base);
  const code = state.promotion_codes.find(row => row.code === 'TERMS');
  code.times_redeemed = 3;
  const beforeCoupons = state.coupons.length;
  await sync({ ...base, adjustment: { kind: 'percent', percent: 25 }, duration_in_months: 4 });
  assert.equal(code.active, false);
  const replacement = state.promotion_codes.filter(row => row.code === 'TERMS').at(-1);
  assert.equal(replacement.max_redemptions, 7);
  assert.equal(state.coupons.length, beforeCoupons + 1);
  replacement.times_redeemed = 2;
  await sync({ ...base, adjustment: { kind: 'percent', percent: 25 }, duration_in_months: 4, restrictions: { first_time_transaction: false } });
  assert.equal(replacement.active, false);
  assert.equal(state.promotion_codes.filter(row => row.code === 'TERMS').at(-1).max_redemptions, 5);
  const foreign = { id: 'promo_foreign', code: 'TAKEN', active: true, times_redeemed: 0, max_redemptions: null, metadata: { owner: 'bakery-b' }, promotion: { type: 'coupon', coupon: 'coupon_foreign' } };
  state.coupons.push({ id: 'coupon_foreign', percent_off: '10', duration: 'forever', applies_to: { products: [] } });
  state.promotion_codes.push(foreign);
  await assert.rejects(sync({ ...base, code: 'TAKEN' }), /active under another Stripe integration/);
  assert.equal(foreign.active, true, 'a foreign integration code is untouched');
});

test('Stripe form numbers and default restriction fields normalize to the configured terms', async () => {
  const { state, send } = fakeStripe();
  await setup(send, { adjustments: [] });
  const row = { id: 'adj:numeric', code: 'NUMERIC', scope: { offer_ids: ['offer:member'] }, adjustment: { kind: 'percent', percent: 15 }, restrictions: { first_time_transaction: false, minimum_amount: 1250, minimum_amount_currency: 'USD' } };
  const sync = () => ensureOfferCodes({ adjustments: [row], offers, owner: 'bakery-a', send });
  await sync();
  const originalCounts = [state.coupons.length, state.promotion_codes.length];
  await sync();
  assert.deepEqual([state.coupons.length, state.promotion_codes.length], originalCounts);
  row.restrictions.minimum_amount = 1500;
  await sync();
  assert.equal(state.promotion_codes.filter(code => code.code === 'NUMERIC' && code.active).length, 1);
  assert.equal(state.promotion_codes.filter(code => code.code === 'NUMERIC').length, 2);
});

test('a failed or lost replacement response retries from owned history without losing caps or duplicating the code', async () => {
  const { state, send } = fakeStripe();
  await setup(send, { adjustments: [] });
  const oldCoupon = { id: 'coupon_retry_old', percent_off: '10', duration: 'forever', name: 'RETRY', applies_to: { products: [] } };
  state.coupons.push(oldCoupon);
  const previous = { id: 'promo_retry_old', code: 'RETRY', active: true, times_redeemed: 3, max_redemptions: 10, restrictions: {}, promotion: { type: 'coupon', coupon: oldCoupon.id }, metadata: { owner: 'bakery-a', adjustment_id: 'adj:retry' } };
  state.promotion_codes.push(previous);
  const row = { id: 'adj:retry', code: 'RETRY', scope: { offer_ids: ['offer:member'] }, adjustment: { kind: 'percent', percent: 30 }, max_redemptions: 10 };
  const sync = () => ensureOfferCodes({ adjustments: [row], offers, owner: 'bakery-a', send });

  state.failPromotionCreate = true;
  await assert.rejects(sync(), /simulated promotion-code create refusal/);
  assert.equal(previous.active, false, 'old code was already stopped before create failed');
  await sync();
  const current = state.promotion_codes.filter(code => code.code === 'RETRY').at(-1);
  assert.deepEqual([current.max_redemptions, current.metadata.redemptions_carried], [7, '3']);
  current.times_redeemed = 2;

  row.adjustment.percent = 40;
  state.losePromotionCreateResponse = true;
  await assert.rejects(sync(), /simulated lost promotion-code response/);
  const countAfterLostResponse = state.promotion_codes.length;
  await sync();
  const latest = state.promotion_codes.filter(code => code.code === 'RETRY').at(-1);
  assert.equal(state.promotion_codes.length, countAfterLostResponse, 'retry discovers the created code instead of creating another');
  assert.deepEqual([latest.max_redemptions, latest.metadata.redemptions_carried, latest.active], [5, '5', true]);
});

test('invalid coupon caps and durations are refused before provider writes', async () => {
  const { state, send } = fakeStripe();
  await setup(send, { adjustments: [] });
  const base = { id: 'adj:invalid', code: 'INVALID', scope: { offer_ids: ['offer:member'] }, adjustment: { kind: 'percent', percent: 10 } };
  const sync = row => ensureOfferCodes({ adjustments: [row], offers, owner: 'bakery-a', send });
  const before = [state.coupons.length, state.promotion_codes.length];
  await assert.rejects(sync({ ...base, max_redemptions: 0 }), /positive whole max_redemptions/);
  await assert.rejects(sync({ ...base, duration: 'repeating' }), /duration_in_months as a positive whole month count/);
  await assert.rejects(sync({ ...base, duration: 'once', duration_in_months: 2 }), /only for a repeating coupon/);
  assert.deepEqual([state.coupons.length, state.promotion_codes.length], before);
});

test('an option that cannot be sold is refused before any call', () => {
  assert.throws(() => pricedOptions([{ id: 'o', price_options: [{ id: 'p', amount_cents: 100, currency: 'usd', payment_timing: 'subscription', interval: 'fortnight' }] }]), /day, week, month or year/);
  assert.throws(() => pricedOptions([{ id: 'o', price_options: [{ amount_cents: 100 }] }]), /without an id or currency/);
  assert.throws(() => pricedOptions([{ id: 'o', price_options: [{ id: 'p', amount_cents: 100, currency: 'usd', quantity: { minimum: 0 } }] }]), /positive whole numbers/);
});

test('a trial option starts with its free days and an offer\'s checkout note sits by the pay button, on a new link and an existing one', async () => {
  const { state, send } = fakeStripe();
  const trialOffers = [
    { id: 'offer:member', label: 'Member', checkout_note: 'The baker sees what you order.', price_options: [{ id: 'price:member-monthly', amount_cents: 4000, currency: 'usd', payment_timing: 'subscription', interval: 'month', trial_days: 7 }] },
    { id: 'offer:session', label: 'Session', price_options: [{ id: 'price:session', amount_cents: 60000, currency: 'usd', payment_timing: 'one_time', trial_days: 7 }] },
  ];
  const run = () => ensureOfferPaymentLinks({ offers: trialOffers, owner: 'bakery-a', afterPaymentUrl: 'https://app.example/', send });
  await run();
  const [member, session] = state.payment_links;
  assert.equal(member.subscription_data.trial_period_days, '7');
  assert.equal(member.custom_text.submit.message, 'The baker sees what you order.');
  assert.equal(session.subscription_data, undefined, 'a one-time payment has no trial');
  assert.equal(session.custom_text, undefined);
  await run();
  assert.equal(state.payment_links.length, 2, 'the second setup keeps the same links');
  assert.equal(member.updates.at(-1).subscription_data.trial_period_days, '7');
  assert.equal(member.updates.at(-1).custom_text.submit.message, 'The baker sees what you order.');
});

test('a first month split into today and next week sells today\'s part as a one-time item beside the plan, with its trial', async () => {
  const { state, send } = fakeStripe();
  const split = { id: 'offer:split', label: 'Plan', price_options: [{ id: 'price:split', amount_cents: 10000, currency: 'usd', payment_timing: 'subscription', interval: 'month', trial_days: 7,
    charges: [{ amount_cents: 1000, days_after_signup: 0 }, { amount_cents: 9000, days_after_signup: 7 }], repeat: { amount_cents: 10000, interval: 'month' }, quantity: { minimum: 1 } }] };
  await ensureOfferPaymentLinks({ offers: [split], adjustments: [], owner: 'bakery-a', afterPaymentUrl: 'https://app.example/', send });
  const link = state.payment_links.find(row => row.metadata?.offer_id === 'offer:split');
  const [plan, today] = link.line_items;
  assert.equal(state.prices.find(price => price.id === plan.price).unit_amount, 10000);
  const once = state.prices.find(price => price.id === today.price);
  assert.deepEqual([once.unit_amount, once.recurring, once.lookup_key, today.quantity], [1000, null, 'price:split:today', '1']);
  assert.equal(link.subscription_data.trial_period_days, '7');
  assert.equal(link.metadata.today_price, once.id);
  const links = state.payment_links.length;
  await ensureOfferPaymentLinks({ offers: [split], adjustments: [], owner: 'bakery-a', afterPaymentUrl: 'https://app.example/', send });
  assert.equal(state.payment_links.length, links, 'a second setup keeps the same link');
});

test('retiring a code carries the provider-confirmed redemption count, including a use after the initial read', async () => {
  const { state, send } = fakeStripe(); await setup(send, { adjustments: [] });
  const row = { id: 'adj:race', code: 'RACE', scope: { offer_ids: ['offer:member'] }, adjustment: { kind: 'percent', percent: 10 }, max_redemptions: 10 };
  await ensureOfferCodes({ adjustments: [row], offers, owner: 'bakery-a', send });
  const prior = state.promotion_codes.at(-1); prior.times_redeemed = 3;
  const racingSend = async request => { if (request.operation_id === 'operation:update-promotion-code' && new URLSearchParams(request.body).get('active') === 'false') prior.times_redeemed = 4; return send(request); };
  await ensureOfferCodes({ adjustments: [{ ...row, adjustment: { kind: 'percent', percent: 20 } }], offers, owner: 'bakery-a', send: racingSend });
  assert.equal(state.promotion_codes.at(-1).max_redemptions, 6);
});

test('a code row read by the one code reader keeps its scope, duration, cap and restrictions on the provider', async () => {
  const { readCheckoutCodeAdjustments } = await import('../read-data/read-code-adjustments.ts');
  const { state, send } = fakeStripe();
  await setup(send, { adjustments: [] });
  const [row] = readCheckoutCodeAdjustments([{ kind: 'checkout-code-adjustment', id: 'adj:baker', code: 'baker 10', label: 'Baker friend', state: 'active',
    applies_to: { offer_ids: ['offer:member'] }, adjustment: { kind: 'amount_cents', amount_cents: 1000, currency: 'USD' }, duration: 'repeating', duration_in_months: 2,
    max_redemptions: 5, restrictions: { first_time_transaction: true } }]);
  await ensureOfferCodes({ adjustments: [row], offers, owner: 'bakery-a', send });
  const coupon = state.coupons.at(-1);
  const member = state.prices.find(price => price.lookup_key === 'price:member-monthly').product;
  assert.deepEqual([coupon.amount_off, coupon.currency, coupon.duration, coupon.duration_in_months, coupon.applies_to.products], ['1000', 'usd', 'repeating', '2', [member]]);
  const code = state.promotion_codes.at(-1);
  assert.deepEqual([code.code, code.max_redemptions, code.restrictions.first_time_transaction], ['BAKER10', 5, 'true']);
});
