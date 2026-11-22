// tools/take-payments/do-work/take-payments.mjs
//
// The functions the take-payments rows run, one per job. Each is `(input, { send, secrets }) => result`, run the
// way the workflows function runner runs a function:
//
//   node /opt/workflows/do-work/run-a-function.mjs /opt/take-payments/do-work/take-payments.mjs <function> < input.json
//
//   The tools keep nothing and open no door: the person's offers, code adjustments, eligibility rules and
//   suggested-amount rows are rows the caller's AI reads from its store and passes in the request (`offers`,
//   `adjustments`, `rules`, `suggestions`).
//   send     delivers one built Stripe request. By default it is made from the person's own Stripe key, which the row
//            mounts on descriptor 4 as the field of the seller's connection the input `seller_connection` names; tests pass a stand-in.
//   secrets  { webhookSecret }: the signing secret the row mounts on descriptor 5 (the connection's `webhook_secret`).
//   readKey  how a held value is read from its descriptor (tests pass a stand-in; the default reads the descriptor).
//
// Nothing here prices anything, names a product, or holds a key. A request is built from the person's offer rows and
// goes to Stripe only through `send`; with no key the function refuses before building a request that could be sent.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { openBillingPage, readBillingPage } from './billing-portal.mjs';
import { readCheckoutOffers } from '../../funnels-and-offers/read-data/read-offers.ts';
import { suggestionListsFrom } from '../read-data/suggestion-lists.mjs';
import { readCheckoutCodeAdjustments } from '../read-data/read-code-adjustments.ts';
import { buildCheckoutMaterialQuote, buildCheckoutQuote } from '../read-data/checkout-quote.ts';
import { applyOfferEligibility } from '../read-data/offer-eligibility.ts';
import { assertPaidAmountMatchesOffer, paidAmountMatchesSignedQuote, normalizePaidCurrency } from '../read-data/verify-paid-amount.ts';
import { checkoutMaterialFromQuote, serializeQuote, sessionIntentFromQuote } from './session-intent.ts';
import {
  advanceInstallment,
  cancelSubscription,
  createHostedSession,
  createSubscriptionSchedule,
  findCompletedHostedSession,
  listCompletedHostedSessions,
  listEndedSubscriptions,
  readHostedSession,
  updateSubscriptionMetadata,
} from './hosted-session.ts';
import { ensureOfferPaymentLinks } from './ensure-offer-payment-links.mjs';
import { destinationCheckoutSubject, onboardingLinkSubject, payeeAccountSubject, payeeReadiness, shareTransferSubject } from './connect-payees.mjs';
import { call } from '../../shared-code/src/build-provider-request.mjs';
import { verifyStripeWebhookSignature } from './admit-a-webhook.mjs';
import { invoiceNeedingPaymentIntent, mapStripeWebhookEvent, paymentEventNamedBy } from './map-webhook-event.mjs';
import { invoicePaymentIntent } from './invoice-payment-intent.mjs';
import { listStripeEvents } from './list-stripe-events.mjs';
import { heldKey, makeStripeSender } from './stripe-send.mjs';
import { assertTestKey, rehearseAPaymentSchedule } from './rehearse-a-payment-schedule.mjs';
import { rehearseABillingPage } from './rehearse-a-billing-page.mjs';
import { readStripeObjects } from './read-stripe-objects.mjs';
export { manageUsagePricing, priceResourceUsage, keepResourceUsageObservation, settleSharedResourceCost, correctResourceUsageSettlement, readResourceUsageSettlement } from './resource-usage.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const dataFile = name => JSON.parse(readFileSync(join(here, '..', 'read-data', name), 'utf8'));

// The descriptor numbers the rows mount things on: 4 is the person's Stripe key, 5 the signing secret for webhooks.
const STRIPE_KEY_DESCRIPTOR = 4;
const WEBHOOK_SECRET_DESCRIPTOR = 5;

/** A request's rows of one kind: the array it carries under `field`, each taking `kind` when its value names none (a row made in
 *  a list itself carries no `kind`). The tools read no store, so a request without the rows is refused by name. */
function rowsIn(input, field, kind) {
  if (!Array.isArray(input[field])) throw new Error(`Pass your ${field} in the request as an array of rows: this tool reads no store.`);
  return input[field].map(row => ({ kind, ...row }));
}

