// tools/take-payments/do-work/take-payments.mjs
//
// The functions the take-payments rows run, one per job. Each is `(input, { door, send, secrets }) => result`, run the
// way the records-door tool runs a function:
//
//   node /opt/records-door/do-work/run-an-export.mjs /opt/take-payments/do-work/take-payments.mjs <function> < input.json
//
//   door     the person's records door (descriptor 3): their offers, code adjustments and eligibility rules are
//            records they keep, read from there when the request does not carry them.
//   send     delivers one built Stripe request. By default it is made from the person's own Stripe key, which the row
//            mounts on descriptor 4 under the held-value name `stripe-api-key`; tests pass a stand-in.
//   secrets  { webhookSecret }: the signing secret the row mounts on descriptor 5 (`stripe-webhook-secret`).
//   readKey  how a held value is read from its descriptor (tests pass a stand-in; the default reads the descriptor).
//
// Nothing here prices anything, names a product, or holds a key. A request is built from the person's offer rows and
// goes to Stripe only through `send`; with no key the function refuses before building a request that could be sent.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { readCheckoutOffers } from '../../funnels-and-offers/read-data/read-offers.ts';
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
import { call } from './build-stripe-http-request.mjs';
import { admitStripeWebhook } from './compare-and-map-stripe-webhook.mjs';
import { heldKey, makeStripeSender } from './stripe-send.mjs';
import { assertTestKey, rehearseAPaymentSchedule } from './rehearse-a-payment-schedule.mjs';
export { manageUsagePricing, priceResourceUsage, keepResourceUsageObservation, settleSharedResourceCost, correctResourceUsageSettlement, readResourceUsageSettlement } from './resource-usage.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const dataFile = name => JSON.parse(readFileSync(join(here, '..', 'read-data', name), 'utf8'));

const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);

// The descriptor numbers the rows mount things on: 3 is the records door, 4 the person's Stripe key, 5 the signing
// secret for webhooks.
const STRIPE_KEY_DESCRIPTOR = 4;
const WEBHOOK_SECRET_DESCRIPTOR = 5;

/** The records of one kind, as the values the readers take. A record without a `kind` takes its type as its kind. */
async function recordsOf(door, type) {
  const values = [];
  for await (const record of door.list({ type })) {
    if (object(record.value)) values.push({ kind: type, ...record.value });
  }
  return values;
}

/** The offers: the request's own `offers` rows when it carries them, else the person's commercial-offer records. */
async function offersOf(input, context, options) {
  const rows = Array.isArray(input.offers) ? input.offers : await recordsOf(context.door, 'commercial-offer');
  return readCheckoutOffers(rows, options);
}

async function adjustmentsOf(input, context) {
  return readCheckoutCodeAdjustments(Array.isArray(input.adjustments) ? input.adjustments : await recordsOf(context.door, 'checkout-code-adjustment'));
}

function sender(context) {
  return context.send ?? makeStripeSender({ key: heldKey(STRIPE_KEY_DESCRIPTOR, context.readKey) });
}

/** What the buyer would pay for the offer and price they chose: the amount due today, what repeats, and when. */
export async function priceASale(input, context) {
  const offers = await offersOf(input, context);
  const adjustments = await adjustmentsOf(input, context);
  const quote = buildCheckoutMaterialQuote(offers, input, adjustments);
  const serialized = serializeQuote(quote);
  return { quote: serialized, material: checkoutMaterialFromQuote(serialized) };
}

/**
 * Price the sale and make the hosted Stripe Checkout Session the buyer is sent to. Needs the buyer's agreement to the
 * billing and legal terms in `consent`. Success and cancel addresses only say where the browser lands; access follows
 * the checked payment event.
 */
export async function startAStripeCheckout(input, context) {
  const offers = await offersOf(input, context);
  const adjustments = await adjustmentsOf(input, context);
  const quote = serializeQuote(buildCheckoutQuote(offers, input, adjustments));
  const intent = sessionIntentFromQuote(quote, { success_url: input.success_url, cancel_url: input.cancel_url });
  const session = await createHostedSession(intent, { send: sender(context) });
  return { ...checkoutMaterialFromQuote(quote), providerSessionId: session.provider_session_id, redirectUrl: session.url };
}

