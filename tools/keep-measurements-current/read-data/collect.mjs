import { opendir, readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { makeHashCodeHexFromBytes } from '../../content-identity/read-data/identity.mjs';
import { refreshCoverage } from './coverage.mjs';
import { observationRecord, forecastRecord } from '../../measurement-ledger/read-data/ledger.mjs';

const text = bytes => new TextDecoder().decode(bytes);
const pin = value => makeHashCodeHexFromBytes(new TextEncoder().encode(JSON.stringify(value)));
const ignored = new Set(['.git', 'node_modules', 'target', '.local', 'dist', 'build']);
const sourceExt = new Set(['.json', '.jsonl', '.mjs', '.js', '.ts', '.rs', '.toml', '.lock', '.py', '.md']);
const defaultLimit = { roots: 64, entries: 50000, files: 12000, bytes: 536870912, depth: 24, fileBytes: 268435456 };

async function walk(root, limits, isSource, gaps) {
  const start = path.resolve(root.path);
  const files = [];
  let entriesSeen = 0;
  const visit = async (at, depth) => {
    if (depth > limits.depth) { gaps.push(`depth limit reached at ${path.relative(start, at) || '.'}`); return; }
    let directory;
    try { directory = await opendir(at); }
    catch (error) { gaps.push(`cannot read ${at}: ${error.code ?? error.message}`); return; }
    try { for await (const entry of directory) {
      if (entriesSeen >= limits.entries) { gaps.push(`directory-entry limit reached at ${path.relative(start, at) || '.'}`); break; }
      entriesSeen++;
      if (entry.isSymbolicLink() || ignored.has(entry.name) || entry.name.startsWith('.DS_Store')) continue;
      const full = path.join(at, entry.name);
      if (entry.isDirectory()) { await visit(full, depth + 1); continue; }
      if (!entry.isFile()) continue;
      const ext = path.extname(entry.name).toLowerCase();
      if (isSource ? !sourceExt.has(ext) : !['.json', '.jsonl'].includes(ext)) continue;
      let info;
      try { info = await stat(full); }
      catch (error) { gaps.push(`cannot stat ${full}: ${error.code ?? error.message}`); continue; }
      if (info.size > limits.fileBytes) { gaps.push(`file size limit skipped ${path.relative(start, full)}`); continue; }
      if (files.length >= limits.files) { gaps.push(`file-count limit reached at ${path.relative(start, full)}`); return; }
      files.push({ full, relative: path.relative(start, full), size: info.size, mtime: info.mtime });
    } } finally { await directory.close().catch(() => {}); }
  };
  const info = await stat(start).catch(error => { gaps.push(`root unavailable ${start}: ${error.code ?? error.message}`); return null; });
  if (!info) return [];
  if (info.isFile()) {
    if (info.size > limits.fileBytes) { gaps.push(`file size limit skipped ${path.basename(start)}`); return []; }
    files.push({ full: start, relative: path.basename(start), size: info.size, mtime: info.mtime });
  } else if (info.isDirectory()) await visit(start, 0);
  else gaps.push(`root is neither a file nor folder: ${start}`);
  return files;
}

function readJson(bytes, label, gaps) {
  try { return JSON.parse(text(bytes)); }
  catch (error) { gaps.push(`invalid JSON in ${label}: ${error.message}`); return null; }
}

function valueAt(value, dottedPath) {
  if (typeof dottedPath !== 'string' || !dottedPath) return undefined;
  return String(dottedPath ?? '').split('.').filter(Boolean).reduce((current, key) => current?.[key], value);
}

function scalarMeasurements(row, adapter, definitions) {
  const declared = new Map(definitions.map(m => [m.id, m]));
  const excluded = new Set(adapter.excluded_metrics ?? []);
  const conditionalExclusions = (adapter.conditional_exclusions ?? [])
    .filter(rule => valueAt(row, rule.when?.field) === rule.when?.equals)
    .flatMap(rule => rule.metrics ?? []);
  const unitSuffixes = adapter.unit_suffixes ?? {};
  const fields = adapter.fields_path ? valueAt(row, adapter.fields_path) : row;
  if (!fields || typeof fields !== 'object') return [];
  return Object.entries(fields).flatMap(([name, value]) => {
    if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || excluded.has(name) || conditionalExclusions.includes(name)) return [];
    const meter = `${adapter.metric_prefix ?? ''}${name}`;
    const suffix = Object.keys(unitSuffixes).find(key => name.endsWith(key));
    const unit = adapter.unit ?? declared.get(meter)?.unit ?? (suffix ? unitSuffixes[suffix] : null) ?? 'unknown';
    return [{ meter, unit, value }];
  });
}

