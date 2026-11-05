// tools/shape-a-thought-into-my-content-formats/do-work/answer-the-content-formats-page.mjs
//
// The Formats page's routes, answered by old trillion's owner (read-data/content-formats.mjs, ported from
// src/content-formats.mjs at tag old-trillion-before-worker-retire) over the person's own records and files through the
// run's records door. The engine runs this as a @workshop-routes tool: input { path, method, query, body, browser },
// result { status, body }.
//
//   GET  /content-formats            the person's saved formats, then the starters
//   POST /content-formats            replaces the person's own list
//   GET  /content-formats/sources    their recordings, notes and pursuits a format can be filled from, newest first
//   POST /content-formats/shape      one thought or source dropped into each format
//   POST /content-formats/follow     how far through a script the words heard reach
//
// Where the old owner kept things, and where they are here:
//   - the saved list (workshop fact `content-formats`) is the one record { id: "content-formats", type:
//     "content-formats", value: { formats: [...] } };
//   - recordings and notes (the `files` reader over Namespace listings) are the person's Namespace files under each
//     source kind's folders and every folder beneath them, reached with the door's list_files and read_file;
//   - pursuits (the engine's pursuit rows) are the person's `pursuit` records.
// A source is named by its file's identity, as the old listing named it; its words are read only when that identity is
// one of the kind's own files, so a source outside the account, or outside the kind's folders, is not in this account.
import { handleContentFormatsRequest, makeContentFormats } from '../read-data/content-formats.mjs';

export const RECORD = Object.freeze({ id: 'content-formats', type: 'content-formats' });
const MOST_SOURCE_BYTES = 256 * 1024;
const LISTED_PER_FOLDER = 50;
const READ_BYTES = 262144;
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const folderOf = name => (name.endsWith('/') ? name : `${name}/`);
const baseName = name => name.slice(name.lastIndexOf('/') + 1);
const titleOf = (kind, name) => (kind.title_drops && name.endsWith(kind.title_drops) ? baseName(name).slice(0, -kind.title_drops.length) : baseName(name));

// Every file under one folder and every folder beneath it, up to LISTED_PER_FOLDER names a folder.
async function filesUnder(files, folder) {
  const found = [];
  const walk = async at => {
    const page = await files('list_files', { folder: folderOf(at), limit: LISTED_PER_FOLDER }).catch(() => null);
    if (!page) return;
    found.push(...(page.names ?? []));
    for (const child of page.folders ?? []) await walk(typeof child === 'string' ? child : child.name);
  };
  await walk(folder);
  return found;
}

// The kind's own files: under its folders, with one of its name endings and small enough to read.
async function kindFiles(files, kind) {
  const rows = [];
  for (const folder of kind.folders ?? []) rows.push(...await filesUnder(files, folder));
  return rows.filter(row => typeof row?.name === 'string' && (kind.name_endings ?? []).some(end => row.name.endsWith(end)) && row.byte_length <= MOST_SOURCE_BYTES);
}

async function textOf(files, name) {
  const parts = [];
  let offset = 0, total = null;
  for (;;) {
    const page = await files('read_file', { name_or_identity: name, offset, length: READ_BYTES });
    total = page.byte_length;
    if (!page.bytes_returned) break;
    parts.push(Buffer.from(page.content ?? '', page.encoding === 'base64' ? 'base64' : 'utf8'));
    offset += page.bytes_returned;
    if (offset >= total) break;
  }
  return Buffer.concat(parts).toString('utf8');
}

/** The source readers the old person store gave makeContentFormats, over the door. */
export function doorReaders(door) {
  const files = (operation, input) => door.files(operation, input);
  const pursuits = async () => {
    const rows = [];
    for await (const record of door.list({ type: 'pursuit' })) if (object(record.value)) rows.push({ id: record.id, ...record.value });
    return rows.sort((a, b) => String(b.recorded_at ?? '').localeCompare(String(a.recorded_at ?? '')));
  };
  return {
    pursuits: {
      list: async (kind, limit) => (await pursuits()).slice(0, limit).map(row => ({ id: row.id, title: row[kind.title] ?? '', at: row.recorded_at ?? '' })),
      words: async (kind, id) => {
        const row = (await pursuits()).find(one => one.id === id);
        return row ? { title: row[kind.title] ?? '', words: (kind.fields ?? []).map(key => row[key]).filter(value => typeof value === 'string').join('\n') } : null;
      },
    },
    files: {
      list: async (kind, limit) => (await kindFiles(files, kind))
        .sort((a, b) => (b.modified_at_ms ?? 0) - (a.modified_at_ms ?? 0)).slice(0, limit)
        .map(row => ({ id: row.identity, title: titleOf(kind, row.name), at: row.modified_at_ms ? new Date(row.modified_at_ms).toISOString() : '' })),
      words: async (kind, identity) => {
        const row = (await kindFiles(files, kind)).find(one => one.identity === identity);
        if (!row) return null;
        const text = await textOf(files, row.name);
        const at = kind.words_after ? text.indexOf(kind.words_after) : -1;
        return { title: titleOf(kind, row.name), words: at >= 0 ? text.slice(at + kind.words_after.length) : text };
      },
    },
  };
}

/** tool:answer-the-content-formats-page: run by tools/records-door/do-work/run-an-export.mjs as fn(input, { door }). */
export async function answerTheContentFormatsPage(input, { door }) {
  const { path = '', method = 'GET', query = {}, body } = object(input) ? input : {};
  const kept = await door.read(RECORD.type, RECORD.id);
  let saved = Array.isArray(kept?.formats) ? kept.formats : null;
  let changed = false;
  const store = { saved: () => saved, putSaved: list => { saved = structuredClone(list); changed = true; } };
  const formats = makeContentFormats({ store, readers: doorReaders(door) });
  const search = new URLSearchParams(object(query) ? query : {}).toString();
  const request = new Request(`https://person${path}${search ? `?${search}` : ''}`, method === 'GET' ? {} : { method, body: JSON.stringify(body ?? {}) });
  const response = await handleContentFormatsRequest(formats, request);
  // A save is checked whole before putSaved, so only a save that passed writes; its answer is what it kept.
  if (changed) await door.write([{ ...RECORD, value: { formats: saved } }]);
  return { status: response.status, body: await response.json() };
}
