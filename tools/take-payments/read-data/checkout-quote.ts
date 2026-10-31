import type {
  CheckoutCustomer,
  CheckoutMaterialRequest,
  CheckoutStartPayload,
} from './checkout-contract.ts';
import {
  findCheckoutCodeAdjustment,
  normalizeCheckoutCodeValue,
  type AppliedCheckoutCodeAdjustment,
  type CheckoutCodeAdjustment,
} from './read-code-adjustments.ts';
import type { CheckoutOffer, CommercialPriceOption } from '../../funnels-and-offers/read-data/read-offers.ts';
import {
  evaluateChargeDimensions,
  type CheckoutChargeDimensionBreakdown,
} from './charge-dimensions.ts';
import { curveAmountCents } from './unit-price-curve.ts';
import { whenMoneyIsTaken, type WhenMoneyIsTaken } from './when-money-is-taken.ts';

export type CheckoutQuote = {
  accessRefs: string[];
  appliedAdjustment?: AppliedCheckoutCodeAdjustment;
  amountDueTodayCents: bigint;
  billingMode: string;
  cadence: string;
  canonicalPlanId: string;
  chargeDimensions?: CheckoutChargeDimensionBreakdown[];
  checkoutAttemptId: string;
  checkoutCode?: string;
  codeNotice?: string;
  checkoutStartedAt: string;
  currency: string;
  customer?: CheckoutCustomer & { name: string };
  installmentCount?: number;
  offerId: string;
  offerLabel: string;
  paymentMode: string;
  priceLabel: string;
  priceOptionId: string;
  recurringAmountCents: bigint;
  /**
   * When this price takes money and how much, as one thing. Absent only when
   * the price takes nothing at all, which is the one case with no schedule to
   * describe. Everything else above is a view of this.
   */
  schedule?: WhenMoneyIsTaken;
  trialDays: number;
  unitCount: number;
  validatedAmountCents: bigint;
};

const CHECKOUT_EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function normalizedText(value: unknown) {
  return typeof value === 'string' ? value.trim() : '';
}

function normalizeCustomer(customer: unknown) {
  const source =
    typeof customer === 'object' && customer !== null
      ? (customer as Partial<CheckoutCustomer>)
      : {};
  const firstName = normalizedText(source.firstName);
  const lastName = normalizedText(source.lastName);
  const email = normalizedText(source.email).toLowerCase();
  const country = normalizedText(source.country);
  const postalCode = normalizedText(source.postalCode);
  const name = [firstName, lastName].filter(Boolean).join(' ');

  if (!CHECKOUT_EMAIL_PATTERN.test(email)) {
    throw new Error('Enter a valid email address.');
  }
  if (!firstName || !lastName) {
    throw new Error('Enter your first and last name.');
  }

  return { country, email, firstName, lastName, name, postalCode };
}

function normalizeCheckoutAttemptId(value: unknown) {
  const attemptId = normalizedText(value);
  if (/^[a-zA-Z0-9_-]{12,96}$/.test(attemptId)) return attemptId;
  throw new Error('Refresh the page and start checkout again.');
}

// The buyer's browser owns when its checkout attempt started and sends it with
// every request (`CheckoutMaterialRequest.checkoutStartedAt` is required). The
// quote is a derivation the engine replays from the log, so it cannot invent a
// start time: an absent or unparseable one is a malformed attempt, not a
// prompt to read a clock.
function normalizeCheckoutStartedAt(value: unknown) {
  const startedAt = normalizedText(value);
  const parsed = Date.parse(startedAt);
  if (!Number.isFinite(parsed)) {
    throw new Error('Refresh the page and start checkout again.');
  }
  return new Date(parsed).toISOString().replace('.000Z', 'Z');
}

function normalizeCheckoutCode(value: unknown) {
  const checkoutCode = normalizeCheckoutCodeValue(value);
  if (!checkoutCode) return undefined;
  if (checkoutCode.length > 96 || /[\u0000-\u001f\u007f]/.test(checkoutCode)) {
    throw new Error('Enter a valid checkout code.');
  }
  return checkoutCode;
}

/**
 * Billable unit count clamped to the price option's own baseline (SSOT).
 * included_units is the floor (you always pay for at least the included tier);
 * a requested count below it is lifted to it, an absent count defaults to it.
 * Flat offers (no included_units) are always exactly one unit.
 */
function normalizedUnitCount(price: CommercialPriceOption, requested: unknown) {
  const included = typeof price.included_units === 'number' && price.included_units > 0
    ? Math.trunc(price.included_units)
    : null;
  if (included == null) return 1;
  const asked = typeof requested === 'number' && Number.isFinite(requested)
    ? Math.trunc(requested)
    : included;
  return Math.max(included, asked);
}

