// parts/stripe-payment-provider/process/ensure-offer-payment-links.mjs
//
// Make Stripe hold one lasting payment link for every priced option of every commercial-offer row, plus the
// plan-management page, the webhook and any checkout-code-adjustment codes, and return only the public
// addresses and the webhook signing secret. Offers stay DATA: adding an offer or a price option is one row in
// the app's `commercial-offer-records`, and this module never names an offer, a price or an app.
//
// A price option with `seats` ({ minimum, maximum }) is sold with a count the buyer picks at checkout (Stripe's adjustable
// quantity); every other option sells one. A subscription option's `trial_days` gives that many free days before the
// first charge, and an offer's `checkout_note` is shown beside the pay button; its `charges` entry on day 0 is sold as
// a one-time item paid at checkout (chargedToday). An offer's `usage_prices` ({ id, currency,
// interval, unit_amount_decimal, meter: { event_name, display_name } }) are prices billed by what was used: each gets a
// billing meter found by its event name (made once) and a counted price that names it, found again by its lookup key
// (the usage price's id). A payment link sells fixed items only, so a counted price is added to a subscription after
// checkout by its owner (the answer's `usage_prices` names each one's price).
//
// Why payment links: a link is created once, while the caller briefly holds a Stripe key, and then works with
// no key at all. A host that must never keep a provider key (a Worker that is handed one at deploy time and
// discards it) can still sell every offer row.
//
// Every call is built by `buildStripeHttpRequest` from `data/stripe-operation-map.json` rows and handed to the
// caller's `send`, which binds the credential and returns the decoded JSON reply (throwing on a non-2xx
// reply). This module holds no secret and makes no network call itself.
//
// Idempotent: a price is found again by its lookup key (the price option id), a link by its metadata, a
// promotion code by its code (one made from a row no row lists any more stops being usable), the plan page by its
// metadata. The webhook is the exception: Stripe returns its signing secret only when it is created, so the caller's
// earlier endpoint is deleted and created again.
//
//   ensureOfferPaymentLinks({ offers, codeOffers, adjustments, owner, afterPaymentUrl, webhook: { url, events }, send, retireLinksWhere })
//   (codeOffers: the offer rows a code may come off, sold or not, so a code keeps working for people already on an offer
//   no longer sold; `offers` when left out)
//   → { links: [{ offer_id, price_option_id, url }], retired: [url], portal_url, webhook_secret, codes: [{ code, active, used, max }], retired_codes: [code],
//       usage_prices: [{ offer_id, price_option_id, price, meter, event_name }] }
//   ensureOfferCodes({ adjustments, offers, owner, send }) → { codes, retired }: only the codes, for a run that changes nothing else;
//   each code comes off only the products of the offers its row's applies_to.offer_ids names.
import { quantityForCheckout } from './quantity-for-checkout.mjs';
import { buildStripeHttpRequest } from './build-stripe-http-request.mjs';
import { CURRENT_STRIPE_API_VERSION } from './stripe-request-mapper.mjs';
import { blake3 } from '@noble/hashes/blake3.js';
import { bytesToHex } from '@noble/hashes/utils.js';

const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);

// Stripe's interval names for the offer row's `interval`; an unknown interval is refused, never guessed.
const INTERVALS = new Set(['day', 'week', 'month', 'year']);

function call(send, operationId, subject, { ref, idempotencyKey } = {}) {
  return send(buildStripeHttpRequest({
    operation_id: operationId,
    input_facts: { ...(subject ? { operation_subject: subject } : {}), ...(ref ? { provider_object_ref: ref } : {}) },
    ...(idempotencyKey ? { idempotency_key: idempotencyKey } : {}),
  }));
}

/** Complete provider pages before reconciling a collection. A repeated/absent cursor is a failure, never completion. */
async function allPages(send, operationId, subject, keep = () => true) {
  const items = new Map();
  const cursors = new Set();
  let after;
  for (;;) {
    const page = await call(send, operationId, { ...subject, ...(after ? { starting_after: after } : {}) });
    if (!Array.isArray(page?.data)) throw new Error('The payment provider collection could not be read.');
    for (const item of page.data) {
      if (typeof item?.id !== 'string' || !item.id) throw new Error('A payment provider collection item has no identity.');
      if (keep(item)) items.set(item.id, item);
    }
    if (page.has_more !== true) return [...items.values()];
    const next = page.data.at(-1)?.id;
    if (!next || cursors.has(next)) throw new Error('The payment provider collection cursor did not advance.');
    cursors.add(next); after = next;
  }
}

