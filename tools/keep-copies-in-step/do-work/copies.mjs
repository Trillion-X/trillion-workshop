// tools/keep-copies-in-step/do-work/copies.mjs
//
// PURPOSE
//   The three rows of this tool, run by tools/records-door/do-work/run-an-export.mjs: seeIfMyCopiesAreInStep answers every
//   device and each record two copies changed apart, sayHowThisDeviceStands answers the device list after one device's
//   report, and settleTwoVersions answers the writes that settle a record kept apart. None reads or keeps anything:
//   the device rows and the records come in with the request and what to keep comes back in the answer.
//
// NON-NEGOTIABLE INVARIANTS
//   1. The decisions are the moved code's (read-data/catch-up.mjs, unchanged): this file only turns the rows a request
//      carries into the synchronous store and records it takes, and answers what it chose.
//   2. A record the request does not carry is absent. Each answered write names what it stands on (`expected`: the
//      record as it was handed in, or null for one nobody had), so the caller's conditional write refuses it when the
//      record changed meanwhile.
//   3. Bounded: at most `most_apart` records kept apart are counted (read-data/catch-up.json).
//
import { catchUp, CatchUpError, KEPT_APART } from '../read-data/catch-up.mjs';
import settings from '../read-data/catch-up.json' with { type: 'json' };

const object = value => Boolean(value) && typeof value === 'object' && !Array.isArray(value);
const word = value => typeof value === 'string' && value.trim().length > 0;

function thingTypeOf(input) {
  if (!word(input.thing_type)) throw new Error('thing_type names the kind of record whose versions to read or settle, for example note.');
  if (input.thing_type === KEPT_APART) throw new Error(`thing_type is the kind of the record kept apart, not ${KEPT_APART}.`);
  return input.thing_type;
}

function nowOf(input) {
  if (input.now === undefined) return () => Date.now();
  const at = Date.parse(input.now);
  if (!Number.isFinite(at)) throw new Error('now must be an ISO time, for example 2026-01-01T00:00:00.000Z.');
  return () => at;
}

/** The device rows the request carries: the list a device report or a read works over, newest first. */
function devicesOf(input) {
  if (input.devices === undefined) return [];
  if (!Array.isArray(input.devices) || !input.devices.every(object)) throw new Error('devices is the list of device rows as they are kept: [{ device_id, title, kind, state, waiting, at, seen_at, copy? }], newest first.');
  return input.devices;
}

/** The records the request carries, by id: [{ id, type, value }]. */
function recordsOf(input) {
  if (input.records === undefined) return new Map();
  if (!Array.isArray(input.records) || !input.records.every(record => object(record) && word(record.id))) throw new Error('records is a list of { id, type, value }: the records kept apart and the records they name.');
  return new Map(input.records.filter(record => record.value !== null && record.value !== undefined).map(record => [record.id, { type: record.type ?? null, value: record.value }]));
}

const devicesStore = rows => {
  let kept = null;
  return { devices: () => kept ?? rows, putDevices: value => { kept = value; }, written: () => kept };
};

/** The records as catch-up.mjs reads them, and the writes it makes (collected, never made). */
function heldRecords(held, keptIds) {
  const writes = [];
  return {
    writes,
    records: {
      ids: (type, { limit } = {}) => (type === KEPT_APART ? keptIds.slice(0, limit) : []),
      read: id => held.get(id)?.value ?? null,
      typeOf: id => held.get(id)?.type ?? null,
      write: rows => { writes.push(...rows); },
    },
  };
}

/** tool:see-if-my-copies-are-in-step */
export function seeIfMyCopiesAreInStep(input = {}) {
  if (!object(input)) throw new Error('The request is one object.');
  const thingType = thingTypeOf(input);
  if (input.positions !== undefined && !Array.isArray(input.positions)) throw new Error('positions is a list of { copy, settled_at }, how far each copy of the records took.');
  const held = recordsOf(input);
  const keptIds = [];
  const otherKinds = new Set();
  for (const [id, record] of held) {
    if (record.type !== KEPT_APART) continue;
    if (keptIds.length >= settings.most_apart) break;
    const versions = Object.values(object(record.value) ? record.value : {}).filter(object);
    const kind = versions[0]?.record_type;
    if (kind !== thingType) { if (word(kind)) otherKinds.add(kind); continue; }
    keptIds.push(id);
  }
  const positions = input.positions === undefined ? null : { list: () => input.positions.filter(object) };
  const view = heldRecords(held, keptIds);
  const answer = catchUp(devicesStore(devicesOf(input)), { records: view.records, positions }).read();
  return { ...answer, other_kinds: [...otherKinds].sort() };
}

/** tool:say-how-this-device-stands: the report as the next device list to keep, or nothing to write when it changed nothing. */
export function sayHowThisDeviceStands(input = {}) {
  if (!object(input)) throw new Error('The request is one object.');
  const store = devicesStore(devicesOf(input));
  const { devices: _devices, now: _now, ...body } = input;
  let reply;
  try { reply = catchUp(store, { records: null, now: nowOf(input) }).here(body); } catch (error) {
    if (error instanceof CatchUpError) throw new Error(error.message);
    throw error;
  }
  return reply.written ? { ...reply, devices: store.written() } : reply;
}

/** tool:settle-two-versions: the writes that settle a record kept apart, for the caller to keep in one write. */
export function settleTwoVersions(input = {}) {
  if (!object(input)) throw new Error('The request is one object.');
  const thingType = thingTypeOf(input);
  const { thing_type: _type, records: _records, ...body } = input;
  const held = recordsOf(input);
  const view = heldRecords(held, []);
  let answer;
  try {
    answer = catchUp(devicesStore([]), { records: view.records }).settle(body);
  } catch (error) {
    if (error instanceof CatchUpError) throw new Error(error.message);
    throw error;
  }
  // Each write stands only on what was handed in for it: a record nobody had is written only while it is still absent.
  const writes = view.writes.map(write => {
    const before = held.get(write.id) ?? null;
    return { ...write, expected: before ? { type: before.type, value: before.value } : null };
  });
  return { ...answer, thing_type: thingType, writes };
}