function successStatus(record, doc, adapter) {
  const success = adapter.useful_work;
  if (!success || success === 'unknown') return 'unknown';
  if (success === 'succeeded') return 'succeeded';
  if (success === 'failed') return 'failed';
  const checks = success.checks ?? [];
  if (!checks.length) return 'unknown';
  const ok = checks.every(check => valueAt(check.source === 'document' ? doc : record, check.path) === check.equals);
  return ok ? 'succeeded' : 'failed';
}

function adapterMatches(adapter, doc, format) {
  if (adapter.format !== format) return false;
  if (adapter.schema && doc?.schema !== adapter.schema) return false;
  if (adapter.match && valueAt(doc, adapter.match.field) !== adapter.match.value) return false;
  return true;
}

function recordsForAdapter(adapter, doc) {
  if (adapter.records_path) {
    const records = valueAt(doc, adapter.records_path);
    return Array.isArray(records) ? records : [];
  }
  return [doc];
}

function adaptedReceipts(doc, root, file, sourceRevision, definitions, bytes, adapters, format) {
  const receipts = [];
  for (const adapter of adapters) {
    if (!adapterMatches(adapter, doc, format)) continue;
    const records = recordsForAdapter(adapter, doc);
    for (let index = 0; index < records.length; index++) {
      const record = records[index];
      if (!record || typeof record !== 'object') continue;
      const operation = valueAt(record, adapter.operation_field) ?? valueAt(doc, adapter.operation_field) ?? adapter.default_operation ?? adapter.operation;
      if (typeof operation !== 'string') continue;
      const timestamp = valueAt(record, adapter.time_field) ?? valueAt(doc, adapter.time_field);
      const revision = valueAt(record, adapter.source_revision_field) ?? valueAt(doc, adapter.source_revision_field) ?? 'unknown';
      const excludedMeasurements = (adapter.conditional_exclusions ?? [])
        .filter(rule => valueAt(record, rule.when?.field) === rule.when?.equals)
        .flatMap(rule => (rule.metrics ?? []).map(name => `${adapter.metric_prefix ?? ''}${name}`));
      const replayed = adapter.replayed_field ? valueAt(record, adapter.replayed_field) === true : false;
      receipts.push({
        id: pin({ adapter: adapter.id, file: `${root.id}/${file.relative}`, index, contents: makeHashCodeHexFromBytes(bytes) }),
        operation,
        source: valueAt(record, adapter.source_field) ?? valueAt(doc, adapter.source_field) ?? root.source_id ?? root.id,
        provider: valueAt(record, adapter.provider_field) ?? valueAt(doc, adapter.provider_field) ?? adapter.provider ?? 'unknown',
        source_revision: revision ?? 'unknown',
        source_revision_current: sourceRevision,
        at: timestamp ?? 'unknown-time',
        timing_source: timestamp ? 'receipt' : 'file-mtime-only',
        ...(!timestamp ? { file_modified_at: file.mtime.toISOString() } : {}),
        replayed,
        excluded_measurements: excludedMeasurements,
        attempt: valueAt(record, adapter.attempt_field) ?? index + 1,
        useful_work: { status: successStatus(record, doc, adapter) },
        measurements: scalarMeasurements(record, adapter, definitions),
      });
    }
  }
  return receipts;
}

function genericReceipts(doc, root, file, sourceRevision, bytes) {
  const list = doc?.schema === 'execution-observations/1' ? doc.receipts : doc?.schema === 'execution-observation/1' ? [doc] : [];
  if (!Array.isArray(list)) return [];
  return list.filter(r => r && typeof r.operation === 'string').map((r, index) => ({
    ...r,
    id: r.id ?? pin({ file: `${root.id}/${file.relative}`, index, bytes: makeHashCodeHexFromBytes(bytes) }),
    source: r.source ?? root.id,
    source_revision: r.source_revision ?? 'unknown',
    source_revision_current: sourceRevision,
    at: r.at ?? 'unknown-time',
    timing_source: r.at ? 'receipt' : 'file-mtime-only',
    ...(!r.at ? { file_modified_at: file.mtime.toISOString() } : {}),
    attempt: r.attempt ?? 1,
    useful_work: r.useful_work ?? { status: 'unknown' },
    measurements: Array.isArray(r.measurements) ? r.measurements : [],
  }));
}

