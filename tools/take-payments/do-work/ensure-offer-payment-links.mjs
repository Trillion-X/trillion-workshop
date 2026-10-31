// tools/take-payments/do-work/ensure-offer-payment-links.mjs
//
// Make Stripe hold one lasting payment link for every priced option of every commercial-offer row, plus the
// plan-management page and any checkout-code-adjustment codes, and return only the public
// addresses. Offers stay DATA: adding an offer or a price option is one row in
// the seller's `commercial-offer` records, and this module never names an offer, a price or an app.
//
// Why payment links: a link is created once, while the caller briefly holds a Stripe key, and then works with
// no key at all. A host that must never keep a provider key (a Worker that is handed one at deploy time and
// discards it) can still sell every offer row.
//
// Every call is built by `call` (build-stripe-http-request.mjs) from `read-data/stripe-operation-map.json` rows and handed to the
// caller's `send`, which binds the credential and returns the decoded JSON reply (throwing on a non-2xx
// reply). This module holds no secret and makes no network call itself.
//
// Idempotent: a price is found again by its lookup key (the price option id), a link by its metadata, a
// promotion code by its code, the plan page by its metadata.
//
//   ensureOfferPaymentLinks({ offers, adjustments, owner, afterPaymentUrl, send, retireLinksWhere })
//   → { links: [{ offer_id, price_option_id, url }], retired: [url], portal_url, codes: [{ code, active, used, max }] }
import { call } from './build-stripe-http-request.mjs';

const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);

// Stripe's interval names for the offer row's `interval`; an unknown interval is refused, never guessed.
const INTERVALS = new Set(['day', 'week', 'month', 'year']);

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
      options.push({ offer, option, recurring });
    }
  }
  return options;
}

async function ensurePrice(send, owner, { offer, option, recurring }) {
  const found = (await call(send, 'operation:find-prices', { lookup_keys: [option.id], active: true, limit: 1 })).data?.[0];
  if (found && found.unit_amount === option.amount_cents && found.currency === option.currency.toLowerCase()
    && (found.recurring?.interval ?? null) === (recurring ? option.interval : null)) return found;
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

async function ensureLink(send, owner, afterPaymentUrl, priced, price, existing) {
  const { offer, option, recurring } = priced;
  const metadata = { owner, offer_id: offer.id, price_option_id: option.id, price: price.id };
  const settings = {
    allow_promotion_codes: true,
    // The offer catalog can include in-person services. Stripe Managed Payments accepts only
    // eligible automated digital products, so these links use ordinary Stripe Payments.
    managed_payments: { enabled: false },
    after_completion: { type: 'redirect', redirect: { url: new URL(offer.post_purchase_route_path || '/', afterPaymentUrl).href } },
    // Subscriptions ask for a card only when something is owed; one-time payments always make a customer so a
    // refund can be traced back to the buyer.
    ...(recurring
      ? { payment_method_collection: 'if_required', subscription_data: { metadata: { owner, offer_id: offer.id, price_option_id: option.id } } }
      : { customer_creation: 'always', payment_intent_data: { metadata: { owner, offer_id: offer.id, price_option_id: option.id } } }),
  };
  const found = existing.find(link => link.metadata?.owner === owner && link.metadata?.price === price.id);
  if (found) return call(send, 'operation:update-payment-link', { allow_promotion_codes: settings.allow_promotion_codes, after_completion: settings.after_completion }, { ref: found.id });
  return call(send, 'operation:create-payment-link', { line_items: [{ price: price.id, quantity: 1 }], metadata, ...settings });
}

async function ensureCode(send, owner, adjustment) {
  const found = (await call(send, 'operation:find-promotion-codes', { code: adjustment.code, limit: 1 })).data?.[0];
  if (found) return found;
  // The checkout-code-adjustment row says what the code takes off: `adjustment: { kind: 'percent', percent }`.
  const percent = adjustment.adjustment?.kind === 'percent' ? adjustment.adjustment.percent : null;
  if (!(percent > 0 && percent <= 100)) throw new Error(`Code ${adjustment.code} needs a percent adjustment between 1 and 100.`);
  const coupon = await call(send, 'operation:create-coupon', { percent_off: percent, duration: adjustment.duration ?? 'forever', name: adjustment.label ?? adjustment.code, metadata: { owner, adjustment_id: adjustment.id } });
  return call(send, 'operation:create-promotion-code', {
    promotion: { type: 'coupon', coupon: coupon.id },
    code: adjustment.code,
    ...(Number.isInteger(adjustment.max_redemptions) ? { max_redemptions: adjustment.max_redemptions } : {}),
    metadata: { owner, adjustment_id: adjustment.id },
  });
}

export async function ensureOfferPaymentLinks({ offers, adjustments = [], owner, afterPaymentUrl, send, retireLinksWhere = [] }) {
  if (typeof owner !== 'string' || !owner) throw new Error('owner names whose Stripe objects these are.');
  if (typeof send !== 'function') throw new Error('send delivers one built request and returns its decoded reply.');
  const existingLinks = (await call(send, 'operation:find-payment-links', { active: true, limit: 100 })).data ?? [];
  const links = [];
  for (const priced of pricedOptions(offers)) {
    const price = await ensurePrice(send, owner, priced);
    const link = await ensureLink(send, owner, afterPaymentUrl, priced, price, existingLinks);
    links.push({ offer_id: priced.offer.id, price_option_id: priced.option.id, url: link.url, id: link.id });
  }
  // A link this owner made for an option no offer row has any more stops taking payments, as does any link matching
  // a `retireLinksWhere` metadata pattern (links an earlier setup made under other metadata). Past buyers keep what
  // they paid for; nobody new can pay through a link whose offer is gone.
  const current = new Set(links.map(link => link.id));
  const retiredPattern = link => retireLinksWhere.some(pattern => Object.entries(pattern).every(([key, value]) => link.metadata?.[key] === value));
  const retired = [];
  for (const link of existingLinks) {
    if (current.has(link.id) || !(link.metadata?.owner === owner || retiredPattern(link))) continue;
    await call(send, 'operation:update-payment-link', { active: false }, { ref: link.id });
    retired.push(link.url);
  }

  const codes = [];
  for (const adjustment of adjustments) {
    const code = await ensureCode(send, owner, adjustment);
    codes.push({ code: code.code, active: code.active, used: code.times_redeemed, max: code.max_redemptions });
  }

  const portals = (await call(send, 'operation:find-portal-configurations', { active: true, limit: 100 })).data ?? [];
  const portal = portals.find(item => item.metadata?.owner === owner) ?? await call(send, 'operation:create-portal-configuration', {
    features: { subscription_cancel: { enabled: true, mode: 'at_period_end' }, payment_method_update: { enabled: true }, invoice_history: { enabled: true } },
    login_page: { enabled: true },
    metadata: { owner },
  });

  return { links: links.map(({ id, ...link }) => link), retired, portal_url: portal.login_page?.url ?? null, codes };
}