/** The offers: the request's own `offers` rows, with the suggested-amount rows its `suggestions` carry. */
function offersOf(input, options) {
  const rows = rowsIn(input, 'offers', 'commercial-offer');
  return readCheckoutOffers(rows, { ...options, suggestionLists: suggestionListsFrom(rows, input.suggestions ?? []) });
}

/** The code adjustments: the request's own `adjustments` rows (none when it carries none: no code changes a price). */
function adjustmentsOf(input) {
  return readCheckoutCodeAdjustments((input.adjustments ?? []).map(row => ({ kind: 'checkout-code-adjustment', ...row })));
}

function sender(context) {
  return context.send ?? makeStripeSender({ key: heldKey(STRIPE_KEY_DESCRIPTOR, context.readKey), fetchImpl: context.fetch });
}

// The sender of a test-mode tool: the person's held test key, and anything that is not a test key is refused before a
// request is built.
function testSender(context) {
  const key = context.key ?? heldKey(STRIPE_KEY_DESCRIPTOR, context.readKey);
  assertTestKey(key);
  return context.send ?? makeStripeSender({ key });
}

/** What the buyer would pay for the offer and price they chose: the amount due today, what repeats, and when. */
export function priceASale(input) {
  const offers = offersOf(input);
  const adjustments = adjustmentsOf(input);
  const quote = buildCheckoutMaterialQuote(offers, input, adjustments);
  const serialized = serializeQuote(quote);
  return { quote: serialized, material: checkoutMaterialFromQuote(serialized) };
}

/**
 * Price the sale and make the hosted Stripe Checkout Session the buyer is sent to. Needs the buyer's agreement to the
 * billing and legal terms in `consent`. Success and cancel addresses only say where the browser lands; access follows
 * the checked payment event. `metadata` (text keys and values) is carried onto the session and its subscription. A code of
 * duration once is taken off the first invoice by a coupon made for it (the same amount the quote took off).
 */
export async function startAStripeCheckout(input, context = {}) {
  const offers = offersOf(input);
  const adjustments = adjustmentsOf(input);
  const quote = serializeQuote(buildCheckoutQuote(offers, input, adjustments));
  const intent = sessionIntentFromQuote(quote, { success_url: input.success_url, cancel_url: input.cancel_url }, input.metadata);
  const send = sender(context);
  const discount = intent.session.first_invoice_discount;
  const discounts = discount
    ? [{ coupon: (await call(send, 'operation:create-coupon', {
      amount_off: discount.amount_cents,
      currency: discount.currency,
      duration: 'once',
      metadata: { adjustment_id: discount.adjustment_id },
    }, { idempotencyKey: `checkout-coupon:${discount.adjustment_id}:${discount.amount_cents}:${discount.currency}` })).id }]
    : undefined;
  const session = await createHostedSession({ ...intent, session: { ...intent.session, discounts } }, { send });
  return { ...checkoutMaterialFromQuote(quote), providerSessionId: session.provider_session_id, redirectUrl: session.url };
}

/**
 * Give a customer a credit on their next invoice: a negative balance transaction, which Stripe takes off the customer's next
 * invoices by itself. One credit per idempotency key, through the one send seam. Refuses before sending when the request is
 * malformed, and refuses the answer when Stripe did not book the credit asked for.
 */
export async function giveACustomerCredit(input, context = {}) {
  const { customer, amount_cents: amount, currency, description, idempotency_key: key } = input ?? {};
  if (typeof customer !== 'string' || !customer.trim()) throw new Error('customer names the Stripe customer the credit is for.');
  if (!Number.isSafeInteger(amount) || amount <= 0) throw new Error('amount_cents must be a whole number of cents above 0.');
  if (typeof currency !== 'string' || !/^[a-z]{3}$/i.test(currency)) throw new Error('currency must be a three-letter code.');
  if (typeof description !== 'string' || !description.trim() || description.length > 350) throw new Error('description says what the credit is for, in up to 350 characters.');
  if (typeof key !== 'string' || !key.trim() || key.length > 255) throw new Error('idempotency_key is required, up to 255 characters, so a repeated ask makes one credit.');
  const booked = await call(sender(context), 'operation:create-customer-balance-transaction', {
    amount: -amount,
    currency: currency.toLowerCase(),
    description: description.trim(),
  }, { ref: customer.trim(), idempotencyKey: key.trim() });
  if (booked.amount !== -amount) throw new Error(`Stripe booked ${booked.amount} for this credit, not ${-amount}.`);
  return { balance_transaction: booked.id, customer: customer.trim(), credit_cents: amount, currency: booked.currency, ending_balance: booked.ending_balance };
}

