// Provider observations needed to allocate a purchase. This does not charge a card.
// Customer/profile identity is independent from the person paying. Payment Link
// purchases get a billing profile; never combine a meter across two subscriptions
// of the same profile, which could bill the same event twice.
import { buildStripeHttpRequest } from '../../seller-payment-setup/process/build-stripe-http-request.mjs';
import { allocationOf, quantityOf } from './offer-allocation.mjs';
const ref = value => typeof value === 'string' ? value : value?.id;
const request = (send, operation_id, operation_subject, provider_object_ref) => send(buildStripeHttpRequest({ operation_id,
  input_facts: { ...(operation_subject ? { operation_subject } : {}), ...(provider_object_ref ? { provider_object_ref } : {}) } }));

export function observedAllocation(subscription, offer) {
  if (!allocationOf(offer)) return null;
  if (subscription.items?.has_more) throw new Error('The provider returned only part of this purchase. Quantity remains unverified.');
  const options = new Set((offer.price_options ?? []).filter(option => quantityOf(option)).map(option => option.id));
  const items = (subscription.items?.data ?? []).filter(item => item.price?.metadata?.offer_id === offer.id
    && options.has(item.price?.metadata?.price_option_id) && item.price?.recurring?.usage_type !== 'metered');
  if (!items.length || items.some(item => !Number.isSafeInteger(item.quantity) || item.quantity < 1)) throw new Error('The provider has not verified the purchased quantity.');
  const count = items.reduce((sum, item) => sum + item.quantity, 0);
  if (!Number.isSafeInteger(count)) throw new Error('The verified quantity cannot be represented exactly.');
  return { source: 'provider-subscription', offer_id: offer.id, subscription_id: subscription.id,
    count, customer: ref(subscription.customer), observed_at: new Date().toISOString(),
    items: items.map(item => ({ quantity: item.quantity, price: item.price.id, price_option_id: item.price.metadata.price_option_id,
      unit_amount_cents: item.price.unit_amount, currency: item.price.currency })),
  };
}

export async function assertMeterIsolation(send, subscription, priceIds) {
  const meters = new Set((subscription.items?.data ?? []).map(item => ref(item.price?.recurring?.meter)).filter(Boolean));
  for (const id of priceIds) {
    const price = await request(send, 'operation:read-price', null, id);
    if (!ref(price.recurring?.meter)) throw new Error('The usage price does not name a verified billing meter.');
    meters.add(ref(price.recurring.meter));
  }
  if (!meters.size) return;
  let cursor;
  for (let page = 0; page < 10; page += 1) {
    const rows = await request(send, 'operation:find-subscriptions', { customer: ref(subscription.customer), status: 'all', limit: 100, ...(cursor ? { starting_after: cursor } : {}) });
    for (const other of rows.data ?? []) {
      if (other.id === subscription.id || ['canceled', 'incomplete_expired'].includes(other.status)) continue;
      if (other.items?.has_more) throw new Error('A billing profile returned incomplete subscription items; usage cannot be safely attributed.');
      if ((other.items?.data ?? []).some(item => meters.has(ref(item.price?.recurring?.meter)))) {
        throw new Error('This billing profile has another subscription with the same usage meter. Use a separate billing profile for this purchase; no usage was reported.');
      }
    }
    if (!rows.has_more) return;
    const next = rows.data?.at(-1)?.id;
    if (!next || next === cursor) break;
    cursor = next;
  }
  throw new Error('The billing profile could not be fully checked within the provider read budget; no usage was reported.');
}
