// Deterministic wake consumer. It collects and persists directly; it creates no AI job.
import { readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { makeHashCodeHexFromBytes } from '../../content-identity/read-data/identity.mjs';
import { performance } from 'node:perf_hooks';
import { readSourceConfig, resolveConfiguredInputs, validateGrantedRoots } from '../read-data/source-config.mjs';
import { projectPriceSource } from '../read-data/provider-prices.mjs';
import { collectAndRefresh } from '../read-data/collect.mjs';
import { run as ledger } from '../../measurement-ledger/do-work/ledger-tool.mjs';

export async function run(input = {}, { door, grantedFolder = process.argv[4] }) {
  const started = performance.now();
  const config = await readSourceConfig(door, input.config_id);
  await validateGrantedRoots(config, grantedFolder);
  const prior = await ledger({ action: 'read_latest_refresh_state' }, { door });
  const priceSource = JSON.parse(await readFile(new URL(config.price_book.path ?? '../read-data/provider-price-source.json', import.meta.url), 'utf8'));
  const prices = projectPriceSource(priceSource);
  const collected = await collectAndRefresh(await resolveConfiguredInputs(config, { prices, prior: prior.state, measure_self: false }));
  const requestKey = collected.coverage.idempotent_key;
  const appended = await ledger({ action: 'append', observations: collected.observations.map(row => row.value), request_key: requestKey + ':observations' }, { door });
  collected.forecast.value.components.push({ operation: 'collector.process', metric: 'physical-refresh-cost', unit: 'unknown', currency: 'unknown', scenario_id: 'monitoring-overhead', scope: 'unknown', value: null });
  collected.forecast.value.completeness = 'incomplete';
  const forecast = await ledger({ action: 'save_forecast', forecast: collected.forecast.value, request_key: requestKey + ':forecast' }, { door });
  const invocation = makeHashCodeHexFromBytes(new TextEncoder().encode(JSON.stringify({ request_key: process.argv[5] ?? null, invocation: randomUUID() })));
  const observerEntry = makeHashCodeHexFromBytes(await readFile(new URL(import.meta.url)));
  const usage = process.resourceUsage(), observedAt = new Date().toISOString();
  const physical = [['wall_until_final_persist_ms', performance.now(), 'ms', 'duration_distribution'], ['user_cpu_until_final_persist_ms', usage.userCPUTime / 1000, 'ms', 'counter_delta'], ['system_cpu_until_final_persist_ms', usage.systemCPUTime / 1000, 'ms', 'counter_delta'], ['process_peak_rss_bytes', usage.maxRSS * 1024, 'byte', 'gauge'], ['final_persist_overhead_ms', null, 'ms', 'duration_distribution']].map(([metric, value, unit, aggregation]) => ({ event_id: `${invocation}:${metric}`, provider: 'native-computer', operation: 'collector.process', metric, metric_kind: aggregation, aggregation, unit, currency: 'none', scenario_id: 'monitoring-overhead', source_revision: observerEntry, source_coverage: 'observer-entry-only', run_id: invocation, window_start: new Date(performance.timeOrigin).toISOString(), window_end: observedAt, observed_at: observedAt, scope: value === null ? 'unknown' : 'measured', value, coverage: 'partial', evidence: 'observer:process-resource-usage', retry_status: 'unknown', error_status: 'unknown' }));
  const physicalSaved = await ledger({ action: 'append', observations: physical, request_key: invocation }, { door });
  return { physical_refresh: { invocation, appended: physicalSaved, measurements: physical }, discovery: collected.discovery, coverage: { status: 'stale-or-incomplete', component_status: collected.coverage.status, component_total: collected.coverage.total_cost, stale_sources: collected.coverage.stale_sources, total_cost: null, currency: collected.coverage.currency, rows: collected.coverage.rows }, appended, forecast, refresh_wall_ms: performance.now() - started, physical_refresh_metering: 'process start through final observation persistence; final persistence tail and money remain unknown', ai_jobs_created: 0 };
}
