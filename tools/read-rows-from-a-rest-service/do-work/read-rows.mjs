// tools/read-rows-from-a-rest-service/do-work/read-rows.mjs
//
// The container tool `tool:read-rows-from-a-rest-service` (tool-rows.json): reads rows of one table of any PostgREST
// service the person connected (a service connection whose descriptor names a project URL and a service key), such as
// a Supabase project. It only reads: GET requests, no writes and no stored procedures.
//
// The connection's service key reaches this one process on a private pipe (the row's invoke.credential_mounts):
// descriptor 3. The project URL is a request field (it is not a secret), and the key goes only to a project under a
// domain read-data/hosts.json names, at that project's /rest/v1 path, as the apikey and Bearer headers PostgREST
// expects. The answer carries rows, never a key or the provider's raw reply.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const HOSTS = JSON.parse(readFileSync(new URL('../read-data/hosts.json', import.meta.url), 'utf8'));

const MAX_ROWS = 1000;
const MOUNT = { serviceKey: 3 };
const TABLE_NAME = /^[a-zA-Z_][a-zA-Z0-9_]{0,62}$/;
const FILTER_OPERATORS = new Set(['eq', 'neq', 'gt', 'gte', 'lt', 'lte', 'like', 'ilike', 'is', 'in']);

// A project URL is an https root with no path, query or credentials, under one of the domains in hosts.json, so the key
// only ever goes to that project.
export function projectOrigin(projectUrl, domains = HOSTS.domains) {
  let target;
  try { target = new URL(projectUrl); } catch { throw new Error('The project URL is not a web address.'); }
  if (target.protocol !== 'https:' || target.username || target.password || target.search || target.hash || (target.pathname !== '/' && target.pathname !== '')) {
    throw new Error('The project URL must be an https address with no path.');
  }
  if (!domains.some(domain => target.hostname === domain || target.hostname.endsWith(`.${domain}`))) {
    throw new Error(`The project URL must be under ${domains.join(' or ')}; the key is not sent anywhere else.`);
  }
  return target.origin;
}

// PostgREST filters: each column maps to 'operator.value' (for example { "status": "eq.active" }).
export function filterPairs(filters = {}) {
  return Object.entries(filters).map(([column, condition]) => {
    if (!TABLE_NAME.test(column)) throw new Error(`The filter column "${column}" is not a plain column name.`);
    const dot = String(condition).indexOf('.');
    const operator = dot > 0 ? String(condition).slice(0, dot) : '';
    if (!FILTER_OPERATORS.has(operator)) throw new Error(`The filter for "${column}" must start with one of: ${[...FILTER_OPERATORS].join(', ')}.`);
    return [column, String(condition)];
  });
}

// Reads one page of rows: { rows, count, total }. The input names the project, the table and what to take; the
// connection's key comes in as `service` = { serviceKey }.
export async function readRows(input, { service, fetchImpl = fetch }) {
  const { serviceKey } = service;
  if (typeof serviceKey !== 'string' || serviceKey.trim() === '') throw new Error('No service key was handed to this run. Connect the service first.');
  const origin = projectOrigin(input.project_url);
  if (!TABLE_NAME.test(input.table ?? '')) throw new Error('Name one table with plain letters, digits and underscores.');
  const url = new URL(`/rest/v1/${encodeURIComponent(input.table)}`, origin);
  url.searchParams.set('select', input.select ?? '*');
  url.searchParams.set('limit', String(Math.min(input.limit ?? 100, MAX_ROWS)));
  if (input.offset) url.searchParams.set('offset', String(input.offset));
  if (input.order) url.searchParams.set('order', input.order);
  for (const [column, condition] of filterPairs(input.filters)) url.searchParams.set(column, condition);
  const headers = { apikey: serviceKey.trim(), Authorization: `Bearer ${serviceKey.trim()}`, Accept: 'application/json', Prefer: 'count=exact' };
  const response = await fetchImpl(url.href, { method: 'GET', headers, signal: AbortSignal.timeout(20000), redirect: 'error' });
  if (response.status === 401 || response.status === 403) throw new Error(`The service refused the held key (${response.status}). Connect the service again with a current key.`);
  if (response.status === 404) throw new Error(`The project has no table named "${input.table}".`);
  if (!response.ok) throw new Error(`The service answered ${response.status}. Try again later.`);
  const rows = await response.json();
  if (!Array.isArray(rows)) throw new Error('The service did not answer a list of rows.');
  const total = Number(String(response.headers.get('content-range') ?? '').split('/')[1]);
  return { rows, count: rows.length, total: Number.isSafeInteger(total) ? total : null };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const read = descriptor => { try { return readFileSync(descriptor, 'utf8').trim(); } catch { return ''; } };
  try {
    const input = JSON.parse(readFileSync(0, 'utf8') || '{}');
    const service = { serviceKey: read(MOUNT.serviceKey) };
    console.log(JSON.stringify(await readRows(input, { service })));
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