/** Every priced option of every offer row, each with the fields Stripe needs; rows without a price are skipped. */
export function pricedOptions(offers) {
  const options = [];
  for (const offer of offers ?? []) {
    if (!object(offer) || typeof offer.id !== 'string') continue;
    for (const option of offer.price_options ?? []) {
      if (!Number.isInteger(option?.amount_cents) || option.amount_cents <= 0) continue;
      if (typeof option.id !== 'string' || typeof option.currency !== 'string') throw new Error(`${offer.id} has a price option without an id or currency.`);
      const recurring = option.payment_timing === 'subscription';
      if (recurring && !INTERVALS.has(option.interval)) throw new Error(`${option.id} is a subscription without a day, week, month or year interval.`);
      quantityForCheckout(option); // Validate all quantities before any provider call.
      options.push({ offer, option, recurring });
    }
  }
  return options;
}

async function ensurePrice(send, owner, { offer, option, recurring }) {
  const found = (await call(send, 'operation:find-prices', { lookup_keys: [option.id], active: true, limit: 1, expand: ['data.product'] })).data?.[0];
  if (found && found.unit_amount === option.amount_cents && found.currency === option.currency.toLowerCase()
    && (found.recurring?.interval ?? null) === (recurring ? option.interval : null)) {
    // The product a buyer sees on the checkout page follows the offer row's words when the row is reworded.
    const shown = { name: offer.label, description: offer.summary || '' };
    if (object(found.product) && (found.product.name !== shown.name || (found.product.description ?? '') !== shown.description)) {
      await call(send, 'operation:update-product', shown, { ref: found.product.id });
    }
    return found;
  }
  // A changed amount gets a new price that takes the lookup key over; buyers already paying keep their old price.
  const product = await call(send, 'operation:create-product', { name: offer.label, description: offer.summary || undefined, metadata: { owner, offer_id: offer.id } });
  return call(send, 'operation:create-price', {
    product: product.id,
    unit_amount: option.amount_cents,
    currency: option.currency.toLowerCase(),
    ...(recurring ? { recurring: { interval: option.interval } } : {}),
    lookup_key: option.id,
    transfer_lookup_key: true,
    metadata: { owner, offer_id: offer.id, price_option_id: option.id },
  });
}

// One billing meter per event name: found again among the active meters, made the first time.
async function ensureMeter(send, meters, meter) {
  const found = meters.find(item => item.event_name === meter.event_name);
  if (found) return found;
  const made = await call(send, 'operation:create-meter', {
    display_name: meter.display_name, event_name: meter.event_name,
    default_aggregation: { formula: 'sum' },
    customer_mapping: { type: 'by_id', event_payload_key: 'stripe_customer_id' },
    value_settings: { event_payload_key: 'value' },
  });
  meters.push(made);
  return made;
}

// A counted price billed by what its meter summed over each period. A changed amount or meter gets a new price that takes
// the lookup key over; subscriptions already carrying the old one keep it.
async function ensureUsagePrice(send, owner, offer, usage, meter) {
  if (typeof usage?.id !== 'string' || typeof usage.currency !== 'string' || !INTERVALS.has(usage.interval) || !(Number(usage.unit_amount_decimal) > 0)) {
    throw new Error(`${offer.id} has a usage price without an id, currency, day/week/month/year interval or amount above zero.`);
  }
  const found = (await call(send, 'operation:find-prices', { lookup_keys: [usage.id], active: true, limit: 1 })).data?.[0];
  if (found && Number(found.unit_amount_decimal) === Number(usage.unit_amount_decimal) && found.currency === usage.currency.toLowerCase()
    && found.recurring?.interval === usage.interval && found.recurring?.meter === meter.id) return found;
  const basis = { owner, offer: offer.id, usage: usage.id, amount: usage.unit_amount_decimal, currency: usage.currency.toLowerCase(), interval: usage.interval, meter: meter.id };
  const product = await call(send, 'operation:create-product', { name: usage.meter.display_name, metadata: { owner, offer_id: offer.id } },
    { idempotencyKey: idempotencyKey({ ...basis, name: usage.meter.display_name, object: 'usage-product' }) });
  return call(send, 'operation:create-price', {
    product: product.id,
    currency: usage.currency.toLowerCase(),
    unit_amount_decimal: usage.unit_amount_decimal,
    recurring: { interval: usage.interval, usage_type: 'metered', meter: meter.id },
    lookup_key: usage.id,
    transfer_lookup_key: true,
    metadata: { owner, offer_id: offer.id, price_option_id: usage.id },
  }, { idempotencyKey: idempotencyKey({ ...basis, product: product.id, object: 'usage-price' }) });
}

