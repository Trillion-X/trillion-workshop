// tools/start-a-computer/do-work/rent-a-machine.mjs
//
// One machine lease, driven by a provider description the person supplies as a file (`readProvider`); the tool holds
// none. A machine description's `host` and `access_key` name which of its own `requests` find, create, read and remove
// a machine and its SSH key; its `price` names the request that reads the size's monthly price. A name description's
// `zone` and `record` do the same for one DNS name. A description with no `base` is a machine the person already runs:
// it is adopted at its address, and removing it forgets it without touching it. A description with a `pull` row is a
// machine nobody can reach from outside: renting it makes a one-time line (`pull.line`, with {token}) the person runs on
// that machine, which then dials out and registers (`registerMachine`); the lease waits until it does. A description with a `resize` job
// changes a running machine's size and keeps its disk (`resizeMachine`, run by do-work/resize-a-machine.mjs).
//
// Optional description fields: `lease_label_key` (the label every owned resource carries, required when there is a
// `base`), `async` (create answers before the machine runs: read it every `every_ms` until `state_at` is `ready_when`),
// `first_boot` ({format}: the first-boot text format the provider takes, given by the request as {format, text} and
// spliced into a body template as {first_boot}), `fingerprint` ({hash, encoding, prefix}: how the provider lists a stored
// public key), and `terms_url` (what the person is billed; shown with the price).
//
// Provider credentials arrive only as an in-memory argument. The lease file names the provider rows, their IDs, the
// address, size, start and cleanup deadline, never a credential. Creating, observing and removing use the same exact
// owned IDs, and nothing is deleted that does not carry this lease's own label. A provider that stores each public key
// once has the person's key found by its fingerprint and used as it is; the lease then never removes it.
import { readFileSync, writeFileSync, mkdirSync, renameSync } from 'node:fs';
import { dirname, isAbsolute } from 'node:path';
import { isIP } from 'node:net';
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { makeHashCodeHexFromBytes } from '../../content-identity/read-data/identity.mjs';

/** A provider description read from the file the person keeps it in; the lease keeps that path to read it again. */
export function readProvider(file) {
  if (typeof file !== 'string' || !isAbsolute(file)) throw new Error('A provider is the absolute path of its description file.');
  const row = JSON.parse(readFileSync(file, 'utf8'));
  if (typeof row?.id !== 'string' || typeof row.name !== 'string') throw new Error(`The provider description ${file} needs an id and a name.`);
  return { ...row, file };
}

/** The value at a dotted path ('' is the value itself; a number segment indexes an array). */
export const at = (value, path) => (path ? path.split('.').reduce((v, key) => v?.[key], value) : value);
/** A row template filled from ctx: "{x}" alone keeps x's type; inside text it is spliced in (by `splice`). */
export function fill(template, ctx, splice = String) {
  if (Array.isArray(template)) return template.map(item => fill(item, ctx, splice));
  if (template && typeof template === 'object') return Object.fromEntries(Object.entries(template).map(([k, v]) => [k.replace(/\{([a-z_]+)\}/gi, (_, key) => splice(String(ctx[key]))), fill(v, ctx, splice)]));
  if (typeof template !== 'string') return template;
  const whole = /^\{([a-z_]+)\}$/i.exec(template);
  return whole && splice === String ? ctx[whole[1]] : template.replace(/\{([a-z_]+)\}/gi, (_, key) => splice(String(ctx[key])));
}
const escape = text => text.replace(/[.*+?^$()|[\]\\]/g, '\\$&');
const parts = row => [row.host, row.access_key, row.price, row.zone, row.record, row.binding].filter(Boolean);
/** A step's request (host.create, record.read, ...) as { method, path relative to the row's base, body_template }. */
function step(row, part, name) {
  const asked = row.requests[part[name]];
  if (!asked?.url.startsWith(row.base)) throw new Error(`The ${row.name} row has no ${part[name] ?? name} request under ${row.base}.`);
  return { ...asked, path: asked.url.slice(row.base.length) };
}

