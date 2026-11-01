import { makeHashCodeHexFromBytes } from '../../content-identity/read-data/identity.mjs';

const bytes = value => new TextEncoder().encode(JSON.stringify(value));
const pin = value => makeHashCodeHexFromBytes(bytes(value));
/** Reconcile generic execution receipts with the current meter and price books.
 * Operations are discovered from receipts and the current catalog; no operation
 * names or product cases are built into this reader. */
export function refreshCoverage(input) {
  const { sources = [], operations = [], receipts = [], meters = [], prices = [], prior = null } = input;
  const ids = new Set();
  for (const [label, list] of Object.entries({ sources, operations, receipts, meters, prices })) {
    if (!Array.isArray(list)) throw new Error(`${label} must be an array.`);
  }
  for (const receipt of receipts) {
    if (!receipt?.id || !receipt?.operation || !receipt?.source_revision || !receipt?.at) throw new Error('Every receipt needs id, operation, source_revision and at.');
    if (ids.has(receipt.id)) throw new Error(`Duplicate receipt id: ${receipt.id}`);
    ids.add(receipt.id);
  }
  const sourcePin = pin({ sources, operations });
  const meterPin = pin(meters);
  const pricePin = pin({ source_revision: input.price_book_revision ?? null, prices });
  const observationPin = pin([...receipts].sort((a, b) => String(a.id).localeCompare(String(b.id))));
  const currentSources = new Map(sources.map(s => [s.id, s.revision]));
  const stale = !prior || prior.source_pin !== sourcePin || prior.meter_pin !== meterPin || prior.price_pin !== pricePin || prior.observation_pin !== observationPin || receipts.some(r => !currentSources.has(r.source) || currentSources.get(r.source) !== r.source_revision);
  const ops = new Set([...operations.map(x => typeof x === 'string' ? x : x.id), ...receipts.map(x => x.operation)]);
  const meterById = new Map(meters.map(m => [m.id, m]));
  for (const receipt of receipts) for (const observation of receipt.measurements ?? []) {
    if (!observation.meter || !observation.unit || !Number.isFinite(observation.value) || observation.value < 0) throw new Error(`Receipt ${receipt.id} has an invalid measurement.`);
  }
  const rows = [];
  for (const operation of [...ops].filter(Boolean).sort()) {
    const operationReceipts = receipts.filter(r => r.operation === operation);
    const providers = [...new Set(operationReceipts.length ? operationReceipts.map(r => r.provider ?? 'unknown') : ['unknown'])].sort();
    for (const provider of providers) {
      const opReceipts = operationReceipts.filter(r => (r.provider ?? 'unknown') === provider);
      const successful = opReceipts.filter(r => r.replayed !== true && r.useful_work?.status === 'succeeded');
      const workSucceeded = successful.length > 0;
      const workStatus = workSucceeded ? 'succeeded' : opReceipts.some(r => r.useful_work?.status === 'failed') ? 'failed' : 'unknown';
      const names = new Set(opReceipts.flatMap(r => (r.measurements ?? []).map(m => m.meter)));
      const relevantMeters = new Set([...names, ...meters.filter(m => m.required_for_all_operations).map(m => m.id)]);
      if (!relevantMeters.size) relevantMeters.add('(no-meter-observed)');
      for (const meterId of [...relevantMeters].sort()) {
        const meter = meterById.get(meterId);
        const matching = meter ? opReceipts.flatMap(r => (r.measurements ?? []).filter(m => m.meter === meterId && m.unit === meter.unit && (!meter.source || r.source === meter.source)).map(m => ({ r, m }))) : [];
        const priceMatches = meter ? prices.filter(p => p.meter === meterId && p.provider === provider) : [];
        const candidatePrice = priceMatches.length === 1 ? priceMatches[0] : null;
        const priceValid = candidatePrice && candidatePrice.unit === meter?.unit && Number.isFinite(candidatePrice.amount) && candidatePrice.amount >= 0 && typeof candidatePrice.currency === 'string' && candidatePrice.currency.trim();
        const price = priceValid ? candidatePrice : null;
        const completeMeasurement = meter && matching.length > 0 && opReceipts.length > 0 && opReceipts.every(r => (r.measurements ?? []).some(m => m.meter === meterId && m.unit === meter.unit && (!meter.source || r.source === meter.source)) || (r.excluded_measurements ?? []).includes(meterId));
        const hasFailure = opReceipts.some(r => r.replayed !== true && r.useful_work?.status === 'failed');
        const sourceMatches = opReceipts.length > 0 && opReceipts.every(r => currentSources.get(r.source) === r.source_revision && r.source_revision !== 'unknown');
        let state = !sourceMatches && opReceipts.length ? 'stale-source-observation' : !meter ? 'unknown-meter' : !completeMeasurement ? 'missing-observation' : hasFailure ? 'partial-retry-or-error' : !workSucceeded ? workStatus : priceMatches.length > 1 ? 'ambiguous-price' : candidatePrice && !priceValid ? 'invalid-price' : !price ? 'missing-price' : 'measured';
        const values = matching.map(x => x.m.value);
        const latest = matching.map(sample => ({ ...sample, timestamp: Date.parse(sample.r.at) })).filter(sample => Number.isFinite(sample.timestamp)).sort((a, b) => a.timestamp - b.timestamp).at(-1);
        const aggregateValue = !completeMeasurement ? null : meter.aggregation === 'max' ? Math.max(...values) : ['last', 'gauge'].includes(meter.aggregation) ? latest?.m.value ?? null : values.reduce((sum, n) => sum + n, 0);
        const value = Number.isFinite(aggregateValue) ? aggregateValue : null;
        if (aggregateValue !== null && value === null) state = 'invalid-measurement-total';
        if (value === null && completeMeasurement && ['last', 'gauge'].includes(meter?.aggregation)) state = 'unknown-gauge-order';
        const unknowns = state === 'measured' ? [] : [state];
        if (!workSucceeded && !unknowns.includes(workStatus)) unknowns.push(workStatus);
        const physicalReceipts = opReceipts.filter(r => r.replayed !== true);
        const computedCost = value === null || !price || !sourceMatches ? null : value * price.amount;
        const cost = Number.isFinite(computedCost) ? computedCost : null;
        if (computedCost !== null && cost === null) state = 'invalid-computed-cost';
        if (state !== (unknowns[0] ?? 'measured')) { unknowns.length = 0; unknowns.push(state); }
        rows.push({ provider, operation, meter: meterId, unit: meter?.unit ?? null, status: state, useful_work: workStatus, value, cost, currency: price?.currency ?? candidatePrice?.currency ?? null, price_source_revision: candidatePrice?.source_revision ?? null, receipts: opReceipts.map(r => r.id), attempts: physicalReceipts.length, replays: opReceipts.length - physicalReceipts.length, retries: physicalReceipts.filter(r => r.attempt > 1).length, errors: physicalReceipts.filter(r => r.useful_work?.status === 'failed').length, unknowns });
      }
    }
  }
  const complete = rows.length > 0 && rows.every(r => r.status === 'measured') && input.discovery_complete !== false;
  const currencies = [...new Set(rows.map(row => row.currency).filter(Boolean))];
  return {
    format: 'measurement-coverage/1',
    status: complete ? 'current' : 'stale-or-incomplete',
    stale_sources: stale,
    discovery_complete: input.discovery_complete !== false,
    pins: { source: sourcePin, meters: meterPin, prices: pricePin },
    operations: [...ops].filter(Boolean).sort(),
    rows,
    total_cost: complete && currencies.length === 1 ? rows.reduce((sum, row) => sum + row.cost, 0) : null,
    currency: complete && currencies.length === 1 ? currencies[0] : null,
    next_state: { source_pin: sourcePin, meter_pin: meterPin, price_pin: pricePin, observation_pin: observationPin, receipt_ids: [...ids].sort() },
    idempotent_key: pin({ sourcePin, meterPin, pricePin, observationPin }),
  };
}
