export type PatronAmountState =
  | { kind: 'editing' }
  | { kind: 'invalid' }
  | { kind: 'below-min'; amountCents: number }
  | { kind: 'above-max'; amountCents: number }
  | { kind: 'valid'; amountCents: number };

export type PatronPolicy = {
  allowCustom: boolean;
  currency: string;
  highlightedCents: number | null;
  highlightLabel: string | null;
  maxCents: number | null;
  minCents: number;
  offerId: string;
  priceOptionId: string;
  suggestedCents: number[];
};

export type SystemOffer = {
  amountCents: number;
  currency: string;
  offerId: string;
  postPurchaseRoutePath: string;
  priceOptionId: string;
};

export function readPatronPolicy(envelope: unknown, expectedOfferId: string): PatronPolicy | null {
  if (!envelope || typeof envelope !== 'object') return null;
  const candidate = envelope as { status?: unknown; offerId?: unknown; policy?: unknown; priceOptionId?: unknown };
  if (candidate.status !== 'ready' || candidate.offerId !== expectedOfferId) return null;
  if (typeof candidate.priceOptionId !== 'string' || !candidate.priceOptionId) return null;
  if (!candidate.policy || typeof candidate.policy !== 'object') return null;
  const policy = candidate.policy as Record<string, unknown>;
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
    offerId: expectedOfferId,
    priceOptionId: candidate.priceOptionId,
    suggestedCents: [...suggestedCents] as number[],
  };
}

export function readSystemOffer(envelope: unknown, expectedOfferId: string): SystemOffer | null {
  if (!envelope || typeof envelope !== 'object') return null;
  const candidate = envelope as Record<string, unknown>;
  const currency = typeof candidate.currency === 'string' ? candidate.currency.toLowerCase() : '';
  if (candidate.status !== 'ready'
    || candidate.offerId !== expectedOfferId
    || typeof candidate.priceOptionId !== 'string'
    || !candidate.priceOptionId
    || !Number.isSafeInteger(candidate.amountCents)
    || Number(candidate.amountCents) <= 0
    || !/^[a-z]{3}$/.test(currency)
    || typeof candidate.postPurchaseRoutePath !== 'string'
    || !candidate.postPurchaseRoutePath.startsWith('/')) return null;
  return {
    amountCents: Number(candidate.amountCents),
    currency,
    offerId: expectedOfferId,
    postPurchaseRoutePath: candidate.postPurchaseRoutePath,
    priceOptionId: candidate.priceOptionId,
  };
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
