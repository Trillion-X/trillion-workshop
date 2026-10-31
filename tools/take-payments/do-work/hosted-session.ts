import { call } from './build-stripe-http-request.mjs';
import { paymentScheduleFromTheWire } from '../read-data/when-money-is-taken.ts';
import {
  howStripeTakesASchedule,
  whatTheCheckoutDoes,
  subscriptionScheduleRequest,
} from './stripe-phases-for-a-payment-schedule.ts';

// ============================================================================
// PURPOSE
// ----------------------------------------------------------------------------
// Stripe hosted Checkout Sessions and the subscription calls around them, for a seller's own Stripe account. Every
// function that talks to Stripe is built from the pure request builders in this folder and sent by the `send` the
// caller hands in (`stripe-send.mjs`: the person's own key goes on the request at the moment of sending and nowhere
// else). `sessionRequestBody` alone builds the session body with no sending at all.
//
// NON-NEGOTIABLE INVARIANTS
//   - The key never enters this file: it is the sender's.
//   - success_url / cancel_url are only where the buyer's browser lands. They NEVER grant access. Access follows
//     the signature-checked payment event, never the redirect.
//   - Idempotency-Key is REQUIRED on create, so a refresh or retry cannot make a second session.
//   - Price is the seller's offer DATA: a pre-made price ref when the caller has one, else an inline price from the
//     offer's amounts.
// ============================================================================

export type Send = (request: { method: string; url: string; headers: Record<string, string>; body?: string }) => Promise<Record<string, unknown>>;

export type HostedSessionLineItem = {
  /** Pre-created Stripe Price id (offer DATA carries one) — preferred when present. */
  price_ref?: string;
  /** Inline price_data unit amount in minor units — used when no price_ref. */
  amount_cents?: number;
  /** Whether this line renews or appears only on the first subscription invoice. */
  billing_mode?: 'recurring' | 'one_time';
  /** Inline price_data product name — used when no price_ref. */
  product_name?: string;
  /** Line quantity. For per-unit add-ons this is max(0, unitCount - included_units). */
  quantity: number;
};

export type CreateHostedSessionInput = {
  session: {
    currency: string;
    /**
     * Provider session mode selected by DATA (offer payment_timing threaded through
     * the quote): 'subscription' builds a recurring Stripe subscription session;
     * 'payment' builds a one_time Stripe payment session. The caller (the session intent)
     * always sets it.
     */
    payment_mode: string;
    /** Recurring interval for inline price_data (used only in subscription mode). */
    interval?: string;
    /**
     * Fixed number of installments for a bounded pay-in-N offer. When present (>= 2)
     * the recurring subscription is stamped with this bound in its metadata so the
     * grant path cancels it after the Nth paid invoice. Absent for open subscriptions
     * and one_time payments.
     */
    installment_count?: number;
    customer_email?: string;
    /** Grant-key echoed back through the webhook (checkoutAttemptId / accountId). */
    client_reference_id?: string;
    offer_id?: string;
    price_option_id?: string;
    validated_amount_cents?: number;
    /** Authoritative total expected on the first subscription invoice. */
    initial_amount_cents?: number;
    cadence?: string;
    /** Extra string metadata the caller wants echoed back on the session and the subscription. */
    metadata?: Record<string, string>;
    /** Total requested units — metadata only (not a Stripe quantity). */
    unit_count?: number;
    /** Days before the first charge; 0/undefined = no trial. $0 charged today when > 0. */
    trial_days?: number;
    /**
     * WHAT THIS OFFER TAKES AND WHEN, said once, as the offer says it.
     *
     * When present this decides the whole session and every field above that
     * describes money is ignored, because two descriptions of what to charge
     * is one too many: the older fields can only say "some now, then the same
     * amount forever", and an offer that charges $20 today, $80 next week and
     * $100 a month after that is not expressible in them at all.
     *
     * The first charge is taken by this checkout rather than by the schedule
     * that follows it. The provider's own documentation is the reason: a
     * subscription schedule's first invoice is created as a draft and
     * finalized about an hour later, so a schedule starting now does not
     * charge now, and the one charge that must not be late is the one the
     * person is watching.
     *
     * Wire shape, amounts as text because whole cents are not JSON numbers:
     *   { charges: [{ amount_cents, days_after_signup }], repeat: ... | null }
     */
    payment_schedule?: unknown;
    success_url: string;
    cancel_url: string;
    line_items: HostedSessionLineItem[];
  };
  idempotency_key: string;
};

