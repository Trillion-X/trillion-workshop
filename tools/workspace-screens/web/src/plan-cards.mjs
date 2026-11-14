// src/plan-cards.mjs
//
// PURPOSE
//   The plans a person compares, as the shared plan cards draw them (parts/ui/show/pricing-overlay): read from the
//   service's own list of offers (GET /billing/offers), each compared plan with its name, its first price, whether it
//   is the recommended one, its own button words, and its line for every feature row (src/plan-comparison.json). The free plan comes first.
//   The workspace's plan gate and the browser extension's plan cards both read it, so they show the same plans.
//
// NON-NEGOTIABLE INVARIANTS
//   1. Only plans compared side by side (offers that carry feature lines) are cards; other offers are not. A card in
//      front of a refused screen (buyableNow) shows only plans that can be bought there and then.
//   2. A list with no priced plan is refused, so a person is never shown a choice that cannot be bought.

/** The compared plans in `offers` (the /billing/offers answer's `offers`), free first. `buyableNow`: only plans whose
 * price is public, for a card that unblocks something in place (an offer bought by applying first, priced after
 * acceptance, belongs where a person chooses how to start, not in front of a refused screen). */
export function planCards(offers, { buyableNow = false } = {}) {
  const compared = (Array.isArray(offers) ? offers : []).filter(offer => offer.features?.length && (!buyableNow || offer.price_visibility !== 'after-acceptance'));
  const priced = offer => (offer.options ?? []).some(option => option.amount_cents > 0);
  if (!compared.some(priced)) throw new Error('No paid plan is available.');
  return compared.map(offer => ({
    id: offer.id, name: offer.label,
    price: offer.options?.[0]?.label ?? offer.free_price ?? offer.summary,
    recommended: Boolean(offer.recommended),
    priced: priced(offer),
    // The offer row's own button words ("Start 7 days free", "Apply"), and the lines its card adds under the features.
    ...(offer.action_label ? { action: offer.action_label } : {}),
    lines: offer.features ?? [], notes: offer.notes ?? [],
  })).sort((a, b) => Number(a.priced) - Number(b.priced));
}