// The calls a row declares, as [method, path pattern, names one resource?]; nothing else is sent. A part's own
// identity placeholder matches only its id_pattern; every other placeholder matches one path or query value.
function operations(row) {
  const ids = Object.fromEntries(parts(row).filter(p => p.id_is).map(p => [p.id_is, patternOf(row, p).replace(/^\^|\$$/g, '')]));
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
      method, headers: { [row.auth.header.toLowerCase()]: `${row.auth.prefix}${secret}`, ...(body ? { 'content-type': 'application/json' } : {}) },
      ...(body ? { body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(timeoutMs),
    });
    if (response.status === 404 && op[2]) return { absent: true };
    const text = await response.text();
    // A delete answered with no body at all (HTTP 204, or 200) is done; any other empty answer is not JSON.
    if (response.ok && method === 'DELETE' && text.trim() === '' && [200, 204].includes(response.status)) return {};
    let answer;
    try { answer = JSON.parse(text); } catch { throw new Error(`${row.name} answered HTTP ${response.status} without JSON.`); }
    if (!response.ok || (row.ok_at && at(answer, row.ok_at) !== true)) throw new Error(`${row.name} refused ${method} ${path.split('?')[0]} (HTTP ${response.status}, ${String(at(answer, row.error_code_at) ?? 'unknown').replace(/[^a-z0-9_-]/gi, '').slice(0, 80)}).`);
    return answer;
  };
}

/** A lease kept in one file (written whole, then renamed over it): a store is { read(), save(lease) }, read answering null when none is kept. */
export function fileStore(file) {
  return {
    async read() { try { return JSON.parse(readFileSync(file, 'utf8')); } catch (error) { if (error.code === 'ENOENT') return null; throw error; } },
    async save(lease) {
      mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
      const next = `${file}.next`;
      writeFileSync(next, `${JSON.stringify(lease, null, 2)}\n`, { mode: 0o600 });
      renameSync(next, file);
    },
  };
}
/** The lease a store keeps, or an error saying none is. */
export async function readLease(store) {
  const kept = await store.read();
  if (!kept) throw new Error('No lease is kept there.');
  return kept;
}

const ENCODINGS = { 'colon-hex': digest => digest.toString('hex').match(/../g).join(':'), hex: digest => digest.toString('hex'), base64: digest => digest.toString('base64').replace(/=+$/, '') };
/** The fingerprint of a public key line in the form the provider lists stored keys by (its `fingerprint`: hash, encoding, optional prefix). */
export function fingerprintOf(line, { hash, encoding, prefix = '' }) {
  if (!ENCODINGS[encoding]) throw new Error(`The fingerprint encoding ${JSON.stringify(encoding)} is not one of ${Object.keys(ENCODINGS).join(', ')}.`);
  return prefix + ENCODINGS[encoding](createHash(hash).update(Buffer.from(String(line).trim().split(/\s+/)[1] ?? '', 'base64')).digest());
}
const patternOf = (row, part) => part.id_pattern ?? row.host?.id_pattern ?? '^.+$';
const ownedId = (row, part, id) => id != null && new RegExp(patternOf(row, part)).test(String(id));
const idAt = (value, part) => at(value, part.id_at ?? 'id');
const owns = (value, part, ctx) => at(value, fill(part.owner_at, ctx)) === fill(part.owner_is ?? '{name}', ctx);
const ownCtx = (row, extra) => {
  if (row.base && typeof row.lease_label_key !== 'string') throw new Error(`The ${row.name} description needs a lease_label_key: the label every resource a lease owns carries.`);
  return { ...row.placement, lease_label_key: row.lease_label_key, ...extra };
};
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const tokenHash = token => makeHashCodeHexFromBytes(Buffer.from(token));
/** Send one of the row's steps, its path and body filled from ctx (the id under the part's own placeholder). */
export function ask(request, row, part, name, ctx, id) {
  const r = step(row, part, name), filled = id === undefined ? ctx : { ...ctx, [part.id_is]: id };
  return request(r.method, fill(r.path, filled, encodeURIComponent), r.body_template && fill(r.body_template, filled));
}
const named = (row, part, listed, key, value) => (Array.isArray(listed) ? listed : []).filter(item => at(item, part.name_at ?? key) === value);

