// tools/move-the-public-door/do-work/portable-dns-cutover.mjs
//
// Exact-host DNS placement owner. Credentials remain in the vault; unrelated records and guarded lists are preserved.
// The DNS provider is a description the person supplies (the file the person keeps, handed in as `provider`): its base,
// auth header, vault name and the requests it declares, with the parts that say which request does what:
//   zone    { find, list_at, id_is, id_pattern, id_at, account_at, guards: [{ request, list_at }] }
//           find a zone by name; its account; lists that must not change while a cutover runs (routes and the like)
//   record  { list, list_at, pages_at?, create, create_given, update, remove, id_is, id_pattern, id_at, name_at, type_at,
//             content_at, address_types, editable_types, fields, desired, read_only_at?, binding_at?, owner_at, owner_is }
//           `desired` is what a placement writes into the record ({host_name}, {address} filled); `fields` are the keys
//           compared; `create` makes one more record of a health-checked set (its body carries the owner mark); `create_given`
//           and `update` send the record body as given ({record_body})
//   binding { list, list_at, id_is, id_pattern, host_at, fields, restore_fields, require?, create (restore), remove }
//           an optional provider-held binding that owns a read-only record (a name served by a hosted program); the
//           cutover removes it, makes the plain record, and puts the binding back on rollback
// Nothing here names a provider. The receipt is held in the run (read-data/door-receipts.mjs keptReceipts) and answered; it
// is saved before every mutation.
import { isIP } from 'node:net';
import https from 'node:https';
import { at, fill, ask, providerClient } from '../../start-a-computer/do-work/rent-a-machine.mjs';

/** provider: the DNS provider description whose base and auth header this uses. */
export function dnsClient(token, { fetchImpl = fetch, provider }) {
  if (!provider?.base || !provider.auth) throw Error('The DNS client needs its DNS provider description.');
  if (typeof token !== 'string' || !/^[A-Za-z0-9_-]{20,256}$/.test(token)) throw Error('The held DNS credential was refused.');
  return providerClient(provider, token, { fetchImpl, timeoutMs: 30000 });
}

const checked = c => {
  if (!/^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/.test(c.hostname) || isIP(c.address) !== 4) throw Error('The exact DNS placement was refused.');
};
const keys = provider => provider.record.fields;
const shape = (provider, row) => Object.fromEntries(keys(provider).map(key => [key, row[key]]));
const equal = (provider, a, b) => JSON.stringify(shape(provider, a)) === JSON.stringify(shape(provider, b));
/** Whether `row` carries every key of `want` with the same value. */
const has = (row, want) => Object.keys(want).every(key => JSON.stringify(row[key]) === JSON.stringify(want[key]));
const stable = (rows, project = x => x) => JSON.stringify(rows.map(project).sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b))));
const nameOf = (provider, row) => at(row, provider.record.name_at ?? 'name');
const typeOf = (provider, row) => at(row, provider.record.type_at ?? 'type');
const contentOf = (provider, row) => at(row, provider.record.content_at ?? 'content');
const idOf = (part, row) => at(row, part.id_at ?? 'id');
const addressRows = (provider, state, hostname) => state.records.filter(row => nameOf(provider, row) === hostname && provider.record.address_types.includes(typeOf(provider, row)));