/** A hosted checkout whose money goes to someone the person pays, with the person's fee kept back. */
export async function startAPayeeCheckout(input, context = {}) {
  const offers = offersOf(input);
  const offer = offers.find(item => item.id === input.offer_id);
  if (!offer) throw new Error(`Offer ${input.offer_id} is not one of your offers.`);
  const option = offer.price_options.find(item => item.id === input.price_option_id);
  if (!option) throw new Error(`Price ${input.price_option_id} is not one of ${offer.id}'s prices.`);
  const subject = destinationCheckoutSubject({
    offer, option, payee_account: input.payee_account ?? null, fee: input.fee ?? null,
    payer_ref: input.payer_ref, success_url: input.success_url, cancel_url: input.cancel_url, metadata: input.metadata ?? {},
  });
  const session = await call(sender(context), 'operation:create-session', subject, { idempotencyKey: input.idempotency_key });
  return { providerSessionId: session.id, redirectUrl: session.url, platform_fee_cents: subject.metadata.platform_fee_cents ?? '0' };
}

export const lookUpAStripeCheckout = async (input, context = {}) => readHostedSession(input, { send: sender(context) });
export const findACompletedStripeCheckout = async (input, context = {}) => findCompletedHostedSession(input, { send: sender(context) });
export const scheduleLaterPayments = async (input, context = {}) => createSubscriptionSchedule(input, { send: sender(context) });
export const countAPaidInstallment = async (input, context = {}) => advanceInstallment(input, { send: sender(context) });
export const cancelAStripeSubscription = async (input, context = {}) => cancelSubscription(input, { send: sender(context) });
export const openABillingPage = async (input, context = {}) => openBillingPage(input, { send: sender(context) });
export const showOnePurchaseBilling = async (input, context = {}) => readBillingPage(input, { send: sender(context) });
/** Every completed checkout since a time, and every subscription that ended since a time: what a seller follows up. */
export const listCompletedStripeCheckouts = async (input, context = {}) => listCompletedHostedSessions(input, { send: sender(context) });
export const listEndedStripeSubscriptions = async (input, context = {}) => listEndedSubscriptions(input, { send: sender(context) });

/**
 * Stripe events of the kinds the event map names, from a time, as the payment rows the webhook check would keep for the
 * same events (see list-stripe-events.mjs). Nothing is kept here; the caller keeps each row once by its id.
 */
export const listStripeEventsAsPaymentEvents = async (input, context = {}) => listStripeEvents(input, {
  send: sender(context),
  eventMap: input.event_map ?? dataFile('webhook-event-map.json'),
});
export const tagAStripeSubscription = async (input, context = {}) => updateSubscriptionMetadata(input, { send: sender(context) });

/** One lasting payment link per priced option of every offer, the plan-management page, and the percent-off codes. */
export async function setUpStripePaymentLinks(input, context = {}) {
  const offers = offersOf(input);
  const adjustments = adjustmentsOf(input);
  return ensureOfferPaymentLinks({
    offers,
    adjustments: adjustments.filter(adjustment => adjustment.state === 'active'),
    owner: input.owner,
    afterPaymentUrl: input.after_payment_url,
    retireLinksWhere: input.retire_links_where ?? [],
    portal: input.portal ?? 'keep',
    apply: input.apply === true,
    send: sender(context),
  });
}

/**
 * Check a Stripe webhook the way Stripe documents it (the replay window and the signature, with the person's signing
 * secret) and read it as payment events. Nothing unchecked is kept: an event that fails any step comes back with its
 * reason and no records. A paid invoice is read for its PaymentIntent only after its signature is verified; a failed read
 * throws, so the webhook answers with an error and Stripe sends it again.
 */