/**
 * Total for `unitCount` units under the price option's DATA-defined per-unit
 * curve (the included tier plus each unit beyond it priced by the — possibly
 * decelerating — curve). No per-plan and no per-band branch: the generic curve
 * evaluator walks whatever bands the DATA declares; a legacy flat rate is just a
 * one-band curve, a flat offer resolves to amount_cents. See unit-price-curve.ts.
 */
function meteredAmountCents(price: CommercialPriceOption, unitCount: number) {
  return curveAmountCents(price, unitCount);
}

export function validateVoluntaryAmountSelection(
  price: CommercialPriceOption,
  requestedAmountCents: unknown,
): number {
  const policy = price.voluntary_amount_policy;
  if (!policy) {
    throw new Error('This price does not accept a customer-selected amount.');
  }
  if (!Number.isSafeInteger(requestedAmountCents) || (requestedAmountCents as number) < 0) {
    throw new Error('Enter a valid amount in whole currency minor units.');
  }
  const amount = requestedAmountCents as number;
  const optionCurrency = priceCurrency(price);
  if (!/^[a-z]{3}$/.test(optionCurrency) || !/^[a-z]{3}$/i.test(policy.currency.trim())) {
    throw new Error('The published contribution currency is invalid.');
  }
  if (policy.currency.trim().toLowerCase() !== optionCurrency) {
    throw new Error('The contribution currency does not match the published price.');
  }
  if (!Number.isSafeInteger(policy.min_cents) || policy.min_cents < 0) {
    throw new Error('The published contribution minimum is invalid.');
  }
  if (policy.max_cents != null
    && (!Number.isSafeInteger(policy.max_cents) || policy.max_cents < policy.min_cents)) {
    throw new Error('The published contribution maximum is invalid.');
  }
  if (policy.suggested_cents.some((suggested) => !Number.isSafeInteger(suggested)
    || suggested < policy.min_cents
    || (policy.max_cents != null && suggested > policy.max_cents))) {
    throw new Error('A published contribution suggestion is outside the policy range.');
  }
  if (!policy.allow_custom && policy.suggested_cents.length === 0) {
    throw new Error('The published contribution policy has no selectable amounts.');
  }
  if (amount !== 0 && amount < policy.min_cents) {
    throw new Error(`Enter 0 for free, or at least ${policy.min_cents} ${optionCurrency}.`);
  }
  if (policy.max_cents != null && amount > policy.max_cents) {
    throw new Error(`Enter an amount no greater than ${policy.max_cents} ${optionCurrency}.`);
  }
  if (!policy.allow_custom && !policy.suggested_cents.includes(amount)) {
    throw new Error('Choose one of the published contribution amounts.');
  }
  return amount;
}

function initialSubscriptionAmountCents(
  price: CommercialPriceOption,
  recurringAmount: bigint,
) {
  if (price.initial_amount_cents == null) return recurringAmount;
  const initial = price.initial_amount_cents;
  if (!Number.isSafeInteger(initial) || initial <= 0) {
    throw new Error('The published initial subscription amount is invalid.');
  }
  if (paymentMode(price) !== 'subscription') {
    throw new Error('An initial subscription amount requires subscription payment timing.');
  }
  const initialAmount = BigInt(initial);
  // A first invoice LOWER than the recurring amount is a real offer, not an
  // error: a plan can open at a reduced rate and settle to its full price
  // afterwards. The refusal here encoded one reading of this field, the
  // founding contribution, where the first invoice is deliberately larger, and
  // treated that reading as the only one. Nothing in the corpus declared this
  // field when the assumption was removed, so no published price changed.
  //
  // What stays refused is above: a non-integer, a zero or negative amount, and
  // a non-subscription timing. Those are unusable rather than merely unusual.
  return initialAmount;
}

function priceTrialDays(price: CommercialPriceOption) {
  return typeof price.trial_days === 'number' && price.trial_days > 0
    ? Math.trunc(price.trial_days)
    : 0;
}

function priceCurrency(price: CommercialPriceOption) {
  return normalizedText(price.currency).toLowerCase() || 'usd';
}

function priceCadence(price: CommercialPriceOption) {
  const interval = normalizedText(price.interval).toLowerCase();
  return interval === 'year' || interval === 'yearly' ? 'year' : 'month';
}

