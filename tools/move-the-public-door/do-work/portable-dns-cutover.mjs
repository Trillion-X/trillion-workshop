// tools/move-the-public-door/do-work/portable-dns-cutover.mjs
//
// Exact-host DNS placement owner. Credentials remain in the vault; unrelated records and guarded lists are preserved.
// The DNS provider is a description the person supplies (the file the person keeps, handed in as `provider`): its base,
// auth header, vault name and the requests it declares, with the parts that say which request does what:
//   zone    { find, list_at, id_is, id_pattern, id_at, account_at, guards: [{ request, list_at }] }
//           find a zone by name; its account; lists that must not change while a cutover runs (routes and the like)
//   record  { list, list_at, pages_at?, create, create_given, update, remove, id_is, id_pattern, id_at, name_at, type_at,
//             content_at, content_at_by_type?, address_types, editable_types, fields, desired, read_only_at?, binding_at?,
//             owner_at, owner_is, omitted_at? }
//           `content_at_by_type` names the key a type's content sits under where it is not `content_at` (a CNAME's target, say);
//           `omitted_at` is the list a list answer carries beside its items: records the typed contract cannot represent, each
//           { type, name }, which no remove call can name, so an adopt reports them as unremovable.
//           `desired` is what a placement writes into the record ({host_name}, {address} filled); `fields` are the keys
//           compared; `create` makes one more record of a health-checked set (its body carries the owner mark); `create_given`
//           and `update` send the record body as given ({record_body})
//   binding { list, list_at, id_is, id_pattern, host_at, fields, restore_fields, require?, create (restore), remove }
//           an optional provider-held binding that owns a read-only record (a name served by a hosted program); the
//           cutover removes it, makes the plain record, and puts the binding back on rollback
//   Two more shapes a provider may take, both optional:
//   transport "engine"  the provider is an MCP server reached through the engine: each request's body_template is { name,
//                     arguments } naming one of its tools; it is sent as the engine's tools:run of `<host>/<name>` at the
//                     description's base (the engine signs in and refreshes the connection, so no credential is held here).
//                     The result is the tool's structuredContent (or its text, parsed as JSON); an error or isError refuses.
//   zone.name_relative  the zone id is the zone's domain name and records name hosts relative to it ('@' is the apex): a
//                     record's name is read back as the full hostname, and `{host_label}` in a body is the relative name.
//   record.id_is_fields  the provider keeps no record ids: a record is removed by the keys named (its record body), and
//                     record.owner_by "address" makes a record this set owns when its address is one of the candidates.
//                     The owner mark (owner_at / owner_is) is kept for providers that have one.
//   record.page_size  a list is read a page at a time by skip and take ({skip}, {take} in the request), until a page is short.
// Nothing here names a provider. The receipt is held in the run (read-data/door-receipts.mjs keptReceipts) and answered; it
// is saved before every mutation.
import { isIP } from 'node:net';
import https from 'node:https';
import { at, fill, ask, providerClient } from '../../start-a-computer/do-work/rent-a-machine.mjs';

/** provider: the DNS provider description. A `transport: "engine"` description holds no credential: each request is sent as one
 * engine tools:run through `call(run)` (run is { address, tool, input }, the engine's own input), which answers the engine's
 * answer; any other description sends the held token with its base and auth header. */
export function dnsClient(token, { fetchImpl = fetch, provider, call }) {
  if (!provider?.base) throw Error('The DNS client needs its DNS provider description.');
  if (provider.transport === 'engine') {
    if (typeof call !== 'function') throw Error(`${provider.name} is reached through the engine: the DNS client needs the engine call.`);
    return engineClient({ provider, call });
  }
  if (!provider.auth) throw Error('The DNS client needs its DNS provider description.');
  if (typeof token !== 'string' || !/^[A-Za-z0-9_-]{20,256}$/.test(token)) throw Error('The held DNS credential was refused.');
  return providerClient(provider, token, { fetchImpl, timeoutMs: 30000 });
}

