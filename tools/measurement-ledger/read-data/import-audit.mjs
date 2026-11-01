// Data-driven adapters for historical simulation artifacts. They emit neutral observations;
// callers supply provenance and numeric field metadata rather than baking a product into the ledger.
import { observationRecord } from './ledger.mjs';

const num = value => typeof value === 'number' && Number.isFinite(value);
const slug = value => String(value ?? 'unknown').replace(/[^a-zA-Z0-9._-]+/g, '-');

export function importStorageRuns(runs, { dataset, sourceRevision, evidenceRoot, fieldDefinitions = {}, observedAt = 'unknown-time' }) {
  if (!Array.isArray(runs) || !dataset || !sourceRevision) throw new TypeError('runs, dataset, and sourceRevision are required');
  const records = [];
  for (const run of runs) {
    const runId = run.source_id ?? run.run_id ?? run.id;
    if (!runId) throw new TypeError('each run needs a stable source_id, run_id, or id');
    const scenario = `${dataset}/${run.workload ?? 'workload'}/${run.scenario_id ?? 'default'}`;
    const evidence = run.evidence ?? (evidenceRoot ? `${evidenceRoot}/${encodeURIComponent(runId)}.json` : undefined);
    const walk = (value, path = []) => {
      for (const [key, child] of Object.entries(value ?? {})) {
        if (num(child)) {
          const metric = [...path, key].join('.');
          const definition = fieldDefinitions[metric] ?? {};
          const event_id = `audit:${dataset}:${runId}:${metric}`;
          records.push(observationRecord({ event_id, provider: run.provider ?? dataset, operation: path.join('.') || 'simulation', metric,
            metric_kind: /retry|fail|attempt|count|visit|ack|duplicate|skip|unsupported/i.test(key) ? 'counter_delta' : 'sample',
            aggregation: /retry|fail|attempt|count|visit|ack|duplicate|skip|unsupported/i.test(key) ? 'counter_delta' : 'sample',
            unit: definition.unit ?? 'unknown', currency: definition.currency ?? 'none', evidence_kind: 'executed-simulation', scenario_id: scenario, source_revision: sourceRevision, run_id: runId,
            window_start: run.window_start ?? observedAt, window_end: run.window_end ?? observedAt, observed_at: run.observed_at ?? observedAt,
            scope: 'measured', value: child, ...(Number.isInteger(run.retry_count) ? { retry_count: run.retry_count, retry_status: 'measured' } : { retry_count: null, retry_status: 'unknown' }),
            ...(Number.isInteger(run.error_count) ? { error_count: run.error_count, error_status: 'measured' } : { error_count: null, error_status: 'unknown' }), ...(evidence && { evidence }) }));
        } else if (child && typeof child === 'object' && !Array.isArray(child)) walk(child, [...path, key]);
      }
    };
    walk(run.totals ?? run.metrics ?? run);
  }
  return records;
}

export function importTrafficCases(cases, { sourceRevision, evidence, fieldDefinitions = {}, observedAt = 'unknown-time' }) {
  if (!Array.isArray(cases) || !sourceRevision) throw new TypeError('cases and sourceRevision are required');
  const records = [];
  cases.forEach((row, index) => {
    const scenario = row.scenario_id ?? row.scenario ?? `case-${index + 1}`;
    const provider = row.provider ?? row.name ?? 'unidentified-provider';
    const run_id = row.run_id ?? `traffic-case-${index + 1}`;
    const knownMetrics = Object.keys(row).filter(k => num(row[k]));
    for (const metric of knownMetrics) {
      const def = fieldDefinitions[metric] ?? {};
      const money = /cost|price|total|monthly|usd|amount/i.test(metric);
      const currency = money ? (def.currency ?? row.currency ?? 'unknown') : 'none';
      const unit = def.unit ?? (money ? currency : 'unit-unspecified');
      const metricKind = def.metric_kind ?? (money ? 'money_sum' : 'sample');
      records.push(observationRecord({ event_id: `audit:traffic:${slug(provider)}:${slug(scenario)}:${metric}:${index + 1}`,
        provider, operation: 'object_traffic_sensitivity', metric, metric_kind: metricKind,
        aggregation: def.aggregation ?? metricKind, unit, currency, scenario_id: scenario,
        source_revision: sourceRevision, run_id, window_start: row.window_start ?? observedAt, window_end: row.window_end ?? observedAt,
        observed_at: row.observed_at ?? observedAt, evidence_kind: 'pricing-scenario', scope: def.scope ?? 'assumed', value: row[metric],
        coverage: row.unknown?.length ? 'partial' : 'complete', ...(evidence && { evidence }) }));
    }
    const unknown = row.unknown ?? row.unknown_components ?? [];
    if (unknown.length) records.push(observationRecord({ event_id: `audit:traffic:${slug(provider)}:${slug(scenario)}:unknown-components:${index + 1}`,
      provider, operation: 'object_traffic_sensitivity', metric: 'unknown_cost_components', metric_kind: 'money_sum', aggregation: 'money_sum',
      unit: row.currency ?? 'unknown', currency: row.currency ?? 'unknown', scenario_id: scenario, source_revision: sourceRevision, run_id,
      window_start: row.window_start ?? observedAt, window_end: row.window_end ?? observedAt, observed_at: row.observed_at ?? observedAt,
      scope: 'unknown', value: null, coverage: 'partial', evidence: evidence ?? 'unknown components listed in source case' }));
  });
  return records;
}

