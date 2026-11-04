import { entitlementOffer } from '../../shared-code/src/offer-allocation.mjs';
// What each plan includes, read from the offer rows through the feature rows in plan-comparison.json. This file knows
// no feature, offer or price: a row says which fact of an offer decides it, and adding a feature is one row there.
import comparison from './plan-comparison.json' with { type: 'json' };
import words from './screen-words.json' with { type: 'json' };
import { offerUsage } from '../../price-and-sell-by-contract/src/usage-meters.mjs';

const fill = (template, parts) => template.replace(/\{(\w+)\}/g, (_, name) => String(parts[name] ?? ''));
const grants = (offer, access) => (entitlementOffer(offer).access_refs ?? []).includes(access);
const allowanceOn = (offer, access) => (entitlementOffer(offer).allowances ?? []).find(row => row.access === access) ?? null;

// Each rule an offer row can be judged by: its value for one feature row, or null when the row does not use it.
const rules = [
  (offer, row) => row.every_account ? { included: true } : null,
  (offer, row) => {
    if (!row.allowance_of) return null;
    if (!grants(offer, row.allowance_of)) return { included: false };
    const allowance = allowanceOn(offer, row.allowance_of);
    const unit = row.unit ?? '';
    return { included: true, value: allowance ? fill(comparison.words.allowance, { count: allowance.count, unit, per: words.allowance.per_words[allowance.per] ?? allowance.per }) : fill(comparison.words.unlimited, { unit, per: words.allowance.per_words[row.per] ?? row.per }) };
  },
  // A plan that charges by a meter says how much comes with it and what more costs; one without that meter falls through.
  (offer, row) => {
    const usage = row.usage_of ? offerUsage(offer).find(item => item.meter.id === row.usage_of) : null;
    return usage ? { included: true, value: usage.words.included } : null;
  },
  (offer, row) => {
    if (!row.spending_terms) return null;
    const terms = offer.spending;
    if (!Number.isFinite(terms?.daily_cap_dollars) || typeof terms.bill_overage !== 'boolean') return { included: false };
    return { included: true, value: `$${terms.daily_cap_dollars}/day cap; ${terms.bill_overage ? 'paid usage billed at listed rates' : 'no paid usage billing'}` };
  },
  (offer, row) => row.access ? { included: grants(offer, row.access) && !(row.without_allowance && allowanceOn(offer, row.access)) } : null,
];

/** Whether an offer is one of the plans compared side by side. */
export const isComparedPlan = offer => grants(offer, comparison.compares.offers_granting);

function judge(offer, row) {
  const judged = rules.map(rule => rule(offer, row)).find(Boolean);
  if (!judged) throw new Error(`Feature ${row.id} in plan-comparison.json names no rule this file knows.`);
  return judged;
}

/** An offer's line for every feature row: `{ id, label, included, value? }`. */
export const planFeatures = offer => comparison.features.map(row => ({ id: row.id, label: row.label, ...judge(offer, row) }));

/** The feature rows `to` includes and `from` does not, as `{ id, label }`: what moving from one plan to the other adds. */
export const planAdds = (from, to) => {
  const had = new Set(planFeatures(from).filter(row => row.included).map(row => row.id));
  return planFeatures(to).filter(row => row.included && !had.has(row.id)).map(({ id, label }) => ({ id, label }));
};

// What a person holds now (src/payment.mjs accessFrom: capabilities, and limits on those every granting offer caps)
// read as the offer facts the rules judge, so a person is judged by exactly the rule their plan's card shows.
const heldAsOffer = access => ({
  access_refs: access.capabilities ?? [],
  allowances: Object.entries(access.limits ?? {}).flatMap(([granted, rows]) => rows.map(row => ({ ...row, access: granted }))),
});
// A path match may also name the request's `method`: the feature is that verb on the path only (starting a Space is POST
// /spaces; reading the Spaces a person was invited into is every plan's).
const isFeaturePath = (row, path, method) => (row.paths ?? []).some(match => (match.method === undefined || match.method === method) && (match.exact === path || (match.under !== undefined && path.startsWith(match.under))));

/** The feature a request path is, `{ id, label }`, when this person's plan does not include it; null when it does or
 * the path is no feature's. */
export function withheldFeature(access, path, method = 'GET') {
  const row = comparison.features.find(item => isFeaturePath(item, path, method));
  return row && !judge(heldAsOffer(access), row).included ? { id: row.id, label: row.label } : null;
}

/** Whether this person's plan includes one feature row (by its id), judged by the same rule its plan card shows; a
 * feature id no row has is never included. */
export function featureIncluded(access, featureId) {
  const row = comparison.features.find(item => item.id === featureId);
  return Boolean(row) && judge(heldAsOffer(access), row).included;
}

/** Every name a plan has or can take, lowest rung first (plan-comparison.json `plan_names`): a sold plan's name is its
 * offer row's label, read from `offers`; a rung no plan holds yet gives its own name. A rung naming an offer `offers`
 * lacks is refused, so the ladder cannot point at a plan that is gone. */
export const planNames = offers => comparison.plan_names.rungs.map(rung => {
  if (!rung.offer) return rung.name;
  const offer = offers.find(item => item.id === rung.offer);
  if (!offer) throw new Error(`plan-comparison.json plan_names names ${rung.offer}, which no offer row is.`);
  return offer.label;
});

/** The price line for a plan with no priced option. */
export const freePriceWords = () => comparison.words.free_price;

/** The plan a visitor is pointed to past the free one: their own price arm when a price experiment gives them one,
 * else the cheapest plan that asks for money and puts no allowance on deciding (the same next step
 * src/allowance.mjs quotes when free decisions run out). A plan sold by the seat (src/seats.mjs) is a team's, never one
 * person's next step. */
export function recommendedPlanId(offers, armId = null) {
  if (armId && offers.some(offer => offer.id === armId && offer.for_sale !== false)) return armId;
  const access = comparison.compares.offers_granting;
  return offers
    .filter(offer => offer.for_sale !== false && isComparedPlan(offer) && !allowanceOn(offer, access) && !offer.seats)
    .map(offer => ({ id: offer.id, cents: Math.min(...(offer.price_options ?? []).map(option => option.amount_cents).filter(cents => cents > 0)) }))
    .filter(item => Number.isFinite(item.cents))
    .sort((a, b) => a.cents - b.cents)[0]?.id ?? null;
}
