import { hostWithin } from '../../http-client/do-work/same-origin.mjs';

// Customer-owned host and path aliases for any Trillion share target.
//
// DNS ownership and Cloudflare Worker attachment are separate facts: proving a
// TXT record does not make Cloudflare send requests to this Worker. The caller
// activates routing only after its Cloudflare owner confirms the custom domain
// is attached to this Worker.
export class ShareLinkRoutingError extends Error {}

const DOMAIN_KEY = 'share-link-domain:';
const RESERVED_HOSTS = new Set(['app.gettrillion.ai', 'harness.gettrillion.ai', 'gettrillion.ai']);
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const hex = bytes => [...bytes].map(byte => byte.toString(16).padStart(2, '0')).join('');

export function normalizeShareDomain(value, { allowReservedSuffix = false } = {}) {
  if (typeof value !== 'string' || !value.trim()) throw new ShareLinkRoutingError('Give the domain you control.');
  const given = value.trim().toLowerCase().replace(/\.$/, '');
  if (given.includes('://') || given.includes('/') || given.includes(':') || given.includes('@')) throw new ShareLinkRoutingError('Give a domain name without a scheme, path, port or sign-in.');
  let hostname;
  try { hostname = new URL(`https://${given}`).hostname.toLowerCase(); }
  catch { throw new ShareLinkRoutingError('That is not a valid domain name.'); }
  if (hostname.length > 253 || !/^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(hostname)) {
    throw new ShareLinkRoutingError('Give a fully qualified domain name.');
  }
  if (RESERVED_HOSTS.has(hostname) || (!allowReservedSuffix && hostWithin(hostname, 'gettrillion.ai'))) throw new ShareLinkRoutingError('That domain is reserved by Trillion.');
  return hostname;
}

/** Canonical exact URL path; query strings are configured on the destination, not the route key. */
export function normalizeSharePath(value) {
  if (typeof value !== 'string' || !value.startsWith('/') || value.startsWith('//') || value.includes('?') || value.includes('#') || value.includes('\\')) {
    throw new ShareLinkRoutingError('A share path starts with / and has no query or fragment.');
  }
  const segments = value.split('/').slice(1);
  if (segments.some(segment => segment === '.' || segment === '..' || /%2f|%5c/i.test(segment))) throw new ShareLinkRoutingError('A share path cannot move outside its address.');
  const path = `/${segments.filter(Boolean).join('/')}`;
  return path === '/' ? '/' : path;
}

function routePath({ path, template, random }) {
  if (template !== undefined) {
    if (typeof template !== 'string' || (template.match(/\{random\}/g) ?? []).length !== 1 || /\{(?!random\})[^{}]+\}/.test(template)) {
      throw new ShareLinkRoutingError('A path template may use one {random} part.');
    }
    const token = hex(random(12));
    return normalizeSharePath(template.replace('{random}', token));
  }
  return normalizeSharePath(path);
}

function routeTarget(value) {
  if (!object(value) || typeof value.kind !== 'string' || typeof value.id !== 'string' || !value.id.trim()) {
    throw new ShareLinkRoutingError('A share link needs a target kind and target id.');
  }
  return { kind: value.kind.trim().slice(0, 80), id: value.id.trim().slice(0, 500), ...(value.revision ? { revision: String(value.revision).slice(0, 200) } : {}) };
}

const domainKey = host => `${DOMAIN_KEY}${host}`;

/**
 * One owner for aliases on arbitrary share targets.
 *
 * storage is a KV-shaped object with async get(key, 'json'), put(key, value),
 * and delete(key). checkTxt(domain, recordName) returns the TXT values that are
 * visible in public DNS. setAttached is an internal callback from the Cloudflare
 * custom-domain owner, never proof supplied by the customer.
 */
