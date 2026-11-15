// Adapted from the immutable askProvider slice; request/query DATA stays with the connection owner.
import { readFileSync } from 'node:fs';
import watch from '../read-data/usage-reading.json' with { type: 'json' };
import { buildInvocation, httpJson } from '../../http-client/do-work/http-invocation.mjs';
import { nodePublicFetch } from '../../http-client/do-work/node-public-fetch.mjs';

let providerRows;
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const day = value => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value)
  && Number.isFinite(Date.parse(`${value}T00:00:00Z`)) && new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) === value;
export const validUsageScope = value => object(value) && Object.keys(value).every(key => ['connection_id', 'since', 'until'].includes(key))
  && /^service_connection:cloudflare(?::[^:\s]+)?$/.test(value.connection_id ?? '') && day(value.since) && day(value.until) && value.since <= value.until;
const unread = reason => ({ state: 'unread', reason });

function counters(account, token) {
  if (!object(account)) return null;
  const result = {};
  for (const [dataset, groups] of Object.entries(watch.datasets)) {
    if (!Array.isArray(account[dataset])) return null;
    result[dataset] = [];
    for (const sample of account[dataset]) {
      if (!object(sample)) return null;
      const projected = {};
      for (const [group, fields] of Object.entries(groups)) {
        if (!object(sample[group])) return null;
        projected[group] = {};
        for (const field of fields) {
          const value = sample[group][field];
          if (group === 'dimensions' ? typeof value !== 'string' || !/^[A-Za-z][A-Za-z0-9_]{0,79}$/.test(value) || value.includes(token)
            : typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > Number.MAX_SAFE_INTEGER) return null;
          projected[group][field] = value;
        }
      }
      result[dataset].push(projected);
    }
  }
  return result;
}

export async function readServiceUsage(scope, { readHeld = fd => readFileSync(fd, 'utf8'), fetchImpl = nodePublicFetch() } = {}) {
  if (!validUsageScope(scope)) return unread('invalid_scope');
  let token, account;
  try { token = readHeld(4)?.trim(); account = readHeld(5)?.trim(); }
  catch { return unread('connection_unreadable'); }
  if (typeof token !== 'string' || !token || /[\r\n\0]/.test(token) || !/^[a-fA-F0-9]{32}$/.test(account ?? '')) return unread('connection_incomplete');
  const period = { since: scope.since, until: scope.until, timezone: 'UTC', inclusive: true };
  const reading = watch.reading, how = watch.readings[reading.id], env = { account_id: account };
  providerRows ??= import('../../connect-a-service-and-seal-its-key/records.json', { with: { type: 'json' } }).then(module => module.default.things);
  const payload = (await providerRows).find(thing => thing.address === how.record)?.payload;
  const request = payload?.instrument_requests?.[how.request];
  if (!request) return unread('reading_unavailable');
  // The qualified transport is forced to return redirects untouched, before any secret can leave its host.
  const fetch = (url, init) => fetchImpl(url, { ...init, redirect: 'manual' });
  try {
    const input = Object.fromEntries(Object.entries(reading.input ?? {}).map(([name, from]) => [name, from.period ? period[from.period] : env[watch.connection_fields[from.connection_field]]]));
    const invocation = await buildInvocation({ ...request, connection_id: payload.connection_id, credential_injections: payload.credential_injections, timeout_ms: payload.timeout_ms }, { input, request: true });
    const send = async ({ url, method, headers, body, credential_injections, timeout_ms }) => {
      const placed = { ...headers };
      for (const { placement } of credential_injections) {
        if (placement.kind !== 'header') throw new Error(`A ${placement.kind} placement is not one this watch can give its token.`);
        placed[placement.name] = `${placement.prefix ?? ''}${token}`;
      }
      const response = await fetch(url, { method, headers: placed, body, signal: AbortSignal.timeout(timeout_ms) });
      return { status_code: response.status, body: await response.text() };
    };
    const answer = await httpJson({ invocation, send }, fetch);
    if (!object(answer) || (Object.hasOwn(answer, 'errors') && (!Array.isArray(answer.errors) || answer.errors.length))) return unread('provider_unreadable');
    const accounts = answer.data?.viewer?.accounts;
    if (!Array.isArray(accounts) || accounts.length !== 1) return unread('account_unreadable');
    const usage = counters(accounts[0], token);
    return usage ? { state: 'read', connection_id: scope.connection_id, account_id: account, period, usage, said: watch.said } : unread('usage_unreadable');
  } catch { return unread('provider_unreadable'); }
}
