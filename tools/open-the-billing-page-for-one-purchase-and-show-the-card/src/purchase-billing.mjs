// A billing session is bound to the verified customer of one subscription. A payer
// manages each funding agreement separately; no global email-login shortcut guesses
// which of several billing profiles with the same email should be opened.
import { buildStripeHttpRequest } from '../../seller-payment-setup/process/build-stripe-http-request.mjs';

export async function purchaseBillingSession({ send, subscription_id, origin, configuration }) {
  if (!/^sub_[A-Za-z0-9]+$/.test(subscription_id ?? '')) throw new Error('Choose a verified subscription.');
  if (!configuration) throw new Error('The billing portal configuration has not been set up.');
  const subscription = await send(buildStripeHttpRequest({ operation_id: 'operation:read-subscription', input_facts: { provider_object_ref: subscription_id } }));
  const customer = typeof subscription?.customer === 'string' ? subscription.customer : subscription?.customer?.id;
  if (!customer) throw new Error('The provider did not identify this subscription’s billing profile.');
  const session = await send(buildStripeHttpRequest({ operation_id: 'operation:create-portal-session', input_facts: { operation_subject: {
    customer, configuration, return_url: new URL('/billing', origin).href,
  } } }));
  const url = new URL(session?.url ?? '');
  if (url.protocol !== 'https:' || url.hostname !== 'billing.stripe.com') throw new Error('The provider returned an unexpected billing-session address.');
  return { redirect: url.href };
}

/** The card one verified purchase is paid with: { brand, last4, exp_month, exp_year, wallet }, or null when the
 *  purchase has none on file (a $0 purchase). Only the card's brand, last four digits and expiry are read. */
export async function purchaseCard({ send, subscription_id }) {
  if (!/^sub_[A-Za-z0-9]+$/.test(subscription_id ?? '')) throw new Error('Choose a verified subscription.');
  const subscription = await send(buildStripeHttpRequest({ operation_id: 'operation:read-subscription-card', input_facts: {
    provider_object_ref: subscription_id, operation_subject: { expand: ['default_payment_method', 'customer.invoice_settings.default_payment_method'] },
  } }));
  const method = [subscription?.default_payment_method, subscription?.customer?.invoice_settings?.default_payment_method].find(row => row && typeof row === 'object' && row.card);
  if (!method) return { card: null };
  const { brand, last4, exp_month, exp_year, wallet } = method.card;
  return { card: { brand: String(brand ?? 'card'), last4: String(last4 ?? ''), exp_month: exp_month ?? null, exp_year: exp_year ?? null, wallet: wallet?.type ?? null } };
}