export async function rentMachine({ request, store, name, publicKey, placement = {}, firstBoot, expiresAt, now = Date.now, wait = pause, provider }) {
  const row = provider, spec = { ...row.placement, ...placement };
  if (!/^[a-z][a-z0-9-]{1,60}$/.test(name) || (row.base ? !publicKey?.startsWith('ssh-ed25519 ') || !spec.size || !spec.location || !spec.image : !row.pull && isIP(spec.address ?? '') !== 4)) throw new Error('The machine lease configuration was refused.');
  const startedAt = now();
  if (expiresAt != null && (!Number.isSafeInteger(expiresAt) || expiresAt <= startedAt)) throw new Error('A cleanup deadline is a time in the future, in milliseconds.');
  if (firstBoot && (!row.base || row.first_boot?.format !== firstBoot.format || typeof firstBoot.text !== 'string')) throw new Error('The provider takes no first-boot text in that format.');
  let lease = await store.read();
  if (lease && lease.state !== 'removed') {
    if (lease.name !== name || lease.provider !== row.id || lease.serverType !== (spec.size ?? null) || lease.location !== (spec.location ?? null)) throw new Error('The saved lease names another placement.');
    return lease.state === 'waiting' ? waitForMachine(store, lease, row) : { ...lease, reused: true };
  }
  lease = { schema: 'machine-lease/1', provider: row.id, providerFile: row.file, name, serverType: spec.size ?? null, location: spec.location ?? null, image: spec.image ?? null, startedAt, expiresAt: expiresAt ?? null, state: 'creating', serverId: null, sshKeyId: null, address: null };
  // A machine the person already runs is adopted at its address; there is nothing to rent and nothing to delete later.
  if (row.pull) return waitForMachine(store, Object.assign(lease, { state: 'waiting', adopted: true }), row);
  if (!row.base) { Object.assign(lease, { state: 'running', address: spec.address, adopted: true }); await store.save(lease); return lease; }
  const base = ownCtx(row, { ...spec, name, public_key: publicKey.trim(), ...(row.fingerprint && { fingerprint: fingerprintOf(publicKey, row.fingerprint) }), ...(firstBoot && { first_boot: firstBoot.text }) }), ctx = { ...base, ...fill(row.fill ?? {}, base) }, s = row.host, k = row.access_key;
  const listed = async () => named(row, s, at(await ask(request, row, s, 'find', ctx), s.list_at), 'name', name);
  if ((await listed()).length) throw new Error('A machine with this name already exists without this lease; it was left untouched.');
  await store.save(lease);
  try {
    const stored = k?.find ? at(await ask(request, row, k, 'find', ctx), k.list_at) : [];
    if (stored?.length) {
      if (stored.length !== 1 || !ownedId(row, k, at(stored[0], k.list_id_at ?? 'id'))) throw new Error('The stored SSH key identity is ambiguous or invalid.');
      lease.sharedSshKeyId = at(stored[0], k.list_id_at ?? 'id');
      await store.save(lease);
    }
    else if (k) {
      lease.sshKeyId = idAt(await ask(request, row, k, 'create', ctx), k);
      if (!ownedId(row, k, lease.sshKeyId)) throw new Error(`${row.name} did not return the SSH key identity.`);
      await store.save(lease);
    }
    const created = at(await ask(request, row, s, 'create', k ? { ...ctx, [k.id_is]: lease.sshKeyId ?? lease.sharedSshKeyId } : ctx), s.created_at);
    lease.serverId = idAt(created, s);
    lease.address = at(created, s.address_at);
    if (!ownedId(row, s, lease.serverId)) throw new Error(`${row.name} did not return the new machine's identity.`);
    if (row.async) {
      await store.save(lease);
      for (let tries = 0; !(at(at(await ask(request, row, s, 'read', ctx, lease.serverId), s.found_at), s.state_at) === row.async.ready_when); tries += 1) {
        if (tries >= (row.async.tries ?? 60)) throw new Error(`${row.name} did not report the machine ready.`);
        await wait(row.async.every_ms ?? 5000);
      }
      lease.address = at(at(await ask(request, row, s, 'read', ctx, lease.serverId), s.found_at), s.address_at);
    }
    if (!lease.address) throw new Error(`${row.name} did not return the new machine's address.`);
    lease.state = 'running';
    await store.save(lease);
    return lease;
  } catch (error) {
    // Retain exact cleanup ownership when the provider's answer is ambiguous; never delete a guessed resource.
    lease.state = 'creation-unknown';
    await store.save(lease);
    if (!lease.serverId) {
      const same = await listed(), owned = same.filter(item => owns(item, s, ctx));
      if (same.length !== owned.length || owned.length > 1) throw new Error('The creation answer is uncertain; the saved lease retains cleanup ownership.');
      if (owned.length === 1) { lease.serverId = idAt(owned[0], s); lease.address = at(owned[0], s.address_at) ?? null; await store.save(lease); }
    }
    if (lease.serverId) await ask(request, row, s, 'remove', ctx, lease.serverId);
    if (lease.sshKeyId) await ask(request, row, k, 'remove', ctx, lease.sshKeyId);
    lease.state = 'removed';
    await store.save(lease);
    throw error;
  }
}

