// The public door's one host lease, driven by a hosting row in parts/service-connections/records.json: the row's
// `rents_a_host` names which of its own instrument_requests find, create, read and remove a host and its access key.
// Provider credentials arrive only as a private in-memory argument. The receipt names the provider row, its IDs,
// the public address, size, start and cleanup deadline, never a token. Creating, observing and removing use the
// same exact owned IDs. This module does not change DNS or deploy an app.
import { readFileSync, writeFileSync, mkdirSync, renameSync, createReadStream } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isIP } from 'node:net';
import { hostingProvider } from '../parts/service-connections/read-data/public-door-rows.mjs';

/** The value at a dotted path ('' is the value itself). */
export const at = (value, path) => (path ? path.split('.').reduce((v, key) => v?.[key], value) : value);
/** A row template filled from ctx: "{x}" alone keeps x's type; inside text it is spliced in. */
export function fill(template, ctx) {
  if (Array.isArray(template)) return template.map(item => fill(item, ctx));
  if (template && typeof template === 'object') return Object.fromEntries(Object.entries(template).map(([k, v]) => [k, fill(v, ctx)]));
  if (typeof template !== 'string') return template;
  const whole = /^\{([a-z_]+)\}$/i.exec(template);
  return whole ? ctx[whole[1]] : template.replace(/\{([a-z_]+)\}/gi, (_, key) => String(ctx[key]));
}
const escape = text => text.replace(/[.*+?^$()|[\]\\]/g, '\\$&');
/** A step's request (host.create, access_key.read, ...) as { method, path relative to the row's base, body_template }. */
function step(row, part, name) {
  const asked = row.requests[part[name]];
  if (!asked?.url.startsWith(row.base)) throw new Error(`The ${row.name} row has no ${part[name] ?? name} request under ${row.base}.`);
  return { ...asked, path: asked.url.slice(row.base.length) };
}
const parts = row => [row.host, row.access_key].filter(Boolean);

// The provider operations a row declares, as [method, path pattern, single resource?]; nothing else is sent.
function operations(row) {
  const ops = [];
  for (const part of parts(row)) {
    const shape = template => new RegExp(`^${escape(fill(template, { ...row.placement, [part.id_is]: '\0id', name: '\0name' }))
      .replace('\0id', `(?:${(part.id_pattern ?? row.host.id_pattern).replace(/^\^|\$$/g, '')})`).replace('\0name', '[^&/?#\\r\\n]+')}$`);
    for (const [name, single] of [['find', false], ['create', false], ['read', true], ['remove', true]]) {
      if (part[name]) { const r = step(row, part, name); ops.push([r.method, shape(r.path), single]); }
    }
  }
  return ops;
}

