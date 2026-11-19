// tools/conversations/read-data/held-door.mjs
//
// The door a run of this folder gets. The person's rows and files are not reached from here: the person's AI reads its
// own store, in that store's own language, and hands in what the run asks for (stored); what the run writes comes back
// as `keep`, for the AI to keep in the same store (rule a-tool-is-only-what-the-store-cannot-do). The importer code reads
// and writes through this door exactly as it did through the records door, so its rules are unchanged.
//
// A run that needs something it was not given does not guess: a record, a list or a file it asks for and was not handed
// is noted in `needs`, answered as absent for the rest of that run, and the run's writes are not returned. The caller
// reads each need from its store, hands the answers in, and runs again until `needs` is empty:
//
//   stored: { records: [{ id, type, value }]              one per record id asked for; value null when absent
//             queries: [{ query, records: [{ id, type, value }] }]   the answer to each list asked for, in the order
//                                                         records:list gives it (greatest id first unless reverse is false)
//             files: { <name or identity>: { base64 } | { text } | null }   null when no such file }
//   needs:  { records: [{ id, type }], lists: [query], files: [name or identity] }
//
// Within one run, a write is seen by every later read and list of the run (a list answer is the caller's answer plus the
// run's own writes of that kind). A write's `expected` is checked against what the run has seen; a mismatch is refused
// as original_command_conflict, as the store would refuse it.
import { isDeepStrictEqual } from 'node:util';
import { makeHashCodeHexFromBytes } from '../../content-identity/read-data/identity.mjs';

const SPAN = 65_536;

/** A query's key: the same query, whatever order its fields were written in. */
export function canonicalQuery(query) {
  const sorted = value => (value && typeof value === 'object' && !Array.isArray(value)
    ? Object.fromEntries(Object.keys(value).sort().map(name => [name, sorted(value[name])]))
    : Array.isArray(value) ? value.map(sorted) : value);
  return JSON.stringify(sorted(query ?? {}));
}

function refused(code, words) {
  const error = new Error(words);
  error.code = code;
  return error;
}