async function pages(request, provider, ctx) {
  const part = provider.record, result = [];
  for (let page = 1; ; page += 1) {
    const answer = await ask(request, provider, part, 'list', { ...ctx, page });
    result.push(...at(answer, part.list_at));
    if (!part.pages_at || page >= (at(answer, part.pages_at) ?? 1)) return result;
  }
}
async function snapshot(c, request, provider, zone, account) {
  const z = provider.zone, labels = c.hostname.split('.');
  if (!zone) {
    for (let n = 0; n < labels.length - 1 && !zone; n += 1) {
      const found = at(await ask(request, provider, z, 'find', { zone: labels.slice(n).join('.') }), z.list_at);
      if (found.length === 1) { zone = idOf(z, found[0]); account = z.account_at ? at(found[0], z.account_at) : undefined; }
    }
  }
  if (!new RegExp(z.id_pattern).test(zone ?? '')) throw Error('The exact DNS zone was not found.');
  const ctx = { zone_id: zone, account_id: account };
  const guards = [];
  for (const guard of z.guards ?? []) guards.push(at(await ask(request, provider, guard, 'request', ctx), guard.list_at));
  const bindings = provider.binding ? at(await ask(request, provider, provider.binding, 'list', ctx), provider.binding.list_at) : [];
  return { zone, account, records: await pages(request, provider, ctx), guards, bindings };
}

/** The cutover receipt `file` names, or an error saying none is kept under that name. */
export async function readCutover(receipts, file) {
  const receipt = await receipts.read(file);
  if (!receipt) throw Error(`No DNS cutover is kept as ${JSON.stringify(file)}.`);
  return receipt;
}
export async function prepareCutover(c, { request, provider, receipts, file }) {
  checked(c);
  const old = await receipts.read(file);
  if (old) { if (old.hostname !== c.hostname || old.address !== c.address) throw Error('Saved cutover belongs to another placement.'); return old; }
  const p = provider.record, b = provider.binding, before = await snapshot(c, request, provider);
  const targets = addressRows(provider, before, c.hostname);
  const binding = b && before.bindings.find(x => at(x, b.host_at) === c.hostname);
  const required = Object.entries(b?.require ?? {});
  const managed = Boolean(binding) && targets.length === 1 && Boolean(at(targets[0], p.read_only_at)) && idOf(b, binding) === at(targets[0], p.binding_at) && required.every(([key, value]) => binding[key] === value);
  // A name with no address record and no binding is placed new: activate makes its one record, rollback removes that record.
  const placed = targets.length === 0 && !binding;
  if (!placed && (targets.length !== 1 || (!managed && !p.editable_types.includes(typeOf(provider, targets[0]))))) throw Error('Cutover requires no address record at the name, one editable address record, or its exact managed binding; no records were changed.');
  const receipt = { schema: 'portable-dns-cutover/2', hostname: c.hostname, address: c.address, state: 'prepared', mode: placed ? 'new-record' : managed ? 'managed-binding' : 'record', originalBinding: managed ? binding : undefined, before, targetId: placed ? null : idOf(p, targets[0]), desired: fill(p.desired, { host_name: c.hostname, address: c.address, lease_label_key: provider.lease_label_key }) };
  return receipts.save(file, receipt);
}
export async function changeCutover(c, { request, provider, receipts, file, rollback = false }) {
  checked(c); const receipt = await readCutover(receipts, file);
  const save = () => receipts.save(file, receipt), p = provider.record;
  if (receipt.hostname !== c.hostname || receipt.address !== c.address) throw Error('Saved cutover belongs to another placement.');
  if (receipt.mode === 'managed-binding') return changeManagedBinding(c, { request, provider, save, receipt, rollback });
  if (receipt.mode === 'new-record') return changeNewRecord(c, { request, provider, save, receipt, rollback });
  const current = await snapshot(c, request, provider, receipt.before.zone, receipt.before.account), original = receipt.before.records.find(x => idOf(p, x) === receipt.targetId), row = current.records.find(x => idOf(p, x) === receipt.targetId);
  const expected = rollback ? receipt.afterTarget : original;
  const keysOf = Object.keys(receipt.desired), pick = value => Object.fromEntries(keysOf.map(key => [key, value[key]]));
  const want = rollback ? pick(original) : receipt.desired, sent = rollback ? shape(provider, original) : { ...shape(provider, original), ...receipt.desired };
  if (!row) throw Error('The owned DNS record disappeared; no mutation was made.');
  const foreign = current.records.filter(x => idOf(p, x) !== receipt.targetId), previous = receipt.before.records.filter(x => idOf(p, x) !== receipt.targetId);
  if (JSON.stringify(foreign.map(x => shape(provider, x))) !== JSON.stringify(previous.map(x => shape(provider, x))) || JSON.stringify(current.guards) !== JSON.stringify(receipt.before.guards)) throw Error('Unrelated DNS records or guarded lists changed; preserve the current state and investigate.');
  if (!has(row, want) && (!expected || !equal(provider, row, expected))) throw Error('The owned record changed since preparation; no mutation was made.');
  if (!has(row, want)) {
    receipt.state = rollback ? 'rollback-changing' : 'changing'; await save();
    const body = { ...sent }; delete body[p.id_at ?? 'id'];
    await ask(request, provider, p, 'update', { zone_id: current.zone, record_body: body }, receipt.targetId);
  }
  const after = await snapshot(c, request, provider, current.zone, current.account), actual = after.records.find(x => idOf(p, x) === receipt.targetId);
  if (!actual || !has(actual, want)) throw Error('DNS mutation needs readback reconciliation; rollback source retained.');
  if (JSON.stringify(after.records.filter(x => idOf(p, x) !== receipt.targetId).map(x => shape(provider, x))) !== JSON.stringify(previous.map(x => shape(provider, x))) || JSON.stringify(after.guards) !== JSON.stringify(receipt.before.guards)) throw Error('DNS mutation readback found unrelated changes; rollback source retained.');
  receipt.state = rollback ? 'rolled-back' : 'active'; if (!rollback) receipt.afterTarget = actual;
  return save();
}

