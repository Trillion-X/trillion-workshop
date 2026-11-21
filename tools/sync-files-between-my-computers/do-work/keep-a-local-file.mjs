// tools/sync-files-between-my-computers/do-work/keep-a-local-file.mjs
//
// Keeps files from the person's computer in their Files under the names they choose. One file (path, name) or a list
// (files: [{ path, name, media_type }]) is kept in order; each file is kept by workflows' keepLocalFile (read-data/whole-file.mjs), which
// sends a small file in pieces and a file above the whole-file threshold in raw pieces (tools/records-door read-data/raw-pieces.mjs).
//
// Non-Negotiable Invariants:
//   1. A link, a folder, a relative path, a bad name, or a file that cannot be read is refused with its reason, and
//      nothing is sent for it.
//   2. One file's refusal or failure does not stop the others: the answer lists what was kept and what was refused, each
//      with its reason, so a run that failed halfway says which files still need keeping.
//   3. Nothing is deleted or moved here. A file is read in place.
//   5. A file's upload id is made from its name, length, change time and file number, so the next run of an unchanged file
//      goes on with an upload a run left partway.
//   4. A run keeps at most DATA `most_files` (keep-a-local-file.json) files.
//
//   keepALocalFile({ path, name, media_type } | { files: [...] }, host) — `host` (the run's host actions) is read only when a file is kept
//     → { kept: [{ name, bytes, media_type, finished }], refused: [{ path, name, code, reason }] }
import { lstat } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { isAbsolute } from 'node:path';
import { keepLocalFile } from '../../workflows/read-data/whole-file.mjs';
import { makeHashCodeHexFromBytes } from '../../content-identity/read-data/identity.mjs';

const SETTINGS = JSON.parse(readFileSync(new URL('./keep-a-local-file.json', import.meta.url), 'utf8'));

// A name in Files is absolute: it starts with the root's slash, as the engine's Files write contract requires.
const NAME = /^\/[A-Za-z0-9][A-Za-z0-9._-]*(\/[A-Za-z0-9][A-Za-z0-9._-]*)*$/;
const MEDIA = /^[a-z]+\/[a-z0-9.+-]+$/;

function refuse(reason) {
  throw Object.assign(new Error(reason), { code: 'refused' });
}

async function keepOne({ path, name, media_type = 'application/octet-stream' } = {}, context) {
  if (typeof path !== 'string' || !isAbsolute(path)) refuse('The local file must be named by its full path.');
  if (typeof name !== 'string' || !NAME.test(name) || name.split('/').some(part => part === '..')) refuse('The name in Files is not a valid name.');
  if (typeof media_type !== 'string' || !MEDIA.test(media_type)) refuse('The media type is not valid.');
  const info = await (context.stat ?? lstat)(path);
  if (info.isSymbolicLink()) refuse('A link is not kept; name the file itself.');
  if (!info.isFile()) refuse('Only a regular file can be kept.');
  // The host's files right is used only when a file is kept: a run that keeps nothing never asks for it.
  // The upload id is the file's own (its name in Files, its length, its change time and its file number), so a run that
  // ends partway, as a run past its deadline does, is gone on with from where the upload stands by the next run of the
  // same file, never sent from the start again (a 3,020,837,328-byte card file was cut at 2 minutes on Nov 21 2026).
  const uploadId = makeHashCodeHexFromBytes(Buffer.from(`keep-a-local-file\0${name}\0${info.size}\0${info.mtimeMs}\0${info.ino}`)).slice(3, 35);
  const finished = await keepLocalFile(context, name, path, { mediaType: media_type, uploadId });
  return { name, bytes: info.size, media_type, finished };
}

export async function keepALocalFile(input = {}, context = {}) {
  const list = Array.isArray(input.files) ? input.files : [input];
  if (list.length < 1 || list.length > SETTINGS.most_files) refuse(`A run keeps 1 to ${SETTINGS.most_files} files.`);
  const kept = [];
  const refused = [];
  for (const file of list) {
    try {
      kept.push(await keepOne(file, context));
    } catch (error) {
      refused.push({ path: file?.path ?? null, name: file?.name ?? null, code: error.code ?? 'failed', reason: error.message });
    }
  }
  return { kept, refused };
}
