// tools/take-payments/do-work/billing-portal.mjs
//
// The billing page of one purchase. `openBillingPage` opens a Stripe customer portal session for the customer that bills
// the subscription, on the flow the buyer picked: change card (payment_method_update), change plan (subscription_update),
// cancel (subscription_cancel), or the page itself. `readBillingPage` reads the purchase as the buyer sees it: its plan,
// status and renewal date, the card that pays it (brand, last four, expiry only), and its receipts. Neither changes a
// subscription or moves money: a change happens on Stripe's page, where the buyer confirms it. Nothing here answers a card
// number, a fingerprint or the key. `send` is the one sender take-payments.mjs passes (the person's own key, read from
// descriptor 4 only at the moment of sending).
//
// Ownership: every read and every session is for the signed-in buyer. `subject_email` is their verified email; the
// purchase's customer must have that email, or the call is refused and nothing of the purchase is returned or opened.
// The subscription is read once to learn its customer; that reply is discarded on a refusal.
import { call } from '../../shared-code/src/build-provider-request.mjs';

const SUBSCRIPTION_ID = /^sub_[A-Za-z0-9]+$/;
const BILLING_HOST = 'billing.stripe.com';
// The flows the billing page starts; each is one Stripe portal deep link (flow_data) and no other.
const FLOWS = new Set(['payment_method_update', 'subscription_update', 'subscription_cancel']);
const RECEIPT_LIMIT = 12;

export class BillingPageError extends Error {}

const text = value => (typeof value === 'string' ? value.trim() : '');

const EMAIL = /^[^\s@]+@[^\s@]+$/;

// The signed-in buyer's verified email, lower-cased. Missing or malformed is refused before any request is sent.
function subjectOf(row) {
  const email = text(row.subject_email).toLowerCase();
  if (!EMAIL.test(email)) throw new BillingPageError('subject_email must be the verified email of the signed-in buyer.');
  return email;
}

export function httpsAddress(value) {
  try {
    const url = new URL(text(value));
    if (url.protocol === 'https:') return url.href;
  } catch { /* refused below */ }
  throw new BillingPageError('return_url must be an https address the billing page returns to.');
}

const subscriptionIdOf = row => {
  const subscriptionId = text((row && typeof row === 'object' ? row : {}).subscription_id);
  if (!SUBSCRIPTION_ID.test(subscriptionId)) throw new BillingPageError('subscription_id must be the sub_ id of one purchase.');
  return subscriptionId;
};

// The flow the buyer starts on Stripe's page, or none for the page itself. A flow that is not one of FLOWS is refused.
export function flowDataFor(flow, subscriptionId) {
  if (flow === undefined || flow === null) return null;
  if (!FLOWS.has(flow)) throw new BillingPageError(`flow must be one of ${[...FLOWS].join(', ')}.`);
  return flow === 'payment_method_update' ? { type: flow } : { type: flow, [flow]: { subscription: subscriptionId } };
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

// The purchase as Stripe holds it, with the card that pays it, its plan (price and product) and its customer expanded.
function readPurchase(send, subscriptionId) {
  return call(send, 'operation:read-subscription-card', { 'expand[0]': 'default_payment_method', 'expand[1]': 'items.data.price.product', 'expand[2]': 'customer' }, { ref: subscriptionId });
}

// The purchase, if its customer is the signed-in buyer. Any other purchase is refused with nothing of it returned.
async function purchaseOfBuyer(send, subscriptionId, subject) {
  const subscription = await readPurchase(send, subscriptionId);
  const email = subscription.customer && typeof subscription.customer === 'object' ? text(subscription.customer.email).toLowerCase() : '';
  if (!email || email !== subject) throw new BillingPageError('This purchase is not one of the signed-in buyer’s purchases.');
  return subscription;
}

// The card that pays the subscription: its own default payment method. Only the parts a payer recognises are kept;
// anything that is not a card answers no card.
function payingCard(subscription) {
  const method = subscription.default_payment_method;
  if (!method || typeof method !== 'object' || method.type !== 'card' || !method.card) return null;
  const { brand, last4, exp_month: expMonth, exp_year: expYear } = method.card;
  return { brand, last4, exp_month: expMonth, exp_year: expYear };
}

const isoTime = seconds => (Number.isInteger(seconds) ? new Date(seconds * 1000).toISOString() : null);

function httpsOrNull(value) {
  try {
    const url = new URL(text(value));
    return url.protocol === 'https:' ? url.href : null;
  } catch {
    return null;
  }
}

function receiptOf(invoice) {
  return {
    id: invoice.id,
    number: invoice.number ?? null,
    created_at: isoTime(invoice.created),
    status: invoice.status ?? null,
    amount_paid_cents: Number.isInteger(invoice.amount_paid) ? invoice.amount_paid : null,
    currency: invoice.currency ?? null,
    receipt_url: httpsOrNull(invoice.hosted_invoice_url),
  };
}

export async function openBillingPage(input, { send }) {
  const row = input && typeof input === 'object' ? input : {};
  const subscriptionId = subscriptionIdOf(row);
  const returnUrl = httpsAddress(row.return_url);
  const flowData = flowDataFor(row.flow, subscriptionId);
  const subject = subjectOf(row);
  const subscription = await purchaseOfBuyer(send, subscriptionId, subject);
  const customer = typeof subscription.customer === 'string' ? subscription.customer : subscription.customer?.id;
  if (!customer) throw new BillingPageError('The provider did not identify this subscription’s billing profile.');
  const configuration = await portalConfiguration(send, text(row.configuration));
  const session = await call(send, 'operation:create-portal-session', { customer, configuration, return_url: returnUrl, ...(flowData ? { flow_data: flowData } : {}) });
  const url = new URL(session.url ?? '');
  if (url.protocol !== 'https:' || url.hostname !== BILLING_HOST) throw new BillingPageError('The provider returned an unexpected billing-session address.');
  return { subscription_id: subscriptionId, redirect: url.href, card: payingCard(subscription) };
}

// The purchase as the buyer sees it: plan, status and renewal, the paying card, and the latest receipts.
export async function readBillingPage(input, { send }) {
  const subscriptionId = subscriptionIdOf(input);
  const subject = subjectOf(input);
  const subscription = await purchaseOfBuyer(send, subscriptionId, subject);
  const { data: invoices = [] } = await call(send, 'operation:find-invoices', { subscription: subscriptionId, limit: RECEIPT_LIMIT });
  const item = subscription.items?.data?.[0] ?? null;
  const price = item?.price && typeof item.price === 'object' ? item.price : null;
  const product = price && typeof price.product === 'object' ? price.product : null;
  const periodEnd = isoTime(item?.current_period_end ?? subscription.current_period_end);
  const endsOnPeriodEnd = subscription.cancel_at_period_end === true;
  return {
    subscription_id: subscriptionId,
    status: subscription.status ?? null,
    cancel_at_period_end: endsOnPeriodEnd,
    renews_at: endsOnPeriodEnd ? null : periodEnd,
    ends_at: isoTime(subscription.cancel_at) ?? (endsOnPeriodEnd ? periodEnd : null),
    plan: price ? {
      label: product?.name ?? price.nickname ?? null,
      amount_cents: Number.isInteger(price.unit_amount) ? price.unit_amount : null,
      currency: price.currency ?? null,
      interval: price.recurring?.interval ?? null,
      quantity: Number.isInteger(item.quantity) ? item.quantity : 1,
    } : null,
    card: payingCard(subscription),
    receipts: invoices.map(receiptOf),
  };
}