/** A name placed new: every record but this name's own must stay as it was, and the guarded lists too. Activate makes the one
 * desired record when the name holds none (a lost answer is found again by readback, never made twice); rollback removes the
 * record activate made, only while it is still exactly that record. */
async function changeNewRecord(c, { request, provider, save, receipt, rollback }) {
  const before = receipt.before, p = provider.record;
  const preserved = state => {
    const other = state.records.filter(x => nameOf(provider, x) !== c.hostname || !p.address_types.includes(typeOf(provider, x)));
    const old = before.records.filter(x => nameOf(provider, x) !== c.hostname || !p.address_types.includes(typeOf(provider, x)));
    if (stable(other, x => shape(provider, x)) !== stable(old, x => shape(provider, x)) || JSON.stringify(state.guards) !== JSON.stringify(before.guards)) throw Error('Unrelated DNS records or guarded lists changed; preserve the current state and investigate.');
  };
  const current = await snapshot(c, request, provider, before.zone, before.account); preserved(current);
  const here = addressRows(provider, current, c.hostname);
  if (rollback) {
    if (here.length) {
      if (here.length !== 1 || !has(here[0], receipt.desired) || (receipt.afterTarget && idOf(p, here[0]) !== idOf(p, receipt.afterTarget))) throw Error('The placed DNS record changed; rollback refused.');
      receipt.state = 'rollback-removing-address'; await save();
      await ask(request, provider, p, 'remove', { zone_id: before.zone }, idOf(p, here[0]));
    }
  } else if (!here.length) {
    receipt.state = 'creating-address'; await save();
    const answer = await ask(request, provider, p, 'create_given', { zone_id: before.zone, record_body: receipt.desired });
    receipt.afterTarget = at(answer, p.created_at ?? 'result'); await save();
  } else if (here.length !== 1 || !has(here[0], receipt.desired)) throw Error('The name holds an address record that is not the placed one; no mutation was made.');
  const after = await snapshot(c, request, provider, before.zone, before.account); preserved(after);
  const now = addressRows(provider, after, c.hostname);
  if (rollback ? now.length : (now.length !== 1 || !has(now[0], receipt.desired))) throw Error('DNS placement needs readback reconciliation; the receipt is kept.');
  if (!rollback) receipt.afterTarget = now[0];
  receipt.state = rollback ? 'rolled-back' : 'active'; return save();
}

