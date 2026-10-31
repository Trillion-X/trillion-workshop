// packages/checkout/read-data/verify-paid-amount.ts
//
// FU-1 (SP7 credential-binding / SP8 secure-by-default / SSOT): a hosted-link
// paid grant must be bound to VERIFIED MONEY. The signature-verified PaymentEvent
// carries the real amount + currency; the offer record DECLARES its acceptable
// prices (price_options — the SSOT). This pure leaf reconciles the two: the grant
// is authorized ONLY when the paid {amountCents, currency} EXACTLY matches one of
// the prices the offer itself declares. No hardcoded amounts, no per-offer branch —
// the offer DATA is the whole specification (L090). Fail-closed: an offer with no
// priced option, a missing/invalid amount, an amount mismatch, or a currency
// mismatch all DENY. This makes the whole category "grant that does not match the
// money actually paid" structurally impossible (L063).
import type { CheckoutOffer, CommercialPriceOption } from '../../funnels-and-offers/read-data/read-offers.ts';
import { validateVoluntaryAmountSelection } from './checkout-quote.ts';
import { paidMatchesCurve } from './unit-price-curve.ts';

export type PaidMoney = { amountCents: number; currency: string };
export type SignedValidatedAmount = PaidMoney & {
  cadence: string;
  priceOptionId: string;
};

/**
 * Normalize a currency the same way the checkout quote does (checkout-quote.ts
 * priceCurrency): trim, lowercase, default 'usd'. Stripe currencies are already
 * lowercase; offer DATA may be authored 'USD' or 'usd'. Comparing normalized both
 * sides means casing/whitespace never causes a false deny or a false allow.
 */
export function normalizePaidCurrency(value: string | undefined): string {
  const v = (value ?? '').trim().toLowerCase();
  return v || 'usd';
}

/** The offer's DECLARED acceptable prices (SSOT): every price option naming an amount. */
export function offerAcceptablePrices(offer: CheckoutOffer): PaidMoney[] {
  return offer.price_options
    .filter((o): o is CommercialPriceOption & { amount_cents: number } => typeof o.amount_cents === 'number')
    .map((o) => ({ amountCents: o.amount_cents, currency: normalizePaidCurrency(o.currency) }));
}

/**
 * True when `paidCents` is a price this option can legitimately produce.
 * Delegates to the generic curve gate (paidMatchesCurve): paid is accepted IFF it
 * equals curveAmountCents(N) for SOME unit count N >= included_units. This is the
 * exact inverse image of the quote's meteredAmountCents — no more (an off-curve
 * price-swap still DENIES), no less (a valid seat band is not wrongly rejected).
 * A flat option (no curve, no rate) accepts exactly amount_cents; a legacy flat
 * rate and a piecewise decelerating curve are both handled by the same code.
 * Fail-closed on any non-finite / negative input or an option with no base price.
 */
function optionAcceptsPaidCents(option: CommercialPriceOption, paidCents: number): boolean {
  if (typeof option.amount_cents !== 'number') return false;
  return paidMatchesCurve(option, paidCents);
}

function optionAcceptsSignedAmount(
  option: CommercialPriceOption,
  signed: SignedValidatedAmount,
): boolean {
  if (normalizePaidCurrency(option.currency) !== normalizePaidCurrency(signed.currency)) return false;
  if (option.voluntary_amount_policy) {
    try {
      return validateVoluntaryAmountSelection(option, signed.amountCents) === signed.amountCents;
    } catch {
      return false;
    }
  }
  return Number.isSafeInteger(signed.amountCents) && signed.amountCents >= 0;
}

export function paidAmountMatchesSignedQuote(
  offer: CheckoutOffer,
  paid: PaidMoney,
  signed: SignedValidatedAmount,
): boolean {
  if (!Number.isSafeInteger(paid.amountCents) || paid.amountCents < 0) return false;
  if (!Number.isSafeInteger(signed.amountCents) || signed.amountCents < 0) return false;
  if (paid.amountCents !== signed.amountCents) return false;
  if (normalizePaidCurrency(paid.currency) !== normalizePaidCurrency(signed.currency)) return false;
  const option = offer.price_options.find((candidate) => candidate.id === signed.priceOptionId);
  if (!option || !optionAcceptsSignedAmount(option, signed)) return false;
  const timing = (option.payment_timing ?? '').trim().toLowerCase();
  const interval = (option.interval ?? '').trim().toLowerCase();
  const expectedCadence = timing === 'one_time' || timing === 'one-time' ? 'one_time'
    : (interval === 'year' || interval === 'yearly' ? 'year' : 'month');
  return signed.cadence === expectedCadence;
}

export function assertPaidAmountMatchesSignedQuote(
  offer: CheckoutOffer,
  paid: PaidMoney,
  signed: SignedValidatedAmount,
): void {
  if (!paidAmountMatchesSignedQuote(offer, paid, signed)) {
    throw new Error(
      `Hosted grant denied: paid ${paid.amountCents} ${normalizePaidCurrency(paid.currency)} `
      + `does not match signed quote ${signed.amountCents} ${normalizePaidCurrency(signed.currency)} `
      + `for price ${signed.priceOptionId}.`,
    );
  }
}

/** True only when the paid money matches a price (flat or metered) the offer declares. */
export function paidAmountMatchesOffer(offer: CheckoutOffer, paid: PaidMoney): boolean {
  const priced = offer.price_options.filter((o) => typeof o.amount_cents === 'number');
  if (priced.length === 0) return false; // no declared price -> cannot verify a paid grant
  const paidCurrency = normalizePaidCurrency(paid.currency);
  return priced.some(
    (option) =>
      normalizePaidCurrency(option.currency) === paidCurrency
      && optionAcceptsPaidCents(option, paid.amountCents),
  );
}

/**
 * Fail-closed money gate. Throws unless the verified paid money matches a price the
 * offer declares. The error names the paid figure and the declared set so a
 * misconfigured payment link (or an attempted price-swap) is diagnosable, without
 * leaking anything secret.
 */
export function assertPaidAmountMatchesOffer(offer: CheckoutOffer, paid: PaidMoney): void {
  if (!Number.isFinite(paid.amountCents) || paid.amountCents < 0) {
    throw new Error(
      `Hosted grant denied: the verified payment amount is missing or invalid for offer ${offer.id}.`,
    );
  }
  if (!paidAmountMatchesOffer(offer, paid)) {
    const declared = offerAcceptablePrices(offer)
      .map((p) => `${p.amountCents} ${p.currency}`)
      .join(', ') || '(no declared price)';
    throw new Error(
      `Hosted grant denied: paid ${paid.amountCents} ${normalizePaidCurrency(paid.currency)} `
      + `does not match any price offer ${offer.id} declares [${declared}].`,
    );
  }
}
