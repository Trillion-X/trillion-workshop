// src/offer-rows.mjs
//
// PURPOSE
//   The offer rows this service reads (records/commercial-offer-records.json), with each variant resolved once. A row
//   with `variant_of` is another offer that differs from the row it names only where it says so: it inherits every
//   field of that row except its identity (`id`, `earlier_ids`, `public_offer_id`, which are its own), its own fields
//   replace the inherited ones whole, and `replace_words` ({ "$100": "$150" }) is applied to every inherited piece of
//   text, so a price-test arm at another price reads its own price everywhere the base row's words name it. An arm of
//   a price experiment is one short row here, never a copy of the whole offer.
//
// NON-NEGOTIABLE INVARIANTS
//   1. Every reader of offer rows reads them from here, so a variant is the same offer everywhere.
//   2. A variant names a row that exists and never reaches itself through other variants.
//   3. Nothing here names an offer, a price or a field: a variant's differences are its own DATA.
//
import catalog from '../records/commercial-offer-records.json' with { type: 'json' };

const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const OWN = new Set(['id', 'earlier_ids', 'public_offer_id']);

function withWords(value, replace) {
  if (typeof value === 'string') return replace.reduce((text, [from, to]) => text.split(from).join(to), value);
  if (Array.isArray(value)) return value.map(item => withWords(item, replace));
  if (object(value)) return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, withWords(item, replace)]));
  return value;
}

/** Every row with its variant resolved: { ...the row it varies, with replace_words applied, ...its own fields }. */
export function resolveOffers(records) {
  const byId = new Map(records.map(row => [row.id, row]));
  const resolve = (row, seen) => {
    if (!row.variant_of) return row;
    if (seen.has(row.id)) throw new Error(`${row.id} is a variant of itself through ${[...seen].join(', ')}.`);
    const base = byId.get(row.variant_of);
    if (!base) throw new Error(`${row.id} is a variant of ${row.variant_of}, which is not an offer row.`);
    const parent = resolve(base, new Set([...seen, row.id]));
    const { replace_words: words = {}, ...own } = row;
    const inherited = Object.fromEntries(Object.entries(parent).filter(([key]) => !OWN.has(key)));
    return { ...withWords(inherited, Object.entries(words)), ...own };
  };
  return records.map(row => resolve(row, new Set()));
}

/** The offer rows, read as records/commercial-offer-records.json is shaped ({ ...file, records }). */
export const offerRows = { ...catalog, records: resolveOffers(catalog.records) };

/** Spending terms for an offer, copied from its resolved product row. */
export const spendingTermsForOffer = offerId => {
  const offer = offerRows.records.find(row => row.id === offerId);
  return offer?.spending ? { ...offer.spending, offer_id: offer.id } : null;
};

/** The no-purchase offer supplies the service's plan cap and billing default. */
export const defaultSpendingTerms = () => {
  const terms = spendingTermsForOffer('offer:trillion-free');
  if (!terms) throw new Error('The free plan must publish its spending terms.');
  return terms;
};

/**
 * The current offer DATA supplies the plan's cap; a purchased agreement pins only
 * its billing choice. This lets a cap DATA edit reach active plans without changing
 * what those customers agreed to pay for usage.
 */
export function currentPlanSpendingTerms(currentOfferTerms, pinnedAgreement = null, offerId = null) {
  const current = currentOfferTerms ?? defaultSpendingTerms();
  const pinnedBilling = typeof pinnedAgreement?.bill_overage === 'boolean'
    ? pinnedAgreement.bill_overage : current.bill_overage;
  return { ...current, bill_overage: pinnedBilling, ...(offerId ? { offer_id: offerId } : {}) };
}

/**
 * The spending terms an account's quota enforces: its active plan's (or `fallback` with none), and a negotiated
 * contract's (access.spending_terms, src/contract-entitlements.mjs) in place of the plan's cap and billing choice. The
 * contract changes only those two terms: the plan stays the account's plan. A daily cap of null is no cap.
 */
export function planSpendingTerms({ plan = null, pinned = null, fallback = defaultSpendingTerms(), contract = null } = {}) {
  const base = plan ? currentPlanSpendingTerms(plan.spending, pinned, plan.offer_id) : fallback;
  return contract ? { ...base, daily_cap_dollars: contract.daily_cap_dollars, bill_overage: contract.bill_overage } : base;
}
