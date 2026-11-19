// tools/workflows/read-data/write-a-source-copy.mjs
//
// Makes a copy of a repository's files for the person's own files at /source-copies/<root>/, the folder the citation
// resolver reads (citation-resolvers.mjs: a root's `{files}` source). The caller reads git (a Mac-side job) and hands in
// the files' text, the commit dates and the head; this tool never reads a repository and reads or writes no store: the
// caller hands in what is already in that folder as `stored.files` and keeps what the run answers as `keep`.
//
//   writeASourceCopy({ input: { root, ref, head, files: [{ path, text }], dates: { <fullhash>: <ISO date> }, complete?,
//                               stored?: { files: { <name>: text | { text } | { base64 } | null } } }, task })
//     -> { root, head, written, bytes, keep: [{ file, identity, base64, expected }] }
//
// A file not handed in is not there. keep holds, in order, each file whose bytes are not already what was handed in;
// expected is the identity of the file as it was handed in, null when it was not there, so a store refuses a keep whose
// file has moved.
//
// A big copy goes in several runs of one head: every run but the last sends `final: false` and keeps only its files
// (no dates, no stamp, so the stamp never claims the new head early; it returns final:false). The last run sends the
// default `final: true` and `also_held`, the paths the earlier runs wrote, which join the stamp's `files`.
//
// Order: every file, then .commit-dates.json, then .source-copy.json LAST, so a copy whose stamp is old never claims a
// new head. A file handed in that already holds exactly the bytes sent is left out of keep, so the same copy sent twice at
// one head is kept once and answers both times. The stamp's `files` are the sorted paths the copy holds: the earlier
// stamp's files that are still held plus the new ones, or exactly the sent list when `complete` is true.
import { makeHashCodeHexFromBytes } from '../../content-identity/read-data/identity.mjs';

export const MOST_FILES = 64;
export const MOST_TEXT_BYTES = 4 * 1024 * 1024;
const ALLOWED_INPUT = new Set(['root', 'ref', 'head', 'files', 'dates', 'complete', 'final', 'also_held', 'stored']);
export const MOST_ALSO_HELD = 256;
const ROOT = /^[a-z0-9][a-z0-9-]*$/;
export const STAMP = '.source-copy.json';
export const DATES = '.commit-dates.json';

// The same rule the reader applies to a cited path.
const badPath = path => typeof path !== 'string' || !path || path.startsWith('/') || path.includes('\\') || path.split('/').some(part => part === '..' || part === '.' || part === '');
// The bytes of a file handed in, or null when it was handed in as not there.
const bytesOfHeld = held => (held === null || held === undefined ? null
  : typeof held === 'string' ? Buffer.from(held, 'utf8')
  : held.text !== undefined ? Buffer.from(String(held.text), 'utf8') : Buffer.from(String(held.base64 ?? ''), 'base64'));

export async function writeASourceCopy({ input = {}, task = {} } = {}) {
  for (const key of Object.keys(input)) if (!ALLOWED_INPUT.has(key)) throw new Error(`input.${key} is not taken.`);
  const { root, ref, head, files, dates, complete = false, final = true, also_held = [], stored = {} } = input;
  if (stored === null || typeof stored !== 'object' || Array.isArray(stored)) throw new Error('input.stored must be { files: { name: text or { base64 } } }.');
  const handed = stored.files ?? {};
  if (handed === null || typeof handed !== 'object' || Array.isArray(handed)) throw new Error('input.stored.files must be an object of file name to text or { base64 }.');
  if (typeof root !== 'string' || !ROOT.test(root)) throw new Error('input.root must be lowercase letters, digits and hyphens, starting with a letter or digit.');
  if (typeof ref !== 'string' || !ref) throw new Error('input.ref must name the ref the copy was made from.');
  if (typeof head !== 'string' || !head) throw new Error('input.head must be the commit the copy was made from.');
  if (typeof complete !== 'boolean') throw new Error('input.complete must be true or false.');
  if (typeof final !== 'boolean') throw new Error('input.final must be true or false.');
  if (!Array.isArray(also_held) || also_held.length > MOST_ALSO_HELD) throw new Error(`input.also_held must be a list of at most ${MOST_ALSO_HELD} paths.`);
  for (const path of also_held) if (badPath(path) || path === STAMP || path === DATES) throw new Error(`${JSON.stringify(path)} is not a path inside ${root}.`);
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
  const before = name => (Object.hasOwn(handed, name) ? bytesOfHeld(handed[name]) : null);
  // The earlier stamp; not handed in or unreadable means none.
  let earlier = null;
  try { earlier = JSON.parse(before(`${at}${STAMP}`)?.toString('utf8') ?? 'null'); } catch { earlier = null; }

  const keep = [];
  let bytes = 0;
  const put = (path, text) => {
    const name = `${at}${path}`;
    const data = Buffer.from(text, 'utf8');
    const was = before(name);
    if (was && was.equals(data)) return;
    keep.push({ file: name, identity: makeHashCodeHexFromBytes(data), base64: data.toString('base64'), expected: was ? makeHashCodeHexFromBytes(was) : null });
    bytes += data.length;
  };
  for (const file of files) put(file.path, file.text);
  if (!final) return { root, head, written: files.length, bytes, final: false, keep };
  put(DATES, JSON.stringify(dates));
  const held = new Set([...files.map(file => file.path), ...also_held]);
  if (!complete && Array.isArray(earlier?.files)) for (const path of earlier.files) if (typeof path === 'string' && !badPath(path)) held.add(path);
  const stamp = { ref, head, copied_at: task.at ?? task.time ?? new Date().toISOString(), files: [...held].sort(), complete };
  put(STAMP, JSON.stringify(stamp));
  return { root, head, written: files.length, bytes, keep };
}