// Import privacy-safe, typed usage events without assuming a particular host's payload format.
// Field names and units are caller supplied; provider/event metadata remains separate from counters.
export function importUsageEvents(events, { sourceRevisionField = 'observer_source_revision', evidence, observedAtField = 'observed_at', fieldDefinitions = {} } = {}) {
  if (!Array.isArray(events)) throw new TypeError('events must be an array');
  const records = [];
  for (const event of events) {
    const meters = event.simulation_meter_export?.meters ?? event.meters ?? {};
    const usage = event.usage ?? {};
    const metrics = {};
    for (const [key, value] of Object.entries(meters.counts ?? {})) metrics[key] = value;
    for (const [key, value] of Object.entries(usage)) if (num(value)) metrics[key] = value;
    const provider = event.invocation?.provider ?? event.provider ?? 'unknown-provider';
    const operation = event.invocation?.route ?? event.route ?? 'inference';
    const model = event.invocation?.model ?? event.model ?? 'unknown-model';
    const revision = event[sourceRevisionField] ?? 'unknown-unversioned-source';
    const run_id = event.source_stream ?? event.source_id ?? event.observation_id ?? event.event_id;
    if (!run_id) throw new TypeError('usage event needs a stable source stream or event ID');
    const at = event[observedAtField] ?? event.observed_at ?? 'unknown-time';
    const scenario = `${provider}/${model}/${operation}`;
    const common = { provider, operation, scenario_id: scenario, source_revision: revision, run_id, window_start: at, window_end: at,
      observed_at: at, ...(Number.isInteger(event.retry_count) ? { retry_count: event.retry_count, retry_status: 'measured' } : { retry_count: null, retry_status: 'unknown' }),
      ...(event.outcome === 'completed' ? { error_count: 0, error_status: 'measured' } : (event.outcome ? { error_count: 1, error_status: 'measured' } : { error_count: null, error_status: 'unknown' })), ...(evidence && { evidence }) };
    for (const [metric, value] of Object.entries(metrics)) {
      const definition = fieldDefinitions[metric] ?? {};
      const event_id = `usage:${run_id}:${event.observation_id ?? event.event_id ?? 'snapshot'}:${metric}`;
      records.push(observationRecord({ event_id, ...common, metric, metric_kind: definition.metric_kind ?? 'counter_delta',
        aggregation: definition.aggregation ?? definition.metric_kind ?? 'counter_delta', unit: definition.unit ?? event.usage_unit ?? 'unit-unspecified',
        currency: 'none', scope: definition.scope ?? 'measured', value, ...(event.unknown?.length ? { coverage: 'partial' } : {}) }));
    }
    if (event.billing?.amount_dollars === null || event.billing?.status === 'not_priced') {
      records.push(observationRecord({ event_id: `usage:${run_id}:${event.observation_id ?? event.event_id ?? 'snapshot'}:cost-unknown`, ...common,
        metric: 'marginal_provider_cost', metric_kind: 'money_sum', aggregation: 'money_sum', unit: 'USD', currency: 'USD', scope: 'unknown', value: null,
        coverage: 'partial' }));
    }
  }
  return records;
}

