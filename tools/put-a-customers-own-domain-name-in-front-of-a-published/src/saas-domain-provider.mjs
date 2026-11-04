// Private service adapter for a separately provisioned Cloudflare for SaaS zone.
// Enabling SaaS, its fallback origin and quota is an operator action, not a
// customer-account or DNS mutation performed by this adapter.
import { failureOf } from '../../shared-code/src/failure.mjs';

export const saasDomainMarker = host => `public-app-saas-domain:${host}`;
const HOST = /^(?=.{4,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z](?:[a-z0-9-]{0,61}[a-z0-9])$/;
const INSTALLATION = /^[a-f0-9]{32}$/;
const PROVIDER_ID = /^(?:[a-f0-9]{32}|[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12})$/;

export function saasDomainProvider({ zoneId, token, storage, fetcher = fetch, validationMethod = 'txt' }) {
  if (!/^[a-f0-9]{32}$/.test(zoneId ?? '') || !token || !storage || !['txt', 'http'].includes(validationMethod)) throw new Error('SaaS domain provider is not configured.');
  const root = `https://api.cloudflare.com/client/v4/zones/${zoneId}/custom_hostnames`;
  async function api(method, path = '', body) {
    const response = await fetcher(`${root}${path}`, { method, headers: {
      authorization: `Bearer ${token}`, accept: 'application/json', ...(body ? { 'content-type': 'application/json' } : {}),
    }, ...(body ? { body: JSON.stringify(body) } : {}) });
    if (response.status === 404 && method === 'GET' && path.startsWith('/')) return null;
    const data = await response.json().catch(() => null);
    if (!response.ok || data?.success !== true) throw Object.assign(new Error(`SaaS hosting could not ${method.toLowerCase()} this domain (${response.status}).`),
      !response.ok && response.status >= 400 && response.status <= 599 ? { status: response.status } : {});
    return data.result;
  }
  function checked(domain, host) {
    if (!domain || domain.hostname !== host || !PROVIDER_ID.test(domain.id ?? '')) throw new Error('SaaS hosting returned an unexpected domain.');
    return domain;
  }
  async function find(host) {
    // The filter is exact in our readback too: never select the first provider
    // result merely because it was returned by a search endpoint.
    const rows = await api('GET', `?hostname=${encodeURIComponent(host)}&per_page=50`);
    if (!Array.isArray(rows)) throw new Error('SaaS hosting did not return its domain inventory.');
    const exact = rows.filter(row => row?.hostname === host);
    if (exact.length > 1) throw new Error('SaaS hosting returned conflicting domains.');
    if (!exact.length && rows.length >= 50) throw new Error('SaaS hosting did not return a complete exact domain inventory.');
    return exact.length ? checked(exact[0], host) : null;
  }
  async function owned(host, installationId) {
    const marker = await storage.get(saasDomainMarker(host), 'json');
    if (marker && marker.installation_id !== installationId) throw new Error('This domain is attached to another app.');
    if (marker?.provider_id && !PROVIDER_ID.test(marker.provider_id)) throw new Error('This domain has an invalid hosting receipt.');
    return marker;
  }
  async function save(host, marker) { await storage.put(saasDomainMarker(host), JSON.stringify(marker)); }
  async function observed(host, marker) {
    if (marker?.provider_id) {
      const domain = await api('GET', `/${encodeURIComponent(marker.provider_id)}`);
      return domain ? checked(domain, host) : null;
    }
    return find(host);
  }
  function challenges(domain) {
    const dns = [], http = [];
    const add = (purpose, type, name, value) => {
      if (typeof name === 'string' && name.length > 0 && name.length <= 253 && typeof value === 'string' && value.length > 0 && value.length <= 4096) dns.push({ purpose, type, name, value });
    };
    const ownership = domain.ownership_verification;
    if (ownership?.type?.toLowerCase() === 'txt') add('hostname', 'TXT', ownership.name, ownership.value);
    const records = Array.isArray(domain.ssl?.validation_records) ? domain.ssl.validation_records : [];
    for (const record of records) {
      add('certificate', 'TXT', record.txt_name, record.txt_value);
      add('certificate', 'CNAME', record.cname, record.cname_target);
    }
    for (const [purpose, record] of [['hostname', domain.ownership_verification_http], ...records.map(record => ['certificate', record])]) {
      if (typeof record?.http_url === 'string' && record.http_url.length <= 2048 && typeof record.http_body === 'string' && record.http_body.length <= 4096) {
        const url = new URL(record.http_url);
        if (url.hostname === domain.hostname && ['http:', 'https:'].includes(url.protocol)) http.push({ purpose, url: record.http_url, body: record.http_body });
      }
    }
    return { ...(dns.length ? { dns_records: dns } : {}), ...(http.length ? { http_challenges: http } : {}) };
  }
  function describe(host, installationId, domain, marker) {
    if (!domain) return { host, status: 'absent', provider: 'cloudflare-saas' };
    const ready = Boolean(marker && marker.status !== 'retiring' && domain.status === 'active' && domain.ssl?.status === 'active');
    return { host, status: ready ? 'attached' : 'pending', ...(ready ? { installation_id: installationId } : {}),
      provider: 'cloudflare-saas', hostname_status: domain.status ?? null, certificate_status: domain.ssl?.status ?? null, ...challenges(domain) };
  }
  async function read({ host, installationId }) {
    const marker = await owned(host, installationId);
    const domain = await observed(host, marker);
    return describe(host, installationId, domain, marker);
  }
  async function attach({ host, installationId }) {
    let marker = await owned(host, installationId);
    if (marker?.status === 'retiring') throw Object.assign(new Error('This domain is still being disconnected.'), { status: 409 });
    let domain = await observed(host, marker);
    if (domain && !marker) throw new Error('This domain is already attached outside this app.');
    if (!marker) {
      marker = { installation_id: installationId, created_at: new Date().toISOString(), status: 'creating' };
      // Persist intent before the external effect. A lost POST response remains
      // recoverable under this exact host and installation instead of creating
      // a second hostname or clearing uncertain ownership.
      await save(host, marker);
    }
    if (!domain) domain = checked(await api('POST', '', { hostname: host, ssl: { method: validationMethod, type: 'dv' } }), host);
    if (marker.provider_id !== domain.id || marker.status !== 'attached') {
      marker = { ...marker, provider_id: domain.id, status: 'attached' };
      await save(host, marker);
    }
    return read({ host, installationId });
  }
  async function detach({ host, installationId }) {
    const marker = await owned(host, installationId);
    const domain = await observed(host, marker);
    if (domain && !marker) throw new Error('This domain is attached outside this app.');
    if (domain) {
      await save(host, { ...marker, provider_id: domain.id, status: 'retiring' });
      await api('DELETE', `/${encodeURIComponent(domain.id)}`);
    }
    // A lost DELETE response keeps intent and provider ID for a later exact
    // read. Never report absence from an error or an accepted delete alone.
    const remaining = domain ? await api('GET', `/${encodeURIComponent(domain.id)}`) : null;
    if (remaining) { checked(remaining, host); return { host, status: 'pending', provider: 'cloudflare-saas' }; }
    // Also inspect the exact name: another provider row must not disappear
    // behind the deletion of an older ID.
    if (await find(host)) return { host, status: 'pending', provider: 'cloudflare-saas' };
    if (marker) await storage.delete(saasDomainMarker(host));
    return { host, status: 'absent', provider: 'cloudflare-saas' };
  }
  async function handle(request) {
    if (request.method !== 'POST') return new Response(null, { status: 405 });
    const action = new URL(request.url).pathname.slice(1);
    if (!['attach', 'read', 'detach'].includes(action)) return new Response(null, { status: 404 });
    const input = await request.json().catch(() => null);
    if (!HOST.test(input?.host ?? '') || !INSTALLATION.test(input?.installationId ?? '')) return Response.json({ error: 'Invalid domain or app.' }, { status: 400 });
    try { return Response.json({ result: await { attach, read, detach }[action](input) }); }
    catch (error) {
      const failure = failureOf(error);
      const status = Number.isInteger(error?.status) && error.status >= 400 && error.status <= 599 ? error.status : 502;
      return Response.json({ error: error.message, ...(failure.code !== 'unexpected' ? {
        failure_code: failure.code, ...(failure.retry_at ? { retry_at: failure.retry_at } : {}),
      } : {}) }, { status });
    }
  }
  return { attach, read, detach, handle };
}