export function heldDoor({ records = [], queries = [], files = {} } = {}) {
  const answered = new Map(records.map(record => [record.id, { id: record.id, type: record.type ?? null, value: record.value ?? null }]));
  const answers = new Map(queries.map(entry => [canonicalQuery(entry.query), entry.records ?? []]));
  const heldFiles = new Map(Object.entries(files).map(([key, held]) => [key, held === null || held === undefined ? null
    : { bytes: Buffer.from(typeof held === 'string' ? held : held.text !== undefined ? held.text : held.base64 ?? '', typeof held === 'string' || held.text !== undefined ? 'utf8' : 'base64') }]));
  const written = new Map();
  const keep = [];
  const uploads = new Map();
  const needs = { records: new Map(), lists: new Map(), files: new Set() };

  // What the run has seen of a record: its own write, else the caller's answer. An unknown id is a need.
  const current = (id, type = null) => {
    if (written.has(id)) return written.get(id);
    if (answered.has(id)) return answered.get(id);
    needs.records.set(id, { id, type });
    return null;
  };
  const valueOf = (id, type) => {
    const record = current(id, type);
    return record && record.value !== null && (!type || !record.type || record.type === type) ? structuredClone(record.value) : null;
  };
  const shown = (record, fields) => (fields
    ? { id: record.id, type: record.type, value: Object.fromEntries(fields.filter(name => name in (record.value ?? {})).map(name => [name, record.value[name]])) }
    : structuredClone(record));

  function fileNamed(wanted) {
    if (heldFiles.has(wanted)) {
      const held = heldFiles.get(wanted);
      if (!held) throw refused('not_found', `No file named ${wanted} was given to this run.`);
      return { name: wanted, bytes: held.bytes };
    }
    for (const [name, held] of heldFiles) {
      if (held && makeHashCodeHexFromBytes(held.bytes) === wanted) return { name, bytes: held.bytes };
    }
    needs.files.add(wanted);
    throw refused('not_found', `No file named ${wanted} was given to this run.`);
  }

  const door = {
    async read(type, id) {
      return valueOf(id, type);
    },
    list(query = {}, { most = Infinity } = {}) {
      const key = canonicalQuery(query);
      if (!answers.has(key)) {
        needs.lists.set(key, query);
        return [][Symbol.iterator]();
      }
      if (query.order) throw refused('original_input_refused', 'A list in a run is ordered by its id only.');
      const merged = new Map(answers.get(key).map(record => [record.id, { id: record.id, type: record.type ?? query.type, value: record.value ?? null }]));
      for (const record of written.values()) if (record.type === query.type && record.value !== null) merged.set(record.id, record);
      const matches = record => record.value !== null && (!query.type || record.type === query.type)
        && (!query.prefix || record.id.startsWith(query.prefix))
        && (query.above === undefined || record.id > query.above) && (query.below === undefined || record.id < query.below)
        && (!query.where || Object.entries(query.where).every(([name, value]) => isDeepStrictEqual(record.value?.[name], value)));
      const ids = [...merged.values()].filter(matches).sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
      if (query.reverse !== false) ids.reverse();
      const top = ids.slice(0, Math.min(query.limit ?? Infinity, most));
      return top.map(record => shown(record, query.fields))[Symbol.iterator]();
    },
    async write(batch, { key } = {}) {
      void key;
      for (const item of batch) {
        const { expected, ...record } = item;
        const before = written.get(record.id) ?? answered.get(record.id) ?? null;
        if (expected !== undefined) {
          if (!before) needs.records.set(record.id, { id: record.id, type: record.type ?? null });
          else {
            const seen = before.value === null ? null : { type: before.type, value: before.value };
            if (!isDeepStrictEqual(seen, expected)) throw refused('original_command_conflict', `${record.id} is not what this write expected.`);
          }
        }
        const next = { id: record.id, type: record.type ?? before?.type ?? null, value: record.value ?? null };
        written.set(record.id, next);
        keep.push({ id: next.id, type: next.type, value: next.value });
      }
      return { changed: batch.length, write_count: batch.length };
    },
    async files(method, input = {}) {
      switch (method) {
        case 'find_file': {
          const file = fileNamed(input.name_or_identity);
          return { identity: makeHashCodeHexFromBytes(file.bytes), byte_length: file.bytes.length, names: [file.name] };
        }
        case 'read_file': {
          const file = fileNamed(input.name_or_identity);
          const offset = input.offset ?? 0;
          const part = file.bytes.subarray(offset, offset + Math.min(input.length || SPAN, SPAN));
          return { identity: makeHashCodeHexFromBytes(file.bytes), byte_length: file.bytes.length, offset, bytes_returned: part.length, encoding: 'base64', content: part.toString('base64') };
        }
        case 'write_file_start': {
          const upload = uploads.get(input.upload_id) ?? { name: input.name, pieces: new Map() };
          uploads.set(input.upload_id, upload);
          return { upload_id: input.upload_id, next_offset: [...upload.pieces.values()].reduce((sum, piece) => sum + piece.length, 0) };
        }
        case 'write_file_piece': {
          const upload = uploads.get(input.upload_id) ?? (() => { throw refused('not_found', `No upload ${input.upload_id} was started in this run.`); })();
          const piece = Buffer.from(input.content_base64 ?? '', 'base64');
          upload.pieces.set(input.offset, piece);
          return { upload_id: input.upload_id, next_offset: input.offset + piece.length };
        }
        case 'write_file_finish': {
          const upload = uploads.get(input.upload_id) ?? (() => { throw refused('not_found', `No upload ${input.upload_id} was started in this run.`); })();
          const bytes = Buffer.concat([...upload.pieces].sort(([a], [b]) => a - b).map(([, piece]) => piece));
          heldFiles.set(input.name, { bytes });
          keep.push({ file: input.name, base64: bytes.toString('base64') });
          return { identity: makeHashCodeHexFromBytes(bytes), name: input.name, byte_length: bytes.length };
        }
        default:
          throw refused('door_does_not_grant', `${method} is not answered in a run here.`);
      }
    },
  };

  return {
    door,
    /** Every record, list and file the run asked for and was not given. Empty when the run is complete. */
    needs: () => ({ records: [...needs.records.values()], lists: [...needs.lists.values()], files: [...needs.files] }),
    /** Every write the run made, in order: records ({ id, type, value }, value null removes) and files ({ file, base64 }). */
    keep: () => keep.map(item => structuredClone(item)),
  };
}
