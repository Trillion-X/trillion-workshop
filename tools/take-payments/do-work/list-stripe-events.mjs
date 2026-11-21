// tools/take-payments/do-work/list-stripe-events.mjs
//
// Stripe events of the kinds the event map names, from a time, as the payment rows the webhook check keeps for the same
// events. Each event is mapped by mapStripeWebhookEvent with webhook-event-map.json and named by paymentEventNamedBy, the
// same steps checkAStripeEvent uses (a paid invoice first reads its PaymentIntent), so one payment gives one row whichever
// way it arrives.
//
// Stripe returns events newest first and keeps them for 30 days. A read asks for events created at or after `since_unix`
// and pages to older ones with starting_after. The rows come back oldest first. `complete` is true when no older event is
// left in the window. When it is false, `next_cursor` is the id to send as `starting_after` to continue the same read.
// Nothing is kept here; the caller keeps each row once by its id, which is the Stripe event id.
import { call } from '../../shared-code/src/build-provider-request.mjs';
import { invoiceNeedingPaymentIntent, mapStripeWebhookEvent, paymentEventNamedBy } from './map-webhook-event.mjs';
import { invoicePaymentIntent } from './invoice-payment-intent.mjs';

const RETENTION_SECONDS = 30 * 86_400; // Stripe lists events going back up to 30 days.
const MAX_PAGE = 100;                  // Stripe's `limit` ceiling.
const MAX_TYPES = 20;                  // Stripe's `types` ceiling.

/** The Stripe event kinds the map keeps. */
export function stripeEventKindsOf(eventMap) {
  return (Array.isArray(eventMap?.rules) ? eventMap.rules : []).map(rule => rule.stripe_event_type);
}

/**
 * @param {{ since_unix: number, starting_after?: string, limit?: number, types?: string[], now_unix?: number }} input
 * @param {{ send: Function, eventMap: object }} context
 * @returns {Promise<{ payment_events: object[], next_cursor: string|null, complete: boolean, cursor_too_old: boolean, left_out: number }>}
 */
export async function listStripeEvents(input, { send, eventMap }) {
  const since = Number(input?.since_unix);
  if (!Number.isSafeInteger(since) || since < 0) throw new Error('since_unix (a whole number of seconds) is required.');
  const now = Number.isSafeInteger(input.now_unix) ? input.now_unix : Math.floor(Date.now() / 1000);
  if (since < now - RETENTION_SECONDS) {
    return { payment_events: [], next_cursor: null, complete: false, cursor_too_old: true, left_out: 0 };
  }

  const known = stripeEventKindsOf(eventMap);
  const types = Array.isArray(input.types) && input.types.length ? input.types : known;
  const unknown = types.filter(type => !known.includes(type));
  if (unknown.length) throw new Error(`Not an event kind the event map keeps: ${unknown.join(', ')}.`);
  if (types.length > MAX_TYPES) throw new Error(`At most ${MAX_TYPES} event kinds per read.`);

  const limit = Math.min(MAX_PAGE, Math.max(1, Number(input.limit) || MAX_PAGE));
  const query = { types, created: { gte: since }, limit: String(limit) };
  if (input.starting_after) query.starting_after = String(input.starting_after);
  const page = await call(send, 'operation:list-events', query);

  const events = Array.isArray(page.data) ? page.data : [];
  const payment_events = [];
  let left_out = 0;
  for (const event of [...events].reverse()) {
    // A paid invoice (or a subscription Checkout's) is read for its PaymentIntent here; a failed read throws, so the caller's
    // saved point does not move past it.
    const invoice = invoiceNeedingPaymentIntent(event);
    const paymentIntent = invoice ? await invoicePaymentIntent(invoice, send) : null;
    const mapped = mapStripeWebhookEvent(event, eventMap, paymentIntent);
    if (mapped) payment_events.push(paymentEventNamedBy(mapped));
    else left_out += 1;
  }

  const more = page.has_more === true && events.length > 0;
  const oldest = events.at(-1);
  if (more && typeof oldest?.id !== 'string') throw new Error('Stripe returned a page with no event id to continue from.');
  return { payment_events, next_cursor: more ? oldest.id : null, complete: !more, cursor_too_old: false, left_out };
}