async function changeManagedBinding(c, { request, provider, save, receipt, rollback }) {
  const before = receipt.before, p = provider.record, b = provider.binding, ctx = { zone_id: before.zone, account_id: before.account };
  const mine = state => addressRows(provider, state, c.hostname);
  const bindingOf = state => state.bindings.find(x => at(x, b.host_at) === c.hostname);
  const bshape = row => row && Object.fromEntries(b.fields.map(key => [key, row[key]]));
  function preserved(state) {
    const other = state.records.filter(x => !mine(state).includes(x)), old = before.records.filter(x => idOf(p, x) !== receipt.targetId);
    if (stable(other, x => shape(provider, x)) !== stable(old, x => shape(provider, x)) || JSON.stringify(state.guards) !== JSON.stringify(before.guards) || stable(state.bindings.filter(x => at(x, b.host_at) !== c.hostname)) !== stable(before.bindings.filter(x => at(x, b.host_at) !== c.hostname))) throw Error('Unrelated DNS, bindings or guarded lists changed; no further mutation was made.');
  }
  let current = await snapshot(c, request, provider, before.zone, before.account); preserved(current);
  let binding = bindingOf(current), target = mine(current);
  const original = before.records.find(x => idOf(p, x) === receipt.targetId);
  if (binding && JSON.stringify(bshape(binding)) !== JSON.stringify(bshape(receipt.originalBinding))) throw Error('The selected binding changed; no mutation was made.');
  if (rollback) {
    if (target.length && !binding) {
      if (target.length !== 1 || !has(target[0], receipt.desired) || (receipt.afterTarget && !equal(provider, target[0], receipt.afterTarget))) throw Error('The direct DNS record changed; rollback refused.');
      receipt.state = 'rollback-removing-address'; await save();
      await ask(request, provider, p, 'remove', { zone_id: before.zone }, idOf(p, target[0]));
    }
    if (!binding) {
      receipt.state = 'rollback-attaching-binding'; await save();
      const body = Object.fromEntries(b.restore_fields.map(key => [key, receipt.originalBinding[key]]));
      await ask(request, provider, b, 'create', { ...ctx, binding_body: body });
    }
  } else {
    if (binding) {
      if (target.length !== 1 || !equal(provider, target[0], original)) throw Error('The managed DNS record changed; no mutation was made.');
      receipt.state = 'removing-binding'; await save();
      await ask(request, provider, b, 'remove', ctx, idOf(b, binding));
      current = await snapshot(c, request, provider, before.zone, before.account); preserved(current); target = mine(current);
      if (bindingOf(current)) throw Error('Binding removal awaits readback; original state retained.');
    }
    if (target.length && (target.length !== 1 || !has(target[0], receipt.desired))) throw Error('A selected-host address remains after binding removal; original state retained.');
    if (!target.length) {
      receipt.state = 'creating-address'; await save();
      const answer = await ask(request, provider, p, 'create_given', { zone_id: before.zone, record_body: receipt.desired });
      receipt.afterTarget = at(answer, p.created_at ?? 'result'); await save();
    }
  }
  const after = await snapshot(c, request, provider, before.zone, before.account); preserved(after);
  binding = bindingOf(after); target = mine(after);
  const restored = Boolean(binding) && JSON.stringify(bshape(binding)) === JSON.stringify(bshape(receipt.originalBinding)) && target.length === 1 && contentOf(provider, target[0]) === contentOf(provider, original) && typeOf(provider, target[0]) === typeOf(provider, original);
  const direct = !binding && target.length === 1 && has(target[0], receipt.desired);
  if (rollback ? !restored : !direct) throw Error('Selected-host mutation needs readback reconciliation; original state retained.');
  if (!rollback) receipt.afterTarget = target[0];
  receipt.state = rollback ? 'rolled-back' : 'active'; return save();
}

