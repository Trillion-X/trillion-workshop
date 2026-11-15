// Compatibility entry and granted-folder adapter. Slot validation and the single-use holder
// have one implementation in guarded-upload-core.mjs; existing module exports keep those bindings.
import { readFileSync, realpathSync, statSync } from 'node:fs';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import { uploadSettings, checkSlot, makeGuardedUploads, fillUploadMessage as fill, uploadRefusal as refusal } from './guarded-upload-core.mjs';
export { uploadSettings, checkSlot, makeGuardedUploads };

/** The Workshop entry: read `input.file` from the granted folder, hold it once and send it to the checked `input.slot`.
 *  stdin = { input: { file, content_type, slot: { url, fields } }, folder }. Answers { sent, size, said }. */
export async function uploadFromFolder({ input = {}, folder } = {}, { settings = uploadSettings(), fetchImpl = fetch } = {}) {
  const name = String(input.file ?? '');
  if (typeof folder !== 'string' || !folder) throw refusal(settings.words.no_folder, 403);
  if (!name || isAbsolute(name) || name.split(/[\\/]/).includes('..')) throw refusal(fill(settings.words.outside_folder, { file: name }), 400);
  const root = realpathSync(folder);
  let path;
  try { path = realpathSync(resolve(root, name)); } catch { throw refusal(fill(settings.words.no_such_file, { file: name }), 404); }
  const inside = relative(root, path);
  if (!inside || inside.startsWith(`..${sep}`) || inside === '..' || isAbsolute(inside)) throw refusal(fill(settings.words.outside_folder, { file: name }), 400);
  const facts = statSync(path);
  if (!facts.isFile()) throw refusal(fill(settings.words.no_such_file, { file: name }), 404);
  if (facts.size > settings.max_hold_bytes) throw refusal(fill(settings.words.too_big, { bytes: facts.size, max: settings.max_hold_bytes }), 413);
  checkSlot(input.slot, input.content_type, settings);
  const uploads = makeGuardedUploads({ settings, fetchImpl });
  const held = uploads.prepare({ bytes: readFileSync(path), contentType: input.content_type, name: path.split(sep).pop() });
  return uploads.send({ id: held.id, slot: input.slot });
}
