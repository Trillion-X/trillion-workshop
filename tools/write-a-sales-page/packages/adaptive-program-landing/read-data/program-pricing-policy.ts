export type PatronAmountState =
  | { kind: 'editing' }
  | { kind: 'invalid' }
  | { kind: 'below-min'; amountCents: number }
  | { kind: 'above-max'; amountCents: number }
  | { kind: 'valid'; amountCents: number };

export type VoluntaryPolicy = {
  allowCustom: boolean;
  currency: string;
  highlightedCents: number | null;
  highlightLabel: string | null;
  maxCents: number | null;
  minCents: number;
  suggestedCents: number[];
};

// The page's next step for one listed offer, read from the offer's own price option (the card the host reports for it):
// a voluntary amount the buyer picks, a fixed checkout, or a booking address. Anything else is no next step at all.
export type OfferNextStep =
  | { kind: 'voluntary'; offerId: string; priceOptionId: string; policy: VoluntaryPolicy }
  | { kind: 'checkout'; offerId: string; priceOptionId: string; amountCents: number; currency: string }
  | { kind: 'booking'; offerId: string; priceOptionId: string; bookingUrl: string };

function readVoluntaryPolicy(value: unknown): VoluntaryPolicy | null {
  if (!value || typeof value !== 'object') return null;
  const policy = value as Record<string, unknown>;
  const currency = typeof policy.currency === 'string' ? policy.currency.toLowerCase() : '';
  const minCents = policy.min_cents;
  const rawMaxCents = policy.max_cents;
  const maxCents = Number.isSafeInteger(rawMaxCents) ? Number(rawMaxCents) : null;
  const suggestedCents = policy.suggested_cents;
  const allowCustom = policy.allow_custom;
  const hasHighlightedCents = Object.prototype.hasOwnProperty.call(policy, 'highlighted_cents');
  const hasHighlightLabel = Object.prototype.hasOwnProperty.call(policy, 'highlight_label');
  const rawHighlightedCents = policy.highlighted_cents;
  const rawHighlightLabel = policy.highlight_label;
  const highlightedCents = Number.isSafeInteger(rawHighlightedCents) ? Number(rawHighlightedCents) : null;
  const highlightLabel = typeof rawHighlightLabel === 'string' ? rawHighlightLabel.trim() : '';
  if (!/^[a-z]{3}$/.test(currency)
    || !Number.isSafeInteger(minCents) || Number(minCents) < 0
    || (rawMaxCents != null && !Number.isSafeInteger(rawMaxCents))
    || (maxCents != null && maxCents < Number(minCents))
    || typeof allowCustom !== 'boolean'
    || !Array.isArray(suggestedCents)
    || suggestedCents.some((amount) => !Number.isSafeInteger(amount)
      || amount < Number(minCents)
      || (maxCents != null && amount > maxCents))
    || hasHighlightedCents !== hasHighlightLabel
    || (hasHighlightedCents && (highlightedCents == null
      || highlightedCents < Number(minCents)
      || (maxCents != null && highlightedCents > maxCents)
      || !suggestedCents.includes(highlightedCents)
      || !highlightLabel))
    || (!allowCustom && suggestedCents.length === 0)) return null;
  return {
    allowCustom,
    currency,
    highlightedCents,
    highlightLabel: hasHighlightLabel ? highlightLabel : null,
    maxCents,
    minCents: Number(minCents),
    suggestedCents: [...suggestedCents] as number[],
  };
}

// `card` is one entry of the host's offers-for-this-page answer: the offer's own price option, with the field that says how it is bought.
export function readOfferNextStep(card: unknown, expectedOfferId: string): OfferNextStep | null {
  if (!card || typeof card !== 'object') return null;
  const row = card as Record<string, unknown>;
  if (row.offer_id !== expectedOfferId || typeof row.price_option_id !== 'string' || !row.price_option_id) return null;
  const priceOptionId = row.price_option_id;
  if (row.policy !== undefined) {
    const policy = readVoluntaryPolicy(row.policy);
    return policy ? { kind: 'voluntary', offerId: expectedOfferId, priceOptionId, policy } : null;
  }
  if (typeof row.booking_url === 'string') {
    return /^https:\/\//.test(row.booking_url)
      ? { kind: 'booking', offerId: expectedOfferId, priceOptionId, bookingUrl: row.booking_url }
      : null;
  }
  const currency = typeof row.currency === 'string' ? row.currency.toLowerCase() : '';
  if (!Number.isSafeInteger(row.amount_cents) || Number(row.amount_cents) <= 0 || !/^[a-z]{3}$/.test(currency)) return null;
  return { kind: 'checkout', offerId: expectedOfferId, priceOptionId, amountCents: Number(row.amount_cents), currency };
}

export function parsePatronAmount(rawValue: string, minCents: number, maxCents: number | null): PatronAmountState {
  const value = rawValue.trim();
  if (!value) return { kind: 'editing' };
  if (!/^\d+(?:\.\d{0,2})?$/.test(value)) return { kind: 'invalid' };
  const [whole, fraction = ''] = value.split('.');
  const amountCents = Number(whole) * 100 + Number(fraction.padEnd(2, '0'));
  if (!Number.isSafeInteger(amountCents)) return { kind: 'invalid' };
  if (amountCents < minCents) return { kind: 'below-min', amountCents };
  if (maxCents != null && amountCents > maxCents) return { kind: 'above-max', amountCents };
  return { kind: 'valid', amountCents };
}

// The booking card's before-booking address: the landing DATA's template with the offer's id in place of {offer_id}. The card's form
// posts there first (the host keeps the booker's email, then answers with the booking address). No template in DATA means the card
// keeps its bare link to the booking address.
export function beforeBookingHrefOf(template: unknown, offerId: string): string | null {
  if (typeof template !== 'string' || !template) return null;
  return template.replace('{offer_id}', encodeURIComponent(offerId));
}