/** What a subscription option takes at checkout before its trial ends (`charges` entry on day 0), in cents, or 0. */
export function chargedToday(option) {
  const today = (option?.charges ?? []).find(charge => charge?.days_after_signup === 0);
  return option?.payment_timing === 'subscription' && Number.isInteger(today?.amount_cents) && today.amount_cents > 0 ? today.amount_cents : 0;
}

async function ensureLink(send, owner, afterPaymentUrl, priced, price, existing) {
  const { offer, option, recurring } = priced;
  const quantity = quantityForCheckout(option);
  const quantityShape = quantity ? JSON.stringify(quantity) : null;
  // A subscription whose `charges` take something on the day it starts sells that amount as a second, one-time item,
  // paid at checkout while the trial runs; what is taken off the first renewal is the caller's (src/payment.mjs).
  const today = recurring ? chargedToday(option) : 0;
  const todayPrice = today ? await ensurePrice(send, owner, { offer, option: { id: `${option.id}:today`, amount_cents: today, currency: option.currency }, recurring: false }) : null;
  const quote = typeof offer.usage_quote === 'string' && offer.usage_quote ? { usage_quote: offer.usage_quote } : {};
  const metadata = { owner, offer_id: offer.id, price_option_id: option.id, price: price.id, ...quote, ...(quantityShape ? { quantity_shape: quantityShape } : {}), ...(todayPrice ? { today_price: todayPrice.id } : {}) };
  // A subscription option with `trial_days` starts with that many free days; an offer's `checkout_note` is the line
  // the buyer reads beside the pay button (what they agree to by paying).
  const trial = recurring && Number.isInteger(option.trial_days) && option.trial_days > 0 ? { trial_period_days: option.trial_days } : {};
  const note = typeof offer.checkout_note === 'string' && offer.checkout_note ? { custom_text: { submit: { message: offer.checkout_note } } } : {};
  const settings = {
    allow_promotion_codes: true,
    ...note,
    // The offer catalog can include in-person services. Stripe Managed Payments accepts only
    // eligible automated digital products, so these links use ordinary Stripe Payments.
    managed_payments: { enabled: false },
    after_completion: { type: 'redirect', redirect: { url: new URL(offer.post_purchase_route_path || '/', afterPaymentUrl).href } },
    // Collect a card even when a trial or promotion makes today's total zero, so the subscription can renew.
    ...(recurring
      ? { payment_method_collection: 'always', subscription_data: { ...trial, metadata: { owner, offer_id: offer.id, price_option_id: option.id, ...quote } } }
      : { customer_creation: 'always', payment_intent_data: { metadata: { owner, offer_id: offer.id, price_option_id: option.id } } }),
  };
  const found = existing.find(link => link.metadata?.owner === owner && link.metadata?.price === price.id
    && (link.metadata?.usage_quote ?? null) === (offer.usage_quote ?? null));
  if (found && ((found.metadata?.quantity_shape ?? null) === quantityShape) && (found.metadata?.today_price ?? null) === (todayPrice?.id ?? null)) {
    return call(send, 'operation:update-payment-link', {
      allow_promotion_codes: settings.allow_promotion_codes, after_completion: settings.after_completion, ...note,
      ...(recurring ? { payment_method_collection: 'always' } : {}),
      ...(recurring && trial.trial_period_days ? { subscription_data: { trial_period_days: trial.trial_period_days } } : {}),
    }, { ref: found.id });
  }
  // A price option that sells seats (`seats: { minimum, maximum }`) lets the buyer pick how many at checkout.
  const adjustable = quantity ? { adjustable_quantity: { enabled: true, ...quantity } } : {};
  const subject = { line_items: [{ price: price.id, quantity: quantity?.minimum ?? 1, ...adjustable }, ...(todayPrice ? [{ price: todayPrice.id, quantity: 1 }] : [])], metadata, ...settings };
  return call(send, 'operation:create-payment-link', subject, offer.usage_quote ? { idempotencyKey: idempotencyKey({ object: 'quoted-payment-link', subject }) } : undefined);
}

