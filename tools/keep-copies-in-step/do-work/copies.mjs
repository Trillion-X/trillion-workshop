// tools/keep-copies-in-step/do-work/copies.mjs
//
// PURPOSE
//   The three rows of this tool, run by tools/records-door/do-work/run-an-export.mjs over the person's own records:
//   seeIfMyCopiesAreInStep reads every device and each record two copies changed apart, sayHowThisDeviceStands keeps
//   one device's report, and settleTwoVersions writes what the person chose for a record kept apart.
//
// NON-NEGOTIABLE INVARIANTS
//   1. The decisions are the moved code's (read-data/catch-up.mjs, unchanged): this file only reads the person's rows
//      into the synchronous store and records it takes, and writes back what it chose.
//   2. Every record read or written is one read-data/copies-rows.json names, of the KEPT_APART type, or of the one kind
//      the request names as `thing_type`; the rows' rights grant no more.
//   3. Every write is conditioned on what was read (`expected`): a row changed meanwhile answers `conflict: true` and
//      nothing is written. The request key makes the same change safe to send again.
//   4. Bounded: at most `most_apart` records kept apart are listed (read-data/catch-up.json) and at most `most_reads`
//      further records are read one by one (read-data/copies-rows.json).
//
import ROWS from '../read-data/copies-rows.json' with { type: 'json' };
import { catchUp, CatchUpError, KEPT_APART } from '../read-data/catch-up.mjs';
import settings from '../read-data/catch-up.json' with { type: 'json' };

const object = value => Boolean(value) && typeof value === 'object' && !Array.isArray(value);
const word = value => typeof value === 'string' && value.trim().length > 0;
const CONFLICT = 'original_command_conflict';

// catch-up.mjs reads synchronously. A record it asks for that was not read yet stops the run with Missing; the record
// is then read through the door and the run starts again from the beginning (it writes nothing before its end).
class Missing { constructor(id) { this.id = id; } }

function thingTypeOf(input) {
  if (!word(input.thing_type)) throw new Error('thing_type names the kind of record whose versions to read or settle, for example note.');
  if (input.thing_type === KEPT_APART) throw new Error(`thing_type is the kind of the record kept apart, not ${KEPT_APART}.`);
  return input.thing_type;
}

function requestKeyOf(input) {
  if (!word(input.request_key)) throw new Error('request_key names this change, so sending it again changes nothing twice.');
  return input.request_key;
}

function nowOf(input) {
  if (input.now === undefined) return () => Date.now();
  const at = Date.parse(input.now);
  if (!Number.isFinite(at)) throw new Error('now must be an ISO time, for example 2026-01-01T00:00:00.000Z.');
  return () => at;
}

/** The person's device rows, and the setting row that holds them. */
async function readDevices(door) {
  const held = await door.readRecord(ROWS.devices.type, ROWS.devices.id);
  const rows = object(held?.value) && Array.isArray(held.value.value) ? held.value.value : [];
  return { held, rows };
}

/** The person's records as catch-up.mjs reads them: what was read through the door, and what it writes, kept aside. */
function heldRecords(held, keptIds, thingType) {
  const writes = [];
  const at = id => {
    if (!held.has(id)) throw new Missing(id);
    return held.get(id);
  };
  return {
    writes,
    records: {
      ids: (type, { limit } = {}) => (type === KEPT_APART ? keptIds.slice(0, limit) : []),
      read: id => at(id)?.value ?? null,
      typeOf: id => at(id)?.type ?? null,
      write: rows => { writes.push(...rows); },
    },
    // A record id the run asked for is read as KEPT_APART when it is one, else as the kind the request names.
    typeFor: id => (String(id).startsWith(`${KEPT_APART}:`) ? KEPT_APART : thingType),
  };
}

