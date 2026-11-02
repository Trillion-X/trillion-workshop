// tools/take-payments/do-work/quantity-for-checkout.mjs
//
// The count a buyer may pick at checkout for a price option with `quantity` (or `seats`) { minimum, maximum }: the row's
// range cut to what one Stripe checkout can carry (read-data/quantity-limits.json), or null for an option that sells one.
import limits from '../read-data/quantity-limits.json' with { type: 'json' };

/** Product quantity remains independent of one provider request's representable range. */
export function quantityForCheckout(option) {
  const quantity = option?.quantity ?? option?.seats;
  if (!quantity) return null;
  const minimum = quantity.minimum ?? 1;
  const configuredMaximum = quantity.maximum;
  if (!Number.isSafeInteger(minimum) || minimum < 1 || (configuredMaximum !== undefined && (!Number.isSafeInteger(configuredMaximum) || configuredMaximum < minimum))) {
    throw new Error('The quantity range must contain positive whole numbers.');
  }
  if (!Number.isSafeInteger(option.amount_cents) || option.amount_cents < 1) throw new Error('An adjustable price must have a positive whole amount.');
  const maximum = Math.min(configuredMaximum ?? Infinity, limits.adjustable_maximum, Math.floor(limits.maximum_amount_minor_units / option.amount_cents));
  if (minimum > maximum) throw new Error('This quantity exceeds one provider checkout. Divide it into separate purchases.');
  return { minimum, maximum };
}