export function makeShareLinkRouting({ storage, checkTxt, resolveTarget, random = size => crypto.getRandomValues(new Uint8Array(size)) }) {
  if (!storage?.get || !storage?.put) throw new TypeError('Share-link routing needs its storage.');
  if (typeof resolveTarget !== 'function') throw new TypeError('Share-link routing needs its target resolver.');
  const address = (host, path) => `https://${host}${path}`;

  async function domainFor(host) { return storage.get(domainKey(host), 'json'); }
  async function ownedDomain(owner, value) {
    const host = normalizeShareDomain(value);
    const row = await domainFor(host);
    if (!row || row.owner !== owner) throw new ShareLinkRoutingError('That domain is not connected to this account.');
    return { host, row };
  }

  async function describe(host, row) {
    return {
      domain: host,
      status: row.status,
      verified: Boolean(row.verified_at),
      connected: row.status === 'active',
      verification_record: row.verified_at ? null : { type: 'TXT', name: `_trillion-verify.${host}`, value: `trillion-domain-verification=${row.token}` },
      routes: row.routes.map(route => ({ ...route, address: address(host, route.path) })),
    };
  }

  async function claimDomain(owner, value) {
    if (typeof owner !== 'string' || !owner.trim()) throw new ShareLinkRoutingError('A signed-in account is needed to connect a domain.');
    const host = normalizeShareDomain(value);
    const current = await domainFor(host);
    if (current && current.owner !== owner) throw new ShareLinkRoutingError('That domain is already connected to another account.');
    if (current) return describe(host, current);
    const token = hex(random(24));
    const row = { owner, status: 'awaiting_dns', token, routes: [], created_at: new Date().toISOString(), attached_at: null };
    await storage.put(domainKey(host), JSON.stringify(row));
    return describe(host, row);
  }

  async function verifyDomain(owner, value) {
    const { host, row } = await ownedDomain(owner, value);
    if (row.status !== 'awaiting_dns') return describe(host, row);
    if (typeof checkTxt !== 'function') throw new ShareLinkRoutingError('Public DNS lookup is not connected.');
    const recordName = `_trillion-verify.${host}`;
    const values = await checkTxt(host, recordName);
    if (!Array.isArray(values) || !values.some(entry => String(entry).replace(/^\"|\"$/g, '') === `trillion-domain-verification=${row.token}`)) {
      return { ...await describe(host, row), verified: false };
    }
    row.status = 'awaiting_attachment';
    row.verified_at = new Date().toISOString();
    await storage.put(domainKey(host), JSON.stringify(row));
    return { ...await describe(host, row), verified: true };
  }

  // Call only after the Cloudflare custom-domain owner confirms the host is
  // attached to this Worker by reading it back from Cloudflare.
  async function setAttached(hostValue, attached) {
    const host = normalizeShareDomain(hostValue);
    const row = await domainFor(host);
    if (!row || !row.verified_at) throw new ShareLinkRoutingError('Verify domain ownership before connecting its address.');
    row.status = attached ? 'active' : 'awaiting_attachment';
    row.attached_at = attached ? new Date().toISOString() : null;
    await storage.put(domainKey(host), JSON.stringify(row));
    return describe(host, row);
  }

  async function addRoute(owner, value, input) {
    const { host, row } = await ownedDomain(owner, value);
    if (row.status !== 'active') throw new ShareLinkRoutingError('The domain must be verified and connected before its links can open.');
    const path = routePath({ path: input?.path, template: input?.template, random });
    const target = routeTarget(input?.target);
    const found = row.routes.find(route => route.path === path);
    if (found && JSON.stringify(found.target) !== JSON.stringify(target)) throw new ShareLinkRoutingError(`The path ${path} is already in use on this domain.`);
    const route = found ?? { path, target, created_at: new Date().toISOString() };
    if (!found) row.routes.push(route);
    await storage.put(domainKey(host), JSON.stringify(row));
    return { ...route, address: address(host, path) };
  }

  async function removeRoute(owner, value, pathValue) {
    const { host, row } = await ownedDomain(owner, value);
    const path = normalizeSharePath(pathValue);
    const length = row.routes.length;
    row.routes = row.routes.filter(route => route.path !== path);
    if (row.routes.length === length) throw new ShareLinkRoutingError(`There is no share link at ${path}.`);
    await storage.put(domainKey(host), JSON.stringify(row));
    return describe(host, row);
  }

  async function changeRoute(owner, value, oldPathValue, input = {}) {
    const { host, row } = await ownedDomain(owner, value);
    if (row.status !== 'active') throw new ShareLinkRoutingError('The domain must be verified and connected before its links can open.');
    const oldPath = normalizeSharePath(oldPathValue);
    const index = row.routes.findIndex(route => route.path === oldPath);
    if (index < 0) throw new ShareLinkRoutingError(`There is no share link at ${oldPath}.`);
    const path = input.path !== undefined || input.template !== undefined
      ? routePath({ path: input.path, template: input.template, random })
      : oldPath;
    if (row.routes.some((route, at) => at !== index && route.path === path)) throw new ShareLinkRoutingError(`The path ${path} is already in use on this domain.`);
    const earlier = row.routes[index];
    const route = {
      ...earlier,
      path,
      ...(input.target !== undefined ? { target: routeTarget(input.target) } : {}),
      updated_at: new Date().toISOString(),
    };
    row.routes[index] = route;
    await storage.put(domainKey(host), JSON.stringify(row));
    return { ...route, address: address(host, path) };
  }

  async function resolve(request) {
    if (request.method !== 'GET' && request.method !== 'HEAD') return null;
    const url = new URL(request.url);
    let host;
    try { host = normalizeShareDomain(url.hostname); } catch { return null; }
    const row = await domainFor(host);
    if (!row || row.status !== 'active') return null;
    const route = row.routes.find(item => item.path === normalizeSharePath(url.pathname));
    if (!route) return null;
    // Contract, checkout, profile and other targets keep their own destination
    // resolver; aliases do not duplicate their rendering or payment UI.
    const destination = await resolveTarget(route.target, { request });
    if (!destination || !URL.canParse(destination) || new URL(destination).protocol !== 'https:') return null;
    return Response.redirect(destination, 302);
  }

  return { claimDomain, verifyDomain, setAttached, addRoute, changeRoute, removeRoute, resolve };
}
