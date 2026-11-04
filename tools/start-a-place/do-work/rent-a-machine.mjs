// tools/start-a-place/do-work/rent-a-machine.mjs
//
// One machine lease, driven by a provider row in ../read-data/providers.json. A `machines` row's `host` and
// `access_key` name which of its own `requests` find, create, read and remove a machine and its SSH key; its `price`
// names the request that reads the size's monthly price. A `names` row's `zone` and `record` do the same for one DNS
// name. A row with no `base` is a machine the person already runs: it is adopted at its address, and removing it
// forgets it without touching it.
//
// Provider credentials arrive only as an in-memory argument. The lease file names the provider rows, their IDs, the
// address, size, start and cleanup deadline, never a credential. Creating, observing and removing use the same exact
// owned IDs, and nothing is deleted that does not carry this lease's own label. A provider that stores each public key
// once has the person's key found by its fingerprint and used as it is; the lease then never removes it.
import { readFileSync, writeFileSync, mkdirSync, renameSync } from 'node:fs';
import { dirname } from 'node:path';
import { isIP } from 'node:net';
import { createHash } from 'node:crypto';

const rows = JSON.parse(readFileSync(new URL('../read-data/providers.json', import.meta.url), 'utf8'));
function one(list, id, what) {
  const row = list.find(r => r.id === id);
  if (!row) throw new Error(`No ${what} row is named ${JSON.stringify(id)}; the rows are ${list.map(r => r.id).join(', ')}.`);
  return row;
}
export const machineProvider = id => one(rows.machines, id, 'machine provider');
export const nameProvider = id => one(rows.names, id, 'name provider');

/** The value at a dotted path ('' is the value itself; a number segment indexes an array). */
export const at = (value, path) => (path ? path.split('.').reduce((v, key) => v?.[key], value) : value);
/** A row template filled from ctx: "{x}" alone keeps x's type; inside text it is spliced in (by `splice`). */
export function fill(template, ctx, splice = String) {
  if (Array.isArray(template)) return template.map(item => fill(item, ctx, splice));
  if (template && typeof template === 'object') return Object.fromEntries(Object.entries(template).map(([k, v]) => [k, fill(v, ctx, splice)]));
  if (typeof template !== 'string') return template;
  const whole = /^\{([a-z_]+)\}$/i.exec(template);
  return whole && splice === String ? ctx[whole[1]] : template.replace(/\{([a-z_]+)\}/gi, (_, key) => splice(String(ctx[key])));
}
const escape = text => text.replace(/[.*+?^$()|[\]\\]/g, '\\$&');
const parts = row => [row.host, row.access_key, row.price, row.zone, row.record].filter(Boolean);
/** A step's request (host.create, record.read, ...) as { method, path relative to the row's base, body_template }. */
function step(row, part, name) {
  const asked = row.requests[part[name]];
  if (!asked?.url.startsWith(row.base)) throw new Error(`The ${row.name} row has no ${part[name] ?? name} request under ${row.base}.`);
  return { ...asked, path: asked.url.slice(row.base.length) };
}

// The calls a row declares, as [method, path pattern, names one resource?]; nothing else is sent. A part's own
// identity placeholder matches only its id_pattern; every other placeholder matches one path or query value.
function operations(row) {
  const ids = Object.fromEntries(parts(row).filter(p => p.id_is).map(p => [p.id_is, p.id_pattern.replace(/^\^|\$$/g, '')]));
  return Object.values(row.requests).map(asked => {
    const path = asked.url.slice(row.base.length), single = Object.keys(ids).some(id => path.endsWith(`{${id}}`));
    const shape = escape(path).replace(/\\?\{([a-z_]+)\\?\}/gi, (_, key) => (ids[key] ? `(?:${ids[key]})` : '[^&/?#\\s]+'));
    return [asked.method, new RegExp(`^${shape}$`), single];
  });
}