// What a checkout-code-adjustment row's `adjustment` takes off, as Stripe coupon fields: `{ kind: 'percent', percent }`
// (1 to 100) or `{ kind: 'amount', amount_cents, currency }` (a fixed amount in the currency's smallest unit).
const COUPON_FIELDS = {
  percent: ({ percent }) => (percent > 0 && percent <= 100 ? { percent_off: percent } : null),
  amount: ({ amount_cents: cents, currency }) => (Number.isInteger(cents) && cents > 0 && typeof currency === 'string' && currency ? { amount_off: cents, currency: currency.toLowerCase() } : null),
};

const sameSet = (a, b) => Array.isArray(a) && a.length === b.length && [...a].sort().every((item, index) => item === b[index]);
const stableJson = value => Array.isArray(value) ? `[${value.map(stableJson).join(',')}]`
  : value && typeof value === 'object' ? `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(',')}}`
    : JSON.stringify(value);
const idempotencyKey = value => `1f:${bytesToHex(blake3(new TextEncoder().encode(stableJson(value))))}`;

function normalizeRestrictions(value, provider = false) {
  if (value !== undefined && !object(value)) throw new Error('Code restrictions must be an object.');
  const restrictions = value ?? {};
  if (restrictions.first_time_transaction !== undefined && typeof restrictions.first_time_transaction !== 'boolean' && !(provider && ['true', 'false'].includes(restrictions.first_time_transaction))) throw new Error('first_time_transaction must be true or false.');
  const amount = restrictions.minimum_amount;
  if (amount !== undefined && amount !== null && (!Number.isSafeInteger(Number(amount)) || Number(amount) < 0)) throw new Error('minimum_amount must be a nonnegative whole amount.');
  const currency = restrictions.minimum_amount_currency;
  if ((amount !== undefined && amount !== null && Number(amount) > 0) && (typeof currency !== 'string' || !currency)) throw new Error('minimum_amount_currency is required with minimum_amount.');
  return {
    compare: {
      first_time_transaction: restrictions.first_time_transaction === true || provider && restrictions.first_time_transaction === 'true',
      minimum_amount: amount == null ? null : Number(amount),
      minimum_amount_currency: amount == null || Number(amount) === 0 ? null : currency.toLowerCase(),
    },
    payload: {
      ...(restrictions.first_time_transaction === true ? { first_time_transaction: true } : {}),
      ...(amount != null && Number(amount) > 0 ? { minimum_amount: Number(amount), minimum_amount_currency: currency.toLowerCase() } : {}),
    },
  };
}

function validCouponTerms(adjustment) {
  const duration = adjustment.duration ?? 'forever';
  if (!['forever', 'once', 'repeating'].includes(duration)) throw new Error(`Code ${adjustment.code} has an unsupported coupon duration.`);
  if (duration === 'repeating' && (!Number.isInteger(adjustment.duration_in_months) || adjustment.duration_in_months < 1)) {
    throw new Error(`Code ${adjustment.code} needs duration_in_months as a positive whole month count for a repeating coupon.`);
  }
  if (duration !== 'repeating' && adjustment.duration_in_months !== undefined) throw new Error(`Code ${adjustment.code} may set duration_in_months only for a repeating coupon.`);
  if (adjustment.max_redemptions !== undefined && (!Number.isSafeInteger(adjustment.max_redemptions) || adjustment.max_redemptions < 1)) {
    throw new Error(`Code ${adjustment.code} needs a positive whole max_redemptions value.`);
  }
  return duration;
}

// The products a row's code may take money off: those of the offers its `applies_to.offer_ids` names, found by their
// price options' lookup keys. A Stripe coupon with no products comes off everything a checkout sells, so a 100% code
// meant for one offer made every other offer free; a row that names no offer, or offers with no price on sale, is refused.
async function productsFor(send, offers, adjustment) {
  const ids = adjustment.applies_to?.offer_ids;
  if (!Array.isArray(ids) || !ids.length) throw new Error(`Code ${adjustment.code} names no offer in applies_to.offer_ids, so it would come off every offer.`);
  const keys = pricedOptions((offers ?? []).filter(offer => ids.includes(offer?.id))).map(row => row.option.id);
  const products = new Set();
  for (let at = 0; at < keys.length; at += 10) {
    for (const price of (await call(send, 'operation:find-prices', { lookup_keys: keys.slice(at, at + 10), active: true, limit: 10 })).data ?? []) {
      products.add(typeof price.product === 'string' ? price.product : price.product?.id);
    }
  }
  if (!products.size) throw new Error(`Code ${adjustment.code} names offers with no price on sale: ${ids.join(', ')}.`);
  return [...products].sort();
}