/** The addresses `hostname` answers with now, sorted; reads only. */
export async function addressesOfName({ hostname, request, provider }) {
  checked({ hostname, address: '192.0.2.1' });
  return addressRows(provider, await snapshot({ hostname }, request, provider), hostname).map(row => contentOf(provider, row)).sort();
}

/** One health probe: an HTTPS GET of `path` at `address`, with the hostname as the name asked for (its certificate and
 * Host), answers true on HTTP 200. `requestImpl` is for tests. */
export function probeHealthy({ hostname, address, path = '/', timeoutMs = 10000, requestImpl = https.request }) {
  return new Promise(resolve => {
    const req = requestImpl({ host: address, servername: hostname, headers: { host: hostname }, path, method: 'GET', timeout: timeoutMs }, res => { res.resume(); resolve(res.statusCode === 200); });
    req.on('timeout', () => { req.destroy(); resolve(false); });
    req.on('error', () => resolve(false));
    req.end();
  });
}

/** Keep one hostname answering with exactly the front-door computers that pass their health check: `candidates` are
 * { address, health_path? }; `check(candidate)` answers true when that computer is healthy. Healthy addresses missing
 * from the name are added first, then unhealthy ones this call owns are removed, so the name is never empty; when no
 * candidate is healthy nothing changes and the call refuses. A record at the name that this set does not own is left
 * untouched and refused unless `adopt` says the existing address records are this set's. */
export async function keepHealthyRecords({ hostname, candidates, check, request, provider, adopt = false }) {
  const p = provider.record, owner = { lease_label_key: provider.lease_label_key, name: hostname };
  checked({ hostname, address: '192.0.2.1' });
  if (!Array.isArray(candidates) || !candidates.length || candidates.some(x => isIP(x?.address) !== 4)) throw Error('Give the front-door computers as { address } rows with public IPv4 addresses.');
  const health = await Promise.all(candidates.map(async candidate => ({ candidate, healthy: Boolean(await check(candidate)) })));
  const healthy = health.filter(x => x.healthy).map(x => x.candidate.address);
  if (!healthy.length) throw Error('No front-door computer is healthy; the name was left as it is.');
  const state = await snapshot({ hostname }, request, provider), here = addressRows(provider, state, hostname);
  const ownedHere = row => adopt || (p.owner_at && at(row, p.owner_at) === fill(p.owner_is, owner));
  const foreign = here.filter(row => !ownedHere(row));
  if (foreign.length) throw Error(`${hostname} already holds ${foreign.length} address record(s) this set does not own; they were left untouched (adopt them to take the name over).`);
  const sameType = row => typeOf(provider, row) === 'A';
  const mine = here.filter(sameType);
  if (here.length !== mine.length) throw Error(`${hostname} holds an address record that is not an A record; it was left untouched.`);
  const have = new Set(mine.map(row => contentOf(provider, row)));
  const added = [], removed = [];
  for (const address of healthy) if (!have.has(address)) {
    const answer = await ask(request, provider, p, 'create', { zone_id: state.zone, host_name: hostname, address, ...owner });
    added.push({ address, id: idOf(p, at(answer, p.created_at ?? 'result')) });
  }
  for (const row of mine) if (!healthy.includes(contentOf(provider, row))) {
    await ask(request, provider, p, 'remove', { zone_id: state.zone }, idOf(p, row));
    removed.push({ address: contentOf(provider, row), id: idOf(p, row) });
  }
  const after = addressRows(provider, await snapshot({ hostname }, request, provider, state.zone, state.account), hostname).map(row => contentOf(provider, row)).sort();
  if (JSON.stringify(after) !== JSON.stringify([...healthy].sort())) throw Error('The name does not answer with the healthy computers after the change; read it back and investigate.');
  return { hostname, healthy, unhealthy: health.filter(x => !x.healthy).map(x => x.candidate.address), added, removed };
}