export function providerClient(row, token, { fetchImpl = fetch, timeoutMs = 15000 } = {}) {
  if (!row?.base) throw new Error(`The ${row?.name ?? 'provider'} row has no provider API; it needs no client.`);
  if (typeof token !== 'string' || !token.trim() || /[\r\n]/.test(token.trim())) throw new Error(`The ${row.name} credential was refused.`);
  const allowed = operations(row), secret = token.trim();
  return async function request(method, path, body) {
    const op = allowed.find(([m, shape]) => m === method && shape.test(path));
    if (!op) throw new Error(`The ${row.name} operation was refused.`);
    const response = await fetchImpl(`${row.base}${path}`, {
      method, headers: { [row.auth.header]: `${row.auth.prefix}${secret}`, ...(body ? { 'content-type': 'application/json' } : {}) },
      ...(body ? { body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(timeoutMs),
    });
    if (response.status === 404 && op[2]) return { absent: true };
    let answer;
    try { answer = await response.json(); } catch { throw new Error(`${row.name} answered HTTP ${response.status} without JSON.`); }
    if (!response.ok) throw new Error(`${row.name} refused ${method} ${path.split('?')[0]} (HTTP ${response.status}, ${String(at(answer, row.error_code_at) ?? 'unknown').replace(/[^a-z0-9_-]/gi, '').slice(0, 80)}).`);
    return answer;
  };
}

function save(file, lease) {
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  const next = `${file}.next`;
  writeFileSync(next, `${JSON.stringify(lease, null, 2)}\n`, { mode: 0o600 });
  renameSync(next, file);
}

export function readLease(file) { return JSON.parse(readFileSync(file, 'utf8')); }

/** The OpenSSH MD5 fingerprint (aa:bb:...) of a public key line, the form providers list stored keys by. */
export const fingerprintOf = line => createHash('md5').update(Buffer.from(String(line).trim().split(/\s+/)[1] ?? '', 'base64')).digest('hex').match(/../g).join(':');
const ownedId = (part, id) => id != null && new RegExp(part.id_pattern).test(String(id));
const idAt = (value, part) => at(value, part.id_at ?? 'id');
const owns = (value, part, ctx) => at(value, part.owner_at) === fill(part.owner_is ?? '{name}', ctx);
/** Send one of the row's steps, its path and body filled from ctx (the id under the part's own placeholder). */
function ask(request, row, part, name, ctx, id) {
  const r = step(row, part, name), filled = id === undefined ? ctx : { ...ctx, [part.id_is]: id };
  return request(r.method, fill(r.path, filled, encodeURIComponent), r.body_template && fill(r.body_template, filled));
}
const named = (row, part, listed, key, value) => (Array.isArray(listed) ? listed : []).filter(item => at(item, part.name_at ?? key) === value);

export async function rentMachine({ request, file, name, publicKey, placement = {}, lifetime = 'test', expiresAt, now = Date.now, provider }) {
  const row = provider, place = { ...row.placement, ...placement };
  if (!/^[a-z][a-z0-9-]{1,60}$/.test(name) || (row.base ? !publicKey?.startsWith('ssh-ed25519 ') || !place.size || !place.location || !place.image : isIP(place.address ?? '') !== 4)) throw new Error('The machine lease configuration was refused.');
  const startedAt = now();
  if (!['test', 'service'].includes(lifetime)) throw new Error('The lease lifetime was refused.');
  if (lifetime === 'test' && (!Number.isSafeInteger(expiresAt) || expiresAt <= startedAt || expiresAt - startedAt > 24 * 60 * 60 * 1000)) throw new Error('A test machine needs a cleanup deadline within one day.');
  if (lifetime === 'service' && expiresAt != null) throw new Error('A retained machine must not have an automatic deletion deadline.');
  let lease;
  try { lease = readLease(file); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  if (lease && lease.state !== 'removed') {
    if (lease.name !== name || lease.provider !== row.id || lease.serverType !== (place.size ?? null) || lease.location !== (place.location ?? null)) throw new Error('The saved lease names another placement.');
    return { ...lease, reused: true };
  }
  lease = { schema: 'place-lease/1', provider: row.id, name, serverType: place.size ?? null, location: place.location ?? null, image: place.image ?? null, lifetime, startedAt, expiresAt: expiresAt ?? null, state: 'creating', serverId: null, sshKeyId: null, address: null };
  // A machine the person already runs is adopted at its address; there is nothing to rent and nothing to delete later.
  if (!row.base) { Object.assign(lease, { state: 'running', address: place.address, adopted: true }); save(file, lease); return lease; }
  const base = { ...place, name, public_key: publicKey.trim(), fingerprint: fingerprintOf(publicKey) }, ctx = { ...base, ...fill(row.fill ?? {}, base) }, s = row.host, k = row.access_key;
  const listed = async () => named(row, s, at(await ask(request, row, s, 'find', ctx), s.list_at), 'name', name);
  if ((await listed()).length) throw new Error('A machine with this name already exists without this lease; it was left untouched.');
  save(file, lease);
  try {
    const stored = k?.find ? at(await ask(request, row, k, 'find', ctx), k.list_at) : [];
    if (stored?.length) lease.sharedSshKeyId = stored[0].id;
    else if (k) {
      lease.sshKeyId = idAt(await ask(request, row, k, 'create', ctx), k);
      if (!ownedId(k, lease.sshKeyId)) throw new Error(`${row.name} did not return the SSH key identity.`);
      save(file, lease);
    }
    const created = at(await ask(request, row, s, 'create', k ? { ...ctx, [k.id_is]: lease.sshKeyId ?? lease.sharedSshKeyId } : ctx), s.created_at);
    lease.serverId = idAt(created, s);
    lease.address = at(created, s.address_at);
    if (!ownedId(s, lease.serverId) || !lease.address) throw new Error(`${row.name} did not return the new machine's identity and address.`);
    lease.state = 'running';
    save(file, lease);
    return lease;
  } catch (error) {
    // Retain exact cleanup ownership when the provider's answer is ambiguous; never delete a guessed resource.
    lease.state = 'creation-unknown';
    save(file, lease);
    if (!lease.serverId) {
      const same = await listed(), owned = same.filter(item => owns(item, s, ctx));
      if (same.length !== owned.length || owned.length > 1) throw new Error('The creation answer is uncertain; the saved lease retains cleanup ownership.');
      if (owned.length === 1) { lease.serverId = idAt(owned[0], s); lease.address = at(owned[0], s.address_at) ?? null; save(file, lease); }
    }
    if (lease.serverId) await ask(request, row, s, 'remove', ctx, lease.serverId);
    if (lease.sshKeyId) await ask(request, row, k, 'remove', ctx, lease.sshKeyId);
    lease.state = 'removed';
    save(file, lease);
    throw error;
  }
}

/** The machine as the provider sees it now: { state, address }, or { state: 'absent' }; an adopted one is as saved. */
export async function readMachine({ request, file, provider }) {
  const lease = readLease(file), row = provider ?? machineProvider(lease.provider);
  if (!row.base || lease.serverId == null) return { state: lease.state, address: lease.address };
  const answer = await ask(request, row, row.host, 'read', { ...row.placement, name: lease.name }, lease.serverId);
  if (answer.absent) return { state: 'absent', address: null };
  const found = at(answer, row.host.found_at);
  if (!owns(found, row.host, { name: lease.name })) throw new Error('The machine is no longer owned by this lease.');
  return { state: at(found, row.host.state_at ?? 'status') ?? 'unknown', address: at(found, row.host.address_at) ?? null };
}

export async function releaseMachine({ request, file, provider }) {
  const lease = readLease(file);
  if (lease.state === 'removed') return lease;
  const row = provider ?? machineProvider(lease.provider), ctx = { ...row.placement, name: lease.name };
  for (const [part, id, what] of [[row.host, lease.serverId, 'machine'], [row.access_key, lease.sshKeyId, 'SSH key']]) {
    if (!part || id == null) continue;
    const answer = await ask(request, row, part, 'read', ctx, id);
    if (answer.absent) continue;
    if (!owns(at(answer, part.found_at), part, ctx)) throw new Error(`The ${what} is no longer owned by this lease; it was left untouched.`);
    await ask(request, row, part, 'remove', ctx, id);
  }
  lease.state = 'removed';
  lease.removedAt = Date.now();
  save(file, lease);
  return lease;
}

/** The size's monthly price at the lease's location: { cents, currency }, or null when the row reads none. */
export async function readPrice({ request, provider, placement = {} }) {
  const row = provider, place = { ...row.placement, ...placement };
  if (!row.base) return Number.isSafeInteger(place.monthly_price_cents) ? { cents: place.monthly_price_cents, currency: place.currency ?? null } : null;
  const p = row.price, prices = at(await ask(request, row, p, 'read', place), p.list_at);
  const here = (Array.isArray(prices) ? prices : []).find(item => at(item, p.location_at) === place.location);
  const monthly = Number(at(here, p.monthly_at));
  if (!here || !Number.isFinite(monthly)) throw new Error(`${row.name} has no monthly price for ${place.size} at ${place.location}.`);
  return { cents: Math.round(monthly * 100), currency: p.currency };
}

/** Point host_name at the lease's address through a names row, keeping the record's identity on the lease. */
export async function pointName({ request, file, provider, zone, hostName }) {
  const lease = readLease(file), row = provider, z = row.zone, r = row.record;
  const ctx = { name: lease.name, zone, host_name: hostName, address: lease.address };
  if (lease.recordId && lease.hostName === hostName) return lease;
  const zones = named(row, z, at(await ask(request, row, z, 'find', ctx), z.list_at), 'name', zone);
  if (zones.length !== 1 || !ownedId(z, idAt(zones[0], z))) throw new Error(`${row.name} has no one zone named ${zone}.`);
  const zoneId = idAt(zones[0], z), inZone = { ...ctx, [z.id_is]: zoneId };
  const existing = named(row, r, at(await ask(request, row, r, 'find', inZone), r.list_at), 'name', hostName);
  if (existing.length) throw new Error(`${hostName} already points somewhere; it was left untouched.`);
  const created = at(await ask(request, row, r, 'create', inZone), r.created_at);
  if (!ownedId(r, idAt(created, r)) || at(created, r.address_at) !== lease.address) throw new Error(`${row.name} did not return the new record.`);
  Object.assign(lease, { names: row.id, zone, zoneId, hostName, recordId: idAt(created, r) });
  save(file, lease);
  return lease;
}

export async function forgetName({ request, file, provider }) {
  const lease = readLease(file);
  if (!lease.recordId) return lease;
  const row = provider ?? nameProvider(lease.names), r = row.record;
  const ctx = { name: lease.name, zone: lease.zone, host_name: lease.hostName, [row.zone.id_is]: lease.zoneId };
  const answer = await ask(request, row, r, 'read', ctx, lease.recordId);
  if (!answer.absent) {
    if (!owns(at(answer, r.found_at), r, ctx)) throw new Error(`The record for ${lease.hostName} is no longer owned by this lease; it was left untouched.`);
    await ask(request, row, r, 'remove', ctx, lease.recordId);
  }
  Object.assign(lease, { recordId: null, nameRemovedAt: Date.now() });
  save(file, lease);
  return lease;
}

export async function watchLease({ request, file, provider, now = Date.now, wait = ms => new Promise(resolve => setTimeout(resolve, ms)), report = () => {} }) {
  for (;;) {
    const lease = readLease(file);
    if (lease.state === 'removed') return lease;
    if (lease.lifetime === 'service') return lease;
    if (now() >= lease.expiresAt) {
      try { return await releaseMachine({ request, file, provider }); }
      catch (error) { report(error.message); await wait(30000); continue; }
    }
    await wait(Math.min(30000, lease.expiresAt - now()));
  }
}
