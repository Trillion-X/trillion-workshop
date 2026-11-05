// tools/render-a-motion-graphics-overlay/do-work/render-overlay.mjs
//
// The row's command. Reads the request on stdin; when it names `spec_record` (a piece's row of list:settings,
// record:setting:render-a-motion-graphics-overlay~piece~<spec id>, whose settings.spec is the spec), reads that row
// through the run's records door and puts its spec in the request. Then runs the renderer under tools/settings
// run-with-settings, which replaces a `settings_record` id (the film's look) with the record itself; the program lays
// it under the request's own `settings` (settings.request_settings). The program's last line is printed unchanged.
//
//   node do-work/render-overlay.mjs < request.json
import { Readable } from 'node:stream';
import { text } from 'node:stream/consumers';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readSettingRecord, settingsOf } from '../../settings/read-data/settings.mjs';
import { runWithSettings } from '../../settings/do-work/run-with-settings.mjs';
import { openRecordsDoor } from '../../records-door/read-data/records-door.mjs';

export const FOLDER = 'render-a-motion-graphics-overlay';
const here = dirname(fileURLToPath(import.meta.url));

export class OverlayRequestError extends Error {}

/** The request with its spec read from `spec_record`, when it names one. */
export async function withSpec(request, door) {
  if (request === null || typeof request !== 'object' || Array.isArray(request)) throw new OverlayRequestError('The request must be one JSON object.');
  if (request.spec_record === undefined) {
    if (request.spec === undefined) throw new OverlayRequestError('Give the spec, or spec_record naming a record:setting:render-a-motion-graphics-overlay~piece~<spec id> row whose settings hold it.');
    return request;
  }
  if (request.spec !== undefined) throw new OverlayRequestError('Give spec or spec_record, not both.');
  const record = await readSettingRecord(door, request.spec_record, { folder: FOLDER });
  if (!record) throw new OverlayRequestError(`No ${request.spec_record} in list:settings. Write the piece's row first, or give the spec itself.`);
  const held = settingsOf(record, `tool:${FOLDER}`);
  if (!held || typeof held.spec !== 'object' || held.spec === null) throw new OverlayRequestError(`${request.spec_record} holds no settings.spec; a piece's row keeps its spec there.`);
  const { spec_record: _, ...rest } = request;
  return { ...rest, spec: held.spec, spec_from: { id: request.spec_record, from: record.value.from ?? null } };
}

export async function renderOverlay({ stdin = process.stdin, door: givenDoor, out = process.stdout, python = 'python3' } = {}) {
  const request = JSON.parse((await text(stdin)) || '{}');
  const needsDoor = request?.spec_record !== undefined || request?.settings_record !== undefined;
  const door = needsDoor ? (givenDoor ?? openRecordsDoor()) : undefined;
  const handed = await withSpec(request, door);
  return runWithSettings(['--folder', FOLDER, '--', python, join(here, 'render_a_motion_graphics_overlay.py')],
    { stdin: Readable.from([JSON.stringify(handed)]), door, out });
}

if (import.meta.url === `file://${process.argv[1]}`) {
  try {
    process.exitCode = await renderOverlay();
  } catch (error) {
    console.log(JSON.stringify({ error: error.message, ...(error.code ? { code: error.code } : {}) }));
    process.exitCode = 1;
  }
}
