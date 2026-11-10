// tools/keep-a-local-file-in-my-files/read-data/keep-a-local-file.mjs
//
// Keeps one file from the person's computer in their Files, written through the records door in pieces that each fit
// one door message (records-door's writeWholeFile). The file is read whole, so it must be a regular file no larger than
// the whole-file bound; a link, a folder or a bigger file is refused with its reason. Nothing is deleted or moved here.
import { lstat, readFile } from 'node:fs/promises';
import { isAbsolute } from 'node:path';
import { writeWholeFile, MOST_BYTES } from '../../records-door/read-data/whole-file.mjs';

const NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*(\/[A-Za-z0-9][A-Za-z0-9._-]*)*$/;
const MEDIA = /^[a-z]+\/[a-z0-9.+-]+$/;

function refuse(reason) {
  throw Object.assign(new Error(reason), { code: 'refused' });
}

/** Keeps the local file at `path` in the person's Files as `name`. Returns the bytes kept and the door's finish answer. */
export async function keepALocalFile({ path, name, media_type = 'application/octet-stream' } = {}, { door, read = readFile, stat = lstat } = {}) {
  if (typeof path !== 'string' || !isAbsolute(path)) refuse('The local file must be named by its full path.');
  if (typeof name !== 'string' || !NAME.test(name) || name.split('/').some(part => part === '..')) refuse('The name in Files is not a valid name.');
  if (typeof media_type !== 'string' || !MEDIA.test(media_type)) refuse('The media type is not valid.');
  const info = await stat(path);
  if (info.isSymbolicLink()) refuse('A link is not kept; name the file itself.');
  if (!info.isFile()) refuse('Only a regular file can be kept.');
  if (info.size > MOST_BYTES) refuse('The file is larger than the most this tool keeps in one go.');
  const bytes = await read(path);
  const finished = await writeWholeFile(door, name, bytes, { mediaType: media_type });
  return { name, bytes: bytes.length, media_type, finished };
}
