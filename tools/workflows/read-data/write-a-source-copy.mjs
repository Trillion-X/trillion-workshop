// tools/workflows/read-data/write-a-source-copy.mjs
//
// Writes a copy of a repository's files into the person's own files at /source-copies/<root>/, the folder the
// citation resolver reads (citation-resolvers.mjs: a root's `{files}` source). The caller reads git (a Mac-side job) and
// hands in the files' text, the commit dates and the head; this tool never reads a repository.
//
//   writeASourceCopy({ input: { root, ref, head, files: [{ path, text }], dates: { <fullhash>: <ISO date> }, complete? }, task }, { door })
//     -> { root, head, written, bytes }
//
// Order: every file, then .commit-dates.json, then .source-copy.json LAST, so a copy whose stamp is old never claims a
// new head. Each write uses an upload id derived from root + head + path, so a retry resumes. The stamp's `files` are the
// sorted paths the copy holds: the earlier stamp's files that are still held plus the new ones, or exactly the sent
// list when `complete` is true.
import { makeHashCodeHexFromBytes } from '../../content-identity/read-data/identity.mjs';
import { readWholeFile, writeWholeFile } from '../../records-door/read-data/whole-file.mjs';

export const MOST_FILES = 64;
export const MOST_TEXT_BYTES = 4 * 1024 * 1024;
const ALLOWED_INPUT = new Set(['root', 'ref', 'head', 'files', 'dates', 'complete']);
const ROOT = /^[a-z0-9][a-z0-9-]*$/;
export const STAMP = '.source-copy.json';
export const DATES = '.commit-dates.json';

// The same rule the reader applies to a cited path.
const badPath = path => typeof path !== 'string' || !path || path.startsWith('/') || path.includes('\\') || path.split('/').some(part => part === '..' || part === '.' || part === '');
const uploadId = (root, head, path) => makeHashCodeHexFromBytes(Buffer.from(`source-copy\n${root}\n${head}\n${path}`, 'utf8')).replace(/^1f:/, '').slice(0, 32);

export async function writeASourceCopy({ input = {}, task = {} } = {}, { door }) {
  for (const key of Object.keys(input)) if (!ALLOWED_INPUT.has(key)) throw new Error(`input.${key} is not taken.`);
  const { root, ref, head, files, dates, complete = false } = input;
  if (typeof root !== 'string' || !ROOT.test(root)) throw new Error('input.root must be lowercase letters, digits and hyphens, starting with a letter or digit.');
  if (typeof ref !== 'string' || !ref) throw new Error('input.ref must name the ref the copy was made from.');
  if (typeof head !== 'string' || !head) throw new Error('input.head must be the commit the copy was made from.');
  if (typeof complete !== 'boolean') throw new Error('input.complete must be true or false.');
  if (!Array.isArray(files)) throw new Error('input.files must be a list of { path, text }.');
  if (files.length > MOST_FILES) throw new Error(`input.files holds ${files.length} files; at most ${MOST_FILES} are taken in one run.`);
  if (dates === null || typeof dates !== 'object' || Array.isArray(dates)) throw new Error('input.dates must be an object of full commit hash to ISO date.');
  const seen = new Set();
  for (const file of files) {
    if (file === null || typeof file !== 'object' || typeof file.text !== 'string') throw new Error('each file must be { path, text } with text a string.');
    if (badPath(file.path)) throw new Error(`${JSON.stringify(file.path)} is not a path inside ${root}.`);
    if (file.path === STAMP || file.path === DATES) throw new Error(`${file.path} is written by this tool, not sent.`);
    if (seen.has(file.path)) throw new Error(`${file.path} is sent twice.`);
    seen.add(file.path);
    if (Buffer.byteLength(file.text, 'utf8') > MOST_TEXT_BYTES) throw new Error(`${file.path} is over ${MOST_TEXT_BYTES} bytes.`);
  }
  for (const [hash, when] of Object.entries(dates)) if (typeof when !== 'string' || Number.isNaN(Date.parse(when)) || !hash) throw new Error(`input.dates.${hash} is not an ISO date.`);

  const at = `/source-copies/${root}/`;
  // The earlier stamp; unreadable means none.
  let earlier = null;
  try {
    const done = await readWholeFile(door, `${at}${STAMP}`);
    earlier = done.bytes ? JSON.parse(done.bytes.toString('utf8')) : null;
  } catch { earlier = null; }

  let bytes = 0;
  const put = async (path, text, mediaType) => {
    const data = Buffer.from(text, 'utf8');
    await writeWholeFile(door, `${at}${path}`, data, { mediaType, uploadId: uploadId(root, head, path) });
    bytes += data.length;
  };
  for (const file of files) await put(file.path, file.text, 'text/plain');
  await put(DATES, JSON.stringify(dates), 'application/json');
  const held = new Set(files.map(file => file.path));
  if (!complete && Array.isArray(earlier?.files)) for (const path of earlier.files) if (typeof path === 'string' && !badPath(path)) held.add(path);
  const stamp = { ref, head, copied_at: task.at ?? task.time ?? new Date().toISOString(), files: [...held].sort(), complete };
  await put(STAMP, JSON.stringify(stamp), 'application/json');
  return { root, head, written: files.length, bytes };
}