function paymentMode(price: CommercialPriceOption) {
  const timing = normalizedText(price.payment_timing).toLowerCase();
  if (timing === 'free') return 'free';
  if (timing === 'one_time' || timing === 'one-time') return 'one_time';
  // A fixed-count installment (pay in N) is a bounded recurring charge: it is not
  // the same as an open-ended subscription, so it carries its own mode and the
  // installment_count downstream bounds it.
  if (timing === 'installment') return 'installment';
  return 'subscription';
}

function billingMode(price: CommercialPriceOption) {
  const mode = paymentMode(price);
  if (mode === 'one_time') return 'one_time';
  if (mode === 'free') return 'free';
  return priceCadence(price);
}

function selectedOffer(offers: readonly CheckoutOffer[], offerId: string) {
  const offer = offers.find((item) => item.id === offerId);
  if (!offer) throw new Error('Selected offer is not published.');
  return offer;
}

function selectedPrice(offer: CheckoutOffer, priceOptionId: string) {
  const price = offer.price_options.find((item) => item.id === priceOptionId);
  if (!price) throw new Error('Selected price is not published.');
  return price;
}

function adjustmentAppliesToOffer(
  adjustment: CheckoutCodeAdjustment,
  offer: CheckoutOffer,
  price: CommercialPriceOption,
) {
  const scope = adjustment.scope;
  const offerMatches = scope.offer_ids.length === 0 || scope.offer_ids.includes(offer.id);
  const priceMatches = scope.price_option_ids.length === 0 || scope.price_option_ids.includes(price.id);
  const accessMatches = scope.access_refs.length === 0 || offer.access_refs.some((accessRef) => scope.access_refs.includes(accessRef));
  return offerMatches && priceMatches && accessMatches;
}

function checkoutDiscountCents(
  adjustment: CheckoutCodeAdjustment,
  amount: bigint,
) {
  if (amount <= 0n) return 0n;
  if (adjustment.adjustment.kind === 'amount_cents') {
    const requested = BigInt(Math.max(0, Math.trunc(adjustment.adjustment.amount_cents ?? 0)));
    return requested > amount ? amount : requested;
  }
  const percent = BigInt(Math.max(0, Math.min(100, Math.trunc(adjustment.adjustment.percent ?? 0))));
  return amount * percent / 100n;
}

type CheckoutAdjustmentOutcome = {
  applied?: AppliedCheckoutCodeAdjustment;
  notice?: string;
};

// A code that is missing / invalid / inapplicable / zero-effect NEVER aborts
// checkout. It degrades to the full price and returns a soft `notice`, so the
// payment form still loads. A hard throw here previously dead-ended
// prepare-checkout (the effect's catch set an error and never set the material),
// leaving the form stuck on "Loading payment form..." forever. Full price is
// always a safe charge (this can only ever charge MORE, never undercharge).
function applyCheckoutAdjustment(
  adjustments: readonly CheckoutCodeAdjustment[],
  checkoutCode: string | undefined,
  offer: CheckoutOffer,
  price: CommercialPriceOption,
  amount: bigint,
): CheckoutAdjustmentOutcome {
  if (!checkoutCode) return {};
  const adjustment = findCheckoutCodeAdjustment(adjustments, checkoutCode);
  if (!adjustment) return { notice: 'That code isn’t valid — continuing at the full price.' };
  if (!adjustmentAppliesToOffer(adjustment, offer, price)) {
    return { notice: 'That code doesn’t apply to this plan — continuing at the full price.' };
  }
  const discountCents = checkoutDiscountCents(adjustment, amount);
  if (discountCents <= 0n) return { notice: 'That code doesn’t change this plan’s price.' };
  return {
    applied: {
      code: adjustment.code,
      discountCents,
      id: adjustment.id,
      label: adjustment.label,
      resultLabel: adjustment.result_label ?? '$0 access',
    },
  };
}

