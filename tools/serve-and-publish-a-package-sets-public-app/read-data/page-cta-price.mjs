import { namedPriceOption } from './named-price-option.mjs';
import { formatMoneyCents } from '../../ui/show/format-money.ts';

/**
 * Resolve the current amount named by a public page record.
 * A multi-option offer needs an authored option id; a sole option is unambiguous.
 * Missing offers, stale names, and non-money rows return no price rather than
 * silently selecting by array position.
 */
export function pageCtaPrice(offers, page) {
  const offerId = typeof page?.checkout_offer_id === 'string' ? page.checkout_offer_id.trim() : '';
  if (!offerId) return { price: undefined, offerId: undefined };
  const rows = Array.isArray(offers)
    ? offers
    : Array.isArray(offers?.records)
      ? offers.records
      : offers && typeof offers === 'object'
        ? [offers]
        : [];
  const offer = rows.find((row) => row && typeof row === 'object' && row.id === offerId);
  if (!offer) return { price: undefined, offerId };
  const optionId = typeof page?.checkout_price_option_id === 'string'
    ? page.checkout_price_option_id.trim()
    : undefined;
  const option = namedPriceOption(offer, optionId);
  if (!option || typeof option.amount_cents !== 'number' || !Number.isFinite(option.amount_cents)) {
    return { price: undefined, offerId };
  }
  return {
    price: formatMoneyCents(option.amount_cents, typeof option.currency === 'string' ? option.currency : 'usd') || undefined,
    offerId,
  };
}