async function runReading(door, held, thingType, keptIds, run) {
  for (let reads = 0; ; reads += 1) {
    const view = heldRecords(held, keptIds, thingType);
    try {
      return { answer: run(view.records), writes: view.writes };
    } catch (error) {
      if (!(error instanceof Missing)) throw error;
      if (reads >= ROWS.most_reads) throw new Error(`More than ${ROWS.most_reads} records were needed: settle fewer versions at once.`);
      const read = await door.readRecord(view.typeFor(error.id), error.id);
      held.set(error.id, read && read.value !== null && read.value !== undefined ? { type: read.type, value: read.value } : null);
    }
  }
}

const devicesStore = rows => {
  let kept = null;
  return { devices: () => kept ?? rows, putDevices: value => { kept = value; }, written: () => kept };
};

async function writeOrConflict(door, writes, key) {
  try {
    await door.write(writes, { key });
    return true;
  } catch (error) {
    if (error?.code === CONFLICT) return false;
    throw error;
  }
}

/** tool:see-if-my-copies-are-in-step */
export async function seeIfMyCopiesAreInStep(input = {}, { door } = {}) {
  if (!object(input)) throw new Error('The request is one object.');
  const thingType = thingTypeOf(input);
  if (input.positions !== undefined && !Array.isArray(input.positions)) throw new Error('positions is a list of { copy, settled_at }, how far each copy of the records took.');
  const { rows } = await readDevices(door);
  const held = new Map();
  const keptIds = [];
  const otherKinds = new Set();
  for await (const record of door.list({ type: KEPT_APART, limit: ROWS.page_rows })) {
    if (keptIds.length >= settings.most_apart) break;
    const versions = Object.values(object(record.value) ? record.value : {}).filter(object);
    const kind = versions[0]?.record_type;
    if (kind !== thingType) { if (word(kind)) otherKinds.add(kind); continue; }
    held.set(record.id, { type: KEPT_APART, value: record.value });
    keptIds.push(record.id);
  }
  const positions = input.positions === undefined ? null : { list: () => input.positions.filter(object) };
  const { answer } = await runReading(door, held, thingType, keptIds, records => catchUp(devicesStore(rows), { records, positions }).read());
  return { ...answer, other_kinds: [...otherKinds].sort() };
}

/** tool:say-how-this-device-stands */
export async function sayHowThisDeviceStands(input = {}, { door } = {}) {
  if (!object(input)) throw new Error('The request is one object.');
  const key = requestKeyOf(input);
  const { held, rows } = await readDevices(door);
  if (held && !object(held.value)) throw new Error(`${ROWS.devices.id} is not an object: write it as { value: [ ... ] }.`);
  const store = devicesStore(rows);
  const { request_key: _key, now: _now, ...body } = input;
  let reply;
  try { reply = catchUp(store, { records: null, now: nowOf(input) }).here(body); } catch (error) {
    if (error instanceof CatchUpError) throw new Error(error.message);
    throw error;
  }
  if (!reply.written) return reply;
  const value = { ...(object(held?.value) ? held.value : {}), value: store.written() };
  const expected = held ? { type: ROWS.devices.type, value: held.value } : null;
  if (!await writeOrConflict(door, [{ id: ROWS.devices.id, type: ROWS.devices.type, value, expected }], key)) return { written: false, conflict: true };
  return reply;
}

/** tool:settle-two-versions */
export async function settleTwoVersions(input = {}, { door } = {}) {
  if (!object(input)) throw new Error('The request is one object.');
  const thingType = thingTypeOf(input);
  const key = requestKeyOf(input);
  const { thing_type: _type, request_key: _key, ...body } = input;
  const held = new Map();
  let run;
  try {
    run = await runReading(door, held, thingType, [], records => catchUp(devicesStore([]), { records }).settle(body));
  } catch (error) {
    if (error instanceof CatchUpError) throw new Error(error.message);
    throw error;
  }
  // Each write stands only on what was read for it: a record nobody had is written only while it is still absent.
  const writes = run.writes.map(write => {
    const before = held.get(write.id) ?? null;
    return { ...write, expected: before ? { type: before.type, value: before.value } : null };
  });
  if (!await writeOrConflict(door, writes, key)) return { settled: null, written: [], conflict: true };
  return run.answer;
}