function sourceRootRevision(root, files) {
  return pin(files.map(f => ({ path: f.relative, size: f.size, content: f.identity })).sort((a, b) => a.path.localeCompare(b.path)));
}

function operationCatalog(doc, file, sourceId, adapters) {
  const found = [];
  for (const adapter of adapters) {
    const basename = path.basename(file.relative);
    if (adapter.filename && adapter.filename !== basename) continue;
    if (adapter.filename_pattern && !(new RegExp(adapter.filename_pattern)).test(basename)) continue;
    const rows = valueAt(doc, adapter.records_path ?? adapter.items_path);
    if (!Array.isArray(rows)) continue;
    for (const row of rows) {
      if (adapter.kind_path && valueAt(row, adapter.kind_path) !== adapter.kind_value) continue;
      const id = typeof row === 'string' ? row : valueAt(row, adapter.id_path);
      if (typeof id === 'string') found.push(id);
    }
  }
  return found.map(id => ({ id, source: sourceId }));
}

function toLedgerRows(coverage, receipts, definitions, priorLinks, priorCorrections, unchanged, now) {
  const meterDefs = new Map(definitions.map(m => [m.id, m]));
  const nextLinks = {};
  const nextCorrections = {};
  const observations = [];
  const makeObservation = (eventId, receipt, measurement, status, operation, meter, rowProvider = 'unknown') => {
    const definition = meterDefs.get(meter);
    const provider = receipt?.provider ?? rowProvider;
    const key = `${receipt?.id ?? operation}\u0000${provider}\u0000${meter}`;
    const aggregationNames = { sum: 'counter_delta', counter: 'counter_delta', counter_delta: 'counter_delta', gauge: 'gauge', last: 'gauge', max: 'gauge', duration: 'duration_distribution', duration_distribution: 'duration_distribution', money: 'money_sum', money_sum: 'money_sum' };
    const aggregation = aggregationNames[definition?.aggregation] ?? 'sample';
    const valueKnown = status === 'measured' && Number.isFinite(measurement?.value);
    const event = {
      event_id: eventId,
      provider,
      operation,
      metric: meter,
      metric_kind: aggregation,
      aggregation,
      unit: definition?.unit ?? measurement?.unit ?? 'unknown',
      currency: definition?.currency ?? 'none',
      scenario_id: receipt?.scenario_id ?? receipt?.source ?? 'observed-operation',
      source_revision: receipt?.source_revision ?? 'unknown',
      run_id: receipt?.id ?? coverage.idempotent_key,
      window_start: receipt?.at ?? 'unknown',
      window_end: receipt?.at ?? 'unknown',
      observed_at: receipt?.at ?? 'unknown-time',
      timing_source: receipt?.timing_source ?? 'unknown',
      ...(receipt?.file_modified_at ? { file_modified_at: receipt.file_modified_at } : {}),
      source_revision_current: receipt?.source_revision_current ?? 'unknown',
      execution_replayed: receipt?.replayed === true,
      scope: valueKnown && receipt?.source_revision !== 'unknown' ? 'measured' : 'unknown',
      value: valueKnown && receipt?.source_revision !== 'unknown' ? measurement.value : null,
      retry_count: receipt?.replayed === true ? 0 : receipt?.attempt > 1 ? 1 : 0,
      error_count: receipt?.replayed === true ? 0 : receipt?.useful_work?.status === 'failed' ? 1 : 0,
      evidence: `receipt:${eventId}`,
      ...(measurement && !valueKnown && Number.isFinite(measurement.value) ? { reported_value: measurement.value } : {}),
      ...(status !== 'measured' ? { coverage_status: status } : {}),
    };
    const priorId = priorLinks[key];
    const correction = unchanged ? priorCorrections[key] : priorId && priorId !== eventId ? priorId : null;
    if (correction) { event.corrects_event_id = correction; nextCorrections[key] = correction; }
    nextLinks[key] = eventId;
    return observationRecord(event);
  };
  for (const receipt of receipts) {
    for (const measurement of receipt.measurements ?? []) {
      const row = coverage.rows.find(x => x.operation === receipt.operation && x.provider === (receipt.provider ?? 'unknown') && x.meter === measurement.meter);
      const meter = meterDefs.get(measurement.meter);
      const measured = Boolean(meter && meter.unit === measurement.unit && receipt.source_revision !== 'unknown');
      const eventId = pin({ receipt: receipt.id, provider: receipt.provider ?? 'unknown', meter: measurement.meter, unit: measurement.unit, value: measurement.value, source_revision: receipt.source_revision, receipt_content_pin: receipt.content_pin });
      observations.push(makeObservation(eventId, receipt, measurement, measured ? 'measured' : 'unknown', receipt.operation, measurement.meter));
      if (row && row.status !== 'measured' && !measured) continue;
    }
  }
  for (const row of coverage.rows) {
    if (receipts.some(r => r.operation === row.operation && (r.provider ?? 'unknown') === row.provider && (r.measurements ?? []).some(m => m.meter === row.meter))) continue;
    const eventId = pin({ provider: row.provider, operation: row.operation, meter: row.meter, coverage_key: coverage.idempotent_key });
    observations.push(makeObservation(eventId, null, null, 'unknown', row.operation, row.meter, row.provider));
  }
  return { observations, nextLinks, nextCorrections };
}

