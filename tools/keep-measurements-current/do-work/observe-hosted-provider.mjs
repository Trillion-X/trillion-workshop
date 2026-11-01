import { readFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SOURCE_URL = new URL('../read-data/hosted-provider-source.json', import.meta.url);
const SOURCE = JSON.parse(await readFile(SOURCE_URL, 'utf8'));
const ownDirectory = path.dirname(fileURLToPath(import.meta.url));
const workshopRoot = path.resolve(ownDirectory, '../../..');

function dataPath(value, dottedPath) {
  return dottedPath.split('.').reduce((current, part) => current?.[/^\d+$/.test(part) ? Number(part) : part], value);
}

function finite(value) {
  return typeof value === 'number' && Number.isFinite(value);
}

function sumKnown(rows, field) {
  if (!rows.length) return { state: 'unknown', reason: 'provider_returned_no_rows' };
  const values = rows.map(row => dataPath(row, field));
  if (values.some(value => !finite(value))) return { state: 'unknown', reason: 'provider_field_missing_or_non_numeric' };
  return { state: 'provider_reported', value: values.reduce((sum, value) => sum + value, 0) };
}

function project(response, spec) {
  if (spec.kind === 'status_only') {
    const success = dataPath(response, spec.status_path);
    const errors = Array.isArray(response?.errors) ? response.errors : [];
    const safeCodes = errors.map(error => error?.code).filter(code => typeof code === 'number' || (typeof code === 'string' && /^[A-Z0-9_-]{1,48}$/.test(code)));
    return {
      provider_success: typeof success === 'boolean' ? success : null,
      provider_error_count: errors.length,
      provider_error_codes: safeCodes,
      value_state: success === true ? 'provider_verified' : 'unknown',
    };
  }
  const rows = dataPath(response, spec.data_path);
  if (!Array.isArray(rows)) return { value_state: 'unknown', reason: 'expected_provider_group_array_missing' };
  if (spec.kind === 'workers_adaptive') {
    const sums = Object.fromEntries(spec.sum_fields.map(field => [field, sumKnown(rows, `sum.${field}`)]));
    const quantiles = Object.fromEntries(spec.quantile_fields.map(field => {
      if (!rows.length) return [field, { state: 'unknown', reason: 'provider_returned_no_rows' }];
      const values = rows.map(row => dataPath(row, `quantiles.${field}`));
      return [field, values.every(finite) ? { state: 'provider_reported_quantile', unit: 'millisecond', values } : { state: 'unknown', reason: 'provider_field_missing_or_non_numeric' }];
    }));
    return { group_count: rows.length, sums, quantiles, value_state: rows.length ? 'provider_reported' : 'unknown' };
  }
  if (spec.kind === 'sum_groups') {
    const sums = spec.sum_fields
      ? Object.fromEntries(spec.sum_fields.map(field => [field, sumKnown(rows, field)]))
      : { [spec.value_path]: sumKnown(rows, spec.value_path) };
    let categories;
    if (spec.category_path && rows.length) {
      const totals = new Map();
      let complete = true;
      for (const row of rows) {
        const category = dataPath(row, spec.category_path);
        const count = dataPath(row, spec.value_path);
        if (typeof category !== 'string' || !finite(count)) { complete = false; break; }
        totals.set(category, (totals.get(category) ?? 0) + count);
      }
      categories = complete
        ? [...totals].sort(([a], [b]) => a.localeCompare(b)).map(([operation, requests]) => ({ operation, requests }))
        : { state: 'unknown', reason: 'provider_category_or_count_missing' };
    }
    return { group_count: rows.length, sums, ...(categories ? { operation_categories: categories } : {}), value_state: rows.length ? 'provider_reported' : 'unknown' };
  }
  if (spec.kind === 'latest_per_private_group_then_sum') {
    if (!rows.length) return { group_count: 0, values: Object.fromEntries(spec.labels.map(label => [label, { state: 'unknown', reason: 'provider_returned_no_rows' }])), value_state: 'unknown' };
    const latest = new Map();
    for (const row of rows) {
      const group = dataPath(row, spec.group_path);
      const time = dataPath(row, spec.time_path);
      if (typeof group !== 'string' || typeof time !== 'string') return { value_state: 'unknown', reason: 'provider_group_or_time_missing' };
      if (!latest.has(group) || time > latest.get(group).time) latest.set(group, { time, row });
    }
    const selected = [...latest.values()].map(item => item.row);
    const values = Object.fromEntries(spec.value_paths.map((field, index) => [spec.labels[index], sumKnown(selected, field)]));
    return { group_count: selected.length, values, value_state: Object.values(values).every(value => value.state === 'provider_reported') ? 'provider_reported' : 'unknown' };
  }
  throw new TypeError(`Unsupported hosted-provider projection ${spec.kind}.`);
}

function inventoryIdentity(name) {
  const suffix = name.includes(':') ? name.slice(name.lastIndexOf(':') + 1) : name;
  if (!/^(?:[0-9a-f]{2}){8,}$/i.test(suffix)) return null;
  try {
    const decoded = Buffer.from(suffix, 'hex').toString('utf8');
    return decoded.startsWith('service_connection:') ? decoded.split(':')[1] : null;
  } catch { return null; }
}

export async function vaultInventory(vault) {
  const names = await vault.namesHeldByTheVault();
  const wanted = names.filter(name => name.startsWith('cloudflare-') || name.startsWith('backblaze-b2-') || inventoryIdentity(name) === 'supabase');
  return wanted.map(name => {
    const provider = name.startsWith('cloudflare-') ? 'cloudflare' : name.startsWith('backblaze-b2-') ? 'backblaze-b2' : 'supabase';
    const shape = vault.shapeHeldByTheVault(name);
    return { provider, holder_kind: shape?.fields ? 'structured' : shape, fields: Array.isArray(shape?.fields) ? [...shape.fields].sort() : [] };
  });
}

function cloudflareAccountId(endpoint) {
  if (typeof endpoint !== 'string') throw new TypeError('The configured Cloudflare account endpoint is not a string.');
  const url = new URL(endpoint);
  if (url.protocol !== 'https:' || !url.hostname.endsWith('.r2.cloudflarestorage.com')) throw new TypeError('The held Cloudflare R2 endpoint is outside the expected official origin.');
  const accountId = url.hostname.split('.')[0];
  if (!/^[a-f0-9]{32}$/i.test(accountId)) throw new TypeError('The held Cloudflare R2 endpoint has no valid account identifier.');
  return accountId;
}

function graphVariables(request, accountId, now) {
  const end = now;
  const start = new Date(now.getTime() - request.window_hours * 60 * 60 * 1000);
  return { accountTag: accountId, start: start.toISOString(), end: end.toISOString() };
}

async function callOne({ provider, request, token, accountId, now, fetchImpl }) {
  const url = new URL(request.path.replaceAll('{account_id}', accountId), provider.origin);
  let body;
  const headers = { authorization: `Bearer ${token}`, accept: 'application/json' };
  if (request.graphql) {
    headers['content-type'] = 'application/json';
    body = JSON.stringify({ query: request.graphql, variables: graphVariables(request, accountId, now) });
  }
  const started = performance.now();
  const startedAt = new Date().toISOString();
  let response;
  let text = '';
  let transportFailure = null;
  try {
    response = await fetchImpl(url, { method: request.method, headers, ...(body === undefined ? {} : { body }), redirect: 'error', signal: AbortSignal.timeout(30_000) });
    text = await response.text();
  } catch (error) {
    transportFailure = error?.name === 'TimeoutError' ? 'timeout' : 'transport_error';
  }
  const elapsedMs = performance.now() - started;
  let json;
  if (text) {
    try { json = JSON.parse(text); } catch { json = null; }
  }
  const providerErrors = Array.isArray(json?.errors) ? json.errors : [];
  const providerErrorCodes = providerErrors
    .map(error => error?.extensions?.code ?? error?.code)
    .filter(code => typeof code === 'number' || (typeof code === 'string' && /^[A-Z0-9_-]{1,48}$/.test(code)));
  const payload = {
    provider: provider.id,
    source_revision: SOURCE.source_revision,
    collection_source_revision: gitRevision(),
    observation_id: request.id,
    observed_started_at: startedAt,
    window_start: request.window_hours ? new Date(now.getTime() - request.window_hours * 60 * 60 * 1000).toISOString() : null,
    window_end: request.window_hours ? now.toISOString() : null,
    scope: request.id.startsWith('r2-') ? 'account_aggregate_all_buckets' : request.id === 'workers-invocations-24h' ? 'account_aggregate_all_workers' : 'account_metadata',
    method: request.method,
    official_origin: url.origin,
    request_body_bytes: body === undefined ? { state: 'measured', value: 0 } : { state: 'measured', value: Buffer.byteLength(body) },
    response_body_bytes: response ? { state: 'measured', value: Buffer.byteLength(text) } : { state: 'unknown', reason: transportFailure },
    elapsed_ms: { state: 'measured', value: Number(elapsedMs.toFixed(3)) },
    attempts: 1,
    retries: 0,
    errors: (transportFailure || !response?.ok || json?.success === false || providerErrors.length > 0) ? 1 : 0,
    provider_error_count: providerErrors.length,
    provider_error_codes: providerErrorCodes,
    http_status: response?.status ?? null,
    ...(transportFailure ? { transport_failure: transportFailure } : {}),
    ...(json ? { result: project(json, request.projection) } : { result: { value_state: 'unknown', reason: transportFailure ?? 'unparseable_provider_response' } }),
    ...(request.unit_notes ? { interpretation: request.unit_notes } : {}),
  };
  return payload;
}

function gitRevision() {
  try {
    return execFileSync('git', ['-C', workshopRoot, 'rev-parse', 'HEAD'], { encoding: 'utf8', timeout: 3000 }).trim();
  } catch { return null; }
}

export async function observeHostedProviders({ source = SOURCE, vault, fetchImpl = fetch, now = new Date() }) {
  if (source.schema !== 'hosted-provider-source/1' || !Array.isArray(source.providers)) throw new TypeError('Unsupported hosted-provider source DATA.');
  const observations = [];
  for (const provider of source.providers) {
    const tokenValue = await vault.heldByTheVault(provider.token_holder);
    const token = typeof tokenValue === 'string' ? tokenValue : tokenValue?.value;
    if (typeof token !== 'string' || token.length < 16) throw new TypeError(`Vault holder ${provider.token_holder} did not yield a usable credential.`);
    const endpointValue = await vault.heldByTheVault(provider.account_endpoint_holder);
    const accountEndpoint = typeof endpointValue === 'string' ? endpointValue : endpointValue?.[provider.account_endpoint_field];
    const accountId = cloudflareAccountId(accountEndpoint);
    for (const request of provider.requests) {
      observations.push(await callOne({ provider, request, token, accountId, now, fetchImpl }));
    }
  }
  return { schema: 'hosted-provider-observations/1', observed_at: new Date().toISOString(), observation_count: observations.length, observations };
}

async function loadVault() {
  const moduleUrl = new URL(SOURCE.vault_helper, SOURCE_URL);
  return import(moduleUrl.href);
}

async function main() {
  const mode = process.argv[2] ?? 'observe';
  const vault = await loadVault();
  if (mode === 'inventory') {
    process.stdout.write(JSON.stringify({ vault_metadata: await vaultInventory(vault) }, null, 2) + '\n');
    return;
  }
  if (mode !== 'observe') throw new TypeError('Usage: node observe-hosted-provider.mjs [inventory|observe].');
  const result = await observeHostedProviders({ vault });
  process.stdout.write(JSON.stringify(result, null, 2) + '\n');
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { await main(); }
  catch (error) {
    process.stderr.write(`hosted provider observation failed: ${error?.message ?? 'unknown error'}\n`);
    process.exitCode = 1;
  }
}
