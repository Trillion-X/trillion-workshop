// tools/keep-copies-in-step/read-data/catch-up.mjs (moved from trillion src/catch-up.mjs)
//
// Purpose
//   Whether every copy of a person's things is in step, as their own store knows it: each device says how it stands
//   (its state, the changes it still holds, when its writes last reached the store), each copy of their records that
//   settles with the store says how far it took (parts/record-log record-sync.mjs copyPositions), and every record two
//   copies changed apart is read from where the record store keeps the versions a conflict met (`kept-apart` records,
//   record-sync.mjs KEPT_APART). A page or an AI reads and settles it through this tool's rows (tool:see-copies-in-step,
//   tool:say-how-this-copy-stands, tool:settle-two-versions; do-work/copies.mjs), which took the place of the store's
//   GET /catch-up routes and the MCP tools copies_in_step and settle_two_versions.
//
// Non-negotiable invariants
//   1. Blind: a state is the open key the device sent; a record kept apart is any record of any type. Nothing here
//      names a kind of device, a state or a kind of record.
//   2. A device row is written only when its state, its waiting count, its kind or its title changed, or when the time
//      it last caught up moved by more than `rewrite_after_ms` (read-data/catch-up.json).
//   3. One home for versions: the record store's kept-apart records. Settling is ordinary writes there (the chosen
//      value to the record, a second record for keep both, then the kept-apart record removed), so it is undoable and
//      every copy takes it like any change. Nothing is removed before what was chosen is written.
//   4. Bounded: at most `most_devices` device rows and `most_apart` records kept apart are read.
//   5. A copy of the records is shown once: as the device that named it (its last settle moves that device's last
//      catch-up), else as a device of its own named with `words.copy_title`, never by its id.
//
// Key concepts
//   device  { device_id, title, kind, state, waiting, at, seen_at, copy? }   at: when its writes last reached the store;
//           copy: the id of the copy of the records this device keeps, so that copy is shown as this device
//   kept    kept-apart:<record id> → { "<field or *>|<checksum>": { record, record_type, field, value } }
//   apart   { id, thing: { kind, id, title }, sides: [{ id, from, keep, value, current? }] }   one side per version, the
//           record as it is now first
//   settle  { id, keep: one | both | merged, side?, value? }
//
// Security
//   Rows live in this person's own store and leave it only to this person's own pages and AIs.
//

import settings from './catch-up.json' with { type: 'json' };
import ROWS from './copies-rows.json' with { type: 'json' };

// The record kind the record store keeps a conflict's versions under (trillion parts/record-log record-sync.mjs KEPT_APART).
export const KEPT_APART = ROWS.kept_apart.type;

export class CatchUpError extends Error {}

const nonempty = value => typeof value === 'string' && value.trim().length > 0;
const short = (value, most) => String(value ?? '').trim().slice(0, most);
const timeOf = value => (typeof value === 'number' ? value : Date.parse(value ?? ''));
const isObject = value => Boolean(value) && typeof value === 'object' && !Array.isArray(value);
const same = (a, b) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
const KEEP = new Set(['one', 'both', 'merged']);
const WHOLE = '*';

// Custody and settlement use only the original versions and stable side ids.
// Current presentation is applied separately and never chooses what is written.
function apartState(id, kept, current) {
  const versions = Object.values(isObject(kept) ? kept : {}).filter(isObject);
  if (!versions.length) return null;
  const { record, record_type: type } = versions[0];
  // Each contested field's versions that differ from what the record holds now, in the order they were kept.
  const others = new Map();
  for (const version of versions) {
    const field = version.field ?? WHOLE;
    const now = field === WHOLE ? current : isObject(current) ? current[field] : undefined;
    if (same(version.value, now)) continue;
    if (!others.has(field)) others.set(field, []);
    if (!others.get(field).some(value => same(value, version.value))) others.get(field).push(version.value);
  }
  const count = Math.max(0, ...[...others.values()].map(values => values.length));
  if (!count) return null;
  const sides = [{ id: 'now', current: true, value: current }];
  for (let n = 0; n < count; n += 1) {
    let value = isObject(current) ? { ...current } : current;
    for (const [field, values] of others) {
      const taken = values[Math.min(n, values.length - 1)];
      if (field === WHOLE) value = taken;
      else if (isObject(value)) { if (taken === null) delete value[field]; else value[field] = taken; }
    }
    sides.push({ id: `kept-${n + 1}`, value });
  }
  return { id, thing: { kind: type ?? '', id: record }, sides };
}

function presentApart(apart, presentation) {
  if (!apart) return null;
  const words = presentation.words ?? {}, count = apart.sides.length - 1;
  const current = apart.sides[0].value;
  const title = (presentation.title_fields ?? []).map(field => (isObject(current) ? current[field] : null)).find(nonempty) ?? apart.thing.id;
  const sides = apart.sides.map((side, n) => {
    const from = n === 0 ? words.now : count === 1 ? words.other : nonempty(words.other) ? `${words.other} ${n}` : undefined;
    const keep = n === 0 ? words.keep_now : count === 1 ? words.keep_other : nonempty(words.keep_other) ? `${words.keep_other} ${n}` : undefined;
    return { ...side, from: from ?? side.id, ...(nonempty(keep) ? { keep } : {}) };
  });
  return { ...apart, thing: { ...apart.thing, title }, sides };
}