/** A machine nobody can reach from outside: the lease waits with the hash of a one-time token, and the person runs the line
 * the description gives (`pull.line`, with {token} and {name}) on that machine, which dials out and registers. The line is
 * given once and never kept; renting again while the lease waits makes a new one. */
async function waitForMachine(store, lease, row) {
  const token = randomBytes(24).toString('hex');
  lease.tokenHash = tokenHash(token);
  await store.save(lease);
  return { ...lease, line: fill(row.pull.line, { token, name: lease.name }) };
}

/** The machine that ran the line registers: the token matches, and the lease now names its address. */
export async function registerMachine({ store, token, address }) {
  const lease = await readLease(store);
  if (lease.state !== 'waiting' || !lease.tokenHash) throw new Error('This lease is not waiting for a machine.');
  const given = Buffer.from(tokenHash(String(token))), kept = Buffer.from(lease.tokenHash);
  if (given.length !== kept.length || !timingSafeEqual(given, kept) || isIP(address ?? '') === 0) throw new Error('The registration was refused.');
  Object.assign(lease, { state: 'running', address, tokenHash: null, registeredAt: Date.now() });
  await store.save(lease);
  return lease;
}

/** The machine as the provider sees it now: { state, address }, or { state: 'absent' }; an adopted one is as saved. */
export async function readMachine({ request, store, provider }) {
  const lease = await readLease(store), row = provider ?? readProvider(lease.providerFile);
  if (!row.base || lease.serverId == null) return { state: lease.state, address: lease.address };
  const answer = await ask(request, row, row.host, 'read', ownCtx(row, { name: lease.name }), lease.serverId);
  if (answer.absent) return { state: 'absent', address: null };
  const found = at(answer, row.host.found_at);
  if (!owns(found, row.host, ownCtx(row, { name: lease.name }))) throw new Error('The machine is no longer owned by this lease.');
  return { state: at(found, row.host.state_at ?? 'status') ?? 'unknown', address: at(found, row.host.address_at) ?? null };
}

export async function releaseMachine({ request, store, provider }) {
  const lease = await readLease(store);
  if (lease.state === 'removed') return lease;
  const row = provider ?? readProvider(lease.providerFile), ctx = ownCtx(row, { name: lease.name });
  for (const [part, id, what] of [[row.host, lease.serverId, 'machine'], [row.access_key, lease.sshKeyId, 'SSH key']]) {
    if (!part || id == null) continue;
    const answer = await ask(request, row, part, 'read', ctx, id);
    if (answer.absent) continue;
    if (!owns(at(answer, part.found_at), part, ctx)) throw new Error(`The ${what} is no longer owned by this lease; it was left untouched.`);
    await ask(request, row, part, 'remove', ctx, id);
  }
  lease.state = 'removed';
  lease.removedAt = Date.now();
  await store.save(lease);
  return lease;
}

