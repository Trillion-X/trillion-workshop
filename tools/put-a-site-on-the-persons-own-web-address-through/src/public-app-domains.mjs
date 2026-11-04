import { normalizeShareDomain } from './share-link-routing.mjs';
import { failureFromReply, failureOf } from '../../keep-and-wake-ai-sessions-on-this-computer/src/failure.mjs';

const PREFIX = 'public-app-domain:';
const PROBE = '/.well-known/trillion-public-app-domain';
const tokenOf = () => [...crypto.getRandomValues(new Uint8Array(24))].map(byte => byte.toString(16).padStart(2, '0')).join('');

export const publicAppDomainKey = host => `${PREFIX}${host}`;
export const publicAppDomainProbePath = PROBE;

/** The provider owner owns credentials and implements these three service-binding actions. */
export function publicAppDomainProvider(binding) {
  if (typeof binding?.fetch !== 'function') return null;
  const call = async (action, input) => {
    const response = await binding.fetch(new Request(`https://public-app-domain-provider/${action}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify(input),
    }));
    if (!response.ok) {
      const detail = await response.json().catch(() => null);
      console.error('Public app domain provider refused', action, response.status, detail?.error ?? 'No detail');
      throw Object.assign(failureFromReply('The hosting provider could not confirm this domain change.',detail),{status:response.status});
    }
    const result = await response.json();
    return result?.result ?? null;
  };
  return {
    prepare: input => call('prepare', input),
    attach: input => call('attach', input),
    read: input => call('read', input),
    detach: input => call('detach', input),
  };
}

function hostOf(value, operatorDomain = false) {
  const host = normalizeShareDomain(value, { allowReservedSuffix: operatorDomain });
  const labels = host.split('.');
  if (labels.length < 2 || labels.at(-1).length < 2 || /^\d+$/.test(labels.at(-1))) throw new Error('Give a domain with a valid top-level name.');
  return host;
}
export { hostOf as checkedPublicAppDomainHost };

function describe(host, row, carrierHost) {
  carrierHost = row.hosting?.carrier_host ?? carrierHost;
  return { host, url: `https://${host}/`, status: row.status,
    ...(row.provider_readback ? { provider_readback: row.provider_readback, provider_checked_at: row.provider_checked_at } : {}),
    ...(row.status === 'active' || row.status === 'ended' || !carrierHost ? {} : { address_record: { type: 'CNAME', name: host, value: carrierHost } }),
    ...(['active', 'ended'].includes(row.status) ? {} : { verification_record: {
      type: 'TXT', name: `_trillion-verify.${host}`, value: `trillion-public-app=${row.token}`,
    } }) };
}

export function publicAppDomainChallenge(request, row) {
  if (request.method !== 'GET' || new URL(request.url).pathname !== PROBE || !row?.token || ['ended', 'retiring'].includes(row.status)) return null;
  return new Response(`trillion-public-app=${row.token}`, {
    headers: { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' },
  });
}

async function visibleTxt(recordName, fetcher) {
  const response = await fetcher(`https://cloudflare-dns.com/dns-query?name=${encodeURIComponent(recordName)}&type=TXT`, {
    headers: { accept: 'application/dns-json' }, redirect: 'manual',
  });
  if (!response.ok) throw new Error('The domain verification record could not be checked.');
  const result = await response.json();
  return (result.Answer ?? []).filter(answer => answer.type === 16)
    .map(answer => String(answer.data ?? '').replace(/^"|"$/g, ''));
}

/** A hostname belongs to one installation and is live only after DNS ownership and a real HTTPS carrier probe. */
function requireProvider(provider) {
  if (typeof provider?.attach !== 'function' || typeof provider?.read !== 'function' || typeof provider?.detach !== 'function') {
    throw new Error('The hosting provider is not connected, so this domain has not been changed.');
  }
  return provider;
}

async function providerCall(provider, method, input) {
  try { return await provider[method](input); }
  catch (error) {
    // Current source refusals and shared service failures must survive this
    // family adapter. A failed provider call is never an absent domain.
    if(failureOf(error).code!=='unexpected'||Number.isInteger(error?.status)&&error.status>=400&&error.status<=599)throw error;
    throw new Error('The hosting provider could not confirm this domain change.');
  }
}

function checkedReadback(host, installationId, result, expected) {
  if (!result || result.host !== host || !['attached', 'absent', 'pending'].includes(result.status)) return null;
  if (result.status === 'attached' && result.installation_id !== installationId) return null;
  if (result.status !== expected) return null;
  return {
    host,
    status: result.status,
    ...(result.status === 'attached' ? { installation_id: installationId } : {}),
    ...(typeof result.provider === 'string' && /^[a-z0-9-]{1,40}$/.test(result.provider) ? { provider: result.provider } : {}),
  };
}

/** A hostname is live only after DNS ownership, provider readback, and the HTTPS carrier challenge all agree. */
export function publicAppDomains({ storage, fetcher = fetch, randomToken = tokenOf, carrierHost = null, provider, operatorUserId = null }) {
  async function prepareHosting(host, installationId, selected) {
    const result = await providerCall(provider, 'prepare', { host, installationId, ...(selected ? { provider: selected } : {}) });
    if (result?.host !== host || !/^[a-z0-9-]{1,40}$/.test(result.provider ?? '')
      || hostOf(result.carrier_host, true) !== result.carrier_host) throw new Error('The hosting provider did not confirm its DNS target.');
    return { provider: result.provider, carrier_host: result.carrier_host };
  }
  const providerTarget = (host, installationId, row) => ({ host, installationId,
    ...(typeof provider?.prepare === 'function' ? { provider: row.hosting?.provider ?? 'cloudflare-pages' } : {}) });
  async function claim({ host: input, installationId, ownerUserId }) {
    const host = hostOf(input, ownerUserId === operatorUserId && Boolean(operatorUserId));
    const key = publicAppDomainKey(host);
    const earlier = await storage.get(key, 'json');
    if (earlier && earlier.status !== 'ended') {
      if (earlier.installation_id !== installationId || earlier.owner_user_id !== ownerUserId) throw new Error('That domain is connected to another app.');
      if (!earlier.hosting && typeof provider?.prepare === 'function') {
        earlier.hosting = await prepareHosting(host, installationId, 'cloudflare-pages');
        await storage.put(key, JSON.stringify(earlier));
      }
      return describe(host, earlier, carrierHost);
    }
    const row = { installation_id: installationId, owner_user_id: ownerUserId, status: 'awaiting_dns', token: randomToken(), created_at: new Date().toISOString() };
    if (typeof provider?.prepare === 'function') row.hosting = await prepareHosting(host, installationId);
    await storage.put(key, JSON.stringify(row));
    return describe(host, row, carrierHost);
  }

  async function activate({ host: input, installationId, ownerUserId }) {
    const host = hostOf(input, ownerUserId === operatorUserId && Boolean(operatorUserId));
    const key = publicAppDomainKey(host);
    const row = await storage.get(key, 'json');
    if (!row || row.installation_id !== installationId || row.owner_user_id !== ownerUserId || row.status === 'ended') throw new Error('That domain is not connected to this app.');
    // Detach may already have happened even when its reply was lost. Finish
    // that retirement before a new claim may attach the hostname again.
    if(row.status==='retiring')throw Object.assign(new Error('This domain is still being disconnected. Finish disconnecting it before reconnecting.'),{status:409});
    const expected = `trillion-public-app=${row.token}`;
    const txt = await visibleTxt(`_trillion-verify.${host}`, fetcher);
    if (!txt.includes(expected)) throw new Error('Add the verification TXT record to this domain, then try again.');
    // Checking a live domain again never stops it serving: only a domain that is not live yet waits for attachment.
    if (row.status !== 'active') row.status = 'awaiting_attachment';
    row.verified_at = new Date().toISOString();
    await storage.put(key, JSON.stringify(row));
    const hosting = requireProvider(provider);
    const target = providerTarget(host, installationId, row);
    let readback = await providerCall(hosting, 'read', target);
    if (checkedReadback(host, installationId, readback, 'attached') === null) {
      await providerCall(hosting, 'attach', { ...target, carrierHost: row.hosting?.carrier_host ?? carrierHost });
      readback = await providerCall(hosting, 'read', target);
    }
    const confirmed = checkedReadback(host, installationId, readback, 'attached');
    if (!confirmed) {
      row.provider_readback = readback && readback.host === host ? readback : { host, status: 'pending' };
      row.provider_checked_at = new Date().toISOString();
      await storage.put(key, JSON.stringify(row));
      throw new Error('The hosting provider has not confirmed this domain for this app yet.');
    }
    row.provider_readback = confirmed;
    row.provider_checked_at = new Date().toISOString();
    await storage.put(key, JSON.stringify(row));
    let response;
    try { response = await fetcher(`https://${host}${PROBE}`, { redirect: 'manual', headers: { accept: 'text/plain' } }); }
    catch (error) {
      if(failureOf(error).tries_again_later||Number.isInteger(error?.status)&&error.status>=400&&error.status<=599)throw error;
      throw new Error('This domain does not reach the public app host yet. Check its CNAME and host connection.');
    }
    if (response.status !== 200 || (await response.text()) !== expected) throw new Error('This domain does not reach the public app host yet. Check its CNAME and host connection.');
    row.status = 'active';
    row.attached_at = new Date().toISOString();
    await storage.put(key, JSON.stringify(row));
    return describe(host, row, carrierHost);
  }

  async function retire({ host: input, installationId, ownerUserId }) {
    const host = hostOf(input, ownerUserId === operatorUserId && Boolean(operatorUserId));
    const key = publicAppDomainKey(host);
    const row = await storage.get(key, 'json');
    if (!row || row.installation_id !== installationId || row.owner_user_id !== ownerUserId) throw new Error('That domain is not connected to this app.');
    if (row.status === 'ended') return describe(host, row, carrierHost);
    row.status = 'retiring';
    await storage.put(key, JSON.stringify(row));
    const hosting = requireProvider(provider);
    const target = providerTarget(host, installationId, row);
    await providerCall(hosting, 'detach', target);
    const readback = await providerCall(hosting, 'read', target);
    const confirmed = checkedReadback(host, installationId, readback, 'absent');
    row.provider_readback = readback && readback.host === host ? readback : { host, status: 'pending' };
    row.provider_checked_at = new Date().toISOString();
    if (!confirmed) {
      await storage.put(key, JSON.stringify(row));
      throw new Error('The hosting provider has not confirmed that this domain was detached. The app has stopped serving it.');
    }
    row.status = 'ended';
    row.ended_at = new Date().toISOString();
    row.provider_readback = confirmed;
    await storage.put(key, JSON.stringify(row));
    return describe(host, row, carrierHost);
  }
  return { claim, activate, retire };
}
