// tools/move-the-public-door/do-work/portable-host-lease.mjs
//
// One host lease, driven by caller-supplied provider rows. Their host and access_key parts name the requests that
// find, create, read and remove owned resources; optional price, zone and record parts read prices and keep DNS names.
// Provider credentials arrive only as a private in-memory argument. The receipt names the provider row, its IDs,
// the public address, size, start and cleanup deadline, never a token. Creating, observing and removing use the
// same exact owned IDs. DNS entries made for a lease keep their own identities and ownership markers; no app is deployed.
// Callers supply receipt read/save methods: the door tools hold them in the run (keptReceipts); another caller can supply private atomic files.
import { isIP } from 'node:net';
import { createHash } from 'node:crypto';

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

// Each placeholder is one path/query value; declared resource identities keep their own patterns.
function requestShape(row, template) {
  const ids = Object.fromEntries([...parts(row), row.zone, row.record].filter(part => part?.id_is)
    .map(part => [part.id_is, (part.id_pattern ?? row.host?.id_pattern).replace(/^\^|\$$/g, '')]));
  return new RegExp(`^${escape(template).replace(/\\?\{([a-z_]+)\\?\}/gi,
    (_, key) => ids[key] ? `(?:${ids[key]})` : '[^&/?#\\s]+')}$`);
}

// The provider operations a row declares, as [method, path pattern, single resource?]; nothing else is sent.
function operations(row) {
  const ops = [];
  for (const part of [...parts(row), row.price, row.zone, row.record].filter(Boolean)) {
    const shape = template => requestShape(row, template);
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
    // A delete is answered 204 No Content, with no body at all (Hetzner's DELETE /servers/{id} and /ssh_keys/{id}).
    if (response.status === 204) return {};
    let answer;
    try { answer = await response.json(); } catch { throw new Error(`The hosting service answered HTTP ${response.status} without JSON.`); }
    if (!response.ok) throw new Error(`The hosting service refused ${method} ${path.split('?')[0]} (HTTP ${response.status}, ${String(at(answer, row.error_code_at) ?? 'unknown').replace(/[^a-z0-9_-]/gi, '').slice(0, 80)}).`);
    return answer;
  };
}

/** The lease receipt `file` names, or an error saying none is kept under that name. */
export async function readHostLease(receipts, file) {
  const kept = await receipts.read(file);
  if (!kept) throw new Error(`No host lease is kept as ${JSON.stringify(file)}.`);
  return kept;
}

const ownedId = (part, row, id) => id != null && new RegExp(part.id_pattern ?? row.host.id_pattern).test(String(id));
const sameName = (row, listed, name) => (Array.isArray(listed) ? listed : []).filter(item => at(item, row.host.name_at ?? 'name') === name);
const idAt = (value, part) => at(value, part.id_at ?? 'id'), ownerAt = (value, part, row) => at(value, part.owner_at ?? row.host.owner_at);
const owns = (value, part, row, ctx) => ownerAt(value, part, row) === fill(part.owner_is ?? '{name}', ctx);
const pathContext = ctx => Object.fromEntries(Object.entries(ctx).map(([key, value]) => [key, encodeURIComponent(String(value))]));
/** The OpenSSH MD5 fingerprint providers use to find a public key already stored there. */
export const fingerprintOf = line => createHash('md5').update(Buffer.from(String(line).trim().split(/\s+/)[1] ?? '', 'base64')).digest('hex').match(/../g).join(':');
/** Send one of the row's steps, its path and body filled from ctx (the id under the part's own placeholder). */
function ask(request, row, part, name, ctx, id) {
  const r = step(row, part, name), filled = id === undefined ? ctx : { ...ctx, [part.id_is]: id };
  return request(r.method, fill(r.path, pathContext(filled)), r.body_template && fill(r.body_template, filled));
}

