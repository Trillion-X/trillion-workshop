// Project qualified scalar tariffs; conditional plans stay excluded. No network or credential access.
export function projectPriceSource(source) {
if (source.format !== 'provider-price-source/1' || !source.source_revision || !source.observed_at) {
  throw new Error('Provider price source needs its format, source revision, and observation date.');
}

const sources = new Map((source.sources ?? []).map(row => [row.id, row]));
if (sources.size !== (source.sources ?? []).length) throw new Error('Provider price source IDs must be unique.');

const ids = new Set();
const prices = [];
const excluded = [];
for (const row of source.unit_rates ?? []) {
  if (!row.id || ids.has(row.id)) throw new Error(`Missing or duplicate provider rate ID: ${row.id ?? '(none)'}`);
  ids.add(row.id);
  if (!row.provider || !row.meter || !Number.isFinite(row.rate) || row.rate < 0 || !Number.isFinite(row.per) || row.per <= 0 || !row.unit || !row.currency || !row.source_id || !sources.has(row.source_id) || !row.source_revision) {
    throw new Error(`Provider rate ${row.id} is missing a valid provider, meter, numeric rate, denominator, unit, currency, source, or source revision.`);
  }
  if (row.evaluator_eligible === true) {
    if (row.billing_model !== 'unconditional-unit-rate') throw new Error(`Rate ${row.id} cannot enter scalar evaluation without an unconditional unit rate.`);
    prices.push({
      provider: row.provider,
      meter: row.meter,
      unit: row.unit,
      amount: row.rate / row.per,
      currency: row.currency,
      source_revision: row.source_revision,
      source_id: row.source_id,
      source_url: sources.get(row.source_id).url,
      basis: row.basis,
    });
  } else {
    excluded.push({ id: row.id, provider: row.provider, meter: row.meter, reason: 'not marked eligible for scalar evaluation' });
  }
}

for (const row of source.conditional_rates ?? []) {
  if (!row.id || ids.has(row.id)) throw new Error(`Missing or duplicate provider rate ID: ${row.id ?? '(none)'}`);
  ids.add(row.id);
  if (!row.source_id || !sources.has(row.source_id) || !row.source_revision || !row.billing_model || !row.condition) {
    throw new Error(`Conditional rate ${row.id} must retain its source, revision, billing model, and application condition.`);
  }
  excluded.push({ id: row.id, provider: row.provider, meter: row.meter ?? null, reason: row.condition });
}

return {
  format: 'provider-price-input/1',
  source_revision: source.source_revision,
  observed_at: source.observed_at,
  sources: source.sources,
  prices,
  excluded,
  local_context: source.local_context ?? null,
};

}