/** The size's monthly price at the lease's location: { cents, currency }, or null when the row reads none. */
export async function readPrice({ request, provider, placement = {} }) {
  const row = provider, spec = { ...row.placement, ...placement };
  if (!row.base) return Number.isSafeInteger(spec.monthly_price_cents) ? { cents: spec.monthly_price_cents, currency: spec.currency ?? null } : null;
  const p = row.price, prices = at(await ask(request, row, p, 'read', spec), p.list_at);
  const here = (Array.isArray(prices) ? prices : []).find(item => at(item, p.location_at) === spec.location);
  const monthly = Number(at(here, p.monthly_at));
  if (!here || !Number.isFinite(monthly)) throw new Error(`${row.name} has no monthly price for ${spec.size} at ${spec.location}.`);
  return { cents: Math.round(monthly * 100), currency: p.currency };
}

/** Change a running machine to another size of its provider, keeping its disk (the row's `resize` job). A machine already at
 * `size` answers unchanged; both sizes' monthly prices are read before anything changes. The machine is powered off, its type
 * changed in place and powered on, each action awaited within the row's bounds. The power-on is asked for once the power-off is
 * (even after a failure), and an error says what the machine reads back as. `keep_disk` must be true: a disk upgrade cannot be
 * undone. Answers { from, to, price_from, price_to, off_at, on_at, seconds_down, status }. */
export async function resizeMachine({ request, store, provider, size, keep_disk = true, dry_run = false, wait = pause, now = Date.now }) {
  const lease = await readLease(store), row = provider ?? readProvider(lease.providerFile), r = row.resize;
  if (!row.base || !r) throw new Error(`The ${row.name} description has no resize job, so it cannot change a machine's size.`);
  if (!Number.isSafeInteger(r.tries) || !Number.isSafeInteger(r.every_ms)) throw new Error(`The ${row.name} resize job needs whole-number tries and every_ms.`);
  if (keep_disk !== true) throw new Error('A resize keeps its disk: an upgrade of the disk cannot be undone, so it is refused.');
  if (typeof size !== 'string' || !/^[a-z0-9][a-z0-9-]{0,40}$/.test(size)) throw new Error("A size is the provider's size name, such as cx23.");
  if (lease.state !== 'running' || lease.serverId == null) throw new Error('Only a running machine can be resized.');
  const ctx = ownCtx(row, { name: lease.name }), id = lease.serverId;
  const readServer = async () => {
    const answer = await ask(request, row, row.host, 'read', ctx, id);
    if (answer.absent) throw new Error('The machine is gone; it cannot be resized.');
    const found = at(answer, row.host.found_at);
    if (!owns(found, row.host, ctx)) throw new Error('The machine is no longer owned by this lease; it was left untouched.');
    return { type: at(found, r.type_at), status: at(found, row.host.state_at) };
  };
  const before = await readServer();
  if (before.type === size) return { unchanged: true, from: size, to: size };
  if (typeof before.type !== 'string') throw new Error(`${row.name} did not name the machine's size.`);
  if (before.status !== r.running_state) throw new Error(`The machine is ${before.status}; a resize needs it ${r.running_state}.`);
  const location = lease.location;
  const price_from = await readPrice({ request, provider: row, placement: { size: before.type, location } });
  const price_to = await readPrice({ request, provider: row, placement: { size, location } });
  // A dry run stops here: nothing is powered off or changed, and the answer is what the resize would read.
  if (dry_run) return { dry_run: true, from: before.type, to: size, price_from, price_to, status: before.status };
  // Each step is asked (its action id answered), then its action is polled: at most `tries` polls after the first, `every_ms` apart.
  const act = async (name, extra) => at(await ask(request, row, r.steps, name, { ...ctx, ...extra }, id), r.action_at);
  const awaitAction = async actionId => {
    for (let tries = 0; ; tries += 1) {
      const status = at(await ask(request, row, r.steps, 'action', { ...ctx, action_id: actionId }), r.status_at);
      if (status === r.action_words.done) return;
      if (status === r.action_words.failed) throw new Error(`${row.name} action ${actionId} ended in error.`);
      if (tries >= r.tries) throw new Error(`${row.name} action ${actionId} was still ${status} after ${r.tries} checks.`);
      await wait(r.every_ms);
    }
  };
  let failure = null, offAt = null;
  try {
    await awaitAction(await act('power_off'));
    offAt = now();
    await awaitAction(await act('change_type', { server_type: size }));
  } catch (error) { failure = error; }
  // Any failure above may have left the machine down, so the power-on is always asked for (refused, harmlessly, if it is up).
  let onAt = null, onError = null;
  try { await awaitAction(await act('power_on')); onAt = now(); }
  catch (error) { onError = error; }
  let state = null, stateError = null;
  try { state = await readServer(); } catch (error) { stateError = error; }
  if (state?.type && state.type !== lease.serverType) { lease.serverType = state.type; await store.save(lease); }
  const failed = [failure, stateError, onError].filter(Boolean);
  if (failed.length || state.type !== size || state.status !== r.running_state) {
    const why = failed.length ? failed.map(error => error.message).join(' ') : `It reads ${state.type} ${state.status}, not ${size} ${r.running_state}.`;
    throw new Error(`The resize of ${lease.name} to ${size} did not finish: ${why} ${onError ? 'Power-on failed.' : 'Power-on was sent and done.'} The machine reads ${state ? `${state.type} ${state.status}` : 'unknown'}.`);
  }
  return { from: before.type, to: size, price_from, price_to, off_at: new Date(offAt).toISOString(), on_at: new Date(onAt).toISOString(), seconds_down: (onAt - offAt) / 1000, status: state.status };
}

