// tools/records-door/read-data/values-door.mjs
//
// The door a tool's run gets when the person's things are given to it as values. The engine keeps none of the person's
// rows or files (trillion-rust signed_in/settings.json: no records or files operation is answered), so the caller (the
// person's AI, which reads and writes the person's own stores directly, in each store's own language) hands the run what
// it reads and keeps what it answers. A tool's code is unchanged: it reads and writes through the same door
// (records-door.mjs recordsDoorFromCall), and this module answers that door from the values.
//
//   stored: { records?: [{ id, type, value }], files?: { name: text | { base64 } }, workspace?: { label: value } }
//   const { door, keep } = valuesDoor(stored, { other })   other(method, input, key, resource): the run's own door, for
//                                                          what is still behind it (tools:run, sharing.*, wake:*)
//   keep() -> [{ id, type, value } | { label, value } | { file, base64 }]   every write, in order; value null removes
//
// Non-Negotiable Invariants:
//   1. Nothing is read from or written to anywhere but the values: a write changes what later reads in the same run see,
//      and is answered back in `keep` for the caller to keep where the person keeps it.
//   2. The answers have the shapes the engine's door gave (records:list pages, records:read { id, type, value },
//      workspace:read's JSON text, the files operations' answers), so a tool written for the door runs as it was.
//   3. No kind, label or file is named here.
import { isDeepStrictEqual } from 'node:util';
import { makeHashCodeHexFromBytes } from '../../content-identity/read-data/identity.mjs';
import { RecordsDoorError, recordsDoorFromCall } from './records-door.mjs';

const FILES = '@own-files';
const SPAN = 65_536;
const refused = (code, words) => { throw new RecordsDoorError(code, words, 'not_started'); };
const wordsOf = text => text.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];

