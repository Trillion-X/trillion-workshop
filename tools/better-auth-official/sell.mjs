// tools/better-auth-official/sell.mjs
//
// A plan on the person's own account, sold with Better Auth's official Stripe plugin (https://www.better-auth.com/docs/plugins/stripe).
// settings.sell is DATA and names no key. It holds:
//   plans   what an account can hold, each {plan, price_id}. Each is the plugin's plan, and the plugin knows a plan by its Stripe price.
//   offers  the terms a plan is bought on, each {offer_id, plan, trial_days, payment_method_collection, on}: the id a buy address names,
//           the free days before the first charge (once per account), whether Checkout asks for a card ("always", Stripe's own default
//           for a trial and the value when none is named, or "if_required"), and whether it is sold now (on; absent is true; an
//           offer that is off answers 404 but its plan stays known, so the events of what was bought on it are still read).
// It also says where a buyer goes and which environment variables hold the Stripe secret key and the webhook's signing secret; the
// unit fills them from its sealed credentials. A plan on an account is the plugin's `subscription` row (referenceId the user's id, plan
// the plan's name, status Stripe's). It is written only from a Stripe event whose signature the plugin checked (POST
// <base_path>/stripe/webhook). A replayed event writes the same state again.
//   sellPlugins(sell, env)           the plugin for settings.sell, or none while it is off
//   buyAnswer(auth, sell, url, ...)  GET /buy/<offer id> (BUY_PATH): a signed-in person goes to a Stripe Checkout on that offer's terms;
//                                    a person not signed in goes to sign-in, which comes back to the same address
import Stripe from 'stripe';
import { stripe } from '@better-auth/stripe';
import journey from '../traffic-attribution/read-data/journey.json' with { type: 'json' };

// The address a purchase starts at; the front door sends it here by on-a-computer/caddy-route-better-auth-buy.caddy.
export const BUY_PATH = '/buy/';
// Only the buy route chooses the offer and the metadata, through auth.api, not a public plugin request body.
export const CHECKOUT_API_PATH = '/subscription/upgrade';

// The plugin can send body metadata to Stripe before it builds Checkout (for example, when creating a customer).
// Neither an HTTP nor a server-side API caller may assert a visitor in that body.
export function stripCheckoutVisitor(body) {
  if (body?.metadata && typeof body.metadata === 'object') {
    delete body.metadata[journey.stripe.visitor_key];
    delete body.metadata[journey.cookie.name];
  }
}