async function ensureCode(send, owner, adjustment, offers) {
  const off = COUPON_FIELDS[adjustment.adjustment?.kind]?.(adjustment.adjustment) ?? null;
  if (!off) throw new Error(`Code ${adjustment.code} needs a percent adjustment between 1 and 100, or an amount adjustment with a whole positive amount_cents and a currency.`);
  const duration = validCouponTerms(adjustment);
  const restrictions = normalizeRestrictions(adjustment.restrictions);
  const desiredMax = Number.isInteger(adjustment.max_redemptions) ? adjustment.max_redemptions : null;
  const products = await productsFor(send, offers, adjustment);
  const matches = await allPages(send, 'operation:find-promotion-codes', { code: adjustment.code, limit: 100, expand: ['data.promotion.coupon.applies_to'] });
  if (matches.some(code => code.active && code.metadata?.owner !== owner)) throw new Error(`Code ${adjustment.code} is active under another Stripe integration.`);
  const owned = matches.filter(code => code.metadata?.owner === owner && code.metadata?.adjustment_id === adjustment.id);
  if (matches.some(code => code.metadata?.owner === owner && code.metadata?.adjustment_id && code.metadata.adjustment_id !== adjustment.id)) throw new Error(`Code ${adjustment.code} is assigned to another adjustment in this integration.`);
  const newestFirst = [...owned].sort((a, b) => Number(b.metadata?.generation ?? 0) - Number(a.metadata?.generation ?? 0)
    || Number(b.created ?? 0) - Number(a.created ?? 0) || String(b.id).localeCompare(String(a.id)));
  const found = newestFirst.find(code => code.active) ?? newestFirst[0];
  const coupon = found?.promotion?.coupon;
  const foundMax = Number.isInteger(found?.max_redemptions) ? found.max_redemptions : null;
  const carriedUses = Number(found?.metadata?.redemptions_carried ?? 0);
  let used = carriedUses + Number(found?.times_redeemed ?? 0);
  const couponMatches = coupon && (coupon.percent_off == null ? null : Number(coupon.percent_off)) === (off.percent_off ?? null)
    && (coupon.amount_off == null ? null : Number(coupon.amount_off)) === (off.amount_off ?? null)
    && (coupon.currency ?? null) === (off.currency ?? null)
    && coupon.duration === duration
    && (coupon.duration_in_months == null ? null : Number(coupon.duration_in_months)) === (adjustment.duration_in_months ?? null)
    && (coupon.name ?? null) === (adjustment.label ?? adjustment.code)
    && sameSet(coupon.applies_to?.products, products);
  const codeMatches = found && couponMatches
    && normalizeRestrictions(found.restrictions, true).compare.first_time_transaction === restrictions.compare.first_time_transaction
    && normalizeRestrictions(found.restrictions, true).compare.minimum_amount === restrictions.compare.minimum_amount
    && normalizeRestrictions(found.restrictions, true).compare.minimum_amount_currency === restrictions.compare.minimum_amount_currency
    && (desiredMax === null ? foundMax === null : foundMax === Math.max(0, desiredMax - carriedUses));
  if (found && codeMatches) {
    const expired = Number.isFinite(found.expires_at) && found.expires_at > 0 && found.expires_at * 1000 <= Date.now();
    const exhausted = foundMax !== null && Number(found.times_redeemed ?? 0) >= foundMax || desiredMax !== null && used >= desiredMax;
    if (expired || exhausted) {
      if (found.active) await call(send, 'operation:update-promotion-code', { active: false }, { ref: found.id });
      return { ...found, active: false };
    }
    // A still-valid code this owner retired earlier comes back when its row lists it again.
    return found.active === false ? call(send, 'operation:update-promotion-code', { active: true }, { ref: found.id }) : found;
  }
  // A code whose coupon comes off other products (made before codes were scoped, or before the row's offers changed)
  // stops, and a code scoped to the row's offers takes its place with the uses it had left.
  if (found?.active) {
    const retired = await call(send, 'operation:update-promotion-code', { active: false }, { ref: found.id });
    if (retired.active !== false || !Number.isSafeInteger(retired.times_redeemed) || retired.times_redeemed < 0) throw new Error('The retired code redemption count could not be confirmed.');
    used = carriedUses + retired.times_redeemed;
  }
  const left = desiredMax === null ? null : desiredMax - used;
  if (left !== null && left < 1) return { ...found, active: false };
  const generation = Number(found?.metadata?.generation ?? 0) + 1;
  const predecessor = found?.id ?? 'initial';
  const terms = { ...off, duration, ...(duration === 'repeating' ? { duration_in_months: adjustment.duration_in_months } : {}), name: adjustment.label ?? adjustment.code, applies_to: { products }, restrictions: restrictions.compare, max_redemptions: desiredMax };
  const termsKey = { owner, adjustment_id: adjustment.id, predecessor, generation, terms };
  const madeCoupon = await call(send, 'operation:create-coupon', { ...off, duration, ...(duration === 'repeating' ? { duration_in_months: adjustment.duration_in_months } : {}), name: adjustment.label ?? adjustment.code, applies_to: { products }, metadata: { owner, adjustment_id: adjustment.id, generation: String(generation) } }, { idempotencyKey: idempotencyKey({ ...termsKey, object: 'coupon' }) });
  return call(send, 'operation:create-promotion-code', {
    promotion: { type: 'coupon', coupon: madeCoupon.id },
    code: adjustment.code,
    ...(left !== null ? { max_redemptions: left } : {}),
    // Stripe's own limits on who may use the code, as the row states them (first_time_transaction, minimum_amount).
    ...(Object.keys(restrictions.payload).length ? { restrictions: restrictions.payload } : {}),
    metadata: { owner, adjustment_id: adjustment.id, redemptions_carried: String(used), generation: String(generation), predecessor },
  }, { idempotencyKey: idempotencyKey({ ...termsKey, coupon: madeCoupon.id, object: 'promotion-code' }) });
}

