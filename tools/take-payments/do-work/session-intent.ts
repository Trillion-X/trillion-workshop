import { createHash } from 'node:crypto';
import type { CheckoutQuote } from '../read-data/checkout-quote.ts';

// ============================================================================
// PURPOSE
// ----------------------------------------------------------------------------
// Turn a worked-out quote into the provider-neutral session intent that `hosted-session.ts` builds a Stripe Checkout
// Session from, and into the checkout material a page shows. Pure: a quote in, an intent out. It names no provider's
// words except the two session modes the provider itself defines ('subscription' and 'payment').
//
// Amounts cross this boundary as text because they are whole cents and JSON numbers are not: reading a large amount
// with Number loses the last digits silently and every total still adds up.
// ============================================================================

export class SessionIntentError extends Error {
  public readonly publicStatus: number;

  constructor(message: string, publicStatus = 400) {
    super(message);
    this.publicStatus = publicStatus;
  }
}

/** A quote with every whole-cent amount written as text, so it survives being sent as JSON. */
export type SerializedQuote = {
  accessRefs?: string[];
  amountDueTodayCents?: string;
  billingMode?: string;
  cadence?: string;
  canonicalPlanId?: string;
  checkoutAttemptId?: string;
  currency?: string;
  customer?: { email?: string };
  installmentCount?: number;
  offerId?: string;
  offerLabel?: string;
  paymentMode?: string;
  priceOptionId?: string;
  recurringAmountCents?: string;
  schedule?: unknown;
  trialDays?: number;
  unitCount?: number;
  validatedAmountCents?: string;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function text(value: unknown): string {
  return typeof value === 'string' && value.trim() ? value.trim() : '';
}

function intOf(value: unknown): number {
  if (typeof value === 'number' && Number.isFinite(value)) return Math.floor(value);
  if (typeof value === 'string' && value.trim() && Number.isFinite(Number(value))) return Math.floor(Number(value));
  return 0;
}

/**
 * The quote's schedule in a shape that survives being sent somewhere. Absent when the quote carries none, which is a
 * price that takes no money at all.
 */
function scheduleForTheProvider(quote: { schedule?: unknown }) {
  const schedule = quote.schedule;
  if (!isRecord(schedule) || !Array.isArray(schedule.charges)) return undefined;
  const charges = schedule.charges
    .filter(isRecord)
    .map((charge) => ({
      amount_cents: String(charge.amountCents),
      days_after_signup: Number(charge.daysAfterSignup),
    }));
  const repeat = isRecord(schedule.repeat)
    ? {
      amount_cents: String(schedule.repeat.amountCents),
      interval: text(schedule.repeat.interval),
      first_days_after_signup: Number(schedule.repeat.firstDaysAfterSignup),
    }
    : null;
  return { charges, repeat };
}

/** The quote as JSON: every bigint cent amount becomes text. */
export function serializeQuote(quote: CheckoutQuote): SerializedQuote & Record<string, unknown> {
  const { amountDueTodayCents, recurringAmountCents, validatedAmountCents, appliedAdjustment, chargeDimensions, schedule, ...rest } = quote;
  return {
    ...rest,
    amountDueTodayCents: String(amountDueTodayCents),
    recurringAmountCents: String(recurringAmountCents),
    validatedAmountCents: String(validatedAmountCents),
    ...(appliedAdjustment ? { appliedAdjustment: { ...appliedAdjustment, discountCents: String(appliedAdjustment.discountCents) } } : {}),
    ...(chargeDimensions ? {
      chargeDimensions: chargeDimensions.map((row) => ({
        ...row,
        amountCents: String(row.amountCents),
        ...(row.scopedUnits ? { scopedUnits: row.scopedUnits.map((scoped) => ({ ...scoped, amountCents: String(scoped.amountCents) })) } : {}),
      })),
    } : {}),
    ...(schedule ? { schedule: {
      charges: schedule.charges.map((charge) => ({ amountCents: String(charge.amountCents), daysAfterSignup: charge.daysAfterSignup })),
      repeat: schedule.repeat ? { ...schedule.repeat, amountCents: String(schedule.repeat.amountCents) } : null,
    } } : {}),
  };
}

// The same logical quote yields the same idempotency key (a refresh reuses the session; changed units, offer or email
// changes the key). A hash of the quote's price-determining fields.
function stableHash(parts: Array<string | number>): string {
  return createHash('sha256').update(parts.join('|')).digest('hex').slice(0, 16);
}

/** The addresses the buyer's browser lands on after the provider's page. They never grant anything. */
export type ReturnUrls = { success_url: string; cancel_url: string };

function returnUrls(urls: Partial<ReturnUrls> | undefined): ReturnUrls {
  const success_url = text(urls?.success_url);
  const cancel_url = text(urls?.cancel_url);
  if (!success_url || !cancel_url) {
    throw new SessionIntentError('success_url and cancel_url are required: the caller must say where the buyer lands afterwards.');
  }
  return { success_url, cancel_url };
}

/** Build the provider-neutral session intent from the worked-out quote. */
export function sessionIntentFromQuote(quote: SerializedQuote, urls: Partial<ReturnUrls> | undefined) {
  const { success_url: successUrl, cancel_url: cancelUrl } = returnUrls(urls);
  const attemptId = text(quote.checkoutAttemptId);
  const offerId = text(quote.offerId);
  const currency = text(quote.currency) || 'usd';
  const requestedCadence = text(quote.cadence).toLowerCase();
  const interval = requestedCadence === 'year' || requestedCadence === 'yearly' ? 'year' : 'month';
  const recurringAmountCents = intOf(quote.recurringAmountCents);
  const oneTimeAmountCents = intOf(quote.amountDueTodayCents);
  const unitCount = intOf(quote.unitCount);
  const trialDays = intOf(quote.trialDays);
  const email = text(quote.customer?.email);
  // paymentMode is DATA (the offer price's payment_timing, threaded through the quote). It selects the provider
  // session SHAPE through the provider's own fixed modes (subscription vs payment), not a per-offer branch. Anything
  // not explicitly recurring is a one-time payment.
  const paymentMode = text(quote.paymentMode).toLowerCase();
  const installmentCount = intOf(quote.installmentCount);
  // A fixed-count installment (pay in N) is a BOUNDED recurring charge: the provider recurs on the interval like a
  // subscription, and `advanceInstallment` cancels it after the Nth paid invoice (installment_count rides the session
  // so it is stamped into the subscription metadata). An installment with no valid count would recur forever, so it
  // fails closed here.
  const isInstallment = paymentMode === 'installment';
  if (isInstallment && installmentCount < 2) {
    throw new SessionIntentError('This installment offer is missing a valid installment count.');
  }
  const isSubscription = paymentMode === 'subscription' || paymentMode === 'recurring';
  // Both an open subscription and a bounded installment ride the provider's recurring session shape; only a one-time
  // price uses the single-charge shape.
  const isRecurringSession = isSubscription || isInstallment;
  // Recurring and installment charge the quoted recurring amount (per cycle); one-time charges the amount due today.
  // The quote already folded the base plus metering into each.
  const lineAmountCents = isRecurringSession ? recurringAmountCents : oneTimeAmountCents;
  const initialContributionCents = isSubscription
    ? Math.max(0, oneTimeAmountCents - recurringAmountCents)
    : 0;
  if (isSubscription && oneTimeAmountCents > 0 && oneTimeAmountCents < recurringAmountCents) {
    throw new SessionIntentError('The initial subscription amount cannot be less than its recurring amount.');
  }
  if (lineAmountCents <= 0) {
    throw new SessionIntentError(
      isRecurringSession
        ? 'A positive recurring amount is required for a paid session.'
        : 'A positive amount is required for a paid session.',
    );
  }
  const validatedAmountCents = intOf(quote.validatedAmountCents);
  const name = text(quote.offerLabel) || offerId;
  if (!name) throw new SessionIntentError('A charge needs a name for what is being bought.');

  const idempotencyKey = `checkout-session:create:${attemptId}:${stableHash([
    offerId,
    text(quote.priceOptionId),
    unitCount,
    lineAmountCents,
    oneTimeAmountCents,
    paymentMode,
    isRecurringSession ? interval : 'one_time',
    isInstallment ? installmentCount : 0,
    email,
  ])}`;

  return {
    session: {
      currency,
      // The provider session mode. A bounded installment uses the subscription shape and is stopped by
      // `advanceInstallment` on the paid-invoice event.
      payment_mode: isRecurringSession ? 'subscription' : 'payment',
      interval: isRecurringSession ? interval : undefined,
      installment_count: isInstallment ? installmentCount : undefined,
      customer_email: email || undefined,
      client_reference_id: attemptId || undefined,
      offer_id: offerId || undefined,
      price_option_id: text(quote.priceOptionId) || undefined,
      validated_amount_cents: validatedAmountCents || lineAmountCents,
      initial_amount_cents: isSubscription && oneTimeAmountCents > 0 ? oneTimeAmountCents : undefined,
      cadence: isRecurringSession ? interval : 'one_time',
      unit_count: unitCount || undefined,
      // A trial applies only to an open subscription; a bounded installment has no trial.
      trial_days: isSubscription ? trialDays || undefined : undefined,
      // When money is taken and how much, forwarded whole and untouched beside the older fields: the offer in its own words, which the
      // provider module turns into whatever that provider calls those things.
      schedule: scheduleForTheProvider(quote),
      success_url: successUrl,
      cancel_url: cancelUrl,
      // A subscription may carry one first-invoice uplift: the one-time line is charged on the first invoice while
      // the recurring line continues unchanged, so the buyer completes one checkout and never needs a later manual
      // conversion.
      line_items: [
        {
          amount_cents: lineAmountCents,
          billing_mode: isRecurringSession ? 'recurring' : 'one_time',
          product_name: name,
          quantity: 1,
        },
        ...(initialContributionCents > 0 ? [{
          amount_cents: initialContributionCents,
          billing_mode: 'one_time',
          product_name: `${name} first-invoice addition`,
          quantity: 1,
        }] : []),
      ],
    },
    idempotency_key: idempotencyKey,
  };
}

/** Everything a page shows about a quote, with the provider's session (when there is one) added. */
export function checkoutMaterialFromQuote(quote: SerializedQuote) {
  return {
    accessRefs: Array.isArray(quote.accessRefs) ? quote.accessRefs : [],
    amountDueTodayCents: text(quote.amountDueTodayCents) || '0',
    billingMode: text(quote.billingMode) || text(quote.cadence) || 'monthly',
    canonicalPlanId: text(quote.canonicalPlanId),
    currency: text(quote.currency) || 'usd',
    offerId: text(quote.offerId),
    paymentMode: text(quote.paymentMode) || 'subscription',
    priceOptionId: text(quote.priceOptionId),
    recurringAmountCents: text(quote.recurringAmountCents) || '0',
    trialDays: intOf(quote.trialDays),
    unitCount: intOf(quote.unitCount),
  };
}