/** A record kept apart, as the screen shows it: the record as it is now, then one side per other version. */
export function apartOf(id, kept, current, limits = settings) {
  return presentApart(apartState(id, kept, current), limits);
}

/**
 * store:     { devices() → [device], putDevices([device]) }, the device rows
 * records:   the person's record store (ids(type, { limit }), read(id), typeOf(id), write([{ id, type, value }], context))
 * positions: record-sync.mjs copyPositions, how far each copy of the records took (or null)
 */
export function catchUp(store, { records, positions = null, now = () => Date.now(), limits = settings } = {}) {
  // A device says how it stands (invariant 2).
  function here(body = {}) {
    const deviceId = short(body.device_id, 80);
    if (!/^[A-Za-z0-9._-]{8,80}$/.test(deviceId)) throw new CatchUpError('Say which device this is with the id it keeps for itself.');
    if (!nonempty(body.state)) throw new CatchUpError('Say how this device stands.');
    const at = timeOf(body.at);
    const copy = short(body.copy_id, 80);
    const row = {
      device_id: deviceId,
      title: short(body.title, 80),
      kind: short(body.kind, 40),
      state: short(body.state, 40),
      waiting: Number.isInteger(body.waiting) && body.waiting > 0 ? body.waiting : 0,
      ...(Number.isFinite(at) ? { at: new Date(at).toISOString() } : {}),
      seen_at: new Date(now()).toISOString(),
      ...(copy ? { copy } : {}),
    };
    const devices = store.devices();
    const before = devices.find(device => device.device_id === deviceId);
    const unchanged = before && before.state === row.state && before.waiting === row.waiting && before.kind === row.kind && before.title === row.title
      && (before.copy ?? '') === (row.copy ?? '')
      && Math.abs((timeOf(before.at) || 0) - (timeOf(row.at) || 0)) < limits.rewrite_after_ms;
    if (unchanged) return { device: before, written: false };
    store.putDevices([row, ...devices.filter(device => device.device_id !== deviceId)].slice(0, limits.most_devices));
    return { device: row, written: true };
  }

  const keptIds = () => records.ids(KEPT_APART, { limit: limits.most_apart });
  const apartAt = id => {
    const kept = records.read(id);
    const record = Object.values(isObject(kept) ? kept : {}).find(isObject)?.record;
    return record ? apartState(id, kept, records.read(record)) : null;
  };

  // The person (or their AI) chose: what was chosen is written first, then the kept versions go (invariant 3).
  function settle(body = {}, context = {}, { rawReceipt = false } = {}) {
    if (!nonempty(body.id) || records.typeOf(body.id) !== KEPT_APART) throw new CatchUpError('Those versions are not kept apart any more.');
    if (!KEEP.has(body.keep)) throw new CatchUpError('Say what to keep: one version, both, or a merged one.');
    const apart = apartAt(body.id);
    if (!apart) {
      records.write([{ id: body.id, type: KEPT_APART, value: null }], context);
      return { settled: { id: body.id, keep: body.keep }, written: [body.id] };
    }
    const type = records.typeOf(apart.thing.id) ?? apart.thing.kind;
    const writes = [];
    if (body.keep === 'one') {
      const side = apart.sides.find(candidate => candidate.id === body.side);
      if (!side) throw new CatchUpError('Say which version to keep by its id.');
      if (!side.current) writes.push({ id: apart.thing.id, type, value: side.value });
    } else if (body.keep === 'merged') {
      if (!('value' in body)) throw new CatchUpError('Give the merged value to keep.');
      writes.push({ id: apart.thing.id, type, value: body.value });
    } else {
      const allocated = new Set();
      let suffix = 1;
      for (const side of apart.sides.filter(side => !side.current)) {
        let id;
        do { id = `${apart.thing.id}${limits.both_suffix}${suffix++}`; }
        while (allocated.has(id) || records.typeOf(id) !== null || records.read(id) !== null);
        allocated.add(id);
        writes.push({ id, type, value: side.value });
      }
    }
    writes.push({ id: body.id, type: KEPT_APART, value: null });
    records.write(writes, context);
    // Runtime acknowledges only committed identities, without selecting shipped
    // presentation after a write. Pure callers retain their synchronous legacy
    // receipt by default; optional public content never gates this commitment.
    const thing = rawReceipt ? { ...apart.thing } : presentApart(apart, limits).thing;
    return { settled: { id: body.id, thing, keep: body.keep }, written: writes.map(write => write.id) };
  }

  // Each copy of the records that settles with the store, shown once (invariant 5): in step as of its last settle.
  const read = ({ presentation = limits } = {}) => {
    const settled = new Map((positions?.list() ?? []).map(copy => [copy.copy, copy.settled_at]));
    const devices = store.devices().map(device => {
      const at = device.copy ? settled.get(device.copy) : undefined;
      if (device.copy) settled.delete(device.copy);
      return at && !((timeOf(device.at) || 0) >= timeOf(at)) ? { ...device, at } : device;
    });
    const copies = [...settled].map(([copy, at]) => ({ device_id: copy, title: presentation.words?.copy_title ?? '', kind: '', state: presentation.copy_state ?? '', waiting: 0, at }));
    return { devices: [...devices, ...copies].slice(0, limits.most_devices), versions: keptIds().map(apartAt).map(apart => presentApart(apart, presentation)).filter(Boolean) };
  };
  return { here, settle, read };
}
