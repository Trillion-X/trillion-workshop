// tools/know-who-is-in-this/do-work/keep-who-appeared.mjs
//
// `tool:keep-who-appeared`, run as a function (tools/workflows do-work/run-a-function.mjs): turns what
// `tool:who-is-in-this` and `tool:find-faces` answered about one recording into rows of the person's appearances list,
// so every person can be found with every recording, time and place where their voice was heard or face seen, and every
// recording with the people in it. It keeps nothing: the rows to keep come back in the answer, and the consent words and
// the earlier rows it works from come in with the request.
//
//   keepWhoAppeared(input, { now? }) -> { list, list_id, recording, kept, named, possible, unknown, superseded, row_ids, rows, superseded_rows }
//   input: { recording, recording_name?, heard?, seen?, every_seconds?, people?, place?, recorded_on?, listening?,
//            consents?, earlier? }
//   consents: [{ how: 'voice' | 'face', person, consent: [words] }], the consent words of each print the answer names, read
//             by the caller from the prints (never their numbers).
//   earlier:  the person's appearance records of this recording read from the list, [{ id, value: { status, how, recording } }].
//
// Non-Negotiable Invariants:
//   1. A named person is answered only while their print for that kind is handed in with consent words; a person with
//      none refuses the whole answer, so nothing new is linked to someone who no longer agreed.
//   2. Nothing is deleted. A row of this recording and kind that the new answer no longer holds (a stretch a later
//      enrolment named, a threshold changed) is answered as superseded (`superseded_rows`) and stays readable.
//   3. A row is merged, never replaced, by whoever keeps it, and a row's id is stable, so keeping the same answer again
//      is the same rows.
import { LIST, ROW_PREFIX, ROW_TYPE, STATUS, appearanceRows, consentOf } from '../read-data/appearances.mjs';

const refuse = (code, words) => { throw Object.assign(new Error(words), { code }); };
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);

function refuseUnconsented(consents, relies) {
  if (consents !== undefined && !Array.isArray(consents)) refuse('bad_input', 'consents is a list of { how, person, consent } read from the prints, no numbers.');
  const held = new Set((consents ?? []).filter(item => object(item) && consentOf({ consent: item.consent }).length).map(item => `${item.how}:${item.person}`));
  for (const [how, person] of relies) {
    if (!held.has(`${how}:${person}`)) refuse('no_consent', `There is no ${how} print with consent words for person ${person}, so nobody is linked to them by their ${how}.`);
  }
}

function earlierRows(earlier, recording, how) {
  if (earlier !== undefined && !Array.isArray(earlier)) refuse('bad_input', 'earlier is a list of the appearance records already kept for this recording: [{ id, value }].');
  const rows = [];
  for (const record of earlier ?? []) {
    if (typeof record?.id === 'string' && record.id.startsWith(ROW_PREFIX) && record.value?.recording === recording && record.value?.how === how) rows.push({ id: record.id.slice(ROW_PREFIX.length), values: record.value });
  }
  return rows;
}

export function keepWhoAppeared(input, { now = () => new Date() } = {}) {
  const made = appearanceRows(input, { now: now() });
  refuseUnconsented(input.consents, made.relies);
  const keeping = new Set(made.rows.map(row => row.id));
  const stale = [];
  for (const how of made.kinds) {
    for (const row of earlierRows(input.earlier, made.recording, how)) {
      if (!keeping.has(row.id) && row.values.status !== STATUS.superseded) stale.push({ id: row.id, values: { status: STATUS.superseded } });
    }
  }
  const count = status => made.rows.filter(row => row.values.status === status).length;
  return {
    list: LIST, list_id: LIST.id, recording: made.recording, kept: made.rows.length, named: count(STATUS.named), possible: count(STATUS.possible),
    unknown: count(STATUS.unknown), superseded: stale.length, row_ids: made.rows.map(row => `${LIST.id}/${row.id}`),
    row_type: ROW_TYPE, rows: made.rows, superseded_rows: stale,
  };
}
