// src/buy-route.mjs
//
// PURPOSE
//   /buy/<offer id>: a person who presses Buy on a sale offer is sent to a Stripe Checkout session for that offer. The
//   offer's price and interval come from its row, and Checkout returns the person to /welcome. Where the purchase started
//   (?jv=, utm_* and ref) travels into the session as client_reference_id and metadata, so attribution reaches the payment.
//
// NON-NEGOTIABLE INVARIANTS
//   1. Offers are DATA: the rows are handed in by the caller. No offer id or price is written here.
//   2. An id with no row, or a row with no charged price, is answered with the plain 404 page. No session is made for it.
//   3. The Stripe secret key is handed in by the caller (the unit's sealed credential). It is never read from the address,
//      never logged and never put in a URL; it travels only in the Authorization header of the one request to Stripe.
//   4. Only the attribution the address carries is copied: jv becomes client_reference_id; utm_* and ref become metadata;
//      each value is cut to Stripe's limit. Nothing else from the address reaches Stripe.
//   5. The return address is the caller's origin plus its success path. The request never names where the person goes.

const STRIPE_SESSIONS = 'https://api.stripe.com/v1/checkout/sessions';
const REFERENCE_LONGEST = 200;
const METADATA_VALUE_LONGEST = 500;
const METADATA_KEYS_MOST = 20;
const RECURRING_INTERVALS = ['day', 'week', 'month', 'year'];
const STRIPE_TIMEOUT_MS = 15_000;

const NOT_FOUND = { status: 404, headers: { 'content-type': 'text/plain; charset=utf-8' }, body: 'Not found.\n' };
const UNAVAILABLE = { status: 502, headers: { 'content-type': 'text/plain; charset=utf-8' }, body: 'Checkout is not available right now. Try again in a few minutes.\n' };

/** The offer id a request path names (`/buy/<id>`, decoded), or null when the path is not a buy address. */
export function offerIdOf(pathname) {
  if (!pathname.startsWith('/buy/')) return null;
  let id;
  try { id = decodeURIComponent(pathname.slice('/buy/'.length)); } catch { return null; }
  return id || null;
}

/** The price a Buy charges: the offer's first option that costs something, or null when no option is charged. */
export function chargedOption(offer) {
  return (offer?.price_options ?? []).find(option => Number.isSafeInteger(option.amount_cents) && option.amount_cents > 0) ?? null;
}

/** The offer row a Buy names when it can be sold (it is for sale and has a charged price), else null. */
export function sellableOffer(offers, id) {
  const offer = offers.find(row => row.id === id);
  return offer && offer.for_sale !== false && chargedOption(offer) ? offer : null;
}

// Control characters never reach Stripe; a value is cut to the longest Stripe keeps.
const cleanCut = (value, longest) => value.replace(/[\u0000-\u001f\u007f]/g, '').slice(0, longest);

/** The attribution a buy address carries: jv as the client reference, utm_* and ref as metadata. */
export function attributionOf(searchParams) {
  const reference = cleanCut(searchParams.get('jv') ?? '', REFERENCE_LONGEST) || null;
  const metadata = {};
  for (const [key, value] of searchParams) {
    if (Object.keys(metadata).length >= METADATA_KEYS_MOST) break;
    if (!/^(utm_[a-z_]{1,30}|ref)$/.test(key) || !value) continue;
    const kept = cleanCut(value, METADATA_VALUE_LONGEST);
    if (kept) metadata[key] = kept;
  }
  return { client_reference_id: reference, metadata };
}

/** The Checkout session's form for a sellable offer: its charged price as one line, a subscription when it repeats (with
 *  its free days first), the attribution, and the return address the caller's origin and success path make. */
export function checkoutForm({ offer, searchParams, origin, successPath }) {
  const option = chargedOption(offer);
  const subscribed = option.payment_timing === 'subscription';
  if (subscribed && !RECURRING_INTERVALS.includes(option.interval)) throw new Error(`Offer ${offer.id} has no interval Stripe bills.`);
  const attribution = attributionOf(searchParams);
  const metadata = { ...attribution.metadata, offer_id: offer.id };
  const form = new URLSearchParams();
  form.set('mode', subscribed ? 'subscription' : 'payment');
  form.set('success_url', `${origin}${successPath}`);
  form.set('line_items[0][quantity]', '1');
  form.set('line_items[0][price_data][currency]', String(option.currency).toLowerCase());
  form.set('line_items[0][price_data][unit_amount]', String(option.amount_cents));
  form.set('line_items[0][price_data][product_data][name]', option.label ?? offer.label ?? offer.id);
  if (subscribed) {
    form.set('line_items[0][price_data][recurring][interval]', option.interval);
    if (option.trial_days > 0) form.set('subscription_data[trial_period_days]', String(option.trial_days));
  }
  if (attribution.client_reference_id) form.set('client_reference_id', attribution.client_reference_id);
  for (const [key, value] of Object.entries(metadata)) form.set(`metadata[${key}]`, value);
  if (subscribed) for (const [key, value] of Object.entries(metadata)) form.set(`subscription_data[metadata][${key}]`, value);
  return form;
}

/** Creates the Checkout session and returns its address. Throws when Stripe refuses or its answer carries no address. */
export async function createCheckoutSession({ form, key, fetchImpl = fetch }) {
  const reply = await fetchImpl(STRIPE_SESSIONS, {
    method: 'POST',
    headers: { authorization: `Bearer ${key}`, 'content-type': 'application/x-www-form-urlencoded' },
    body: form.toString(),
    signal: AbortSignal.timeout(STRIPE_TIMEOUT_MS),
  });
  if (!reply.ok) throw new Error(`Stripe answered ${reply.status}.`);
  const session = await reply.json();
  if (typeof session?.url !== 'string' || !session.url.startsWith('https://')) throw new Error('Stripe gave no Checkout address.');
  return session.url;
}

/** What a buy address answers: `{ status, headers, body }`. A purchase is a 303 to its Checkout session. */
// A failure is logged with its message only (Stripe's status or the missing address), never the request or the key.
export async function answerBuy({ pathname, searchParams, offers, key, origin, successPath, fetchImpl, log = console.error }) {
  const id = offerIdOf(pathname);
  const offer = id ? sellableOffer(offers, id) : null;
  if (!offer) return NOT_FOUND;
  try {
    const url = await createCheckoutSession({ form: checkoutForm({ offer, searchParams, origin, successPath }), key, fetchImpl });
    return { status: 303, headers: { location: url, 'cache-control': 'no-store' }, body: null };
  } catch (error) {
    log(`buy ${offer.id}: ${error.message}`);
    return UNAVAILABLE;
  }
}
