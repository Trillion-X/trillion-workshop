// tools/render-a-motion-graphics-overlay/do-work/render-insert.mjs
//
// The command of tool:render-an-overlay-insert-for-a-cut. Reads the request on stdin and, through the run's records door:
//   - spec_record (one) or spec_records (a batch): each a piece's row of list:settings whose settings.spec is the shot;
//   - settings_record: the film's look row, read here (not left to run-with-settings) so its `insert` section's
//     claim_check.settings_record can be read too;
//   - claim_check.settings_record (in the request, or else in the look's insert section): the person's row of
//     tool:check-every-claim-against-its-facts-and-sources, handed to that check as the record itself.
// Then runs do-work/render_an_overlay_insert.py and prints its last line unchanged.
//
//   node do-work/render-insert.mjs < request.json
import { Readable } from 'node:stream';
import { text } from 'node:stream/consumers';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isSettingId, readSettingRecord, settingsOf } from '../../settings/read-data/settings.mjs';
import { runWithSettings } from '../../settings/do-work/run-with-settings.mjs';
import { openRecordsDoor } from '../../records-door/read-data/records-door.mjs';
import { withSpec, FOLDER, OverlayRequestError } from './render-overlay.mjs';

export const CLAIMS_FOLDER = 'check-every-claim-against-its-facts-and-sources';
const here = dirname(fileURLToPath(import.meta.url));

/** The claim check's request with its settings row read, when it names one by id. */
async function withClaimRow(claimCheck, door) {
  if (!claimCheck || typeof claimCheck !== 'object' || !isSettingId(claimCheck.settings_record)) return claimCheck;
  const record = await readSettingRecord(door, claimCheck.settings_record, { folder: CLAIMS_FOLDER });
  if (!record) throw new OverlayRequestError(`No ${claimCheck.settings_record} in list:settings: write the claim check's row first, or give claim_check.settings as an object.`);
  return { ...claimCheck, settings_record: record };
}

/** The request with every row it names read: the shots, the look and the claim check's settings. */
export async function withRows(request, door) {
  if (request === null || typeof request !== 'object' || Array.isArray(request)) throw new OverlayRequestError('The request must be one JSON object.');
  let handed = { ...request };
  if (handed.spec_records !== undefined) {
    if (handed.specs !== undefined || handed.spec !== undefined || handed.spec_record !== undefined) throw new OverlayRequestError('Give one of spec, spec_record, specs or spec_records.');
    if (!Array.isArray(handed.spec_records) || handed.spec_records.length === 0) throw new OverlayRequestError('spec_records must be a non-empty list of piece row ids.');
    const specs = [];
    for (const id of handed.spec_records) specs.push((await withSpec({ spec_record: id }, door)).spec);
    const { spec_records: ids, ...rest } = handed;
    handed = { ...rest, specs, specs_from: ids };
  } else if (handed.specs === undefined) {
    handed = await withSpec(handed, door);
  }
  if (isSettingId(handed.settings_record)) {
    const record = await readSettingRecord(door, handed.settings_record, { folder: FOLDER });
    if (!record) throw new OverlayRequestError(`No ${handed.settings_record} in list:settings: write the film's look row first, or give settings.`);
    handed = { ...handed, settings_record: record, settings_from: { id: record.id, from: record.value.from ?? null } };
  }
  if (handed.claim_check !== undefined) {
    handed.claim_check = await withClaimRow(handed.claim_check, door);
  } else if (handed.settings_record && typeof handed.settings_record === 'object') {
    const inLook = settingsOf(handed.settings_record, `tool:${FOLDER}`)?.insert?.claim_check;
    if (inLook) handed.claim_check = await withClaimRow(inLook, door);
  }
  return handed;
}

function namesRows(request) {
  const look = request?.settings_record;
  return request?.spec_record !== undefined || request?.spec_records !== undefined || isSettingId(look)
    || isSettingId(request?.claim_check?.settings_record);
}

export async function renderInsert({ stdin = process.stdin, door: givenDoor, out = process.stdout, python = 'python3' } = {}) {
  const request = JSON.parse((await text(stdin)) || '{}');
  const door = namesRows(request) ? (givenDoor ?? openRecordsDoor()) : givenDoor;
  const handed = await withRows(request, door);
  return runWithSettings(['--folder', FOLDER, '--', python, join(here, 'render_an_overlay_insert.py')],
    { stdin: Readable.from([JSON.stringify(handed)]), door, out });
}

if (import.meta.url === `file://${process.argv[1]}`) {
  try {
    process.exitCode = await renderInsert();
  } catch (error) {
    console.log(JSON.stringify({ error: error.message, ...(error.code ? { code: error.code } : {}) }));
    process.exitCode = 1;
  }
}