/** provider: the hosting row (read-data/public-door-rows.mjs hostingProvider). receipts/file: the receipt store (read-data/door-receipts.mjs keptReceipts) and its receipt name. */
export async function provisionHostLease({ request, receipts, file, name, publicKey, serverType, location, image, address, lifetime = 'test', expiresAt, now = Date.now, provider, schema = 'portable-host-lease/1' }) {
  const row = provider, place = { ...row.placement, ...(serverType && { size: serverType }), ...(location && { location }), ...(image && { image }), ...(address && { address }) };
  if (!/^[a-z][a-z0-9-]{1,60}$/.test(name) || (row.base ? !publicKey?.startsWith('ssh-ed25519 ') || !place.size || !place.location || !place.image : isIP(place.address ?? '') !== 4)) throw new Error('The host lease configuration was refused.');
  const startedAt = now();
  if (!['test', 'service'].includes(lifetime)) throw new Error('The hosting lifetime was refused.');
  if (lifetime === 'test' && (!Number.isSafeInteger(expiresAt) || expiresAt <= startedAt || expiresAt - startedAt > 24 * 60 * 60 * 1000)) throw new Error('A test host needs a cleanup deadline within one day.');
  if (lifetime === 'service' && expiresAt != null) throw new Error('A retained service must not have an automatic deletion deadline.');
  let lease = await receipts.read(file);
  if (lease && lease.state !== 'removed') {
    if (lease.name !== name || lease.provider !== row.id || lease.serverType !== place.size || lease.location !== place.location) throw new Error('The saved host lease names another placement.');
    return { ...lease, reused: true };
  }
  lease = { schema, provider: row.id, name, serverType: place.size, location: place.location, image: place.image, lifetime, startedAt, expiresAt: expiresAt ?? null, state: 'creating', serverId: null, sshKeyId: null, address: null };
  const save = () => receipts.save(file, lease);
  // A box the owner already runs is adopted at its address; there is nothing to rent and nothing to delete later.
  if (!row.base) { Object.assign(lease, { state: 'running', address: place.address, adopted: true }); await save(); return lease; }
  const base = { ...place, name, public_key: publicKey.trim() }, ctx = { ...base, ...fill(row.fill ?? {}, base) }, s = row.host, k = row.access_key;
  const listed = async () => sameName(row, at(await ask(request, row, s, 'find', ctx), s.list_at), name);
  if ((await listed()).length) throw new Error('A host with this name already exists without this lease; it was left untouched.');
  await save();
  try {
    const stored = k?.find ? at(await ask(request, row, k, 'find', { ...ctx, fingerprint: fingerprintOf(publicKey) }), k.list_at) : [];
    if (stored?.length) {
      if (stored.length !== 1 || !ownedId(k, row, at(stored[0], k.list_id_at ?? 'id'))) throw new Error('The stored SSH key identity is ambiguous or invalid.');
      lease.sharedSshKeyId = at(stored[0], k.list_id_at ?? 'id');
      await save();
    } else if (k) {
      lease.sshKeyId = idAt(await ask(request, row, k, 'create', ctx), k);
      if (!ownedId(k, row, lease.sshKeyId)) throw new Error('The hosting service did not return the SSH key identity.');
      await save();
    }
    const created = at(await ask(request, row, s, 'create', k ? { ...ctx, [k.id_is]: lease.sshKeyId ?? lease.sharedSshKeyId } : ctx), s.created_at);
    lease.serverId = idAt(created, s);
    lease.address = at(created, s.address_at);
    if (!ownedId(s, row, lease.serverId) || !lease.address) throw new Error('The hosting service did not return the new server identity and address.');
    lease.state = 'running';
    await save();
    return lease;
  } catch (error) {
    // Retain exact cleanup ownership when the provider's answer is ambiguous; never delete a guessed resource.
    lease.state = 'creation-unknown';
    await save();
    if (!lease.serverId) {
      const named = await listed(), owned = named.filter(item => owns(item, s, row, ctx));
      if (named.length !== owned.length || owned.length > 1) throw new Error('The creation answer is uncertain; the saved lease retains cleanup ownership.');
      if (owned.length === 1) { lease.serverId = idAt(owned[0], s); lease.address = at(owned[0], s.address_at) ?? null; await save(); }
    }
    if (lease.serverId) await ask(request, row, s, 'remove', ctx, lease.serverId);
    if (lease.sshKeyId) await ask(request, row, k, 'remove', ctx, lease.sshKeyId);
    lease.state = 'removed';
    await save();
    throw error;
  }
}

/** provider: the hosting row the lease was made with (its receipt names it). */
export async function removeHostLease({ request, receipts, file, provider }) {
  const lease = await readHostLease(receipts, file);
  if (lease.state === 'removed') return lease;
  const row = provider, ctx = { ...row.placement, name: lease.name };
  for (const [part, id, what] of [[row.host, lease.serverId, 'server'], [row.access_key, lease.sshKeyId, 'SSH key']]) {
    if (!part || id == null) continue;
    const answer = await ask(request, row, part, 'read', ctx, id);
    if (answer.absent) continue;
    if (!owns(at(answer, part.found_at), part, row, ctx)) throw new Error(`The ${what} is no longer owned by this lease; it was left untouched.`);
    await ask(request, row, part, 'remove', ctx, id);
  }
  lease.state = 'removed';
  lease.removedAt = Date.now();
  await receipts.save(file, lease);
  return lease;
}