export async function checkAStripeEvent(input, context = {}) {
  const secret = context.secrets?.webhookSecret ?? heldKey(WEBHOOK_SECRET_DESCRIPTOR, context.readKey);
  const checked = verifyStripeWebhookSignature({
    payload: input.payload,
    header: input.signature_header,
    secret,
    toleranceSeconds: input.tolerance_seconds,
    nowSeconds: input.now_seconds,
  });
  if (!checked.admitted) return { admitted: false, reason: checked.reason, payment_event: null };
  const invoice = invoiceNeedingPaymentIntent(checked.stripeEvent);
  const paymentIntent = invoice ? await invoicePaymentIntent(invoice, sender(context)) : null;
  const mapped = mapStripeWebhookEvent(checked.stripeEvent, input.event_map ?? dataFile('webhook-event-map.json'), paymentIntent);
  if (!mapped) return { admitted: false, reason: 'unmapped-event-type', payment_event: null };
  return {
    admitted: true,
    event_kind: mapped.event_kind,
    payment_event: paymentEventNamedBy(mapped),
  };
}

/**
 * A completed checkout as the Stripe event it stands for: the same `checkout.session.completed` shape the webhook check
 * maps, so the one DATA map (webhook-event-map.json) is the only place that knows Stripe's words. Its id comes
 * from the checkout, so reading the same checkout again names the same record.
 */
function checkoutAsStripeEvent(checkout) {
  return {
    id: `checkout:${checkout.provider_session_id}`,
    type: 'checkout.session.completed',
    created: checkout.created,
    data: { object: {
      id: checkout.provider_session_id,
      mode: checkout.payment_mode,
      payment_intent: checkout.payment_intent,
      invoice: checkout.invoice_id,
      amount_total: checkout.amount_total_cents,
      currency: checkout.currency,
      // A listed session is a completed one: it holds money when it charged anything, and none is owed when it charged 0.
      payment_status: checkout.amount_total_cents > 0 ? 'paid' : 'no_payment_required',
      subscription: checkout.subscription_id,
      customer_details: { email: checkout.customer_email },
      metadata: { offer_id: checkout.offer_id, ...(checkout.price_option_id ? { price_option_id: checkout.price_option_id } : {}), ...(checkout.journey_visitor ? { journey_visitor: checkout.journey_visitor } : {}) },
    } },
  };
}

/**
 * Every completed Stripe checkout since a time, as the payment events it stands for, returned in the answer (nothing is
 * kept here: the caller's AI keeps them where it keeps its records, and paid-access folds payment events into held
 * access by the buyer's email). An event's id comes from the checkout, so reading the same checkout again names the same
 * event. A checkout with no buyer email or no offer is left out, with the reason counted. Each event carries the
 * `pursuit_ids` of the offer it was bought under (the request's `offers` rows, matched by id or `earlier_ids`).
 */
export async function listCompletedCheckoutsAsPaymentEvents(input, context = {}) {
  const listed = await listCompletedHostedSessions(input, { send: sender(context) });
  const eventMap = input.event_map ?? dataFile('webhook-event-map.json');
  const offerRows = input.offers ?? [];
  const pursuitsOf = new Map(offerRows.filter(row => Array.isArray(row.pursuit_ids) && row.pursuit_ids.length)
    .flatMap(row => [row.id, ...(Array.isArray(row.earlier_ids) ? row.earlier_ids : [])].map(id => [id, row.pursuit_ids])));
  const left = { no_buyer_email: 0, no_offer: 0, not_mapped: 0 };
  const events = new Map();
  for (const checkout of listed.checkouts) {
    if (!checkout.customer_email) { left.no_buyer_email += 1; continue; }
    if (!checkout.offer_id) { left.no_offer += 1; continue; }
    const event = checkoutAsStripeEvent(checkout);
    // A subscription Checkout that charged is keyed by its first invoice's PaymentIntent, read here; a failed read throws.
    const invoice = invoiceNeedingPaymentIntent(event);
    const mapped = mapStripeWebhookEvent(event, eventMap, invoice ? await invoicePaymentIntent(invoice, sender(context)) : null);
    if (!mapped) { left.not_mapped += 1; continue; }
    const pursuits = pursuitsOf.get(checkout.offer_id);
    const row = paymentEventNamedBy(mapped);
    events.set(row.id, { ...row, ...(pursuits ? { pursuit_ids: pursuits } : {}) });
  }
  return { events: [...events.values()], left_out: left, complete: listed.complete, next_created_after_unix: listed.next_created_after_unix };
}