/** An engine client for an MCP provider: `request(POST, '', { name, arguments })` names one tool the description declares, sent
 * as the engine's tools:run of `<host>/<name>` at the provider's address (the engine signs in and refreshes the connection). The
 * tool's structured result is read, or its text parsed as JSON. A refusal names the tool, never the answer. */
function engineClient({ provider, call }) {
  const declared = new Set(Object.values(provider.requests).map(asked => asked.body_template?.name));
  const host = new URL(provider.base).host;
  return async function request(method, path, body) {
    if (method !== 'POST' || path !== '' || !declared.has(body?.name)) throw Error(`The ${provider.name} operation was refused.`);
    let answer;
    try { answer = await call({ address: provider.base, tool: `${host}/${body.name}`, input: body.arguments ?? {} }); } catch (error) { if (error?.from_a_step) throw error; throw Error(`${provider.name} did not answer ${body.name}.`); }
    const result = answer?.result;
    if (!result || result.isError) throw Error(`${provider.name} refused ${body.name}.`);
    if (result.structuredContent !== undefined) return result.structuredContent;
    try { return JSON.parse(result.content?.[0]?.text ?? 'null'); } catch { throw Error(`${provider.name} answered ${body.name} without JSON.`); }
  };
}

/** The relative name a record of `zone` takes for `hostname` ('@' for the apex); the hostname itself when the zone names full hosts. */
const labelOf = (provider, zone, hostname) => !provider.zone?.name_relative ? hostname : hostname === zone ? '@' : hostname.slice(0, -(zone.length + 1));
/** The record body a provider removes a record by (its id_is_fields), the name as the zone names it; the content goes under the key its type takes. */
const bodyOf = (provider, zone, row) => Object.fromEntries(provider.record.id_is_fields.map(key => key === provider.record.content_at
  ? [contentKeyOf(provider, row), contentOf(provider, row)]
  : [key, key === provider.record.name_at ? labelOf(provider, zone, nameOf(provider, row)) : at(row, key)]));
/** Remove one record: by its id, or by its body where the provider keeps no ids. */
const removeRow = (request, provider, zone, row) => provider.record.id_is_fields
  ? ask(request, provider, provider.record, 'remove', { zone_id: zone, record_body: bodyOf(provider, zone, row), address: contentOf(provider, row), host_label: labelOf(provider, zone, nameOf(provider, row)), rr_type: typeOf(provider, row) })
  : ask(request, provider, provider.record, 'remove', { zone_id: zone }, idOf(provider.record, row));
/** The name a record of `zone` takes in full: the zone's own name for '@', else the label joined to the zone. */
const fullNameOf = (zone, name) => name === '@' ? zone : `${name}.${zone}`;

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
/** The key a record's content (address, target or value) sits under: its type's own key where the provider names one. */
const contentKeyOf = (provider, row) => provider.record.content_at_by_type?.[typeOf(provider, row)] ?? provider.record.content_at ?? 'content';
const contentOf = (provider, row) => at(row, contentKeyOf(provider, row));
const idOf = (part, row) => at(row, part.id_at ?? 'id');
const addressRows = (provider, state, hostname) => state.records.filter(row => nameOf(provider, row) === hostname && provider.record.address_types.includes(typeOf(provider, row)));

/** A list that groups values under each row (`values_at`: an RRset's records) yields one row per value: the value sits under
 * `content_at` and the group's name, type and TTL are kept on each row. */
function expandValues(part, rows) {
  return rows.flatMap(row => {
    const { [part.values_at]: values = [], ...group } = row;
    return values.map(value => ({ ...group, [part.content_at]: value[part.value_at] }));
  });
}