export function buildCheckoutMaterialQuote(
  offers: readonly CheckoutOffer[],
  input: CheckoutMaterialRequest,
  adjustments: readonly CheckoutCodeAdjustment[] = [],
): CheckoutQuote {
  const offer = selectedOffer(offers, normalizedText(input.offerId));
  const price = selectedPrice(offer, normalizedText(input.priceOptionId));
  const mode = paymentMode(price);
  const dimensionEvaluation = evaluateChargeDimensions(price, input.chargeDimensions);
  if (dimensionEvaluation && input.unitCount != null) {
    throw new Error('A dimension-priced offer cannot also receive legacy unitCount.');
  }
  const unitCount = dimensionEvaluation ? 1 : normalizedUnitCount(price, input.unitCount);
  const amount = price.voluntary_amount_policy
    ? BigInt(validateVoluntaryAmountSelection(price, input.customerSelectedAmountCents))
    : dimensionEvaluation?.totalAmountCents ?? meteredAmountCents(price, unitCount);
  const trialDays = priceTrialDays(price);
  const checkoutCode = normalizeCheckoutCode(input.checkoutCode);
  const adjustmentOutcome = applyCheckoutAdjustment(adjustments, checkoutCode, offer, price, amount);
  const appliedAdjustment = adjustmentOutcome.applied;
  const adjustedAmount = appliedAdjustment ? amount - appliedAdjustment.discountCents : amount;
  const amountDueBeforeTrial = adjustedAmount <= 0n ? 0n : adjustedAmount;
  const initialSubscriptionAmount = initialSubscriptionAmountCents(price, amount);
  const initialContribution = initialSubscriptionAmount - amount;
  if (initialContribution > 0n && trialDays > 0) {
    throw new Error('An upfront founding contribution cannot be combined with a deferred trial charge.');
  }
  const initialAmountDueBeforeTrial = amountDueBeforeTrial + initialContribution;
  if (price.voluntary_amount_policy) {
    validateVoluntaryAmountSelection(price, Number(amountDueBeforeTrial));
  }
  // A trial defers the first charge: $0 is due TODAY, but the plan is not "free"
  // — it bills amountDueBeforeTrial after trialDays. Only a genuinely $0 price is 'free'.
  const amountDueToday = trialDays > 0 ? 0n : initialAmountDueBeforeTrial;
  const adjustedMode = amountDueBeforeTrial === 0n ? 'free' : mode;
  const recurringAmount = adjustedMode === 'one_time' || adjustedMode === 'free' ? 0n : amountDueBeforeTrial;

  // When money is taken and how much, as one thing, for whoever has to arrange
  // it with a payment provider. A price that writes its own charges is read as
  // written; anything older is derived into the same shape.
  //
  // A price that writes its own charges states amounts outright, so a discount
  // code, a chosen contribution, or per-unit arithmetic has nothing to act on.
  // That combination is REFUSED rather than allowed to quietly charge the
  // published amount while the person is looking at a discount they applied.
  const writesItsOwnCharges = Array.isArray((price as { charges?: unknown }).charges);
  if (writesItsOwnCharges) {
    if (appliedAdjustment) {
      throw new Error('This price states its own charges, so a checkout code has no amount to reduce.');
    }
    if (price.voluntary_amount_policy || dimensionEvaluation || unitCount > 1) {
      throw new Error('This price states its own charges, so it cannot also be priced per unit or by contribution.');
    }
  }
  const schedule = adjustedMode === 'free'
    ? null
    : whenMoneyIsTaken(price, amountDueBeforeTrial);

  return {
    accessRefs: offer.access_refs,
    ...(appliedAdjustment ? { appliedAdjustment } : {}),
    ...(adjustmentOutcome.notice ? { codeNotice: adjustmentOutcome.notice } : {}),
    amountDueTodayCents: adjustedMode === 'free' ? 0n : amountDueToday,
    billingMode: adjustedMode === 'free' ? 'free' : billingMode(price),
    cadence: mode === 'one_time' ? 'one_time' : priceCadence(price),
    canonicalPlanId: offer.id,
    ...(dimensionEvaluation ? { chargeDimensions: dimensionEvaluation.breakdown } : {}),
    checkoutAttemptId: normalizeCheckoutAttemptId(input.checkoutAttemptId),
    checkoutCode,
    checkoutStartedAt: normalizeCheckoutStartedAt(input.checkoutStartedAt),
    currency: priceCurrency(price),
    ...(price.installment_count == null ? {} : { installmentCount: price.installment_count }),
    offerId: offer.id,
    offerLabel: offer.label,
    paymentMode: adjustedMode,
    priceLabel: appliedAdjustment?.resultLabel ?? price.label,
    priceOptionId: price.id,
    recurringAmountCents: recurringAmount,
    ...(schedule ? { schedule } : {}),
    trialDays,
    unitCount,
    validatedAmountCents: amountDueBeforeTrial,
  };
}

export function buildCheckoutQuote(
  offers: readonly CheckoutOffer[],
  input: CheckoutStartPayload,
  adjustments: readonly CheckoutCodeAdjustment[] = [],
): CheckoutQuote {
  if (!input?.consent?.billing || !input?.consent?.legal) {
    throw new Error('Agree to the billing and legal terms before checkout.');
  }

  return {
    ...buildCheckoutMaterialQuote(offers, input, adjustments),
    // Customer identity is OPTIONAL pre-provider: the hosted provider page
    // collects the buyer's real email/name. Only validate + attach when present.
    customer: input.customer ? normalizeCustomer(input.customer) : undefined,
  };
}