/** A hosted checkout whose money goes to someone the person pays, with the person's fee kept back. */
export async function startAPayeeCheckout(input, context) {
  const offers = await offersOf(input, context);
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

export const lookUpAStripeCheckout = async (input, context) => readHostedSession(input, { send: sender(context) });
export const findACompletedStripeCheckout = async (input, context) => findCompletedHostedSession(input, { send: sender(context) });
export const scheduleLaterPayments = async (input, context) => createSubscriptionSchedule(input, { send: sender(context) });
export const countAPaidInstallment = async (input, context) => advanceInstallment(input, { send: sender(context) });
export const cancelAStripeSubscription = async (input, context) => cancelSubscription(input, { send: sender(context) });
/** Every completed checkout since a time, and every subscription that ended since a time: what a seller follows up. */
export const listCompletedStripeCheckouts = async (input, context) => listCompletedHostedSessions(input, { send: sender(context) });
export const listEndedStripeSubscriptions = async (input, context) => listEndedSubscriptions(input, { send: sender(context) });
export const tagAStripeSubscription = async (input, context) => updateSubscriptionMetadata(input, { send: sender(context) });

/** One lasting payment link per priced option of every offer, the plan-management page, and the percent-off codes. */
export async function setUpStripePaymentLinks(input, context) {
  const offers = await offersOf(input, context);
  const adjustments = await adjustmentsOf(input, context);
  return ensureOfferPaymentLinks({
    offers,
    adjustments: adjustments.filter(adjustment => adjustment.state === 'active'),
    owner: input.owner,
    afterPaymentUrl: input.after_payment_url,
    retireLinksWhere: input.retire_links_where ?? [],
    send: sender(context),
  });
}

/**
 * Check a Stripe webhook the way Stripe documents it (the replay window and the signature, with the person's signing
 * secret) and read it as payment events. Nothing unchecked is kept: an event that fails any step comes back with its
 * reason and no records.
 */
export function checkAStripeEvent(input, context) {
  const secret = context.secrets?.webhookSecret ?? heldKey(WEBHOOK_SECRET_DESCRIPTOR, context.readKey);
  const verdict = admitStripeWebhook({
    payload: input.payload,
    header: input.signature_header,
    secret,
    eventMap: input.event_map ?? dataFile('stripe-webhook-event-map.json'),
    toleranceSeconds: input.tolerance_seconds,
    nowSeconds: input.now_seconds,
  });
  if (!verdict.admitted) return { admitted: false, reason: verdict.reason, payment_event: null };
  return {
    admitted: true,
    event_kind: verdict.event_kind,
    payment_event: { kind: 'payment-event', id: `payment-event:${verdict.records[0].event_id}`, ...verdict.records[0] },
  };
}

/** Whether the money a buyer actually paid is a price the offer declares (and, when given, the quoted one). */
export async function checkWhatWasPaid(input, context) {
  const offers = await offersOf(input, context, { includeSuperseded: true });
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
export async function showOffersForABuyer(input, context) {
  const offers = await offersOf(input, context);
  const rules = Array.isArray(input.rules) ? input.rules : await recordsOf(context.door, 'offer-eligibility-rule');
  const { offers: visible, decisions } = applyOfferEligibility(offers, input.held_access_refs ?? [], rules);
  return { offers: visible, decisions };
}

/** A person to pay through Stripe: their account (made when none is named), what Stripe still needs, and the onboarding page. */
export async function setUpSomeoneIPay(input, context) {
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
export async function paySomeoneAShare(input, context) {
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
export async function rehearseASchedule(input, context) {
  const key = context.key ?? heldKey(STRIPE_KEY_DESCRIPTOR, context.readKey);
  assertTestKey(key);
  return rehearseAPaymentSchedule(input, context.send ?? makeStripeSender({ key }));
}