export function leaseClient(row, token, { fetchImpl = fetch, timeoutMs = 15000 } = {}) {
  if (!row?.base) throw new Error(`The ${row?.name ?? 'hosting'} row has no provider API; it needs no hosting client.`);
  if (typeof token !== 'string' || !token.trim() || /[\r\n]/.test(token)) throw new Error('The hosting credential was refused.');
  const allowed = operations(row);
  return async function request(method, path, body) {
    const op = allowed.find(([m, shape]) => m === method && shape.test(path));
    if (!op) throw new Error('The hosting operation was refused.');
    const response = await fetchImpl(`${row.base}${path}`, {
      method, headers: { [row.auth.header.toLowerCase()]: `${row.auth.prefix}${token}`, ...(body ? { 'content-type': 'application/json' } : {}) },
      ...(body ? { body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(timeoutMs),
    });
    if (response.status === 404 && op[2]) return { absent: true };
    let answer;
    try { answer = await response.json(); } catch { throw new Error(`The hosting service answered HTTP ${response.status} without JSON.`); }
    if (!response.ok) throw new Error(`The hosting service refused ${method} ${path.split('?')[0]} (HTTP ${response.status}, ${String(at(answer, row.error_code_at) ?? 'unknown').replace(/[^a-z0-9_-]/gi, '').slice(0, 80)}).`);
    return answer;
  };
}
export const hetznerLeaseClient = (token, options) => leaseClient(hostingProvider('hetzner'), token, options);

function save(file, lease) {
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  const next = `${file}.next`;
  writeFileSync(next, `${JSON.stringify(lease, null, 2)}\n`, { mode: 0o600 });
  renameSync(next, file);
}

export function readHostLease(file) { return JSON.parse(readFileSync(file, 'utf8')); }

const ownedId = (part, row, id) => id != null && new RegExp(part.id_pattern ?? row.host.id_pattern).test(String(id));
const sameName = (row, listed, name) => (Array.isArray(listed) ? listed : []).filter(item => at(item, row.host.name_at ?? 'name') === name);
const idAt = (value, part) => at(value, part.id_at ?? 'id'), ownerAt = (value, part, row) => at(value, part.owner_at ?? row.host.owner_at);
/** Send one of the row's steps, its path and body filled from ctx (the id under the part's own placeholder). */
function ask(request, row, part, name, ctx, id) {
  const r = step(row, part, name), filled = id === undefined ? ctx : { ...ctx, [part.id_is]: id };
  return request(r.method, fill(r.path, filled), r.body_template && fill(r.body_template, filled));
}

export async function provisionHostLease({ request, file, name, publicKey, serverType, location, image, address, lifetime = 'test', expiresAt, now = Date.now, provider = hostingProvider('hetzner') }) {
  const row = provider, place = { ...row.placement, ...(serverType && { size: serverType }), ...(location && { location }), ...(image && { image }), ...(address && { address }) };
  if (!/^[a-z][a-z0-9-]{1,60}$/.test(name) || (row.base ? !publicKey?.startsWith('ssh-ed25519 ') || !place.size || !place.location || !place.image : isIP(place.address ?? '') !== 4)) throw new Error('The host lease configuration was refused.');
  const startedAt = now();
  if (!['test', 'service'].includes(lifetime)) throw new Error('The hosting lifetime was refused.');
  if (lifetime === 'test' && (!Number.isSafeInteger(expiresAt) || expiresAt <= startedAt || expiresAt - startedAt > 24 * 60 * 60 * 1000)) throw new Error('A test host needs a cleanup deadline within one day.');
  if (lifetime === 'service' && expiresAt != null) throw new Error('A retained service must not have an automatic deletion deadline.');
  let lease;
  try { lease = readHostLease(file); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  if (lease && lease.state !== 'removed') {
    if (lease.name !== name || (lease.provider ?? 'hetzner') !== row.id || lease.serverType !== place.size || lease.location !== place.location) throw new Error('The saved host lease names another placement.');
    return { ...lease, reused: true };
  }
  lease = { schema: 'trillion.portable-host-lease/1', provider: row.id, name, serverType: place.size, location: place.location, image: place.image, lifetime, startedAt, expiresAt: expiresAt ?? null, state: 'creating', serverId: null, sshKeyId: null, address: null };
  // A box the owner already runs is adopted at its address; there is nothing to rent and nothing to delete later.
  if (!row.base) { Object.assign(lease, { state: 'running', address: place.address, adopted: true }); save(file, lease); return lease; }
  const base = { ...place, name, public_key: publicKey.trim() }, ctx = { ...base, ...fill(row.fill ?? {}, base) }, s = row.host, k = row.access_key;
  const listed = async () => sameName(row, at(await ask(request, row, s, 'find', ctx), s.list_at), name);
  if ((await listed()).length) throw new Error('A host with this name already exists without this lease; it was left untouched.');
  save(file, lease);
  try {
    if (k) {
      lease.sshKeyId = idAt(await ask(request, row, k, 'create', ctx), k);
      if (!ownedId(k, row, lease.sshKeyId)) throw new Error('The hosting service did not return the SSH key identity.');
      save(file, lease);
    }
    const created = at(await ask(request, row, s, 'create', k ? { ...ctx, [k.id_is]: lease.sshKeyId } : ctx), s.created_at);
    lease.serverId = idAt(created, s);
    lease.address = at(created, s.address_at);
    if (!ownedId(s, row, lease.serverId) || !lease.address) throw new Error('The hosting service did not return the new server identity and address.');
    lease.state = 'running';
    save(file, lease);
    return lease;
  } catch (error) {
    // Retain exact cleanup ownership when the provider's answer is ambiguous; never delete a guessed resource.
    lease.state = 'creation-unknown';
    save(file, lease);
    if (!lease.serverId) {
      const named = await listed(), owned = named.filter(item => ownerAt(item, s, row) === name);
      if (named.length !== owned.length || owned.length > 1) throw new Error('The creation answer is uncertain; the saved lease retains cleanup ownership.');
      if (owned.length === 1) { lease.serverId = idAt(owned[0], s); lease.address = at(owned[0], s.address_at) ?? null; save(file, lease); }
    }
    if (lease.serverId) await ask(request, row, s, 'remove', ctx, lease.serverId);
    if (lease.sshKeyId) await ask(request, row, k, 'remove', ctx, lease.sshKeyId);
    lease.state = 'removed';
    save(file, lease);
    throw error;
  }
}

export async function removeHostLease({ request, file, provider }) {
  const lease = readHostLease(file);
  if (lease.state === 'removed') return lease;
  const row = provider ?? hostingProvider(lease.provider ?? 'hetzner'), ctx = { ...row.placement, name: lease.name };
  for (const [part, id, what] of [[row.host, lease.serverId, 'server'], [row.access_key, lease.sshKeyId, 'SSH key']]) {
    if (!part || id == null) continue;
    const answer = await ask(request, row, part, 'read', ctx, id);
    if (answer.absent) continue;
    if (ownerAt(at(answer, part.found_at), part, row) !== lease.name) throw new Error(`The ${what} is no longer owned by this lease; it was left untouched.`);
    await ask(request, row, part, 'remove', ctx, id);
  }
  lease.state = 'removed';
  lease.removedAt = Date.now();
  save(file, lease);
  return lease;
}

export async function watchHostLease({ request, file, provider, now = Date.now, wait = ms => new Promise(resolve => setTimeout(resolve, ms)), report = () => {} }) {
  for (;;) {
    const lease = readHostLease(file);
    if (lease.state === 'removed') return lease;
    if (lease.lifetime === 'service') return lease;
    if (now() >= lease.expiresAt) {
      try { return await removeHostLease({ request, file, provider }); }
      catch (error) { report(error.message); await wait(30000); continue; }
    }
    await wait(Math.min(30000, lease.expiresAt - now()));
  }
}

// A supervisor hands the hosting token to descriptor 3, never argv, environment, configuration or a receipt.
// CONFIG may name `provider` (a hosting-provider row id, default hetzner) and override its placement.
if (typeof process !== 'undefined' && process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [operation, file, configFile] = process.argv.slice(2);
  if (!['provision', 'remove', 'watch'].includes(operation) || !file || (operation === 'provision' ? !configFile || process.argv.length !== 5 : process.argv.length !== 4)) throw new Error('usage: portable-host-lease.mjs provision LEASE_FILE CONFIG_FILE | remove LEASE_FILE | watch LEASE_FILE (credential on fd 3)');
  const config = operation === 'provision' ? JSON.parse(readFileSync(configFile, 'utf8')) : null;
  const provider = hostingProvider(config?.provider ?? readHostLease(file).provider ?? 'hetzner');
  let token = '';
  if (provider.base) for await (const bytes of createReadStream(null, { fd: 3, autoClose: false })) {
    token += bytes.toString();
    if (token.length > 65536) throw new Error('The hosting credential exceeds its private input bound.');
  }
  const request = provider.base ? leaseClient(provider, token.trim()) : null;
  if (operation === 'watch') await watchHostLease({ request, file, provider, report: message => process.stderr.write(`${message}\n`) });
  else {
    const lease = operation === 'provision'
      ? await provisionHostLease({ ...config, provider, publicKey: config.publicKeyFile && readFileSync(config.publicKeyFile, 'utf8'), request, file })
      : await removeHostLease({ request, file, provider });
    process.stdout.write(`${JSON.stringify(lease)}\n`);
  }
}
