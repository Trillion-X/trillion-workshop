// File input for the existing writing gate. The caller's granted folder is the
// only source; source bytes never become part of this wrapper's result.
import { constants, closeSync, fstatSync, openSync, readFileSync, readSync, realpathSync } from 'node:fs';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import { text } from 'node:stream/consumers';
import { checkWritingAgainstItsRecipe } from './check-writing-against-its-recipe.mjs';

const refuse = code => { throw Object.assign(new Error(code), { code }); };
const limits = JSON.parse(readFileSync(new URL('../read-data/write-file-limits.json', import.meta.url), 'utf8'));

export function checkWritingFile(input, { folder, maxBytes = limits.max_bytes } = {}) {
  if (typeof input?.file !== 'string' || !input.file || isAbsolute(input.file)) refuse('writing_file_needs_relative_path');
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1) refuse('writing_file_needs_byte_bound');
  const root = realpathSync(folder);
  const file = realpathSync(resolve(root, input.file));
  const within = relative(root, file);
  if (!within || within === '..' || within.startsWith(`..${sep}`) || isAbsolute(within)) refuse('writing_file_outside_granted_folder');
  const fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW);
  let bytes;
  try {
    const before = fstatSync(fd);
    if (!before.isFile()) refuse('writing_file_not_regular');
    if (before.size > maxBytes) refuse('writing_file_over_byte_bound');
    const buffer = Buffer.alloc(maxBytes + 1);
    let length = 0, read;
    while (length < buffer.length && (read = readSync(fd, buffer, length, buffer.length - length, null)) > 0) length += read;
    const after = fstatSync(fd);
    if (length > maxBytes) refuse('writing_file_over_byte_bound');
    if (before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs) refuse('writing_file_changed_during_read');
    bytes = buffer.subarray(0, length);
  } finally { closeSync(fd); }
  let request;
  try { request = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)); }
  catch { refuse('writing_file_invalid_utf8_json'); }
  if (request === null || typeof request !== 'object' || Array.isArray(request)) refuse('writing_file_needs_request_object');
  if (input.recipe !== undefined) {
    request.recipe = input.recipe;
    delete request.recipe_id;
  } else if (input.recipe_id !== undefined) {
    request.recipe_id = input.recipe_id;
    delete request.recipe;
  }
  return checkWritingAgainstItsRecipe(request);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  try {
    const input = JSON.parse((await text(process.stdin)) || '{}');
    console.log(JSON.stringify({ result: checkWritingFile(input, { folder: process.argv[2] }) }));
  } catch (error) {
    console.log(JSON.stringify({ error: error.code ?? 'writing_file_check_failed' }));
    process.exitCode = 1;
  }
}