const PLAIN = { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' };
const NOT_FOUND = { status: 404, headers: PLAIN, body: 'Not found.\n' };
const UNAVAILABLE = { status: 502, headers: PLAIN, body: 'Checkout is not available right now. Try again in a few minutes.\n' };
const goTo = location => ({ status: 303, headers: { location, 'cache-control': 'no-store' }, body: null });

// URL source labels are not proof of who visited. Do not copy a visitor key (including jv) from the address to Stripe.
// Stripe keeps 50 keys of up to 40 characters, each value up to 500. Control characters never go.
const ATTRIBUTION_KEY = /^(ref|utm_[a-z_]{1,30})$/;
const METADATA_VALUE_LONGEST = 500;
const METADATA_KEYS_MOST = 20;

const COLLECTIONS = ['always', 'if_required'];
const collectionOf = offer => offer.payment_method_collection ?? 'always';
const isOn = offer => offer.on !== false;

/** The plugin's plans: one per settings plan, by its name and Stripe price. Free days are an offer's, so no plan carries them. */
export const plansOf = plans => plans.map(({ plan, price_id }) => ({ name: plan, priceId: price_id }));

/** Refuses settings.sell whose offers name a plan it does not list, or a collection Stripe does not take, or a plan name that is
 *  not lower case (the plugin keeps a plan's name in lower case and compares a buyer's plan as asked). */
export function checkSell(sell) {
  const plans = new Set(sell.plans.map(({ plan }) => plan));
  for (const { plan } of sell.plans) if (plan !== plan.toLowerCase()) throw new Error(`settings.sell.plans: the plan name ${plan} must be lower case`);
  if (new Set(sell.plans.map(({ price_id }) => price_id)).size !== sell.plans.length) throw new Error('settings.sell.plans: two plans name one price, and the plugin knows a plan by its price');
  for (const offer of sell.offers) {
    if (!plans.has(offer.plan)) throw new Error(`settings.sell.offers: ${offer.offer_id} names the plan ${offer.plan}, which settings.sell.plans does not list`);
    if (!COLLECTIONS.includes(collectionOf(offer))) throw new Error(`settings.sell.offers: ${offer.offer_id} payment_method_collection is one of ${COLLECTIONS.join(', ')}`);
    if (!(Number.isInteger(offer.trial_days) && offer.trial_days >= 0)) throw new Error(`settings.sell.offers: ${offer.offer_id} trial_days is a whole number of days, 0 for none`);
    if (![undefined, true, false].includes(offer.on)) throw new Error(`settings.sell.offers: ${offer.offer_id} on is true or false`);
  }
}

// An account has free days once: none when any of its plans had a trial or is in one (the plugin's own rule for a plan's freeTrial).
const hadTrial = async (ctx, referenceId) => (await ctx.context.adapter.findMany({ model: 'subscription', where: [{ field: 'referenceId', value: referenceId }] }))
  .some(row => row.trialStart || row.trialEnd || row.status === 'trialing');

/** What Checkout is made with for the offer the buy named (metadata.offer_id): its card collection, and its free days if the account
 *  has had none. */
export const checkoutTerms = sell => async ({ subscription }, _request, ctx) => {
  const offer = sell.offers.find(row => row.offer_id === ctx.body?.metadata?.offer_id);
  if (!offer) throw new Error('the Checkout names no offer settings.sell lists');
  const trial = offer.trial_days > 0 && !(await hadTrial(ctx, subscription.referenceId)) ? { trial_period_days: offer.trial_days } : {};
  return { params: { payment_method_collection: collectionOf(offer), subscription_data: trial } };
};

/** Better Auth's Stripe plugin for settings.sell, or no plugin while it is off. A missing key or signing secret stops the start. */
export function sellPlugins(sell, env = process.env) {
  if (!sell?.enabled) return [];
  const key = env[sell.stripe_key_env];
  const webhookSecret = env[sell.webhook_secret_env];
  if (!key) throw new Error(`${sell.stripe_key_env} is empty: settings.sell needs the Stripe secret key in the environment`);
  if (!webhookSecret) throw new Error(`${sell.webhook_secret_env} is empty: settings.sell needs the webhook's signing secret in the environment`);
  checkSell(sell);
  return [stripe({
    stripeClient: new Stripe(key, { ...(sell.stripe_api ?? {}), maxNetworkRetries: sell.stripe_retries }),
    stripeWebhookSecret: webhookSecret,
    createCustomerOnSignUp: false,
    // A plan goes only on an account whose email is proven, so a typed address never takes over another person's Stripe customer.
    subscription: { enabled: true, requireEmailVerification: true, plans: plansOf(sell.plans), getCheckoutSessionParams: checkoutTerms(sell) },
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
 * What a buy address answers: `{ status, headers, body }`. An offer settings.sell does not list, or one that is off, is 404. A person
 * not signed in goes to sign-in and back here; a signed-in person goes to the success path when the account already holds the offer's
 * plan (active or in its free days), else to the Checkout the plugin makes on the offer's terms (303). A refusal from Stripe is a 502, logged by its message only, never the request or a key.
 */
export async function buyAnswer(auth, sell, url, headers, log = console.error) {
  const id = offerIdOf(url.pathname);
  const offer = id ? sell.offers.find(row => row.offer_id === id && isOn(row)) : null;
  if (!offer) return NOT_FOUND;
  const session = await auth.api.getSession({ headers });
  if (!session) return goTo(`${sell.sign_in_path}?${new URLSearchParams({ next: url.pathname + url.search })}`);
  try {
    const held = await auth.api.listActiveSubscriptions({ headers });
    if (held.some(row => row.plan === offer.plan)) return goTo(sell.success_path);
    const made = await auth.api.upgradeSubscription({
      headers,
      body: { plan: offer.plan, successUrl: sell.success_path, cancelUrl: sell.cancel_path, metadata: { ...attributionOf(url.searchParams), offer_id: offer.offer_id }, disableRedirect: true },
    });
    if (typeof made?.url !== 'string' || !made.url.startsWith('https://')) throw new Error('Stripe gave no Checkout address.');
    return goTo(made.url);
  } catch (error) {
    log(`buy ${offer.offer_id}: ${error?.body?.code ?? error?.message}`);
    return UNAVAILABLE;
  }
}