export function valuesDoor({ records = [], files = {}, workspace = {} } = {}, { other } = {}) {
  const kept = new Map(records.map(record => [record.id, record]));
  const stored = new Map(Object.entries(files).map(([name, held]) => [name, Buffer.from(typeof held === 'string' ? held : held?.base64 ?? '', typeof held === 'string' ? 'utf8' : 'base64')]));
  const settings = structuredClone(workspace);
  const written = [];
  const uploads = new Map();
  const named = wanted => [...stored.keys()].find(name => name === wanted || makeHashCodeHexFromBytes(stored.get(name)) === wanted)
    ?? refused('not_found', `No file named ${wanted} was given to this run.`);
  const answers = {
    'records:read': ({ id, type }) => {
      const held = kept.get(id);
      return { id, type, value: held && (!type || held.type === type) ? held.value : null };
    },
    'records:list': ({ type, prefix, limit = 999, after, fields, where, above, below, order, reverse = true }) => {
      const ids = [...kept.values()].filter(record => record.type === type).map(record => record.id).sort();
      if (reverse && !order) ids.reverse();
      const matches = record => !where || Object.entries(where).every(([name, value]) => isDeepStrictEqual(record.value?.[name], value));
      const shown = record => (fields ? { id: record.id, type: record.type, value: Object.fromEntries(fields.filter(name => name in (record.value ?? {})).map(name => [name, record.value[name]])) } : record);
      const from = ids.filter(id => (!prefix || id.startsWith(prefix)) && (above === undefined || id > above) && (below === undefined || id < below));
      const start = after === undefined ? 0 : from.indexOf(after) + 1;
      const page = from.slice(start, start + limit);
      return { records: page.map(id => kept.get(id)).filter(matches).map(shown), next: start + limit < from.length ? page.at(-1) : null };
    },
    'records:search': ({ question, type, limit = 60 }) => {
      const terms = [...new Set(wordsOf(String(question ?? '')))].filter(word => word.length >= 2);
      const holds = record => { const words = wordsOf(JSON.stringify(record.value ?? {})); return terms.every(term => words.some(word => word.startsWith(term))); };
      const found = terms.length ? [...kept.values()].filter(record => (!type || record.type === type) && holds(record)).slice(0, limit) : [];
      return { question, terms, pending: [], unavailable: [], results: found.map((record, at) => ({ id: `record:${record.id}`, record: record.id, type: record.type, found_in: ['written'], score: 1 / (61 + at),
        address: { resource: '@own-records', operation: 'records:read', input: { id: record.id, type: record.type } } })) };
    },
    'records:write': ({ records: items }) => {
      for (const { expected, ...item } of items) {
        if (expected !== undefined && !isDeepStrictEqual(kept.get(item.id) ? { type: kept.get(item.id).type, value: kept.get(item.id).value } : null, expected)) refused('original_command_conflict', `${item.id} is not what this write expected.`);
        item.value === null ? kept.delete(item.id) : kept.set(item.id, item);
        written.push({ id: item.id, type: item.type, value: item.value });
      }
      return { changed: items.length, write_count: items.length };
    },
    'workspace:read': ({ selection: { labels } }) => ({ status: 200, content_type: 'application/json',
      text: JSON.stringify({ records: Object.fromEntries(labels.filter(label => Object.hasOwn(settings, label)).map(label => [label, settings[label]])) }) }),
    'workspace:write': ({ writes }) => {
      for (const { address_label: label, payload } of writes) { settings[label] = structuredClone(payload); written.push({ label, value: payload }); }
      return { changed: writes.length, write_count: writes.length };
    },
    list_files: ({ folder = '/', after, limit = 50 }) => {
      const base = folder.endsWith('/') ? folder : `${folder}/`;
      const under = [...stored.keys()].filter(name => name.startsWith(base)).sort();
      const names = under.filter(name => !name.slice(base.length).includes('/') && (!after || name > after)).slice(0, limit);
      return { names: names.map(name => ({ name, identity: makeHashCodeHexFromBytes(stored.get(name)), byte_length: stored.get(name).length })),
        next_after: names.length === limit ? names.at(-1) : null,
        folders: after ? [] : [...new Set(under.map(name => name.slice(base.length)).filter(rest => rest.includes('/')).map(rest => `${base}${rest.split('/')[0]}`))] };
    },
    find_file: ({ name_or_identity: wanted }) => { const name = named(wanted); return { identity: makeHashCodeHexFromBytes(stored.get(name)), byte_length: stored.get(name).length, names: [name] }; },
    read_file: ({ name_or_identity: wanted, offset = 0, length = SPAN }) => {
      const bytes = stored.get(named(wanted)), part = bytes.subarray(offset, offset + Math.min(length || SPAN, SPAN));
      return { identity: makeHashCodeHexFromBytes(bytes), byte_length: bytes.length, offset, bytes_returned: part.length, encoding: 'base64', content: part.toString('base64') };
    },
    search: ({ question, limit = 60 }) => {
      const terms = [...new Set(wordsOf(String(question ?? '')))].filter(word => word.length >= 2);
      const hits = terms.length ? [...stored.keys()].filter(name => { const words = wordsOf(name.split('/').at(-1)); return terms.every(term => words.some(word => word.startsWith(term))); }).sort().slice(0, limit) : [];
      return { question, terms, pending: [], unavailable: [], results: hits.map((path, at) => ({ id: `file:${path}`, source: 'files', name: path.split('/').at(-1), path, found_in: ['name'], score: 0.8 / (61 + at),
        address: { resource: FILES, operation: 'find_file', input: { name_or_identity: path } } })) };
    },
    write_file_start: ({ upload_id: id, name, byte_length: length }) => {
      const upload = uploads.get(id) ?? { name, length, pieces: new Map() };
      uploads.set(id, upload);
      return { upload_id: id, next_offset: [...upload.pieces.values()].reduce((sum, piece) => sum + piece.length, 0) };
    },
    write_file_piece: ({ upload_id: id, offset, content_base64: content }) => {
      const upload = uploads.get(id) ?? refused('not_found', `No upload ${id} was started in this run.`);
      upload.pieces.set(offset, Buffer.from(content ?? '', 'base64'));
      return { upload_id: id, next_offset: offset + upload.pieces.get(offset).length };
    },
    write_file_finish: ({ upload_id: id, name }) => {
      const upload = uploads.get(id) ?? refused('not_found', `No upload ${id} was started in this run.`);
      const bytes = Buffer.concat([...upload.pieces].sort(([a], [b]) => a - b).map(([, piece]) => piece));
      stored.set(name, bytes);
      written.push({ file: name, base64: bytes.toString('base64') });
      return { identity: makeHashCodeHexFromBytes(bytes), name, byte_length: bytes.length };
    },
  };
  const call = async (method, input, key, resource) => (Object.hasOwn(answers, method)
    ? answers[method](input ?? {})
    : other ? other(method, input, key, resource) : refused('door_does_not_grant', `${method} is not answered here: nothing behind this run answers it.`));
  return { door: recordsDoorFromCall(call, { filesResource: FILES, resource: '@own-records' }), keep: () => written.slice() };
}