/** Point host_name at the lease's address through a names row, keeping the record's identity on the lease. */
export async function pointName({ request, store, provider, zone, hostName }) {
  const lease = await readLease(store), row = provider, z = row.zone, r = row.record;
  const ctx = ownCtx(row, { name: lease.name, zone, host_name: hostName, address: lease.address });
  if (lease.recordId && lease.hostName === hostName) return lease;
  const zones = named(row, z, at(await ask(request, row, z, 'find', ctx), z.list_at), 'name', zone);
  if (zones.length !== 1 || !ownedId(row, z, idAt(zones[0], z))) throw new Error(`${row.name} has no one zone named ${zone}.`);
  const zoneId = idAt(zones[0], z), inZone = { ...ctx, [z.id_is]: zoneId };
  const existing = named(row, r, at(await ask(request, row, r, 'find', inZone), r.list_at), 'name', hostName);
  if (existing.length) throw new Error(`${hostName} already points somewhere; it was left untouched.`);
  const created = at(await ask(request, row, r, 'create', inZone), r.created_at);
  if (!ownedId(row, r, idAt(created, r)) || at(created, r.address_at) !== lease.address) throw new Error(`${row.name} did not return the new record.`);
  Object.assign(lease, { names: row.id, namesFile: row.file, zone, zoneId, hostName, recordId: idAt(created, r) });
  await store.save(lease);
  return lease;
}

export async function forgetName({ request, store, provider }) {
  const lease = await readLease(store);
  if (!lease.recordId) return lease;
  const row = provider ?? readProvider(lease.namesFile), r = row.record;
  const ctx = ownCtx(row, { name: lease.name, zone: lease.zone, host_name: lease.hostName, [row.zone.id_is]: lease.zoneId });
  const answer = await ask(request, row, r, 'read', ctx, lease.recordId);
  if (!answer.absent) {
    if (!owns(at(answer, r.found_at), r, ctx)) throw new Error(`The record for ${lease.hostName} is no longer owned by this lease; it was left untouched.`);
    await ask(request, row, r, 'remove', ctx, lease.recordId);
  }
  Object.assign(lease, { recordId: null, nameRemovedAt: Date.now() });
  await store.save(lease);
  return lease;
}

export async function watchLease({ request, store, provider, now = Date.now, wait = ms => new Promise(resolve => setTimeout(resolve, ms)), report = () => {} }) {
  for (;;) {
    const lease = await readLease(store);
    if (lease.state === 'removed') return lease;
    if (lease.expiresAt == null) return lease;
    if (now() >= lease.expiresAt) {
      try { return await releaseMachine({ request, store, provider }); }
      catch (error) { report(error.message); await wait(30000); continue; }
    }
    await wait(Math.min(30000, lease.expiresAt - now()));
  }
}