/**
 * Stripe holds exactly the codes the rows list: each row's code is made (or brought back), coming off only the products
 * of the offers its row names (`offers` are the offer rows it may name), and a code this owner made from a row (its
 * metadata names an adjustment_id) that no row lists any more stops being usable. Codes made some other way (no
 * adjustment_id) are never touched.
 * → { codes: [{ code, active, used, max }], retired: [code] }
 */
export async function ensureOfferCodes({ adjustments = [], offers = [], owner, send }) {
  const codes = [];
  for (const adjustment of adjustments) {
    const code = await ensureCode(send, owner, adjustment, offers);
    codes.push({ code: code.code, active: code.active, used: code.times_redeemed, max: code.max_redemptions });
  }
  const listed = new Set(adjustments.map(adjustment => adjustment.id));
  const retired = [];
  for (const code of await allPages(send, 'operation:find-promotion-codes', { active: true, limit: 100 }, code => code.metadata?.owner === owner && code.metadata?.adjustment_id && !listed.has(code.metadata.adjustment_id))) {
    if (code.metadata?.owner !== owner || !code.metadata?.adjustment_id || listed.has(code.metadata.adjustment_id)) continue;
    await call(send, 'operation:update-promotion-code', { active: false }, { ref: code.id });
    retired.push(code.code);
  }
  return { codes, retired };
}

/** Only prospective counted prices. Existing subscriptions keep their old price
 * IDs; callers may safely prepare a new agreement without rebuilding webhooks,
 * portal settings or retiring any other checkout. */
export async function ensureOfferUsagePrices({ offers, owner, send }) {
  const usagePrices = [];
  const eventNames = new Set((offers ?? []).flatMap(offer => (offer?.usage_prices ?? []).map(usage => usage.meter?.event_name)));
  const meters = eventNames.size ? await allPages(send, 'operation:find-meters', { status: 'active', limit: 100 }, meter => eventNames.has(meter.event_name)) : [];
  for (const offer of offers ?? []) {
    for (const usage of offer?.usage_prices ?? []) {
      const meter = await ensureMeter(send, meters, usage.meter ?? {});
      const price = await ensureUsagePrice(send, owner, offer, usage, meter);
      usagePrices.push({ offer_id: offer.id, price_option_id: usage.id, price: price.id, meter: meter.id, event_name: meter.event_name });
    }
  }
  return usagePrices;
}

