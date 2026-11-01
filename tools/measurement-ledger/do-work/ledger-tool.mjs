import { appendOnce, aggregate, billingRecord, forecastRecord, FORECAST_TYPE, OBSERVATION_TYPE } from '../read-data/ledger.mjs';
import { isDeepStrictEqual } from 'node:util';

async function saveImmutable(door, record, key) {
  if (!key) throw new TypeError('stable request_key required');
  const existing = await door.readRecord(record.type, record.id);
  if (existing) {
    if (!isDeepStrictEqual(existing.value, record.value)) throw new Error(`${record.type} version already exists with different content`);
    return { saved: false, replayed: true, id: record.id, type: record.type };
  }
  try { await door.write([{ ...record, expected: null }], { key }); }
  catch (e) {
    if (e.code !== 'original_command_conflict') throw e;
    const concurrent = await door.readRecord(record.type, record.id);
    if (!concurrent || !isDeepStrictEqual(concurrent.value, record.value)) throw new Error(`${record.type} version already exists with different content`);
    return { saved: false, replayed: true, id: record.id, type: record.type };
  }
  const readback = await door.readRecord(record.type, record.id);
  if (!readback || !isDeepStrictEqual(readback.value, record.value)) throw new Error(`${record.type} readback mismatch`);
  return { saved: true, id: record.id, type: record.type };
}

export async function run(input, { door }) {
  if (input.action === 'append') return appendOnce(door, input.observations ?? [], { key: input.request_key });
  if (input.action === 'read_latest_refresh_state') {
    const forecasts = [];
    for await (const record of door.list({ type: FORECAST_TYPE, prefix: 'record:cost-measurement-forecast:', fields: ['forecast_id', 'version', 'created_at', 'refresh_state'] })) {
      if (forecasts.length >= 10000) throw new RangeError('forecast state read limit exceeded; narrow the account record query.');
      forecasts.push(record.value && typeof record.value === 'object' ? record.value : record);
    }
    const latest = forecasts.filter(row => row.refresh_state && Number.isInteger(row.version))
      .sort((a, b) => String(b.created_at ?? '').localeCompare(String(a.created_at ?? '')) || b.version - a.version)[0];
    return { state: latest?.refresh_state ?? null, forecast_id: latest?.forecast_id ?? null, version: latest?.version ?? null, records_read: forecasts.length };
  }
  if (input.action === 'aggregate') {
    const records = [];
    for await (const r of door.list({ type: OBSERVATION_TYPE, prefix: 'record:cost-measurement-observation:' })) records.push(r);
    return { record_type: OBSERVATION_TYPE, aggregate: aggregate(records, { groupBy: input.group_by }), records_read: records.length };
  }
  if (input.action === 'save_forecast') {
    const record = forecastRecord(input.forecast);
    return { ...(await saveImmutable(door, record, input.request_key)), completeness: record.value.completeness };
  }
  if (input.action === 'save_billing') {
    const record = billingRecord(input.billing);
    return { ...(await saveImmutable(door, record, input.request_key)), scope: record.value.scope };
  }
  throw new TypeError('action must be append, aggregate, save_forecast, or save_billing');
}