/** Every listed record of the zone, and the records the list answer omits (`omitted_at`), each once. */
async function pages(request, provider, ctx) {
  const part = provider.record, result = [], omitted = new Map();
  for (let page = 1; ; page += 1) {
    const size = part.page_size, answer = await ask(request, provider, part, 'list', { ...ctx, page, skip: size ? (page - 1) * size : undefined, take: size });
    const rows = at(answer, part.list_at);
    result.push(...(part.values_at ? expandValues(part, rows) : rows));
    for (const row of (part.omitted_at ? at(answer, part.omitted_at) : undefined) ?? []) omitted.set(JSON.stringify(row), row);
    if (size ? rows.length < size : !part.pages_at || page >= (at(answer, part.pages_at) ?? 1)) return { rows: result, omitted: [...omitted.values()] };
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
  const listed = await pages(request, provider, ctx);
  const full = rows => z.name_relative ? rows.map(row => ({ ...row, [provider.record.name_at ?? 'name']: fullNameOf(zone, at(row, provider.record.name_at ?? 'name')) })) : rows;
  return { zone, account, records: full(listed.rows), omitted: full(listed.omitted), guards, bindings };
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
  // A provider that keeps no record ids (record.id_is_fields) moves the name's one record by its body: the receipt keeps the
  // record itself, since it has no id to find it by.
  const byBody = !placed && !managed && Boolean(p.id_is_fields);
  const receipt = { schema: 'portable-dns-cutover/2', hostname: c.hostname, address: c.address, state: 'prepared', mode: placed ? 'new-record' : managed ? 'managed-binding' : byBody ? 'record-by-body' : 'record', originalBinding: managed ? binding : undefined, original: byBody ? targets[0] : undefined, before, targetId: placed || byBody ? null : idOf(p, targets[0]), desired: fill(p.desired, { host_name: c.hostname, address: c.address, lease_label_key: provider.lease_label_key }) };
  return receipts.save(file, receipt);
}
export async function changeCutover(c, { request, provider, receipts, file, rollback = false }) {
  checked(c); const receipt = await readCutover(receipts, file);
  const save = () => receipts.save(file, receipt), p = provider.record;
  if (receipt.hostname !== c.hostname || receipt.address !== c.address) throw Error('Saved cutover belongs to another placement.');
  if (receipt.mode === 'managed-binding') return changeManagedBinding(c, { request, provider, save, receipt, rollback });
  if (receipt.mode === 'new-record') return changeNewRecord(c, { request, provider, save, receipt, rollback });
  if (receipt.mode === 'record-by-body') return changeByBody(c, { request, provider, save, receipt, rollback });
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
      await removeRow(request, provider, before.zone, here[0]);
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

/** The name's one record at a provider that keeps no record ids (record.id_is_fields): activate adds the record at the new
 * address, reads it back, then removes the original by its body, so the name never answers with no address; rollback adds the
 * original address back and then removes the placed record. Each step is found again by readback before it is sent, so a lost
 * answer is never made twice. Every record but this name's address records, and the guarded lists, must stay as they were,
 * and the name may hold only the original and the placed record while it moves: anything else refuses with no mutation. A
 * record added back takes the TTL the provider's create writes, not the original's. */
async function changeByBody(c, { request, provider, save, receipt, rollback }) {
  const before = receipt.before, p = provider.record, original = receipt.original;
  const preserved = state => {
    const other = state.records.filter(x => nameOf(provider, x) !== c.hostname || !p.address_types.includes(typeOf(provider, x)));
    const old = before.records.filter(x => nameOf(provider, x) !== c.hostname || !p.address_types.includes(typeOf(provider, x)));
    if (stable(other, x => shape(provider, x)) !== stable(old, x => shape(provider, x)) || JSON.stringify(state.guards) !== JSON.stringify(before.guards)) throw Error('Unrelated DNS records or guarded lists changed; preserve the current state and investigate.');
  };
  const from = typeOf(provider, original), was = contentOf(provider, original);
  const isOriginal = row => typeOf(provider, row) === from && contentOf(provider, row) === was;
  const isPlaced = row => typeOf(provider, row) === 'A' && contentOf(provider, row) === c.address;
  const [keep, drop, keepAddress] = rollback ? [isOriginal, isPlaced, was] : [isPlaced, isOriginal, c.address];
  const read = async () => { const state = await snapshot(c, request, provider, before.zone, before.account); preserved(state); return addressRows(provider, state, c.hostname); };
  let here = await read();
  if (here.some(row => !isOriginal(row) && !isPlaced(row))) throw Error('The name holds an address record this cutover did not place; no mutation was made.');
  if (!here.some(keep)) {
    if (rollback && from !== 'A') throw Error(`The original ${from} record cannot be made again by this provider's create; rollback refused.`);
    receipt.state = rollback ? 'rollback-adding-address' : 'adding-address'; await save();
    await ask(request, provider, p, 'create', { zone_id: before.zone, host_name: c.hostname, host_label: labelOf(provider, before.zone, c.hostname), type: 'A', address: keepAddress, lease_label_key: provider.lease_label_key, name: c.hostname });
    here = await read();
    if (!here.some(keep)) throw Error('DNS placement needs readback reconciliation; the receipt is kept.');
  }
  for (const row of here.filter(drop)) {
    receipt.state = rollback ? 'rollback-removing-address' : 'removing-address'; await save();
    await removeRow(request, provider, before.zone, row);
  }
  here = await read();
  if (here.length !== 1 || !keep(here[0])) throw Error('DNS placement needs readback reconciliation; the receipt is kept.');
  if (!rollback) receipt.afterTarget = here[0];
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
      await removeRow(request, provider, before.zone, target[0]);
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

/** The values a record set of `type` holds at `hostname` in a read state, as the provider's content strings, sorted. */
const valuesAt = (state, provider, hostname, type) => state.records.filter(row => nameOf(provider, row) === hostname && typeOf(provider, row) === type).map(row => contentOf(provider, row)).sort();

/** The declared record sets as { type: sorted values }: a row's priority is written in front of its value (an MX's is). */
export function declaredSetsOf(declared) {
  const sets = {};
  for (const { type, value, priority } of declared) sets[type] = [...(sets[type] ?? []), priority === undefined ? value : `${priority} ${value}`];
  for (const type of Object.keys(sets)) sets[type].sort();
  return sets;
}

/** The record sets `hostname` holds now, for the types the declared rows name, shaped as declaredSetsOf shapes them; reads only. */
export async function recordSetsOf({ hostname, declared, request, provider }) {
  checked({ hostname, address: '192.0.2.1' });
  const state = await snapshot({ hostname }, request, provider), sets = {};
  for (const type of Object.keys(declaredSetsOf(declared))) sets[type] = valuesAt(state, provider, hostname, type);
  return sets;
}

/** Each record set a names entry declares beside its address record is made exactly the declared values: a missing value is
 * added (an add when the set already exists, else a create), an extra value of a declared type is removed, by compare. Other
 * types and other names are never touched, and the address record stays with keepHealthyRecords. A provider whose create
 * writes only address records (no {type} in its create body) is refused before any call. Readback must show the declared values. */
export async function keepRecordSets({ hostname, declared, request, provider }) {
  checked({ hostname, address: '192.0.2.1' });
  const wanted = declaredSetsOf(declared), p = provider.record, owner = { lease_label_key: provider.lease_label_key, name: hostname };
  if (!JSON.stringify(provider.requests[p.create]?.body_template ?? {}).includes('{type}')) throw Error(`${provider.name} creates only address records: it cannot keep the record sets of ${hostname}.`);
  const state = await snapshot({ hostname }, request, provider), zone = state.zone, label = labelOf(provider, zone, hostname);
  const added = [], removed = [];
  for (const [type, values] of Object.entries(wanted)) {
    const current = valuesAt(state, provider, hostname, type);
    for (const value of values) if (!current.includes(value)) {
      await ask(request, provider, p, current.length && p.add ? 'add' : 'create', { zone_id: zone, host_name: hostname, host_label: label, type, address: value, ...owner });
      current.push(value); added.push({ type, value });
    }
    for (const row of state.records.filter(row => nameOf(provider, row) === hostname && typeOf(provider, row) === type)) if (!values.includes(contentOf(provider, row))) {
      await removeRow(request, provider, zone, row);
      removed.push({ type, value: contentOf(provider, row) });
    }
  }
  const after = await snapshot({ hostname }, request, provider, zone, state.account), read = {};
  for (const type of Object.keys(wanted)) read[type] = valuesAt(after, provider, hostname, type);
  if (JSON.stringify(read) !== JSON.stringify(wanted)) throw Error(`${hostname} does not hold the declared record sets after the change; read it back and investigate.`);
  return { hostname, added, removed };
}

/** Keep one hostname answering with exactly the front-door computers that pass their health check: `candidates` are
 * { address, health_path? }; `check(candidate)` answers true when that computer is healthy. Healthy addresses missing
 * from the name are added first, then unhealthy ones this call owns are removed, so the name is never empty; when no
 * candidate is healthy nothing changes and the call refuses. Without `adopt`, a record at the name that this set does not own
 * (or one the list omits) is left untouched and refused. With `adopt` the name is the healthy set's: after the healthy records
 * are added, every other address record of the name (any type in address_types: A, CNAME, redirect) is removed, and each
 * record the provider omits from its list is reported in `unremovable`, since no remove call can name it. Other names and
 * the rest of the zone are never touched. */
export async function keepHealthyRecords({ hostname, candidates, check, request, provider, adopt = false }) {
  const p = provider.record, owner = { lease_label_key: provider.lease_label_key, name: hostname };
  checked({ hostname, address: '192.0.2.1' });
  if (!Array.isArray(candidates) || !candidates.length || candidates.some(x => isIP(x?.address) !== 4)) throw Error('Give the front-door computers as { address } rows with public IPv4 addresses.');
  const health = await Promise.all(candidates.map(async candidate => ({ candidate, healthy: Boolean(await check(candidate)) })));
  const healthy = health.filter(x => x.healthy).map(x => x.candidate.address);
  if (!healthy.length) throw Error('No front-door computer is healthy; the name was left as it is.');
  const state = await snapshot({ hostname }, request, provider), here = addressRows(provider, state, hostname);
  const omittedHere = state.omitted.filter(row => nameOf(provider, row) === hostname && p.address_types.includes(typeOf(provider, row)));
  const ownedHere = row => adopt || (p.owner_at ? at(row, p.owner_at) === fill(p.owner_is, owner) : p.owner_by === 'address' && candidates.some(x => x.address === contentOf(provider, row)));
  const foreign = here.filter(row => !ownedHere(row));
  if (!adopt && (foreign.length || omittedHere.length)) throw Error(`${hostname} already holds ${foreign.length + omittedHere.length} address record(s) this set does not own; they were left untouched (adopt them to take the name over).`);
  const isA = row => typeOf(provider, row) === 'A';
  if (!adopt && here.some(row => !isA(row))) throw Error(`${hostname} holds an address record that is not an A record; it was left untouched.`);
  const kept = row => isA(row) && healthy.includes(contentOf(provider, row));
  const have = new Set(here.filter(isA).map(row => contentOf(provider, row)));
  const added = [], removed = [];
  for (const address of healthy) if (!have.has(address)) {
    const answer = await ask(request, provider, p, have.size && p.add ? 'add' : 'create', { zone_id: state.zone, host_name: hostname, host_label: labelOf(provider, state.zone, hostname), type: 'A', address, ...owner });
    added.push({ address, id: idOf(p, at(answer, p.created_at ?? 'result')) });
  }
  for (const row of here) if (!kept(row)) {
    await removeRow(request, provider, state.zone, row);
    removed.push({ type: typeOf(provider, row), content: contentOf(provider, row), id: idOf(p, row) });
  }
  const after = addressRows(provider, await snapshot({ hostname }, request, provider, state.zone, state.account), hostname).map(row => contentOf(provider, row)).sort();
  if (JSON.stringify(after) !== JSON.stringify([...healthy].sort())) throw Error('The name does not answer with the healthy computers after the change; read it back and investigate.');
  const unremovable = omittedHere.map(row => ({ type: typeOf(provider, row), host_name: hostname }));
  return { hostname, healthy, unhealthy: health.filter(x => !x.healthy).map(x => x.candidate.address), added, removed, unremovable };
}