/** Discover current source/package revisions and receipts, then call the single
 * canonical coverage evaluator. Raw prompts and transcripts never leave this
 * process; event logs are reduced to turn.completed usage counters only. */
export async function collectAndRefresh(input) {
  if (!Array.isArray(input?.source_roots) || !Array.isArray(input?.receipt_roots)) throw new TypeError('source_roots and receipt_roots are required arrays.');
  const limits = { ...defaultLimit, ...(input.limits ?? {}) };
  if (input.source_roots.length + input.receipt_roots.length > limits.roots) throw new RangeError(`Root-count limit exceeded: ${limits.roots}.`);
  const started = performance.now();
  const cpuBefore = process.resourceUsage();
  const gaps = [];
  if (input.source_roots.length === 0) gaps.push('no source roots were configured');
  if (input.receipt_roots.length === 0) gaps.push('no execution receipt roots were configured');
  const sources = [];
  const operations = [];
  const receipts = [];
  const meters = input.meters ?? JSON.parse(text(await readFile(new URL('../read-data/meter-definitions.json', import.meta.url))));
  const adapters = input.receipt_adapters ?? JSON.parse(text(await readFile(new URL('../read-data/receipt-adapters.json', import.meta.url))));
  const catalogAdapters = input.catalog_adapters ?? JSON.parse(text(await readFile(new URL('../read-data/catalog-adapters.json', import.meta.url))));
  const prices = input.prices ?? [];
  let filesSeen = 0;
  let bytesSeen = 0;
  for (const root of input.source_roots) {
    if (filesSeen >= limits.files || bytesSeen >= limits.bytes) { gaps.push('global source scan limit reached'); break; }
    if (!root?.id || !root?.path) throw new TypeError('Each source root needs id and path.');
    const files = await walk(root, limits, true, gaps);
    const identityRows = [];
    for (const file of files) {
      if (filesSeen >= limits.files) { gaps.push('total file-count limit reached'); break; }
      if (bytesSeen + file.size > limits.bytes) { gaps.push('total byte limit reached'); break; }
      const bytes = await readFile(file.full);
      filesSeen++;
      bytesSeen += bytes.length;
      if (bytesSeen > limits.bytes) { gaps.push('total byte limit reached'); break; }
      const identity = makeHashCodeHexFromBytes(bytes);
      identityRows.push({ ...file, identity });
      if (file.relative.endsWith('.json') && catalogAdapters.some(adapter => adapter.filename === path.basename(file.relative) || adapter.filename_pattern && (new RegExp(adapter.filename_pattern)).test(path.basename(file.relative)))) {
        const doc = readJson(bytes, `${root.id}/${file.relative}`, gaps);
        if (doc) operations.push(...operationCatalog(doc, file, root.id, catalogAdapters));
      }
    }
    sources.push({ id: root.id, revision: sourceRootRevision(root, identityRows) });
  }
  const fileHashes = [];
  for (const root of input.receipt_roots) {
    if (filesSeen >= limits.files || bytesSeen >= limits.bytes) { gaps.push('global receipt scan limit reached'); break; }
    if (!root?.id || !root?.path) throw new TypeError('Each receipt root needs id and path.');
    const files = await walk(root, limits, false, gaps);
    const rootReceipts = [];
    const sourceId = root.source_id ?? root.id;
    const packageRevision = sources.find(s => s.id === sourceId)?.revision;
    for (const file of files) {
      if (filesSeen >= limits.files) { gaps.push('total file-count limit reached'); break; }
      if (bytesSeen + file.size > limits.bytes) { gaps.push('total byte limit reached'); break; }
      const bytes = await readFile(file.full);
      filesSeen++;
      bytesSeen += bytes.length;
      if (bytesSeen > limits.bytes) { gaps.push('total byte limit reached'); break; }
      const identity = makeHashCodeHexFromBytes(bytes);
      fileHashes.push({ path: `${root.id}/${file.relative}`, identity, size: bytes.length });
      const currentRevision = identity;
      const effectiveRevision = packageRevision ?? 'unknown';
      if (path.extname(file.relative).toLowerCase() === '.jsonl') {
        const lines = text(bytes).split(/\r?\n/);
        for (let lineIndex = 0; lineIndex < lines.length; lineIndex++) {
          if (!lines[lineIndex].trim()) continue;
          let event;
          try { event = JSON.parse(lines[lineIndex]); }
          catch (error) { gaps.push(`invalid event line ${lineIndex + 1} in ${root.id}/${file.relative}: ${error.message}`); continue; }
          const adapted = adaptedReceipts(event, root, file, effectiveRevision, meters, new TextEncoder().encode(lines[lineIndex]), adapters, 'jsonl');
          rootReceipts.push(...adapted.map(receipt => ({ ...receipt, id: pin({ file: `${root.id}/${file.relative}`, line: lineIndex + 1, adapter: receipt.id }), content_pin: identity })));
        }
        continue;
      }
      const doc = readJson(bytes, `${root.id}/${file.relative}`, gaps);
      if (!doc) continue;
      const adapted = adaptedReceipts(doc, root, file, effectiveRevision, meters, bytes, adapters, 'json');
      const generic = genericReceipts(doc, root, file, effectiveRevision, bytes);
      rootReceipts.push(...adapted, ...generic);
      for (const receipt of [...adapted, ...generic]) receipt.content_pin = identity;
      if (!adapted.length && !generic.length && doc.schema) gaps.push(`unsupported receipt schema ${doc.schema} at ${root.id}/${file.relative}`);
    }
    const rootPin = pin(fileHashes.filter(f => f.path.startsWith(`${root.id}/`)).sort((a, b) => a.path.localeCompare(b.path)));
    const currentRevision = packageRevision ?? root.source_revision ?? rootPin;
    if (!sources.some(s => s.id === sourceId)) sources.push({ id: sourceId, revision: currentRevision });
    for (const receipt of rootReceipts) {
      receipt.source = sourceId;
      // The observed producer revision is historical evidence; scanning current source cannot rewrite it.
      receipt.source_revision_current = currentRevision;
      receipts.push(receipt);
    }
  }
  const before = input.prior ?? null;
  // Receipt roots are also revision inputs: changing event bytes invalidates prior forecasts
  // even when an upstream producer reuses a receipt ID.
  sources.sort((a, b) => a.id.localeCompare(b.id));
  const operationsUnique = [...new Map(operations.map(o => [`${o.source}\u0000${o.id}`, o])).values()].sort((a, b) => a.source.localeCompare(b.source) || a.id.localeCompare(b.id));
  let selfMeasurement = null;
  if (input.measure_self === true) {
    const source = input.self_source_id ?? 'keep-measurements-current';
    const revision = sources.find(s => s.id === source)?.revision ?? 'unknown';
    const inputKey = pin({ sources, operations: operationsUnique, receipt_files: fileHashes, meters, prices });
    const resumed = before?.self_measurement?.input_key === inputKey ? before.self_measurement.receipt : null;
    if (resumed) selfMeasurement = before.self_measurement;
    else {
      const cpuAfter = process.resourceUsage();
      const receipt = {
        id: pin({ operation: 'collector.process', input_key: inputKey }),
        operation: 'collector.process', source, source_revision: revision, at: input.now ?? new Date().toISOString(),
        timing_source: 'collector-process', attempt: input.attempt ?? 1, useful_work: { status: gaps.length === 0 ? 'succeeded' : 'unknown' },
        measurements: [
          { meter: 'collector.wall_ms', unit: 'ms', value: performance.now() - started },
          { meter: 'collector.cpu_user_ms', unit: 'ms', value: Math.max(0, cpuAfter.userCPUTime - cpuBefore.userCPUTime) / 1000 },
          { meter: 'collector.cpu_system_ms', unit: 'ms', value: Math.max(0, cpuAfter.systemCPUTime - cpuBefore.systemCPUTime) / 1000 },
          { meter: 'collector.files_seen', unit: 'file', value: filesSeen },
          { meter: 'collector.bytes_seen', unit: 'byte', value: bytesSeen },
        ], content_pin: pin({ input_key: inputKey, filesSeen, bytesSeen, cpuAfter }),
      };
      selfMeasurement = { input_key: inputKey, receipt };
    }
    receipts.push(selfMeasurement.receipt);
  }
  const coverage = refreshCoverage({ sources, operations: operationsUnique, receipts, meters, prices, price_book_revision: input.price_book_revision, prior: before, discovery_complete: gaps.length === 0 });
  const now = input.now ?? new Date().toISOString();
  const unchanged = before?.idempotent_key === coverage.idempotent_key;
  const observationGeneratedAt = unchanged ? (before.observation_generated_at ?? now) : now;
  const { observations, nextLinks, nextCorrections } = toLedgerRows(coverage, receipts, meters, before?.observation_links ?? {}, before?.observation_corrections ?? {}, unchanged, observationGeneratedAt);
  const version = unchanged ? (before.forecast_version ?? 1) : (before?.forecast_version ?? 0) + 1;
  const forecastCreatedAt = unchanged ? (before.forecast_created_at ?? now) : now;
  const forecast = forecastRecord({
    forecast_id: coverage.idempotent_key,
    version: Math.max(1, version),
    source_revision: coverage.pins.source,
    created_at: forecastCreatedAt,
    completeness: coverage.status === 'current' ? 'complete' : 'incomplete',
    components: coverage.rows.map(r => {
      const price = prices.find(p => p.meter === r.meter && p.provider === r.provider);
      const sample = receipts.find(receipt => receipt.operation === r.operation && (receipt.provider ?? 'unknown') === r.provider);
      const currency = price?.currency ?? 'unknown';
      const priced = r.status === 'measured' && r.cost !== null && Boolean(price?.currency);
      return { provider: r.provider, operation: r.operation, metric: r.meter, unit: priced ? currency : 'unknown', currency, scenario_id: sample?.scenario_id ?? sample?.source ?? 'observed-operation', scope: priced ? 'measured' : 'unknown', value: priced ? r.cost : null, status: r.status };
    }),
    refresh_state: { ...coverage.next_state, idempotent_key: coverage.idempotent_key, forecast_version: Math.max(1, version), forecast_created_at: forecastCreatedAt, observation_generated_at: observationGeneratedAt, observation_links: nextLinks },
  });
  const persistedState = { ...forecast.value.refresh_state, observation_corrections: nextCorrections, ...(selfMeasurement ? { self_measurement: selfMeasurement } : {}) };
  forecast.value.refresh_state = persistedState;
  return {
    format: 'measurement-collection/1',
    collected_at: now,
    discovery: { complete: gaps.length === 0, files_seen: filesSeen, bytes_seen: bytesSeen, source_roots: sources, operation_catalog: operationsUnique, receipt_files: fileHashes, gaps },
    coverage,
    observations,
    forecast,
    refresh_state: persistedState,
    persistence: { owner: 'measurement-ledger + existing records door', records: [...observations, forecast], write_required: true, unchanged_run: coverage.idempotent_key === before?.idempotent_key },
  };
}
