// tools/take-payments/do-work/rehearse-a-billing-page.mjs
//
// Make a subscription in Stripe TEST MODE and open its billing page, to see that the billing page comes back for a
// real subscription at Stripe before a real buyer needs it. Everything is made on the test key's test account: a customer,
// a product, a price, and a one-phase schedule that starts the subscription; then the billing page of that
// subscription is opened by the same code the billing-page tool runs (billing-portal.mjs). The page's address is
// returned for the caller to read; this function never opens it. Test mode is checked by the caller before anything is built
// (take-payments.mjs, assertTestKey), so a live key never reaches here. No product or customer identity lives here.
import { call } from './build-stripe-http-request.mjs';
import { findPortalConfiguration, httpsAddress, openBillingPage } from './billing-portal.mjs';

const text = value => (typeof value === 'string' ? value.trim() : '');

// A billing portal configuration of this test account to open the page with: the account's own, else one made here with
// the features a payer expects (cancel at period end, change the card, see invoices).
async function configurationFor(send) {
  const found = await findPortalConfiguration(send);
  if (found) return found;
  const made = await call(send, 'operation:create-portal-configuration', {
    features: { subscription_cancel: { enabled: true, mode: 'at_period_end' }, payment_method_update: { enabled: true }, invoice_history: { enabled: true } },
    business_profile: { headline: 'Billing page rehearsal, test mode' },
  });
  return made.id;
}

/**
 * @param {{ product_name: string, amount_cents: number, return_url: string, currency?: string }} input
 * @param {(request: object) => Promise<object>} send delivers one built request (made with a test key)
 * @returns what Stripe made and said: the subscription, the billing page's address, the card that pays it (none yet)
 */
export async function rehearseABillingPage(input, send) {
  const productName = text(input?.product_name);
  if (!productName) throw new Error('A product name is required; this tool holds no seller identity.');
  if (!Number.isSafeInteger(input.amount_cents) || input.amount_cents <= 0) throw new Error('amount_cents must be a whole number of cents above 0.');
  const returnUrl = httpsAddress(input.return_url);
  const currency = text(input.currency) || 'usd';

  const customer = await call(send, 'operation:create-customer', { description: 'billing page rehearsal, test mode' });
  const product = await call(send, 'operation:create-product', { name: productName });
  const price = await call(send, 'operation:create-price', { currency, unit_amount: input.amount_cents, product: product.id, recurring: { interval: 'month', interval_count: 1 } });
  const schedule = await call(send, 'operation:create-subscription-schedule', {
    customer: customer.id,
    start_date: 'now',
    end_behavior: 'release',
    phases: [{ items: [{ price: price.id, quantity: 1 }], duration: { interval: 'month', interval_count: 1 } }],
  });
  const subscriptionId = text(typeof schedule.subscription === 'string' ? schedule.subscription : schedule.subscription?.id)
    || text((await call(send, 'operation:list-subscriptions', { customer: customer.id })).data?.[0]?.id);
  if (!subscriptionId) throw new Error('Stripe made the schedule but named no subscription for it.');

  const configuration = await configurationFor(send);
  const page = await openBillingPage({ subscription_id: subscriptionId, return_url: returnUrl, configuration }, { send });
  return { ...page, customer_id: customer.id, schedule_id: schedule.id, portal_configuration: configuration };
}