export type HostedSessionResult = {
  created?: number;
  provider_session_id: string;
  url: string;
  status: string;
  mode: string;
  amount_total: number | null;
  currency: string | null;
  subscription: string | null;
  /** 'paid' | 'no_payment_required' | 'unpaid' — set on read, absent on create. */
  payment_status?: string;
  /** Buyer email captured by Stripe (customer_details.email / customer_email). */
  customer_email?: string;
  /** Grant keys we set in session metadata at create time. */
  offer_id?: string;
  client_reference_id?: string;
  cadence?: string;
  metadata?: Record<string, string>;
  /**
   * The subscription's RECURRING amount in minor units (base + metered add-ons),
   * read authoritatively from the Stripe subscription. This is the "verified money"
   * the offer money-gate matches — a trial charges 0 today but commits to this.
   */
  recurring_amount_cents?: number | null;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function text(value: unknown): string {
  return typeof value === 'string' && value.trim() ? value.trim() : '';
}

function positiveInt(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? Math.floor(value) : 0;
}

class HostedSessionError extends Error {
  public readonly publicStatus: number;

  constructor(message: string, publicStatus = 502) {
    super(message);
    this.publicStatus = publicStatus;
  }
}

/** Build one Stripe line_items[] entry: pre-created price ref OR inline price_data. */
function lineItemBody(
  item: HostedSessionLineItem,
  currency: string,
  interval: string,
  isSubscription: boolean,
) {
  const quantity = positiveInt(item.quantity);
  if (quantity <= 0) return null;
  const priceRef = text(item.price_ref);
  if (priceRef) {
    return { price: priceRef, quantity };
  }
  const amount = positiveInt(item.amount_cents);
  if (amount <= 0) {
    throw new HostedSessionError('Line item needs price_ref or a positive amount_cents.', 400);
  }
  const priceData: Record<string, unknown> = {
    currency,
    product_data: { name: requiredProductName(item) },
    unit_amount: amount,
  };
  // A subscription Checkout Session may contain both recurring items and
  // one-time items. One-time items appear only on the first invoice.
  const lineRecurs = isSubscription && text(item.billing_mode) !== 'one_time';
  if (lineRecurs) priceData.recurring = { interval: text(interval) || 'month' };
  return { price_data: priceData, quantity };
}

/**
 * The line items and session mode a payment schedule asks for.
 *
 * Only the door charge appears here. Everything after it is phases, attached
 * once the card is collected, and putting any of it in the session would mean
 * the same money described twice in two places that can disagree.
 */
function doorChargeFromASchedule(
  session: CreateHostedSessionInput['session'],
  currency: string,
) {
  const schedule = paymentScheduleFromTheWire(session.payment_schedule);
  const arrangement = howStripeTakesASchedule(schedule);
  const checkout = whatTheCheckoutDoes(arrangement);

  if (checkout.amountCents > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new HostedSessionError('The amount due at the door is too large to send without losing cents.', 400);
  }

  const productName = text(session.line_items?.[0]?.product_name) || text(session.offer_id);
  if (checkout.mode === 'payment' && !productName) {
    // A charge with nothing naming it appears on a statement as money taken by
    // nobody for nothing. This package holds no product's name of its own, so
    // the caller supplies it or there is no session.
    throw new HostedSessionError('A charge needs a name for what is being bought.', 400);
  }

  return { arrangement, checkout, productName, currency };
}

/** Assemble the create-session form body from the provider-agnostic session intent. */
export function sessionRequestBody(session: CreateHostedSessionInput['session']) {
  const currency = text(session.currency) || 'usd';
  const interval = text(session.interval) || 'month';
  // A schedule says what this offer takes and when, so when one is present it
  // decides the session and the older money fields are not consulted at all.
  const scheduled = session.payment_schedule === undefined || session.payment_schedule === null
    ? null
    : doorChargeFromASchedule(session, currency);

  // The Stripe checkout-session mode is DATA-selected. 'payment' is Stripe's one_time
  // mode; anything else maps to the recurring 'subscription' mode.
  const stripeMode = scheduled
    ? scheduled.checkout.mode
    : (text(session.payment_mode) === 'payment' ? 'payment' : 'subscription');
  const isSubscription = stripeMode === 'subscription';
  const lineItems = scheduled
    ? (scheduled.checkout.mode === 'payment'
      ? [lineItemBody(
        {
          amount_cents: Number(scheduled.checkout.amountCents),
          billing_mode: 'one_time' as const,
          product_name: scheduled.productName,
          quantity: 1,
        },
        currency,
        interval,
        false,
      )].filter((item): item is NonNullable<typeof item> => item !== null)
      : [])
    : (Array.isArray(session.line_items) ? session.line_items : [])
      .map((item) => lineItemBody(item, currency, interval, isSubscription))
      .filter((item): item is NonNullable<typeof item> => item !== null);
  // A setup session takes no money, so it carries no line items and must not
  // be refused for having none.
  if (lineItems.length === 0 && stripeMode !== 'setup') {
    throw new HostedSessionError('At least one line item is required for a checkout session.', 400);
  }

  const offerId = text(session.offer_id);
  const clientRef = text(session.client_reference_id);
  const unitCount = positiveInt(session.unit_count);
  const trialDays = positiveInt(session.trial_days);
  const metadata: Record<string, string> = {};
  if (offerId) metadata.offer_id = offerId;
  if (clientRef) metadata.checkout_attempt_id = clientRef;
  if (unitCount > 0) metadata.unit_count = String(unitCount);
  const priceOptionId = text(session.price_option_id);
  const validatedAmountCents = positiveInt(session.validated_amount_cents);
  const cadence = text(session.cadence);
  const initialAmountCents = positiveInt(session.initial_amount_cents);
  if (priceOptionId) metadata.price_option_id = priceOptionId;
  if (validatedAmountCents > 0) metadata.validated_amount_cents = String(validatedAmountCents);
  if (cadence) metadata.cadence = cadence;
  if (initialAmountCents > 0) metadata.initial_amount_cents = String(initialAmountCents);
  Object.assign(metadata, stringMetadata(session.metadata));

  const body: Record<string, unknown> = {
    mode: stripeMode,
    success_url: text(session.success_url),
    cancel_url: text(session.cancel_url),
  };
  if (lineItems.length > 0) body.line_items = lineItems;

  if (scheduled?.checkout.keepTheCardForLater) {
    // EVERYTHING SCHEDULED DEPENDS ON THIS ONE FIELD.
    //
    // Without it the card is authorized for this charge and then forgotten, so
    // the schedule has nothing to bill. It fails on its first phase, days
    // later, to somebody who was told they were signed up and has no reason to
    // come back and look. Nothing about the checkout itself looks wrong, which
    // is why it belongs beside the reason rather than in a list of options.
    //
    // A customer must also exist for a schedule to attach to, and a session
    // that only collects a card makes one by itself; one that takes money does
    // not unless it is asked to.
    body.customer_creation = 'always';
    if (stripeMode === 'payment') {
      body.payment_intent_data = { setup_future_usage: 'off_session' };
    }
  }
  if (session.customer_email) body.customer_email = text(session.customer_email);
  if (clientRef) body.client_reference_id = clientRef;
  if (Object.keys(metadata).length > 0) body.metadata = metadata;

  // trial + per-subscription metadata only exist on a subscription session. A one_time
  // payment session carries the grant metadata at the top level (set above).
  if (isSubscription && !scheduled) {
    const subscriptionData: Record<string, unknown> = {};
    if (trialDays > 0) subscriptionData.trial_period_days = trialDays;
    const subscriptionMetadata: Record<string, string> = { ...metadata };
    // Stripe's subscription-ended webhook carries the Subscription object, not
    // the Checkout Session. Preserve the same already-provider-visible buyer
    // email on the Subscription so the generic entitlement-reversal route can
    // deterministically derive the account without trusting browser input or
    // performing a second network lookup after the subscription has ended.
    const customerEmail = text(session.customer_email);
    if (customerEmail) subscriptionMetadata.customer_email = customerEmail;
    // A bounded installment stamps its bound into the subscription so the grant path
    // (advance-installment) knows the target count and can stop after the Nth paid
    // invoice. installments_paid starts at 0 and the grant path increments it.
    const installmentCount = positiveInt(session.installment_count);
    if (installmentCount >= 2) {
      subscriptionMetadata.installment_count = String(installmentCount);
      subscriptionMetadata.installments_paid = '0';
    }
    if (Object.keys(subscriptionMetadata).length > 0) subscriptionData.metadata = subscriptionMetadata;
    if (Object.keys(subscriptionData).length > 0) body.subscription_data = subscriptionData;
  }
  return body;
}

/** A charge with nothing naming it appears on a statement as money taken by nobody for nothing. */
function requiredProductName(item: HostedSessionLineItem): string {
  const name = text(item.product_name);
  if (!name) throw new HostedSessionError('A charge needs a name for what is being bought.', 400);
  return name;
}

function toResult(session: Record<string, unknown>): HostedSessionResult {
  return {
    provider_session_id: text(session.id),
    url: text(session.url),
    status: text(session.status) || 'open',
    mode: text(session.mode) || 'subscription',
    amount_total: typeof session.amount_total === 'number' ? session.amount_total : null,
    currency: text(session.currency) || null,
    subscription: text(session.subscription) || null,
  };
}

function customerEmailOf(session: Record<string, unknown>): string {
  const direct = text(session.customer_email);
  if (direct) return direct;
  const details = isRecord(session.customer_details) ? session.customer_details : {};
  return text(details.email);
}

/** Sum a subscription's recurring line items: sum(price.unit_amount * quantity). */
function subscriptionRecurringCents(subscription: Record<string, unknown>): number | null {
  const items = isRecord(subscription.items) ? subscription.items : {};
  const data = Array.isArray(items.data) ? items.data : [];
  if (data.length === 0) return null;
  let total = 0;
  for (const raw of data) {
    const item = isRecord(raw) ? raw : {};
    const price = isRecord(item.price) ? item.price : {};
    const unit = typeof price.unit_amount === 'number' ? price.unit_amount : 0;
    const qty = typeof item.quantity === 'number' && item.quantity > 0 ? item.quantity : 1;
    total += unit * qty;
  }
  return total;
}

function stringMetadata(value: unknown): Record<string, string> {
  if (!isRecord(value)) return {};
  const out: Record<string, string> = {};
  for (const [key, raw] of Object.entries(value)) {
    const normalized = text(raw);
    if (normalized) out[key] = normalized;
  }
  return out;
}

function intOf(value: unknown): number {
  if (typeof value === 'number' && Number.isFinite(value)) return Math.floor(value);
  if (typeof value === 'string' && value.trim() && Number.isFinite(Number(value))) return Math.floor(Number(value));
  return 0;
}

/**
 * Create a Stripe hosted Checkout Session and return the hosted `url` for the buyer to be sent to.
 * Fail-closed: bad input or a non-2xx Stripe reply throws, so the caller surfaces a clean error and never a silent
 * success.
 */
export async function createHostedSession(input: unknown, { send }: { send: Send }): Promise<HostedSessionResult> {
  const row = isRecord(input) ? input : {};
  const session = isRecord(row.session) ? (row.session as CreateHostedSessionInput['session']) : null;
  if (!session) throw new HostedSessionError('session intent is required.', 400);
  const idempotencyKey = text(row.idempotency_key);
  if (!idempotencyKey) {
    throw new HostedSessionError('idempotency_key is required to create a checkout session.', 400);
  }
  const created = await call(send, 'operation:create-session', sessionRequestBody(session), { idempotencyKey });
  const result = toResult(created);
  if (!result.provider_session_id || !result.url) {
    throw new HostedSessionError('Stripe did not return a hosted checkout session url.');
  }
  return result;
}

/**
 * Read a hosted Checkout Session by id, enriched for the grant path: the session's completion status, payment_status,
 * buyer email and the metadata set at create time, AND the subscription's authoritative recurring amount (a follow-up
 * read of the subscription). The amounts and status come from Stripe, not from the browser, so the success redirect
 * cannot forge them.
 */
export async function readHostedSession(input: unknown, { send }: { send: Send }): Promise<HostedSessionResult> {
  const row = isRecord(input) ? input : {};
  const sessionId = text(row.provider_session_id ?? row.session_id ?? row.id);
  if (!sessionId) throw new HostedSessionError('provider_session_id is required.', 400);

  const session = await call(send, 'operation:read-session', null, { ref: sessionId });

  const result = toResult(session);
  result.created = typeof session.created === 'number' && Number.isSafeInteger(session.created)
    && session.created > 0 ? session.created : undefined;
  result.payment_status = text(session.payment_status) || undefined;
  result.customer_email = customerEmailOf(session) || undefined;
  const metadata = isRecord(session.metadata) ? session.metadata : {};
  result.offer_id = text(metadata.offer_id) || undefined;
  result.client_reference_id = text(session.client_reference_id) || undefined;
  result.price_option_id = text(metadata.price_option_id) || undefined;
  result.validated_amount_cents = positiveInt(Number(metadata.validated_amount_cents)) || null;
  result.initial_amount_cents = positiveInt(Number(metadata.initial_amount_cents)) || null;
  result.cadence = text(metadata.cadence) || undefined;
  result.metadata = stringMetadata(metadata);
  result.recurring_amount_cents = null;

  const subscriptionId = text(session.subscription);
  if (subscriptionId) {
    const subscription = await call(send, 'operation:read-subscription', null, { ref: subscriptionId });
    result.recurring_amount_cents = subscriptionRecurringCents(subscription);
    if (!result.currency) result.currency = text(subscription.currency) || null;
  }
  return result;
}

/**
 * Find the newest completed hosted session for one exact buyer and offer.
 *
 * This is the recovery half of hosted checkout: the normal path carries the session id on the provider return URL,
 * while this bounded read lets an idempotent grant be resumed when that browser return was interrupted. The provider
 * remains the source of truth and only matching completed sessions are returned; no customer, card, invoice, or
 * credential material crosses this boundary.
 */
export async function findCompletedHostedSession(input: unknown, { send }: { send: Send }) {
  const row = isRecord(input) ? input : {};
  const customerEmail = text(row.customer_email ?? row.email).toLowerCase();
  const offerId = text(row.offer_id ?? row.offerId);
  const hasCustomerEmail = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(customerEmail);
  const createdAfterUnix = Number(row.created_after_unix ?? row.createdAfterUnix);
  const hasCreatedBoundary = Number.isSafeInteger(createdAfterUnix) && createdAfterUnix > 0;
  if (!hasCustomerEmail && !hasCreatedBoundary) {
    throw new HostedSessionError(
      'customer_email or created_after_unix is required to recover a hosted checkout.',
      400,
    );
  }
  if (!offerId) {
    throw new HostedSessionError('offer_id is required to recover a hosted checkout.', 400);
  }

  let startingAfter = '';
  let pagesRead = 0;
  let sessionsExamined = 0;
  let matchingEmailCount = 0;
  let matchingOfferCount = 0;
  const offerMatchesWithinBoundary: string[] = [];

  while (pagesRead < 10) {
    const query: Record<string, unknown> = { limit: '100', status: 'complete' };
    if (hasCreatedBoundary) query.created = { gte: createdAfterUnix };
    if (startingAfter) query.starting_after = startingAfter;
    const page = await call(send, 'operation:list-sessions', query);
    pagesRead += 1;
    const sessions = Array.isArray(page.data) ? page.data : [];
    for (const candidate of sessions) {
      if (!isRecord(candidate)) continue;
      sessionsExamined += 1;
      const metadata = isRecord(candidate.metadata) ? candidate.metadata : {};
      const emailMatches = hasCustomerEmail
        && customerEmailOf(candidate).toLowerCase() === customerEmail;
      const offerMatches = text(metadata.offer_id) === offerId;
      if (emailMatches) matchingEmailCount += 1;
      if (offerMatches) matchingOfferCount += 1;
      if (!offerMatches || (hasCustomerEmail && !emailMatches)) continue;
      const providerSessionId = text(candidate.id);
      if (!providerSessionId) continue;
      if (!hasCustomerEmail) {
        offerMatchesWithinBoundary.push(providerSessionId);
        continue;
      }
      return {
        found: true,
        provider_session_id: providerSessionId,
        pages_read: pagesRead,
        sessions_examined: sessionsExamined,
        matching_email_count: matchingEmailCount,
        matching_offer_count: matchingOfferCount,
      };
    }
    if (page.has_more !== true || sessions.length === 0) break;
    const last = sessions.at(-1);
    startingAfter = isRecord(last) ? text(last.id) : '';
    if (!startingAfter) break;
  }

  if (!hasCustomerEmail && offerMatchesWithinBoundary.length === 1) {
    return {
      found: true,
      provider_session_id: offerMatchesWithinBoundary[0],
      pages_read: pagesRead,
      sessions_examined: sessionsExamined,
      matching_email_count: 0,
      matching_offer_count: matchingOfferCount,
    };
  }

  return {
    found: false,
    pages_read: pagesRead,
    sessions_examined: sessionsExamined,
    matching_email_count: matchingEmailCount,
    matching_offer_count: matchingOfferCount,
    ambiguous: !hasCustomerEmail && offerMatchesWithinBoundary.length > 1,
  };
}

/** One completed checkout as a seller's follow-up needs it: who bought what, for how much, and the subscription. */
export type CompletedCheckout = {
  provider_session_id: string;
  created: number;
  customer_email: string | null;
  offer_id: string | null;
  price_option_id: string | null;
  amount_total_cents: number | null;
  currency: string | null;
  subscription_id: string | null;
};

/**
 * Every completed hosted checkout since a time, oldest first, for a seller who follows up on each one (sends the setup,
 * keeps a customer record). Payment Link checkouts are hosted sessions too, so this finds them with the rest.
 *
 * Bounded: at most `max_pages` (default 10, at most 10) pages of 100. `complete` is false when more remained, and
 * `next_created_after_unix` is where the next read starts; the same checkout can come back in two reads, so a caller keeps
 * each one once by `provider_session_id`. Only the fields above cross this boundary; no card,
 * invoice, address or customer object does. `offer_id` keeps only sessions whose metadata names that offer.
 */
export async function listCompletedHostedSessions(input: unknown, { send }: { send: Send }) {
  const row = isRecord(input) ? input : {};
  const createdAfterUnix = Number(row.created_after_unix ?? row.createdAfterUnix);
  if (!Number.isSafeInteger(createdAfterUnix) || createdAfterUnix < 0) {
    throw new HostedSessionError('created_after_unix (a whole number of seconds) is required.', 400);
  }
  const offerId = text(row.offer_id ?? row.offerId);
  const maxPages = Math.min(10, positiveInt(Number(row.max_pages)) || 10);

  const found: CompletedCheckout[] = [];
  let startingAfter = '';
  let pagesRead = 0;
  let more = false;
  while (pagesRead < maxPages) {
    const query: Record<string, unknown> = { limit: '100', status: 'complete', created: { gte: createdAfterUnix } };
    if (startingAfter) query.starting_after = startingAfter;
    const page = await call(send, 'operation:list-sessions', query);
    pagesRead += 1;
    const sessions = Array.isArray(page.data) ? page.data : [];
    for (const candidate of sessions) {
      if (!isRecord(candidate)) continue;
      const metadata = isRecord(candidate.metadata) ? candidate.metadata : {};
      const providerSessionId = text(candidate.id);
      if (!providerSessionId || (offerId && text(metadata.offer_id) !== offerId)) continue;
      found.push({
        provider_session_id: providerSessionId,
        created: typeof candidate.created === 'number' ? candidate.created : 0,
        customer_email: customerEmailOf(candidate) || null,
        offer_id: text(metadata.offer_id) || null,
        price_option_id: text(metadata.price_option_id) || null,
        amount_total_cents: typeof candidate.amount_total === 'number' ? candidate.amount_total : null,
        currency: text(candidate.currency) || null,
        subscription_id: text(candidate.subscription) || null,
      });
    }
    more = page.has_more === true && sessions.length > 0;
    if (!more) break;
    const last = sessions.at(-1);
    startingAfter = isRecord(last) ? text(last.id) : '';
    if (!startingAfter) break;
  }
  found.sort((a, b) => a.created - b.created || a.provider_session_id.localeCompare(b.provider_session_id));
  const newest = found.at(-1)?.created;
  return {
    checkouts: found,
    complete: !more,
    pages_read: pagesRead,
    // Stripe lists newest first, so what a cut-short read left is older: the next read starts at the same time again.
    // A complete read moves on to the newest checkout's second (not past it, so one made later in that second is
    // kept); a caller keeps each checkout once by provider_session_id.
    next_created_after_unix: more ? createdAfterUnix : newest ?? createdAfterUnix,
  };
}

/**
 * Subscriptions that ended since a time, for a seller who marks each customer's record ended. Bounded like
 * listCompletedHostedSessions; only the subscription id, when it ended, and the metadata it carries cross back.
 */
export async function listEndedSubscriptions(input: unknown, { send }: { send: Send }) {
  const row = isRecord(input) ? input : {};
  const endedAfterUnix = Number(row.ended_after_unix ?? row.endedAfterUnix);
  if (!Number.isSafeInteger(endedAfterUnix) || endedAfterUnix < 0) {
    throw new HostedSessionError('ended_after_unix (a whole number of seconds) is required.', 400);
  }
  const maxPages = Math.min(10, positiveInt(Number(row.max_pages)) || 10);

  const ended: { subscription_id: string; ended_at: number; metadata: Record<string, string> }[] = [];
  let startingAfter = '';
  let pagesRead = 0;
  let more = false;
  while (pagesRead < maxPages) {
    const query: Record<string, unknown> = { limit: '100', status: 'canceled' };
    if (startingAfter) query.starting_after = startingAfter;
    const page = await call(send, 'operation:list-subscriptions', query);
    pagesRead += 1;
    const subscriptions = Array.isArray(page.data) ? page.data : [];
    for (const candidate of subscriptions) {
      if (!isRecord(candidate)) continue;
      const subscriptionId = text(candidate.id);
      const endedAt = typeof candidate.ended_at === 'number' ? candidate.ended_at : 0;
      if (!subscriptionId || endedAt < endedAfterUnix) continue;
      ended.push({ subscription_id: subscriptionId, ended_at: endedAt, metadata: stringMetadata(candidate.metadata) });
    }
    more = page.has_more === true && subscriptions.length > 0;
    if (!more) break;
    const last = subscriptions.at(-1);
    startingAfter = isRecord(last) ? text(last.id) : '';
    if (!startingAfter) break;
  }
  ended.sort((a, b) => a.ended_at - b.ended_at || a.subscription_id.localeCompare(b.subscription_id));
  return { ended, complete: !more, pages_read: pagesRead };
}

export type CreateSubscriptionScheduleResult = {
  schedule_id: string;
  status: string;
  starts_at: number;
};

/**
 * Create the schedule that takes everything after the door charge.
 *
 * This runs once the checkout has settled, because until then there is no customer to bill and no card to bill it
 * to. The door charge is NOT here and must not be: the provider creates a schedule's first invoice as a draft and
 * finalizes it about an hour later, so money that has to land while the person is watching cannot be one of these
 * phases.
 *
 * Fail-closed on every missing piece. A schedule that silently does not get made is an offer whose later charges
 * never happen, discovered weeks later by nobody, because everything about the checkout looked right.
 */
export async function createSubscriptionSchedule(input: unknown, { send }: { send: Send }): Promise<CreateSubscriptionScheduleResult> {
  const row = isRecord(input) ? input : {};
  const schedule = paymentScheduleFromTheWire(row.payment_schedule);
  const arrangement = howStripeTakesASchedule(schedule);
  const request = subscriptionScheduleRequest(arrangement, {
    customerRef: text(row.customer_ref ?? row.customer),
    currency: text(row.currency) || 'usd',
    productName: text(row.product_name),
    // The caller says when signup happened rather than this reading a clock, so asking twice for one signup asks for
    // the same schedule twice instead of two schedules a few seconds apart.
    signedUpAtUnixSeconds: Number(row.signed_up_at_unix_seconds),
  });

  const idempotencyKey = text(row.idempotency_key);
  const created = await call(send, 'operation:create-subscription-schedule', request, idempotencyKey ? { idempotencyKey } : {});
  const scheduleId = text(created.id);
  if (!scheduleId) {
    throw new HostedSessionError('Stripe did not return a subscription schedule.', 502);
  }
  return {
    schedule_id: scheduleId,
    status: text(created.status) || 'not_started',
    starts_at: Number(request.start_date),
  };
}

export type CancelSubscriptionResult = {
  subscription_id: string;
  status: string;
  cancel_at_period_end: boolean;
};

export type UpdateSubscriptionMetadataResult = {
  subscription_id: string;
  metadata: Record<string, string>;
  updated: boolean;
};

/**
 * Cancel a Stripe subscription. Immediate cancel (DELETE) stops it now; at_period_end keeps the already-paid period
 * active and stops the next renewal. Fail-closed: a missing id throws, so the caller never silently leaves a
 * subscription running.
 */
export async function cancelSubscription(input: unknown, { send }: { send: Send }): Promise<CancelSubscriptionResult> {
  const row = isRecord(input) ? input : {};
  const subscriptionId = text(row.subscription_id ?? row.subscription ?? row.id);
  if (!subscriptionId) throw new HostedSessionError('subscription_id is required to cancel.', 400);
  const atPeriodEnd = row.at_period_end === true;
  const subscription = atPeriodEnd
    ? await call(send, 'operation:update-subscription', { cancel_at_period_end: true }, { ref: subscriptionId })
    : await call(send, 'operation:cancel-subscription', null, { ref: subscriptionId });
  return {
    subscription_id: text(subscription.id) || subscriptionId,
    status: text(subscription.status) || (atPeriodEnd ? 'active' : 'canceled'),
    cancel_at_period_end: subscription.cancel_at_period_end === true,
  };
}

/**
 * Additive subscription metadata patch. Reads the current subscription first, merges only the non-empty keys given,
 * and skips the write when the effective metadata is unchanged.
 */
export async function updateSubscriptionMetadata(input: unknown, { send }: { send: Send }): Promise<UpdateSubscriptionMetadataResult> {
  const row = isRecord(input) ? input : {};
  const subscriptionId = text(row.subscription_id ?? row.subscription ?? row.id);
  if (!subscriptionId) {
    throw new HostedSessionError('subscription_id is required to update subscription metadata.', 400);
  }
  const patch = stringMetadata(row.metadata);
  if (Object.keys(patch).length === 0) {
    return { subscription_id: subscriptionId, metadata: {}, updated: false };
  }
  const current = await call(send, 'operation:read-subscription', null, { ref: subscriptionId });
  const currentMetadata = stringMetadata(current.metadata);
  const nextMetadata = { ...currentMetadata, ...patch };
  const changed = Object.keys(nextMetadata).some((keyName) => currentMetadata[keyName] !== nextMetadata[keyName])
    || Object.keys(currentMetadata).length !== Object.keys(nextMetadata).length;
  if (!changed) {
    return { subscription_id: subscriptionId, metadata: nextMetadata, updated: false };
  }
  const subscription = await call(send, 'operation:update-subscription', { metadata: nextMetadata }, { ref: subscriptionId });
  return {
    subscription_id: text(subscription.id) || subscriptionId,
    metadata: stringMetadata(subscription.metadata),
    updated: true,
  };
}

export type AdvanceInstallmentResult = {
  subscription_id: string;
  /** True when this subscription is a bounded installment plan we act on; false = ignored. */
  handled: boolean;
  /** How many installments have been paid after this event (counter after increment). */
  installments_paid: number;
  /** The plan's fixed count (0 when not an installment subscription). */
  installment_count: number;
  /** True when this event completed the plan and the subscription was canceled. */
  canceled: boolean;
  /** True when this invoice was already counted (idempotent replay of a webhook). */
  duplicate: boolean;
};

/**
 * Count one paid installment of a bounded pay-in-N offer. Called on each paid-invoice event carrying the subscription.
 * It reads the plan's installment bound from the subscription's metadata, counts this paid invoice, and once the Nth
 * installment is paid it cancels the subscription so no further invoice is ever generated (the exact bound an open
 * Stripe subscription lacks). Open subscriptions (no installment_count metadata) are ignored. Idempotent: a replayed
 * webhook for the same invoice id is counted once.
 */
export async function advanceInstallment(input: unknown, { send }: { send: Send }): Promise<AdvanceInstallmentResult> {
  const row = isRecord(input) ? input : {};
  const subscriptionId = text(row.subscription_id ?? row.subscription ?? row.id);
  if (!subscriptionId) throw new HostedSessionError('subscription_id is required to advance an installment.', 400);
  const invoiceId = text(row.invoice_id ?? row.invoice);

  const subscription = await call(send, 'operation:read-subscription', null, { ref: subscriptionId });
  const metadata = isRecord(subscription.metadata) ? subscription.metadata : {};
  const installmentCount = intOf(metadata.installment_count);
  // Not a bounded installment: leave open subscriptions untouched.
  if (installmentCount < 2) {
    return {
      subscription_id: subscriptionId,
      handled: false,
      installments_paid: 0,
      installment_count: 0,
      canceled: false,
      duplicate: false,
    };
  }

  const alreadyPaid = intOf(metadata.installments_paid);
  const lastInvoiceId = text(metadata.last_installment_invoice_id);
  // Idempotent: a webhook retry for the same invoice must not double-count.
  if (invoiceId && lastInvoiceId && invoiceId === lastInvoiceId) {
    return {
      subscription_id: subscriptionId,
      handled: true,
      installments_paid: alreadyPaid,
      installment_count: installmentCount,
      canceled: false,
      duplicate: true,
    };
  }

  const paid = alreadyPaid + 1;
  if (paid >= installmentCount) {
    // Final installment paid: mark the access as retained before ending the billing schedule. The subscription-ended
    // event is also sent for ordinary cancellations; this marker lets the reader tell "paid in full" from "access
    // ended", so the final installment does not revoke what was bought.
    const completionMetadata: Record<string, string> = {
      installments_paid: String(paid),
      entitlement_retained: 'true',
    };
    if (invoiceId) completionMetadata.last_installment_invoice_id = invoiceId;
    await call(send, 'operation:update-subscription', { metadata: completionMetadata }, { ref: subscriptionId });
    // Then cancel immediately so no further invoice is generated.
    await call(send, 'operation:cancel-subscription', null, { ref: subscriptionId });
    return {
      subscription_id: subscriptionId,
      handled: true,
      installments_paid: paid,
      installment_count: installmentCount,
      canceled: true,
      duplicate: false,
    };
  }

  // Not final: persist the incremented counter (and the invoice id for idempotency).
  const updateMetadata: Record<string, string> = { installments_paid: String(paid) };
  if (invoiceId) updateMetadata.last_installment_invoice_id = invoiceId;
  await call(send, 'operation:update-subscription', { metadata: updateMetadata }, { ref: subscriptionId });
  return {
    subscription_id: subscriptionId,
    handled: true,
    installments_paid: paid,
    installment_count: installmentCount,
    canceled: false,
    duplicate: false,
  };
}
