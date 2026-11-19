// tools/shape-a-thought-into-my-content-formats/do-work/answer-the-content-formats-page.mjs
//
// The Formats page's routes, answered by old trillion's owner (read-data/content-formats.mjs, ported from
// src/content-formats.mjs at tag old-trillion-before-worker-retire). The engine runs this as a @workshop-routes tool:
// input { path, method, query, body, browser, saved, pursuits, stored }, result { status, body }. It reads and keeps
// nothing itself: the person's saved list (`saved`), pursuit rows (`pursuits`) and recordings and notes (`stored.files`)
// are read by the caller's AI from where the person keeps them and handed in, and a save answers the list it checked and
// would keep, for the caller to store.
//
//   GET  /content-formats            the person's saved formats, then the starters
//   POST /content-formats            checks the person's own list and answers it (nothing is stored here)
//   GET  /content-formats/sources    their recordings and notes by name, then their pursuits newest first
//   POST /content-formats/shape      one thought or source dropped into each format
//   POST /content-formats/follow     how far through a script the words heard reach
//
// Where the old owner kept things, and where they are here:
//   - the saved list (workshop fact `content-formats`) is the request's `saved` list of formats;
//   - recordings and notes (the `files` reader over Namespace listings) are the files handed in as `stored.files`
//     ({ name: text | { base64 } }) under each source kind's folders and every folder beneath them;
//   - pursuits (the engine's pursuit rows) are the request's `pursuits`, each { id, ...value }.
// A source is named by its file's identity, as the old listing named it; its words are read only when that identity is
// one of the kind's own files handed in, so a source not handed in, or outside the kind's folders, is not in this account.
import { makeHashCodeHexFromBytes } from '../../content-identity/read-data/identity.mjs';
import { handleContentFormatsRequest, makeContentFormats } from '../read-data/content-formats.mjs';

const MOST_SOURCE_BYTES = 256 * 1024;
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const folderOf = name => (name.endsWith('/') ? name : `${name}/`);
const baseName = name => name.slice(name.lastIndexOf('/') + 1);
const titleOf = (kind, name) => (kind.title_drops && name.endsWith(kind.title_drops) ? baseName(name).slice(0, -kind.title_drops.length) : baseName(name));
const bytesOf = held => (typeof held === 'string' ? Buffer.from(held, 'utf8')
  : Buffer.from(object(held) && typeof held.base64 === 'string' ? held.base64 : '', 'base64'));

// The files handed in, each { name, identity, bytes }, in name order.
const filesOf = given => Object.entries(object(given) ? given : {})
  .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
  .map(([name, held]) => { const bytes = bytesOf(held); return { name, identity: makeHashCodeHexFromBytes(bytes), bytes }; });

// The kind's own files: under its folders, with one of its name endings and small enough to read.
const kindFiles = (files, kind) => files.filter(file => (kind.folders ?? []).some(folder => file.name.startsWith(folderOf(folder)))
  && (kind.name_endings ?? []).some(end => file.name.endsWith(end)) && file.bytes.length <= MOST_SOURCE_BYTES);

/** The source readers the old person store gave makeContentFormats, over the files and pursuit rows handed in. */
export function givenReaders(givenFiles = {}, pursuitRows = []) {
  const files = filesOf(givenFiles);
  const pursuits = pursuitRows.filter(row => object(row) && typeof row.id === 'string')
    .sort((a, b) => String(b.recorded_at ?? '').localeCompare(String(a.recorded_at ?? '')));
  return {
    pursuits: {
      list: async (kind, limit) => pursuits.slice(0, limit).map(row => ({ id: row.id, title: row[kind.title] ?? '', at: row.recorded_at ?? '' })),
      words: async (kind, id) => {
        const row = pursuits.find(one => one.id === id);
        return row ? { title: row[kind.title] ?? '', words: (kind.fields ?? []).map(key => row[key]).filter(value => typeof value === 'string').join('\n') } : null;
      },
    },
    files: {
      list: async (kind, limit) => kindFiles(files, kind).slice(0, limit).map(file => ({ id: file.identity, title: titleOf(kind, file.name), at: '' })),
      words: async (kind, identity) => {
        const file = kindFiles(files, kind).find(one => one.identity === identity);
        if (!file) return null;
        const text = file.bytes.toString('utf8');
        const at = kind.words_after ? text.indexOf(kind.words_after) : -1;
        return { title: titleOf(kind, file.name), words: at >= 0 ? text.slice(at + kind.words_after.length) : text };
      },
    },
  };
}

/** tool:answer-the-content-formats-page: run by tools/workflows/do-work/run-a-function.mjs as fn(input). */
export async function answerTheContentFormatsPage(input) {
  const { path = '', method = 'GET', query = {}, body, saved: given, pursuits = [], stored = {} } = object(input) ? input : {};
  let saved = Array.isArray(given) ? given : null;
  const store = { saved: () => saved, putSaved: list => { saved = structuredClone(list); } };
  const formats = makeContentFormats({ store, readers: givenReaders(object(stored) ? stored.files : {}, Array.isArray(pursuits) ? pursuits : []) });
  const search = new URLSearchParams(object(query) ? query : {}).toString();
  const request = new Request(`https://person${path}${search ? `?${search}` : ''}`, method === 'GET' ? {} : { method, body: JSON.stringify(body ?? {}) });
  const response = await handleContentFormatsRequest(formats, request);
  // A save is checked whole before putSaved; its answer is the list it would keep, for the caller to store.
  return { status: response.status, body: await response.json() };
}
