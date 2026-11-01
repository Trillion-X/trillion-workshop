// Pure numeric measurement semantics shared by server consumers and browser screens.
const scopes = new Set(['measured', 'assumed', 'unknown']);
const aggregations = new Set(['counter_delta', 'gauge', 'duration_distribution', 'money_sum', 'sample']);
const required = ['event_id', 'provider', 'operation', 'metric', 'metric_kind', 'aggregation', 'unit', 'currency', 'scenario_id', 'source_revision', 'run_id', 'window_start', 'window_end', 'observed_at', 'scope', 'value'];

export function validateObservation(o) {
  for (const k of required.filter(k => k !== 'value')) if (typeof o?.[k] !== 'string' || !o[k].trim()) throw new TypeError(`Missing observation field: ${k}`);
  if (!Object.hasOwn(o, 'value')) throw new TypeError('Missing observation field: value');
  if (!scopes.has(o.scope)) throw new TypeError('scope must be measured, assumed, or unknown');
  if (!aggregations.has(o.aggregation)) throw new TypeError('unsupported aggregation semantics');
  if (o.scope === 'unknown' ? o.value !== null : (typeof o.value !== 'number' || !Number.isFinite(o.value))) throw new TypeError('unknown values must be null; measured/assumed values must be finite');
  for (const [k, status] of [['retry_count', 'retry_status'], ['error_count', 'error_status']]) {
    if (o[k] !== undefined && o[k] !== null && (!Number.isInteger(o[k]) || o[k] < 0)) throw new TypeError(`${k} must be a nonnegative integer, null, or absent`);
    if (o[status] !== undefined && !['measured', 'assumed', 'unknown'].includes(o[status])) throw new TypeError(`${status} must be measured, assumed, or unknown`);
    if (o[status] === 'unknown' && o[k] != null) throw new TypeError(`${k} must be null when ${status} is unknown`);
  }
  if (o.evidence !== undefined && (typeof o.evidence !== 'string' || /prompt|transcript|payload|credential/i.test(o.evidence))) throw new TypeError('evidence must be a private-content-free reference');
  if (o.coverage !== undefined && !['complete', 'partial'].includes(o.coverage)) throw new TypeError('coverage must be complete or partial');
  if (o.corrects_event_id && o.corrects_event_id === o.event_id) throw new TypeError('an event cannot correct itself');
  return o;
}

// Corrections replace their target for analytical views but preserve both account records. Ambiguous forks fail closed.
function activeObservations(records) {
  const events = records.map(r => r.value && typeof r.value === 'object' ? r.value : r);
  const byId = new Map(events.map(o => [o.event_id, o]));
  if (byId.size !== events.length) throw new TypeError('duplicate event IDs in input');
  const corrects = new Map();
  for (const o of events) if (o.corrects_event_id) {
    const target = byId.get(o.corrects_event_id);
    if (!target) throw new TypeError(`correction target missing: ${o.corrects_event_id}`);
    for (const k of ['provider', 'operation', 'metric', 'evidence_kind', 'metric_kind', 'aggregation', 'unit', 'currency', 'scenario_id', 'run_id', 'window_start', 'window_end']) {
      if (o[k] !== target[k]) throw new TypeError(`correction cannot change measurement dimension: ${k}`);
    }
    const prior = corrects.get(o.corrects_event_id) ?? [];
    prior.push(o.event_id); corrects.set(o.corrects_event_id, prior);
  }
  for (const [target, replacements] of corrects) if (replacements.length > 1) throw new TypeError(`ambiguous corrections for ${target}`);
  for (const event of events) {
    const seen = new Set(); let current = event;
    while (current?.corrects_event_id) {
      if (seen.has(current.event_id)) throw new TypeError('correction cycle detected');
      seen.add(current.event_id); current = byId.get(current.corrects_event_id);
    }
  }
  const replaced = new Set(corrects.keys());
  return events.filter(o => !replaced.has(o.event_id));
}

const DEFAULT_DIMS = ['provider', 'operation', 'metric', 'evidence_kind', 'metric_kind', 'aggregation', 'unit', 'currency', 'scenario_id', 'source_revision', 'run_id', 'window_start', 'window_end'];
export function aggregate(records, { groupBy = DEFAULT_DIMS } = {}) {
  const active = activeObservations(records);
  const groups = new Map();
  for (const o of active) {
    validateObservation(o);
    const key = JSON.stringify(groupBy.map(k => o[k] ?? null));
    const g = groups.get(key) ?? { dimensions: Object.fromEntries(groupBy.map(k => [k, o[k] ?? null])), count: 0, measured_count: 0, assumed_count: 0, unknown_count: 0, partial_count: 0,
      retry_count: 0, retry_known_count: 0, retry_unknown_count: 0, error_count: 0, error_known_count: 0, error_unknown_count: 0, values: [], value: null, completeness: 'complete' };
    g.count++; g[`${o.scope}_count`]++;
    if (o.retry_status === 'unknown' || o.retry_count === null || o.retry_count === undefined) g.retry_unknown_count++; else { g.retry_known_count++; g.retry_count += o.retry_count; }
    if (o.error_status === 'unknown' || o.error_count === null || o.error_count === undefined) g.error_unknown_count++; else { g.error_known_count++; g.error_count += o.error_count; }
    if (o.coverage === 'partial') g.partial_count++;
    if (o.scope !== 'unknown') g.values.push({ value: o.value, observed_at: o.observed_at });
    groups.set(key, g);
  }
  return [...groups.values()].map(g => {
    const op = g.dimensions.aggregation;
    if (g.unknown_count === g.count && !g.partial_count) g.completeness = 'unknown';
    else if (g.unknown_count || g.partial_count) g.completeness = 'partial';
    g.retry_completeness = g.retry_unknown_count === g.count ? 'unknown' : (g.retry_unknown_count ? 'partial' : 'complete');
    g.error_completeness = g.error_unknown_count === g.count ? 'unknown' : (g.error_unknown_count ? 'partial' : 'complete');
    if (!g.retry_known_count) g.retry_count = null;
    if (!g.error_known_count) g.error_count = null;
    if (op === 'counter_delta' || op === 'money_sum') g.value = g.values.length ? g.values.reduce((a, b) => a + b.value, 0) : null;
    else if (op === 'gauge') g.value = g.values.length ? [...g.values].sort((a, b) => a.observed_at.localeCompare(b.observed_at)).at(-1).value : null;
    else if (op === 'duration_distribution') g.value = g.values.length ? { count: g.values.length, min: Math.min(...g.values.map(v => v.value)), max: Math.max(...g.values.map(v => v.value)), sum: g.values.reduce((a, b) => a + b.value, 0) } : null;
    else g.value = g.values.length ? g.values.at(-1).value : null;
    return { ...g, value_scope: (g.unknown_count === g.count && !g.partial_count) ? 'unknown' : ((g.unknown_count || g.partial_count) ? 'partial' : (g.assumed_count ? 'assumed' : (g.measured_count ? 'measured' : 'unknown'))), values: undefined };
  });
}

