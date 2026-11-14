// tools/take-payments/do-work/billing-portal.mjs
//
// The billing page of one purchase: a Stripe customer portal session for the customer that bills the subscription, and
// the card that pays it (brand, last four, expiry only). It reads the subscription and opens one session; it changes no
// subscription, moves no money and never answers a card number, a fingerprint or the key. `send` is the one sender
// take-payments.mjs passes (the person's own key, read from descriptor 4 only at the moment of sending).
import { call } from './build-provider-request.mjs';

const SUBSCRIPTION_ID = /^sub_[A-Za-z0-9]+$/;
const BILLING_HOST = 'billing.stripe.com';

export class BillingPageError extends Error {}

const text = value => (typeof value === 'string' ? value.trim() : '');

export function httpsAddress(value) {
  try {
    const url = new URL(text(value));
    if (url.protocol === 'https:') return url.href;
  } catch { /* refused below */ }
  throw new BillingPageError('return_url must be an https address the billing page returns to.');
}

// The configuration the account has for the portal: its default, else the first active one, else none.
export async function findPortalConfiguration(send) {
  const { data = [] } = await call(send, 'operation:find-portal-configurations', { active: 'true' });
  return (data.find(configuration => configuration.is_default) ?? data.find(configuration => configuration.active))?.id ?? null;
}

// The configuration the portal opens with: the one the caller names, else the account's. None at all is a refusal,
// never an invented configuration.
async function portalConfiguration(send, named) {
  if (named) return named;
  const found = await findPortalConfiguration(send);
  if (!found) throw new BillingPageError('This Stripe account has no billing portal configuration yet: set one up in Stripe, then try again.');
  return found;
}

// The card that pays the subscription: its own default payment method, expanded by the read. Only the parts a payer
// recognises are kept; anything that is not a card answers no card.
function payingCard(subscription) {
  const method = subscription.default_payment_method;
  if (!method || typeof method !== 'object' || method.type !== 'card' || !method.card) return null;
  const { brand, last4, exp_month: expMonth, exp_year: expYear } = method.card;
  return { brand, last4, exp_month: expMonth, exp_year: expYear };
}

export async function openBillingPage(input, { send }) {
  const row = input && typeof input === 'object' ? input : {};
  const subscriptionId = text(row.subscription_id);
  if (!SUBSCRIPTION_ID.test(subscriptionId)) throw new BillingPageError('subscription_id must be the sub_ id of one purchase.');
  const returnUrl = httpsAddress(row.return_url);
  const subscription = await call(send, 'operation:read-subscription-card', { 'expand[0]': 'default_payment_method' }, { ref: subscriptionId });
  const customer = typeof subscription.customer === 'string' ? subscription.customer : subscription.customer?.id;
  if (!customer) throw new BillingPageError('The provider did not identify this subscription’s billing profile.');
  const configuration = await portalConfiguration(send, text(row.configuration));
  const session = await call(send, 'operation:create-portal-session', { customer, configuration, return_url: returnUrl });
  const url = new URL(session.url ?? '');
  if (url.protocol !== 'https:' || url.hostname !== BILLING_HOST) throw new BillingPageError('The provider returned an unexpected billing-session address.');
  return { subscription_id: subscriptionId, redirect: url.href, card: payingCard(subscription) };
}