/** Prepare an independently identified checkout, leaving every other link and
 * purchased agreement intact. An optional usage_quote is carried by Stripe's
 * subscription metadata, so the seller can read back exactly what was sold. */
export async function ensureOfferCheckoutLinks({ offers, owner, afterPaymentUrl, send }) {
  const existing = await allPages(send, 'operation:find-payment-links', { active: true, limit: 100 }, link => link.metadata?.owner === owner);
  const links = [];
  for (const priced of pricedOptions(offers)) {
    const price = await ensurePrice(send, owner, priced);
    const link = await ensureLink(send, owner, afterPaymentUrl, priced, price, existing);
    links.push({ offer_id: priced.offer.id, price_option_id: priced.option.id, url: link.url, id: link.id });
  }
  return links;
}

export async function ensureOfferPaymentLinks({ offers, codeOffers = offers, adjustments = [], owner, afterPaymentUrl, webhook, send, retireLinksWhere = [] }) {
  if (typeof owner !== 'string' || !owner) throw new Error('owner names whose Stripe objects these are.');
  if (typeof send !== 'function') throw new Error('send delivers one built request and returns its decoded reply.');
  const retiredPattern = link => retireLinksWhere.some(pattern => Object.entries(pattern).every(([key, value]) => link.metadata?.[key] === value));
  const existingLinks = await allPages(send, 'operation:find-payment-links', { active: true, limit: 100 }, link => link.metadata?.owner === owner || retiredPattern(link));
  const links = [];
  for (const priced of pricedOptions(offers)) {
    const price = await ensurePrice(send, owner, priced);
    const link = await ensureLink(send, owner, afterPaymentUrl, priced, price, existingLinks);
    links.push({ offer_id: priced.offer.id, price_option_id: priced.option.id, url: link.url, id: link.id });
  }
  // Prices billed by use: one meter per event name, one counted price per usage row.
  const usagePrices = await ensureOfferUsagePrices({ offers, owner, send });
  // A link this owner made for an option no offer row has any more stops taking payments, as does any link matching
  // a `retireLinksWhere` metadata pattern (links an earlier setup made under other metadata). Past buyers keep what
  // they paid for; nobody new can pay through a link whose offer is gone.
  const current = new Set(links.map(link => link.id));
  const retired = [];
  for (const link of existingLinks) {
    // A separately quoted agreement is immutable until the customer buys it;
    // refreshing the general catalogue cannot rewrite or withdraw its terms.
    if (link.metadata?.usage_quote) continue;
    if (current.has(link.id) || !(link.metadata?.owner === owner || retiredPattern(link))) continue;
    await call(send, 'operation:update-payment-link', { active: false }, { ref: link.id });
    retired.push(link.url);
  }

  const { codes, retired: retiredCodes } = await ensureOfferCodes({ adjustments, offers: codeOffers, owner, send });

  const portals = await allPages(send, 'operation:find-portal-configurations', { active: true, limit: 100 }, item => item.metadata?.owner === owner);
  const portal = portals.find(item => item.metadata?.owner === owner) ?? await call(send, 'operation:create-portal-configuration', {
    features: { subscription_cancel: { enabled: true, mode: 'at_period_end' }, payment_method_update: { enabled: true }, invoice_history: { enabled: true } },
    login_page: { enabled: true },
    metadata: { owner },
  });

  // The signing secret is readable only at creation, so this owner's endpoint (or one at the same address) is replaced.
  for (const hook of await allPages(send, 'operation:find-webhook-endpoints', { limit: 100 }, hook => hook.url === webhook.url || hook.metadata?.owner === owner)) {
    if (hook.url === webhook.url || hook.metadata?.owner === owner) await call(send, 'operation:delete-webhook-endpoint', null, { ref: hook.id });
  }
  // Events are rendered in the endpoint's API version, and the webhook event map reads that version's shape.
  const hook = await call(send, 'operation:create-webhook-endpoint', { url: webhook.url, enabled_events: webhook.events, api_version: CURRENT_STRIPE_API_VERSION, metadata: { owner } });

  return { links: links.map(({ id, ...link }) => link), retired, portal_url: portal.login_page?.url ?? null, portal_configuration: portal.id, webhook_secret: hook.secret, codes, retired_codes: retiredCodes, usage_prices: usagePrices };
}