export function importAttemptRows(attempts, { provider, operation, scenario_id, sourceRevision, run_id, observed_at = 'unknown-time', evidence, fieldDefinitions = {}, unknownMetrics = [] }) {
  if (!Array.isArray(attempts) || !provider || !operation || !sourceRevision || !run_id) throw new TypeError('attempts, provider, operation, sourceRevision, and run_id are required');
  const records = [];
  attempts.forEach((attempt, index) => {
    const metrics = Object.fromEntries(Object.entries(attempt.usage ?? {}).filter(([, value]) => num(value)));
    for (const key of ['wall_ms', 'http_status']) if (num(attempt[key])) metrics[key] = attempt[key];
    for (const [metric, value] of Object.entries(metrics)) {
      const definition = fieldDefinitions[metric] ?? {};
      records.push(observationRecord({ event_id: `attempt:${run_id}:${index + 1}:${metric}`, provider: attempt.provider ?? provider, operation,
        metric, metric_kind: definition.metric_kind ?? (metric === 'wall_ms' ? 'duration_distribution' : 'counter_delta'),
        aggregation: definition.aggregation ?? (metric === 'wall_ms' ? 'duration_distribution' : 'counter_delta'), unit: definition.unit ?? 'unit-unspecified',
        currency: definition.currency ?? 'none', scenario_id: attempt.scenario_id ?? scenario_id ?? 'default', source_revision: sourceRevision,
        run_id: `${run_id}:${index + 1}`, window_start: attempt.started_at ?? observed_at, window_end: attempt.ended_at ?? observed_at,
        observed_at: attempt.observed_at ?? observed_at, scope: definition.scope ?? 'measured', value,
        ...(Number.isInteger(attempt.retries) ? { retry_count: attempt.retries, retry_status: 'measured' } : { retry_count: null, retry_status: 'unknown' }),
        ...(attempt.outcome ? { error_count: attempt.outcome === 'success' ? 0 : 1, error_status: 'measured' } : { error_count: null, error_status: 'unknown' }), ...(evidence && { evidence }) }));
    }
    for (const definition of unknownMetrics) records.push(observationRecord({ event_id: `attempt:${run_id}:${index + 1}:${definition.metric}`, provider: attempt.provider ?? provider,
      operation, metric: definition.metric, metric_kind: definition.metric_kind ?? 'sample', aggregation: definition.aggregation ?? 'sample', unit: definition.unit,
      currency: definition.currency ?? 'none', scenario_id: attempt.scenario_id ?? scenario_id ?? 'default', source_revision: sourceRevision,
      run_id: `${run_id}:${index + 1}`, window_start: attempt.started_at ?? observed_at, window_end: attempt.ended_at ?? observed_at,
      observed_at: attempt.observed_at ?? observed_at, scope: 'unknown', value: null, ...(evidence && { evidence }) }));
  });
  return records;
}

export function prepareAuditImport({ source_revision = {}, evidence_root = 'audit', run_sets = [], case_sets = [], usage_sets = [], attempt_sets = [], native_observations = [] }) {
  const records = [];
  for (const set of run_sets) records.push(...importStorageRuns(set.runs, { dataset: set.dataset, sourceRevision: set.source_revision ?? source_revision[set.dataset], evidenceRoot: set.evidence_root ?? evidence_root, fieldDefinitions: set.field_definitions, ...(set.observed_at ? { observedAt: set.observed_at } : {}) }));
  for (const set of case_sets) records.push(...importTrafficCases(set.cases, { sourceRevision: set.source_revision ?? source_revision[set.dataset] ?? source_revision.traffic, evidence: set.evidence ?? evidence_root, fieldDefinitions: set.field_definitions }));
  for (const set of usage_sets) records.push(...importUsageEvents(set.events, { ...(set.options ?? {}), evidence: set.evidence ?? evidence_root, fieldDefinitions: set.field_definitions }));
  for (const set of attempt_sets) records.push(...importAttemptRows(set.attempts, { ...set.options, fieldDefinitions: set.field_definitions, unknownMetrics: set.unknown_metrics, evidence: set.evidence ?? evidence_root }));
  for (const observation of native_observations) records.push(observationRecord(observation));
  const ids = new Set();
  for (const record of records) { if (ids.has(record.id)) throw new TypeError(`duplicate imported event: ${record.id}`); ids.add(record.id); }
  return records;
}
