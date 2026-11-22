// tools/better-auth-official/sell.mjs
//
// A plan on the person's own account, sold with Better Auth's official Stripe plugin (https://www.better-auth.com/docs/plugins/stripe).
// settings.sell is DATA: the offers sold (each {offer_id, price_id, trial_days}, the plugin's plan named by the offer's id), where a buyer
// goes and how Stripe is reached. It names no key: the Stripe secret key and the webhook's signing secret are read from the environment
// variables it names, which the unit fills from its sealed credentials. A plan on an account is the plugin's `subscription` row
// (referenceId the user's id, plan the offer's id, status Stripe's), written only from a Stripe event whose signature the plugin checked
// (POST <base_path>/stripe/webhook). A replayed event writes the same state again.
//   sellPlugins(sell, env)           the plugin for settings.sell, or none while it is off
//   buyAnswer(auth, sell, url, ...)  GET /buy/<offer id> (BUY_PATH): a signed-in person goes to a Stripe Checkout for that offer; a person
//                                    not signed in goes to sign-in, which comes back to the same address
import Stripe from 'stripe';
import { stripe } from '@better-auth/stripe';

// The address a purchase starts at; the front door sends it here by on-a-computer/caddy-route-better-auth-buy.caddy.
export const BUY_PATH = '/buy/';

const PLAIN = { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' };
const NOT_FOUND = { status: 404, headers: PLAIN, body: 'Not found.\n' };
const UNAVAILABLE = { status: 502, headers: PLAIN, body: 'Checkout is not available right now. Try again in a few minutes.\n' };
const goTo = location => ({ status: 303, headers: { location, 'cache-control': 'no-store' }, body: null });

// Only the attribution a buy address carries reaches Stripe, as the session's metadata (Stripe keeps 50 keys of up to 40 characters,
// each value up to 500): jv (the journey visitor), ref and utm_*. Control characters never go.
const ATTRIBUTION_KEY = /^(jv|ref|utm_[a-z_]{1,30})$/;
const METADATA_VALUE_LONGEST = 500;
const METADATA_KEYS_MOST = 20;

/** The plugin's plans: one per offer, named by its id, with its Stripe price and free days. */
export const plansOf = offers => offers.map(({ offer_id, price_id, trial_days }) => ({
  name: offer_id, priceId: price_id, ...(trial_days > 0 ? { freeTrial: { days: trial_days } } : {}),
}));

/** Better Auth's Stripe plugin for settings.sell, or no plugin while it is off. A missing key or signing secret stops the start. */
export function sellPlugins(sell, env = process.env) {
  if (!sell?.enabled) return [];
  const key = env[sell.stripe_key_env];
  const webhookSecret = env[sell.webhook_secret_env];
  if (!key) throw new Error(`${sell.stripe_key_env} is empty: settings.sell needs the Stripe secret key in the environment`);
  if (!webhookSecret) throw new Error(`${sell.webhook_secret_env} is empty: settings.sell needs the webhook's signing secret in the environment`);
  // The plugin keeps a plan's name in lower case and compares a buyer's plan as asked, so an offer id is lower case or the start stops.
  const cased = sell.offers.find(({ offer_id }) => offer_id !== offer_id.toLowerCase());
  if (cased) throw new Error(`settings.sell.offers: the offer id ${cased.offer_id} must be lower case`);
  return [stripe({
    stripeClient: new Stripe(key, { ...(sell.stripe_api ?? {}), maxNetworkRetries: sell.stripe_retries }),
    stripeWebhookSecret: webhookSecret,
    createCustomerOnSignUp: false,
    // A plan goes only on an account whose email is proven, so a typed address never takes over another person's Stripe customer.
    subscription: { enabled: true, requireEmailVerification: true, plans: plansOf(sell.offers) },
  })];
}

/** The offer id a request path names (/buy/<id>, decoded), or null when the path is not a buy address. */
export function offerIdOf(pathname) {
  if (!pathname.startsWith(BUY_PATH)) return null;
  try { return decodeURIComponent(pathname.slice(BUY_PATH.length)) || null; } catch { return null; }
}

/** The attribution a buy address carries, as Checkout metadata. */
export function attributionOf(searchParams) {
  const metadata = {};
  for (const [key, value] of searchParams) {
    if (Object.keys(metadata).length >= METADATA_KEYS_MOST) break;
    const kept = ATTRIBUTION_KEY.test(key) ? value.replace(/[\u0000-\u001f\u007f]/g, '').slice(0, METADATA_VALUE_LONGEST) : '';
    if (kept) metadata[key] = kept;
  }
  return metadata;
}

/**
 * What a buy address answers: `{ status, headers, body }`. An offer settings.sell does not list is 404. A person not signed in goes to
 * sign-in and back here; a signed-in person goes to the success path when the account already holds that plan (active or in its free
 * days), else to the Checkout the plugin makes for the offer (303). A refusal from Stripe is a 502, logged by its message only, never the request or a key.
 */
export async function buyAnswer(auth, sell, url, headers, log = console.error) {
  const id = offerIdOf(url.pathname);
  const offer = id ? sell.offers.find(row => row.offer_id === id) : null;
  if (!offer) return NOT_FOUND;
  const session = await auth.api.getSession({ headers });
  if (!session) return goTo(`${sell.sign_in_path}?${new URLSearchParams({ next: url.pathname + url.search })}`);
  try {
    const held = await auth.api.listActiveSubscriptions({ headers });
    if (held.some(row => row.plan === offer.offer_id)) return goTo(sell.success_path);
    const made = await auth.api.upgradeSubscription({
      headers,
      body: { plan: offer.offer_id, successUrl: sell.success_path, cancelUrl: sell.cancel_path, metadata: { ...attributionOf(url.searchParams), offer_id: offer.offer_id }, disableRedirect: true },
    });
    if (typeof made?.url !== 'string' || !made.url.startsWith('https://')) throw new Error('Stripe gave no Checkout address.');
    return goTo(made.url);
  } catch (error) {
    log(`buy ${offer.offer_id}: ${error?.body?.code ?? error?.message}`);
    return UNAVAILABLE;
  }
}
