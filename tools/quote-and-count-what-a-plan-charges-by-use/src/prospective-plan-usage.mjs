// Connect the existing seller rule owner, meter DATA and Stripe price owner for
// a new purchase. A purchased agreement never re-enters this calculation.
import { blake3 } from '@noble/hashes/blake3.js';
import { bytesToHex } from '@noble/hashes/utils.js';
import { rational, multiplyAmounts, divideAmounts, priceUsageTree } from '../../take-payments/read-data/resource-usage.mjs';
import { pinServiceResourceTerms, serviceUsageResources } from '../../shared-code/src/service-resource-pricing.mjs';
import { offerUsage, offerWithUsage, usageAtPrice } from '../../shared-code/src/usage-meters.mjs';

export const usageQuoteIdentity = value => bytesToHex(blake3(new TextEncoder().encode(JSON.stringify(value))));

// Stripe accepts twelve decimal places of cents. Round only at that actual
// provider boundary, upwards; the exact rule and base cost stay in the snapshot.
function providerCents(value) {
  const amount = rational(value), scale = 1000000000000n;
  const n = (amount.n * scale + amount.d - 1n) / amount.d;
  const raw = n.toString().padStart(13, '0');
  return `${raw.slice(0, -12)}.${raw.slice(-12)}`.replace(/0+$/, '').replace(/\.$/, '');
}

export async function prospectivePlanUsage({ offer, runTool, client_id, at = new Date().toISOString() }) {
  const existing = offerUsage(offer);
  if (!existing.length) return { offer, usage_terms: [], resource_pricing_terms: [] };
  const rules = await pinServiceResourceTerms({ runTool, resource_ids: [...new Set([...existing.map(row => row.meter.id), ...serviceUsageResources().map(row => row.id)])], plan_id: offer.id, client_id, at });
  const byResource = new Map(rules.map(rule => [rule.resource_id, rule]));
  const usage = existing.map(row => {
    const rule = byResource.get(row.meter.id);
    if (!rule) throw new Error('Every prospective usage meter needs its purchased pricing rule.');
    const priced = priceUsageTree({ at, pinned_terms: { [row.meter.id]: rule }, tree: {
      id: row.meter.id, label: row.meter.label, resource_id: row.meter.id, currency: row.currency,
      cost: String(row.cost_dollars), children: [],
    } });
    const cents = divideAmounts(multiplyAmounts(priced.charged, '100'), String(row.meter.days_per));
    const unit_amount_decimal = providerCents(cents);
    const suffix = usageQuoteIdentity({ offer: offer.id, meter: row.meter.id, rule, unit_amount_decimal, currency: row.currency, interval: row.interval });
    return usageAtPrice(row, { unit_amount_decimal, pricing_terms: rule, price_option_id: `${row.price_option_id}:terms:${suffix}` });
  });
  return { offer: offerWithUsage(offer, usage), usage_terms: usage, resource_pricing_terms: rules };
}
