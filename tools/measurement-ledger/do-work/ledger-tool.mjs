import { aggregate, billingRecord, forecastRecord, observationRecord, FORECAST_TYPE, OBSERVATION_TYPE } from '../read-data/ledger.mjs';

// Pure: the request carries everything the answer needs and the answer holds the result. Nothing is read or kept here.
const rowValues = records => records.map(record => (record?.value && typeof record.value === 'object' ? record.value : record));

export async function run(input) {
  if (input.action === 'check_observations') {
    const rows = (input.observations ?? []).map(observationRecord);
    if (new Set(rows.map(row => row.id)).size !== rows.length) throw new TypeError('duplicate event IDs in batch');
    return { record_type: OBSERVATION_TYPE, count: rows.length, records: rows };
  }
  if (input.action === 'latest_refresh_state') {
    const forecasts = rowValues(input.forecasts ?? []);
    const latest = forecasts.filter(row => row.refresh_state && Number.isInteger(row.version))
      .sort((a, b) => String(b.created_at ?? '').localeCompare(String(a.created_at ?? '')) || b.version - a.version)[0];
    return { record_type: FORECAST_TYPE, state: latest?.refresh_state ?? null, forecast_id: latest?.forecast_id ?? null, version: latest?.version ?? null, records_read: forecasts.length };
  }
  if (input.action === 'aggregate') {
    const records = input.observations ?? [];
    return { record_type: OBSERVATION_TYPE, aggregate: aggregate(records, { groupBy: input.group_by }), records_read: records.length };
  }
  if (input.action === 'check_forecast') {
    const record = forecastRecord(input.forecast);
    return { record, completeness: record.value.completeness };
  }
  if (input.action === 'check_billing') {
    const record = billingRecord(input.billing);
    return { record, scope: record.value.scope };
  }
  throw new TypeError('action must be check_observations, aggregate, check_forecast, check_billing, or latest_refresh_state');
}