/** Whether the money a buyer actually paid is a price the offer declares (and, when given, the quoted one). */
export function checkWhatWasPaid(input) {
  const offers = offersOf(input, { includeSuperseded: true });
  const offer = offers.find(item => item.id === input.offer_id);
  if (!offer) throw new Error(`Offer ${input.offer_id} is not one of your offers.`);
  const paid = { amountCents: input.paid?.amountCents, currency: input.paid?.currency };
  try {
    assertPaidAmountMatchesOffer(offer, paid);
  } catch (error) {
    return { matches: false, reason: error.message };
  }
  if (input.quoted && !paidAmountMatchesSignedQuote(offer, paid, input.quoted)) {
    return { matches: false, reason: `Paid ${paid.amountCents} ${normalizePaidCurrency(paid.currency)} does not match the quoted ${input.quoted.amountCents}.` };
  }
  return { matches: true, reason: '' };
}

/** The offers a buyer may see, given the access they already hold and the person's eligibility rules. */
export function showOffersForABuyer(input) {
  const offers = offersOf(input);
  const rules = (input.rules ?? []).map(row => ({ kind: 'offer-eligibility-rule', ...row }));
  const { offers: visible, decisions } = applyOfferEligibility(offers, input.held_access_refs ?? [], rules);
  return { offers: visible, decisions };
}

/** A person to pay through Stripe: their account (made when none is named), what Stripe still needs, and the onboarding page. */
export async function setUpSomeoneIPay(input, context = {}) {
  const send = sender(context);
  const account = input.account
    ? await call(send, 'operation:read-connected-account', null, { ref: input.account })
    : await call(send, 'operation:create-connected-account', payeeAccountSubject({
      settings: input.settings, email: input.email, owner: input.owner, payee_ref: input.payee_ref,
    }), { idempotencyKey: input.idempotency_key });
  const link = await call(send, 'operation:create-account-link', onboardingLinkSubject({
    account: account.id, refresh_url: input.refresh_url, return_url: input.return_url,
  }));
  return { account: account.id, readiness: payeeReadiness(account), onboarding_url: link.url };
}

/**
 * Pay a share on from the person's own Stripe balance to someone they pay. This moves money, so it needs the person's
 * explicit `confirm_moves_money: true` in the same request, and the key.
 */
export async function paySomeoneAShare(input, context = {}) {
  if (input.confirm_moves_money !== true) {
    throw new Error('This pays real money out of your Stripe balance. Send confirm_moves_money: true to go ahead.');
  }
  const transfer = await call(sender(context), 'operation:create-transfer', shareTransferSubject(input), { idempotencyKey: input.idempotency_key });
  return { transfer: transfer.id, amount_cents: transfer.amount, currency: transfer.currency, destination: transfer.destination };
}

/**
 * Build the later payments of a schedule at Stripe in TEST MODE and report what Stripe says it will charge and when.
 * The key is the person's held test key; anything that is not a test key is refused before a request is built.
 */
export async function rehearseASchedule(input, context = {}) {
  return rehearseAPaymentSchedule(input, testSender(context));
}

/**
 * Make a subscription in Stripe TEST MODE and open its billing page, to see that the billing page comes back for a real
 * subscription at Stripe. The key is the person's held test key; anything that is not a test key is refused first.
 */
export async function rehearseABillingPageInTestMode(input, context = {}) {
  return rehearseABillingPage(input, testSender(context));
}

// `seller_connection` is the engine's: it names the connection whose key the row mounts, and is not an input of the read, which
// refuses any input its row of read-data/stripe-read-shapes.json does not name.
const readInputOf = ({ seller_connection: _mounted, ...input }) => input;

/** The promotion codes of the account (one by its code, or those active or not), with the coupon each gives. Reads only. */
export const readStripePromotionCodes = async (input, context = {}) => readStripeObjects('read:promotion-codes', readInputOf(input), { send: sender(context) });
/** The same read against the person's Stripe test account; a key that is not a test key is refused first. */
export const readStripePromotionCodesInTestMode = async (input, context = {}) => readStripeObjects('read:promotion-codes', readInputOf(input), { send: testSender(context) });

export { observeLiveUsage } from './live-usage.mjs';
export { reportResourceUsage, readResourceUsageReport, reconcileResourceUsageReport, cancelPreparedResourceUsageReport } from './resource-usage-reporting.mjs';
