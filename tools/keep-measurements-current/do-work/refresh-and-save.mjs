// Collects current evidence and answers the rows to keep. It reads and keeps nothing: the source configuration
// (`config`) and the forecast rows read from the person's store (`forecasts`) come in with the request, and the
// observations, forecast and process measurements go back in the answer for the caller to write through its store.
import { text } from 'node:stream/consumers';
import { pathToFileURL } from 'node:url';
import path from 'node:path';
import { readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { makeHashCodeHexFromBytes } from '../../content-identity/read-data/identity.mjs';
import { performance } from 'node:perf_hooks';
import { resolveConfiguredInputs, validateGrantedRoots, validateSourceConfig } from '../read-data/source-config.mjs';
import { projectPriceSource } from '../read-data/provider-prices.mjs';
import { collectAndRefresh } from '../read-data/collect.mjs';
import { run as ledger } from '../../measurement-ledger/do-work/ledger-tool.mjs';

export async function run(input = {}, { grantedFolder = process.argv[2] } = {}) {
  const started = performance.now();
  const config = validateSourceConfig(input.config);
  await validateGrantedRoots(config, grantedFolder);
  const prior = await ledger({ action: 'latest_refresh_state', forecasts: input.forecasts ?? [] });
  const priceSource = JSON.parse(await readFile(new URL(config.price_book.path ?? '../read-data/provider-price-source.json', import.meta.url), 'utf8'));
  const prices = projectPriceSource(priceSource);
  const collected = await collectAndRefresh(await resolveConfiguredInputs(config, { prices, prior: prior.state, measure_self: false }));
  const observations = await ledger({ action: 'check_observations', observations: collected.observations.map(row => row.value) });
  collected.forecast.value.components.push({ operation: 'collector.process', metric: 'physical-refresh-cost', unit: 'unknown', currency: 'unknown', scenario_id: 'monitoring-overhead', scope: 'unknown', value: null });
  collected.forecast.value.completeness = 'incomplete';
  const forecast = await ledger({ action: 'check_forecast', forecast: collected.forecast.value });
  const invocation = makeHashCodeHexFromBytes(new TextEncoder().encode(JSON.stringify({ invocation: randomUUID() })));
  const observerEntry = makeHashCodeHexFromBytes(await readFile(new URL(import.meta.url)));
  const usage = process.resourceUsage(), observedAt = new Date().toISOString();
  const physical = [['wall_until_result_ms', performance.now(), 'ms', 'duration_distribution'], ['user_cpu_until_result_ms', usage.userCPUTime / 1000, 'ms', 'counter_delta'], ['system_cpu_until_result_ms', usage.systemCPUTime / 1000, 'ms', 'counter_delta'], ['process_peak_rss_bytes', usage.maxRSS * 1024, 'byte', 'gauge']].map(([metric, value, unit, aggregation]) => ({ event_id: `${invocation}:${metric}`, provider: 'native-computer', operation: 'collector.process', metric, metric_kind: aggregation, aggregation, unit, currency: 'none', scenario_id: 'monitoring-overhead', source_revision: observerEntry, source_coverage: 'observer-entry-only', run_id: invocation, window_start: new Date(performance.timeOrigin).toISOString(), window_end: observedAt, observed_at: observedAt, scope: 'measured', value, coverage: 'partial', evidence: 'observer:process-resource-usage', retry_status: 'unknown', error_status: 'unknown' }));
  const physicalRows = await ledger({ action: 'check_observations', observations: physical });
  return { physical_refresh: { invocation, rows: physicalRows.records, measurements: physical }, discovery: collected.discovery, coverage: { status: 'stale-or-incomplete', component_status: collected.coverage.status, component_total: collected.coverage.total_cost, stale_sources: collected.coverage.stale_sources, total_cost: null, currency: collected.coverage.currency, rows: collected.coverage.rows }, observations: observations.records, forecast: forecast.record, refresh_wall_ms: performance.now() - started, tasks_created: 0 };
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  try {
    console.log(JSON.stringify({ result: await run(JSON.parse((await text(process.stdin)) || '{}')) }));
  } catch (error) {
    console.log(JSON.stringify({ error: error.message }));
    process.exitCode = 1;
  }
}
