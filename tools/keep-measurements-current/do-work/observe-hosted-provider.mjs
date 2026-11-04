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

const HOLDER_ROLES = ['token', 'account_endpoint', 'key_id', 'key'];

/**
 * The person's credential rows say which vault holders belong to which provider. No holder name or
 * vendor prefix lives in this code: a vault name not named by a row is never read or reported.
 * `{ schema: 'hosted-provider-credentials/1', rows: [{ provider, holders?: { token, account_endpoint, ... }, service_connection? }] }`
 */
export function validateCredentialRows(credentials) {
  if (!credentials || credentials.schema !== 'hosted-provider-credentials/1' || !Array.isArray(credentials.rows)) {
    throw new TypeError('Give credential rows as hosted-provider-credentials/1: { schema, rows: [{ provider, holders, service_connection }] }.');
  }
  const seen = new Set();
  return credentials.rows.map((row, index) => {
    const where = `credential row ${index + 1}`;
    if (typeof row?.provider !== 'string' || !/^[a-z0-9][a-z0-9-]{0,63}$/.test(row.provider)) throw new TypeError(`${where} needs a provider id.`);
    if (seen.has(row.provider)) throw new TypeError(`${where} repeats provider ${row.provider}.`);
    seen.add(row.provider);
    const holders = row.holders ?? {};
    if (typeof holders !== 'object' || Array.isArray(holders)) throw new TypeError(`${where} holders is an object of role to vault holder name.`);
    for (const [role, name] of Object.entries(holders)) {
      if (!HOLDER_ROLES.includes(role)) throw new TypeError(`${where} names unknown holder role ${role}; roles are ${HOLDER_ROLES.join(', ')}.`);
      if (typeof name !== 'string' || !name) throw new TypeError(`${where} holder ${role} must be a vault holder name.`);
    }
    if (row.service_connection !== undefined && (typeof row.service_connection !== 'string' || !row.service_connection)) {
      throw new TypeError(`${where} service_connection must be a nonempty name.`);
    }
    if (!Object.keys(holders).length && !row.service_connection) throw new TypeError(`${where} names no holder and no service connection.`);
    return { provider: row.provider, holders: { ...holders }, ...(row.service_connection ? { service_connection: row.service_connection } : {}) };
  });
}

export async function vaultInventory(vault, credentials) {
  const rows = validateCredentialRows(credentials);
  const names = await vault.namesHeldByTheVault();
  const held = new Set(names);
  const out = [];
  for (const row of rows) {
    const wanted = [
      ...Object.values(row.holders).filter(name => held.has(name)),
      ...(row.service_connection ? names.filter(name => inventoryIdentity(name) === row.service_connection) : []),
    ];
    for (const name of wanted) {
      const shape = vault.shapeHeldByTheVault(name);
      out.push({ provider: row.provider, holder_kind: shape?.fields ? 'structured' : shape, fields: Array.isArray(shape?.fields) ? [...shape.fields].sort() : [] });
    }
    const missing = Object.entries(row.holders).filter(([, name]) => !held.has(name)).map(([role]) => role);
    if (missing.length) out.push({ provider: row.provider, holder_kind: 'not_held', missing_roles: missing.sort() });
  }
  return out;
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

export async function observeHostedProviders({ source = SOURCE, credentials, vault, fetchImpl = fetch, now = new Date() }) {
  if (source.schema !== 'hosted-provider-source/1' || !Array.isArray(source.providers)) throw new TypeError('Unsupported hosted-provider source DATA.');
  const rows = new Map(validateCredentialRows(credentials).map(row => [row.provider, row]));
  const observations = [];
  const unconfigured = [];
  for (const provider of source.providers) {
    const row = rows.get(provider.id);
    if (!row?.holders.token || !row.holders.account_endpoint) { unconfigured.push(provider.id); continue; }
    const tokenValue = await vault.heldByTheVault(row.holders.token);
    const token = typeof tokenValue === 'string' ? tokenValue : tokenValue?.value;
    if (typeof token !== 'string' || token.length < 16) throw new TypeError(`The token holder in the ${provider.id} credential row did not yield a usable credential.`);
    const endpointValue = await vault.heldByTheVault(row.holders.account_endpoint);
    const accountEndpoint = typeof endpointValue === 'string' ? endpointValue : endpointValue?.[provider.account_endpoint_field];
    const accountId = cloudflareAccountId(accountEndpoint);
    for (const request of provider.requests) {
      observations.push(await callOne({ provider, request, token, accountId, now, fetchImpl }));
    }
  }
  // A provider with no credential row is not observed, and says so: nothing is guessed from vault names.
  return { schema: 'hosted-provider-observations/1', observed_at: new Date().toISOString(), observation_count: observations.length, observations,
    ...(unconfigured.length ? { unconfigured_providers: unconfigured } : {}) };
}

async function loadVault() {
  const moduleUrl = new URL(SOURCE.vault_helper, SOURCE_URL);
  return import(moduleUrl.href);
}

const USAGE = 'Usage: node observe-hosted-provider.mjs [inventory|observe] --credentials FILE (hosted-provider-credentials/1 rows).';

async function main() {
  const args = process.argv.slice(2);
  const at = args.indexOf('--credentials');
  if (at < 0 || !args[at + 1]) throw new TypeError(USAGE);
  const credentials = JSON.parse(await readFile(args[at + 1], 'utf8'));
  args.splice(at, 2);
  const mode = args[0] ?? 'observe';
  if (mode !== 'inventory' && mode !== 'observe') throw new TypeError(USAGE);
  validateCredentialRows(credentials);
  const vault = await loadVault();
  if (mode === 'inventory') {
    process.stdout.write(JSON.stringify({ vault_metadata: await vaultInventory(vault, credentials) }, null, 2) + '\n');
    return;
  }
  const result = await observeHostedProviders({ credentials, vault });
  process.stdout.write(JSON.stringify(result, null, 2) + '\n');
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { await main(); }
  catch (error) {
    process.stderr.write(`hosted provider observation failed: ${error?.message ?? 'unknown error'}\n`);
    process.exitCode = 1;
  }
}
