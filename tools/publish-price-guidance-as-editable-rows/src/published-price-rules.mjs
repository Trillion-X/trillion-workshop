// The geometric price rules a service publishes for its offers. A published list replaces the shipped list. Each row
// names one price experiment by applies_to and carries one rule that cleanRule accepts. A rule says what the price
// should be from what people did; it never changes what a customer is charged, because each plan price is a payment
// link set by whoever owns the offer.
import { cleanRule } from '#tools/price-and-sell-by-contract/src/geometric-pricing.mjs';
import { resolvePublishedContentSource } from './published-content-source.mjs';

/** The shipped section that holds the list. */
export const PRICE_RULES_SOURCE = { file: 'records/service-price-rules.json', pointer: '/rules' };

const invalid = () => Object.assign(new Error('Published price rules need a list of distinct experiment identities and valid price rules.'), { status: 503, code: 'marketplace_price_rules_invalid' });
const record = value => value !== null && typeof value === 'object' && !Array.isArray(value);

/** ports: the same { shelf, makers, read, check, identityOf, itemIdOf } that resolvePublishedContentSource takes. */
export async function readPublishedPriceRules({ bootstrap, ...ports }) {
  const selected = await resolvePublishedContentSource(PRICE_RULES_SOURCE, { bootstrap, ...ports });
  const rows = selected.found ? selected.value : [];
  if (!Array.isArray(rows)) throw invalid();
  const seen = new Set();
  return rows.map(row => {
    if (!record(row) || typeof row.applies_to !== 'string' || !row.applies_to.trim() || seen.has(row.applies_to.trim())) throw invalid();
    const applies_to = row.applies_to.trim();
    seen.add(applies_to);
    try { return { applies_to, rule: cleanRule(row.rule) }; }
    catch (error) { throw Object.assign(invalid(), { cause: error }); }
  });
}
