// tools/keep-copies-in-step/do-work/copies.mjs
//
// PURPOSE
//   The three rows of this tool, run by tools/records-door/do-work/run-an-export.mjs: seeCopiesInStep answers each
//   device and every record of one kind kept as two versions; sayHowThisCopyStands keeps what a device says of itself;
//   settleTwoVersions writes what the person chose for a record kept apart. The decisions are read-data/catch-up.mjs,
//   moved from the trillion app; this file reads the person's rows into the shapes it takes and writes back what it
//   wrote, through the records door.
//
// NON-NEGOTIABLE INVARIANTS
//   1. The moved code decides; this file only lends it the rows it reads and carries its writes to the door.
//   2. Every record read or written is one read-data/copies-rows.json names, or a record of the kind the request names
//      (the row's rights are filled from the input's `kind`, so a run reaches no other kind).
//   3. Every write is conditioned on what was read (`expected`): a row changed meanwhile answers `conflict: true` and
//      nothing is written. A `request_key` makes the same change safe to send again.
//   4. Settling writes the choice and removes the kept versions in one write, so nothing is removed unless what was
//      chosen is written too.
//
import ROWS from '../read-data/copies-rows.json' with { type: 'json' };
import settings from '../read-data/catch-up.json' with { type: 'json' };
import { CatchUpError, KEPT_APART, catchUp } from '../read-data/catch-up.mjs';

const object = value => Boolean(value) && typeof value === 'object' && !Array.isArray(value);
const CONFLICT = 'original_command_conflict';
// What a write expects: absent rows stay absent, a row read stays as read (a value that is not an object is written
// without a condition, as the door takes only objects there).
const condition = held => (!held ? { expected: null } : object(held.value) ? { expected: { type: held.type, value: held.value } } : {});
const nowOf = input => {
  if (input.now === undefined) return Date.now();
  const at = Date.parse(input.now);
  if (!Number.isFinite(at)) throw new Error('now must be an ISO time, for example 2026-01-01T00:00:00.000Z.');
  return at;
};
const kindOf = input => {
  if (typeof input.kind !== 'string' || !input.kind.trim()) throw new Error('kind names the kind of records whose versions to read, for example note.');
  return input.kind;
};
const keyOf = input => {
  if (typeof input.request_key !== 'string' || !input.request_key.trim()) throw new Error('request_key names this change, so sending it again changes nothing twice.');
  return input.request_key;
};

/** The person's device rows, as the setting holds them. */
async function devicesOf(door) {
  const held = await door.readRecord(ROWS.devices.type, ROWS.devices.id);
  const list = object(held?.value) && Array.isArray(held.value.value) ? held.value.value.filter(object) : [];
  return { held, list };
}

/** A device-row store over what was read; putDevices keeps the rows to write. */
function deviceStore(list) {
  let rows = list, put = null;
  return { devices: () => rows, putDevices: value => { rows = value; put = value; }, put: () => put };
}

/** The record store the moved code reads: the rows read here, by id. Writes are kept to carry to the door. */
function recordsOver(held) {
  const writes = [];
  return {
    ids: (type, { limit } = {}) => [...held].filter(([, record]) => record.type === type).map(([id]) => id).slice(0, limit),
    read: id => held.get(id)?.value ?? null,
    typeOf: id => held.get(id)?.type ?? null,
    write: rows => { writes.push(...rows); },
    writes,
  };
}

const versionsOf = value => Object.values(object(value) ? value : {}).filter(object);

/** tool:see-copies-in-step */
export async function seeCopiesInStep(input = {}, { door } = {}) {
  if (!object(input)) throw new Error('The request is one object.');
  const kind = kindOf(input);
  const positions = input.positions ?? [];
  if (!Array.isArray(positions) || !positions.every(copy => object(copy) && typeof copy.copy === 'string')) {
    throw new Error('positions must be a list of { copy, settled_at }: how far each copy of the records took.');
  }
  const { list } = await devicesOf(door);
  const held = new Map();
  const otherKinds = {};
  for await (const record of door.list({ type: KEPT_APART, limit: settings.most_apart })) {
    if (held.size >= settings.most_apart) break;
    const versions = versionsOf(record.value);
    const of = versions[0]?.record_type ?? '';
    if (!versions.length || versions.some(version => version.record_type !== kind)) { otherKinds[of] = (otherKinds[of] ?? 0) + 1; continue; }
    held.set(record.id, { type: KEPT_APART, value: record.value });
    const id = versions[0].record;
    if (typeof id === 'string' && !held.has(id)) held.set(id, { type: kind, value: await door.read(kind, id) });
  }
  const copies = catchUp(deviceStore(list), { records: recordsOver(held), positions: { list: () => positions }, now: () => nowOf(input) });
  return { ...copies.read(), other_kinds: otherKinds };
}

/** tool:say-how-this-copy-stands */
export async function sayHowThisCopyStands(input = {}, { door } = {}) {
  if (!object(input)) throw new Error('The request is one object.');
  const { held, list } = await devicesOf(door);
  const store = deviceStore(list);
  let answer;
  try { answer = catchUp(store, { records: recordsOver(new Map()), now: () => nowOf(input) }).here(input); }
  catch (error) { if (error instanceof CatchUpError) return { error: error.message }; throw error; }
  if (!answer.written) return answer;
  const value = { ...(object(held?.value) ? held.value : {}), value: store.put() };
  try {
    await door.write([{ id: ROWS.devices.id, type: ROWS.devices.type, value, ...condition(held) }], input.request_key ? { key: input.request_key } : {});
  } catch (error) {
    if (error?.code === CONFLICT) return { device: answer.device, written: false, conflict: true };
    throw error;
  }
  return answer;
}

/** tool:settle-two-versions */
export async function settleTwoVersions(input = {}, { door } = {}) {
  if (!object(input)) throw new Error('The request is one object.');
  const kind = kindOf(input);
  const key = keyOf(input);
  const held = new Map();
  const before = new Map();
  const keep = (id, record) => { if (record) { held.set(id, record); before.set(id, record); } };
  if (typeof input.id === 'string' && input.id) keep(input.id, await door.readRecord(KEPT_APART, input.id));
  const versions = versionsOf(held.get(input.id)?.value);
  if (versions.some(version => version.record_type !== kind)) throw new Error(`kind must be the kind of the record kept apart: ${versions[0].record_type}.`);
  const thing = versions[0]?.record;
  if (typeof thing === 'string') {
    keep(thing, await door.readRecord(kind, thing));
    // keep both names each other version after the record; the names already taken are read so none is written over.
    if (input.keep === 'both') {
      for await (const record of door.list({ type: kind, prefix: `${thing}${settings.both_suffix}` })) keep(record.id, { type: kind, value: record.value });
    }
  }
  const records = recordsOver(held);
  let answer;
  try { answer = catchUp(deviceStore([]), { records }).settle(input, {}); }
  catch (error) { if (error instanceof CatchUpError) return { error: error.message }; throw error; }
  const writes = records.writes.map(write => ({ ...write, ...condition(before.get(write.id)) }));
  try { await door.write(writes, { key }); }
  catch (error) {
    if (error?.code === CONFLICT) return { settled: false, conflict: true, written: [] };
    throw error;
  }
  return answer;
}
