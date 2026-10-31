// tools/check-a-folder-against-my-rules/do-work/repair-control-bytes-in-my-folder.mjs
//
// Writes a raw control byte in the source files a person names as the escape that means the same
// character (do-work/write-control-bytes-as-escapes.mjs). Run by the Workshop tool
// `tool:rewrite-control-bytes-as-escapes` on the person's computer, in a folder they granted for change:
//
//   node do-work/repair-control-bytes-in-my-folder.mjs <the granted folder> < { "files": ["<path inside it>", ...] }
//
// A path is named, never discovered, and must lie inside the folder: a file that is not a regular file there
// (a link, a path that leaves the folder, a special file) is left alone and says why, through the same reader
// that judges source. It prints { result: { rewritten, left_alone, each } } on its last line.
import { stat } from 'node:fs/promises';
import path from 'node:path';
import { text } from 'node:stream/consumers';
import { readSourceFileInRepository } from './read-source-file-in-repository.mjs';
import { writeControlBytesAsEscapesIn } from './write-control-bytes-as-escapes.mjs';

const isFolder = (candidate) => stat(candidate).then((found) => found.isDirectory(), () => false);

try {
  const folder = process.argv[2];
  if (!folder || !path.isAbsolute(folder) || !(await isFolder(folder))) {
    throw new Error('the granted folder was not given as an absolute path to a folder');
  }
  const { files } = JSON.parse((await text(process.stdin)) || '{}');
  if (!Array.isArray(files) || files.length === 0 || files.some((file) => typeof file !== 'string')) {
    throw new Error('name the files to rewrite: files is a list of paths inside the folder');
  }
  const each = files.map((file) => {
    const custody = readSourceFileInRepository(folder, file, { contentRequired: false, regularRequired: true });
    if (custody.status !== 'read') return { path: file, changed: false, why: custody.reason ?? custody.status };
    try {
      return { ...writeControlBytesAsEscapesIn(path.join(folder, file)), path: file };
    } catch (error) {
      return { path: file, changed: false, why: String(error.message ?? error) };
    }
  });
  const refused = each.some((one) => !one.changed && one.found);
  console.log(JSON.stringify({
    result: { rewritten: each.filter((one) => one.changed).length, left_alone: each.filter((one) => !one.changed).length, each },
  }));
  process.exitCode = refused ? 1 : 0;
} catch (error) {
  console.log(JSON.stringify({ error: error.message }));
  process.exitCode = 2;
}
