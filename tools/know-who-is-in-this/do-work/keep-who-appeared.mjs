// tools/know-who-is-in-this/do-work/keep-who-appeared.mjs
//
// `tool:keep-who-appeared`, run as a function (tools/records-door do-work/run-an-export.mjs): keeps what
// `tool:who-is-in-this` and `tool:find-faces` answered about one recording as rows of the person's appearances list, so
// every person can be found with every recording, time and place where their voice was heard or face seen, and every
// recording with the people in it. The two tools change no file; this is the one that keeps their answers.
//
//   keepWhoAppeared(input, { door, now? }) -> { list_id, recording, kept, named, possible, unknown, superseded, row_ids }
//   input: { recording, recording_name?, heard?, seen?, every_seconds?, people?, place?, recorded_on?, listening? }
//
// Non-Negotiable Invariants:
//   1. A named person is kept only while their print for that kind still exists with consent words; a print taken out
//      (consent withdrawn) refuses the whole keep, so nothing new is linked to someone who no longer agreed.
//   2. Nothing is deleted. A row of this recording and kind that the new answer no longer holds (a stretch a later
//      enrolment named, a threshold changed) is marked superseded and stays readable.
//   3. A row is merged, never replaced (tools/records-door lists-door putRows), and every write is conditional on what
//      was read.
import { listsOverDoor } from '../../records-door/read-data/lists-door.mjs';
import { writeBatches } from '../../records-door/read-data/write-batches.mjs';
import { LIST, PRINT_KINDS, ROW_PREFIX, ROW_TYPE, STATUS, appearanceRows, consentOf } from '../read-data/appearances.mjs';

// The door refuses a message over 64 KiB; a row travels once as its value and once as the value it is expected to replace.
const DOOR_BYTES = 60_000;
const DOOR_ROWS = 256;
const refuse = (code, words) => { throw Object.assign(new Error(words), { code }); };

async function refuseUnconsented(door, relies) {
  for (const [how, person] of relies) {
    const type = PRINT_KINDS[how];
    const value = await door.read(type, `${type}:${person}`);
    if (!consentOf(value).length) refuse('no_consent', `There is no ${how} print with consent words for person ${person}, so nobody is linked to them by their ${how}.`);
  }
}

async function earlierRows(door, recording, how) {
  const rows = [];
  for await (const record of door.list({ type: ROW_TYPE, where: { recording, how }, fields: ['status', 'how', 'recording'] })) {
    if (typeof record?.id === 'string' && record.id.startsWith(ROW_PREFIX) && record.value?.recording === recording && record.value?.how === how) rows.push({ id: record.id.slice(ROW_PREFIX.length), values: record.value ?? {} });
  }
  return rows;
}

export async function keepWhoAppeared(input, { door, now = () => new Date() } = {}) {
  const made = appearanceRows(input, { now: now() });
  await refuseUnconsented(door, made.relies);
  const lists = listsOverDoor(door);
  await lists.ensure({ ...LIST });
  const keeping = new Set(made.rows.map(row => row.id));
  const stale = [];
  for (const how of made.kinds) {
    for (const row of await earlierRows(door, made.recording, how)) {
      if (!keeping.has(row.id) && row.values.status !== STATUS.superseded) stale.push({ id: row.id, values: { status: STATUS.superseded } });
    }
  }
  const writes = [...made.rows, ...stale];
  for (const batch of writeBatches(writes, { rows: DOOR_ROWS, bytes: DOOR_BYTES, measure: row => 2 * JSON.stringify(row).length })) await lists.putRows(LIST.id, { rows: batch });
  const count = status => made.rows.filter(row => row.values.status === status).length;
  return {
    list_id: LIST.id, recording: made.recording, kept: made.rows.length, named: count(STATUS.named), possible: count(STATUS.possible),
    unknown: count(STATUS.unknown), superseded: stale.length, row_ids: made.rows.map(row => `${LIST.id}/${row.id}`),
  };
}

