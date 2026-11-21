// tools/render-a-motion-graphics-overlay/do-work/render-insert.mjs
//
// The command of tool:render-an-overlay-insert-for-a-cut. Reads the request on stdin; the rows it works from come in the
// request itself, read by the person's AI from their settings table and given as the rows (no records door is opened,
// nothing is kept):
//   - spec (one) or specs (a batch): the shots, each a piece row's settings.spec;
//   - settings_record: the film's look row as { id, type, value };
//   - claim_check.settings_record: the person's row of tool:check-every-claim-against-its-facts-and-sources, as
//     { id, type, value }, in the request or in the look's insert section. A look whose insert section names that row by
//     id is refused: give claim_check with the row itself.
// Then runs do-work/render_an_overlay_insert.py and prints its last line unchanged.
//
//   node do-work/render-insert.mjs < request.json
import { text } from 'node:stream/consumers';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { isSettingId, settingsOf } from '../../settings/read-data/settings.mjs';
import { FOLDER, OverlayRequestError, refuseRowIds, runProgram } from './render-overlay.mjs';
import { realpathSync } from 'node:fs';

export const CLAIMS_FOLDER = 'check-every-claim-against-its-facts-and-sources';
const here = dirname(fileURLToPath(import.meta.url));

/** The request, once it holds its shots and its rows themselves, never their ids. */
export function withRows(request) {
  if (request === null || typeof request !== 'object' || Array.isArray(request)) throw new OverlayRequestError('The request must be one JSON object.');
  if (request.spec_record !== undefined || request.spec_records !== undefined) throw new OverlayRequestError("spec_record and spec_records are not read here: give the piece rows' settings.spec as spec or specs.");
  refuseRowIds(request, ['settings_record']);
  const given = [request.spec, request.specs].filter(item => item !== undefined);
  if (given.length !== 1) throw new OverlayRequestError('Give one of spec or specs.');
  if (request.specs !== undefined && (!Array.isArray(request.specs) || request.specs.length === 0)) throw new OverlayRequestError('specs must be a non-empty list of shots.');
  const claimCheck = request.claim_check ?? (request.settings_record && typeof request.settings_record === 'object'
    ? settingsOf(request.settings_record, `tool:${FOLDER}`)?.insert?.claim_check : undefined);
  if (isSettingId(claimCheck?.settings_record)) {
    throw new OverlayRequestError(`claim_check.settings_record is a row's id: give claim_check with the row itself, { id, type, value }, as your AI read it from the ${CLAIMS_FOLDER} settings.`);
  }
  return request;
}

export async function renderInsert({ stdin = process.stdin, out = process.stdout, python = 'python3' } = {}) {
  const request = JSON.parse((await text(stdin)) || '{}');
  const handed = withRows(request);
  return runProgram([python, join(here, 'render_an_overlay_insert.py')], handed, out);
}

if (import.meta.url === (process.argv[1] ? pathToFileURL(realpathSync(process.argv[1])).href : '')) {
  try {
    process.exitCode = await renderInsert();
  } catch (error) {
    console.log(JSON.stringify({ error: error.message, ...(error.code ? { code: error.code } : {}) }));
    process.exitCode = 1;
  }
}