export async function watchHostLease({ request, receipts, file, provider, now = Date.now, wait = ms => new Promise(resolve => setTimeout(resolve, ms)), report = () => {} }) {
  for (;;) {
    const lease = await readHostLease(receipts, file);
    if (lease.state === 'removed') return lease;
    if (lease.lifetime === 'service') return lease;
    if (now() >= lease.expiresAt) {
      try { return await removeHostLease({ request, receipts, file, provider }); }
      catch (error) { report(error.message); await wait(30000); continue; }
    }
    await wait(Math.min(30000, lease.expiresAt - now()));
  }
}

/** The host as its provider sees it; an adopted machine remains the saved receipt. */
export async function readHostState({ request, receipts, file, provider }) {
  const lease = await readHostLease(receipts, file), row = provider;
  if (!row.base || lease.serverId == null) return { state: lease.state, address: lease.address };
  const answer = await ask(request, row, row.host, 'read', { ...row.placement, name: lease.name }, lease.serverId);
  if (answer.absent) return { state: 'absent', address: null };
  const found = at(answer, row.host.found_at);
  if (!owns(found, row.host, row, { name: lease.name })) throw new Error('The machine is no longer owned by this lease.');
  return { state: at(found, row.host.state_at ?? 'status') ?? 'unknown', address: at(found, row.host.address_at) ?? null };
}

/** The exact location's monthly price in cents, or a caller-supplied price for an adopted machine. */
export async function readPrice({ request, provider, placement = {} }) {
  const row = provider, spec = { ...row.placement, ...placement };
  if (!row.base) return Number.isSafeInteger(spec.monthly_price_cents) ? { cents: spec.monthly_price_cents, currency: spec.currency ?? null } : null;
  const p = row.price, prices = at(await ask(request, row, p, 'read', spec), p.list_at);
  const here = (Array.isArray(prices) ? prices : []).find(item => at(item, p.location_at) === spec.location);
  const monthly = Number(at(here, p.monthly_at));
  if (!here || !Number.isFinite(monthly)) throw new Error(`${row.name} has no monthly price for ${spec.size} at ${spec.location}.`);
  return { cents: Math.round(monthly * 100), currency: p.currency };
}

const named = (row, part, listed, key, value) => (Array.isArray(listed) ? listed : []).filter(item => at(item, part.name_at ?? key) === value);

/** Create one previously unused DNS name and retain the exact provider identity on the lease. */
export async function pointName({ request, receipts, file, provider, zone, hostName }) {
  const lease = await readHostLease(receipts, file), row = provider, z = row.zone, r = row.record;
  const ctx = { name: lease.name, zone, host_name: hostName, address: lease.address };
  if (lease.recordId && lease.hostName === hostName) return lease;
  const zones = named(row, z, at(await ask(request, row, z, 'find', ctx), z.list_at), 'name', zone);
  if (zones.length !== 1 || !ownedId(z, row, idAt(zones[0], z))) throw new Error(`${row.name} has no one zone named ${zone}.`);
  const zoneId = idAt(zones[0], z), inZone = { ...ctx, [z.id_is]: zoneId };
  const existing = named(row, r, at(await ask(request, row, r, 'find', inZone), r.list_at), 'name', hostName);
  if (existing.length) throw new Error(`${hostName} already points somewhere; it was left untouched.`);
  const created = at(await ask(request, row, r, 'create', inZone), r.created_at);
  if (!ownedId(r, row, idAt(created, r)) || at(created, r.address_at) !== lease.address) throw new Error(`${row.name} did not return the new record.`);
  Object.assign(lease, { names: row.id, zone, zoneId, hostName, recordId: idAt(created, r) });
  await receipts.save(file, lease);
  return lease;
}

/** Remove only a DNS record whose current ownership marker still matches this lease. */
export async function forgetName({ request, receipts, file, provider }) {
  const lease = await readHostLease(receipts, file);
  if (!lease.recordId) return lease;
  const row = provider, r = row.record;
  const ctx = { name: lease.name, zone: lease.zone, host_name: lease.hostName, [row.zone.id_is]: lease.zoneId };
  const answer = await ask(request, row, r, 'read', ctx, lease.recordId);
  if (!answer.absent) {
    if (!owns(at(answer, r.found_at), r, row, ctx)) throw new Error(`The record for ${lease.hostName} is no longer owned by this lease; it was left untouched.`);
    await ask(request, row, r, 'remove', ctx, lease.recordId);
  }
  Object.assign(lease, { recordId: null, nameRemovedAt: Date.now() });
  await receipts.save(file, lease);
  return lease;
}
