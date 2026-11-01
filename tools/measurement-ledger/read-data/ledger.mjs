// Generic account record schema and arithmetic. It consumes neutral observations and has no product imports.
import { isDeepStrictEqual } from 'node:util';
import { writeBatches } from '../../records-door/read-data/write-batches.mjs';
export const OBSERVATION_TYPE = 'record:cost-measurement-observation';
export const FORECAST_TYPE = 'record:cost-measurement-forecast';
export const BILLING_TYPE = 'record:cost-measurement-billing';
import { validateObservation, aggregate } from './aggregation.mjs';
export { validateObservation, aggregate } from './aggregation.mjs';
const scopes = new Set(['measured', 'assumed', 'unknown']);
const safeId = s => encodeURIComponent(s);
export function observationId(o) { validateObservation(o); return `record:cost-measurement-observation:${safeId(o.event_id)}`; }
export function observationRecord(o) { validateObservation(o); return { id: observationId(o), type: OBSERVATION_TYPE, value: { schema: 2, ...o } }; }

export function forecastRecord(f) {
  if (!f?.forecast_id || !Number.isInteger(f.version) || f.version < 1 || !f.source_revision || !f.created_at || !Array.isArray(f.components)) throw new TypeError('forecast needs id, positive version, source revision, creation time, and components');
  let incomplete = false;
  for (const c of f.components) {
    if (!c.operation || !c.metric || !c.unit || !c.currency || !c.scenario_id || !scopes.has(c.scope)) throw new TypeError('forecast component lacks operation, metric, unit, currency, scenario, or scope');
    if (c.scope === 'unknown') { if (c.value !== null) throw new TypeError('unknown forecast values must be null'); incomplete = true; }
    else if (typeof c.value !== 'number' || !Number.isFinite(c.value)) throw new TypeError('measured and assumed forecast values must be finite');
  }
  if (f.completeness === 'complete' && incomplete) throw new TypeError('cannot claim a forecast complete with unknown components');
  return { id: `record:cost-measurement-forecast:${safeId(f.forecast_id)}:v${f.version}`, type: FORECAST_TYPE, value: { schema: 2, ...f, component_count: f.components.length, completeness: incomplete ? 'incomplete' : (f.completeness ?? 'complete') } };
}

export function billingRecord(b) {
  if (!b?.provider || !b?.billing_id || !Number.isInteger(b.version) || b.version < 1 || !b.billing_period_start || !b.billing_period_end || !b.currency || !b.unit || !b.source_revision || !b.scope || !b.observed_at) throw new TypeError('billing needs provider, id, positive version, period, currency, unit, source revision, scope, and observed time');
  if (!scopes.has(b.scope)) throw new TypeError('billing scope must be measured, assumed, or unknown');
  if (b.scope === 'unknown' ? b.amount !== null : (typeof b.amount !== 'number' || !Number.isFinite(b.amount))) throw new TypeError('unknown billing amount must be null; measured/assumed amount must be finite');
  return { id: `record:cost-measurement-billing:${safeId(b.billing_id)}:v${b.version}`, type: BILLING_TYPE, value: { schema: 1, ...b } };
}

export class EventConflictError extends Error { constructor(id) { super(`event ID already exists with different content: ${id}`); this.name = 'EventConflictError'; } }

export async function appendOnce(door, observations, { key, batchSize = 128 }) {
  if (typeof key !== 'string' || !key) throw new TypeError('stable request key required');
  const rows = observations.map(observationRecord);
  if (new Set(rows.map(r => r.id)).size !== rows.length) throw new TypeError('duplicate event IDs in batch');
  const writes = [];
  let replayed = 0;
  for (const row of rows) {
    const old = await door.readRecord(row.type, row.id);
    if (old) {
      if (!isDeepStrictEqual(old.value, row.value)) throw new EventConflictError(row.id);
      replayed++; continue;
    }
    // Records door documents expected:null as atomic absent-value precondition. On conflict, exact reread decides
    // replay vs conflicting same-event content; no assumption is made from a write receipt alone.
    writes.push({ ...row, expected: null });
  }
  if (!writes.length) return { inserted: 0, replayed };
  let inserted = 0; const receipts = [];
  const batches = writeBatches(writes, { rows: batchSize, bytes: 60 * 1024 });
  for (let index = 0; index < batches.length; index++) {
    const batch = batches[index]; const batchKey = `${key}:batch:${index}`;
    try {
      const receipt = await door.write(batch, { key: batchKey }); receipts.push(receipt);
      inserted += receipt.write_count ?? batch.length;
      for (const row of batch) {
        const saved = await door.readRecord(row.type, row.id);
        if (!saved || !isDeepStrictEqual(saved.value, row.value)) throw new EventConflictError(row.id);
      }
    } catch (e) {
      if (e.code !== 'original_command_conflict') throw e;
      for (const row of batch) {
        const saved = await door.readRecord(row.type, row.id);
        if (!saved || !isDeepStrictEqual(saved.value, row.value)) throw new EventConflictError(row.id);
      }
      replayed += batch.length;
    }
  }
  return { inserted, replayed, receipts };
}
