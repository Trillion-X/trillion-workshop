// tools/conversations/read-data/rows-in-hand.mjs
//
// The person's rows, file bytes and list answers a run is handed, read here in memory, and what the run writes back as
// `keep`. A run reaches no store: the caller (the person's AI) reads what the run asks for from the store the person keeps
// it in, hands it in as `stored` in the input, and runs again (rule a-tool-is-only-what-the-store-cannot-do).
//
//   input.stored: { records: [{ id, type, value }]          one per record id asked for; value null when absent
//                   queries: [{ query, records: [{ id, type, value }] }]   the answer to each list asked for, in the order
//                                                          records:list gives it (greatest id first unless reverse is false)
//                   files: { <name>: { base64 } | { text } | null }      null when no such file }
//   answer:  { ...result, keep, complete: true }                 the run is complete: keep is what it wrote
//            { needs, keep: [], complete: false }                 the run asked for what it was not handed: the caller reads
//                                                                each need, hands it in, and runs again. Nothing is kept.
//   needs:   { records: [{ id, type }], lists: [query], files: [name] }
//
// keep holds, in the order the run wrote them, { id, type, value, expected } for each record (value null removes it) and
// { file, identity, base64, expected } for each file. expected is the record (or file identity) as the run saw it before
// that write: { type, value }, or null when it was absent. A store refuses a keep whose expected record has moved.
import { isDeepStrictEqual } from 'node:util';
import { makeHashCodeHexFromBytes } from '../../content-identity/read-data/identity.mjs';

/** A query's key: the same query, whatever order its fields were written in. */
export function canonicalQuery(query) {
  const sorted = value => (value && typeof value === 'object' && !Array.isArray(value)
    ? Object.fromEntries(Object.keys(value).sort().map(name => [name, sorted(value[name])]))
    : Array.isArray(value) ? value.map(sorted) : value);
  return JSON.stringify(sorted(query ?? {}));
}

const bytesOfHeld = held => {
  if (held === null || held === undefined) return null;
  if (typeof held === 'string') return Buffer.from(held, 'utf8');
  return held.text !== undefined ? Buffer.from(held.text, 'utf8') : Buffer.from(held.base64 ?? '', 'base64');
};

export function rowsInHand({ records = [], queries = [], files = {} } = {}) {
  const handed = new Map(records.map(record => [record.id, { id: record.id, type: record.type ?? null, value: record.value ?? null }]));
  const answers = new Map(queries.map(entry => [canonicalQuery(entry.query), entry.records ?? []]));
  const handedFiles = new Map(Object.entries(files).map(([name, held]) => [name, bytesOfHeld(held)]));
  const written = new Map();
  const fileWritten = new Map();
  const keep = [];
  const needs = { records: new Map(), lists: new Map(), files: new Set() };

  // The record as this run sees it: its own write, else what was handed. A record not handed is a need.
  const recordOf = (id, type = null) => {
    if (written.has(id)) return written.get(id);
    if (handed.has(id)) return handed.get(id);
    needs.records.set(id, { id, type });
    return null;
  };
  const shown = (record, fields) => (fields
    ? { id: record.id, type: record.type, value: Object.fromEntries(fields.filter(name => name in (record.value ?? {})).map(name => [name, record.value[name]])) }
    : structuredClone(record));

  return {
    /** The value of a record as this run sees it (a copy), or null when it is absent. */
    valueOf(id, type = null) {
      const record = recordOf(id, type);
      return record && record.value !== null && (!type || !record.type || record.type === type) ? structuredClone(record.value) : null;
    },
    /** The records a list query gives as this run sees them (its writes of that type included), greatest id first unless reverse is false. */
    rowsOf(query = {}, { most = Infinity } = {}) {
      const key = canonicalQuery(query);
      if (!answers.has(key)) {
        needs.lists.set(key, query);
        return [];
      }
      if (query.order) throw new Error('A list in a run is ordered by its id only.');
      const merged = new Map(answers.get(key).map(record => [record.id, { id: record.id, type: record.type ?? query.type ?? null, value: record.value ?? null }]));
      for (const record of written.values()) if (record.type === query.type && record.value !== null) merged.set(record.id, record);
      const matches = record => record.value !== null && (!query.type || record.type === query.type)
        && (!query.prefix || record.id.startsWith(query.prefix))
        && (query.above === undefined || record.id > query.above) && (query.below === undefined || record.id < query.below)
        && (!query.where || Object.entries(query.where).every(([name, value]) => isDeepStrictEqual(record.value?.[name], value)));
      const ids = [...merged.values()].filter(matches).sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
      if (query.reverse !== false) ids.reverse();
      return ids.slice(0, Math.min(query.limit ?? Infinity, most)).map(record => shown(record, query.fields));
    },
    /** Keeps a record write: value null removes it. Later reads of the run see it. */
    keepRecord({ id, type = null, value = null }) {
      const before = written.has(id) ? written.get(id) : handed.get(id) ?? null;
      const expected = before && before.value !== null ? { type: before.type, value: structuredClone(before.value) } : null;
      const next = { id, type: type ?? before?.type ?? null, value: structuredClone(value) };
      written.set(id, next);
      keep.push({ id, type: next.type, value: structuredClone(value), expected });
    },
    /** The bytes of a file the person keeps under this name, or null when there is none. A name not handed is a need. */
    bytesOf(name) {
      if (fileWritten.has(name)) return fileWritten.get(name).bytes;
      if (!handedFiles.has(name)) {
        needs.files.add(name);
        return null;
      }
      return handedFiles.get(name);
    },
    /** The identity of a file the person keeps under this name, or null when there is none. */
    identityOf(name) {
      const bytes = this.bytesOf(name);
      return bytes ? makeHashCodeHexFromBytes(bytes) : null;
    },
    /** Keeps a file's bytes under its name, as the person's file. */
    keepFile(name, bytes) {
      const whole = Buffer.from(bytes);
      const identity = makeHashCodeHexFromBytes(whole);
      const before = this.identityOf(name);
      fileWritten.set(name, { bytes: whole, identity });
      keep.push({ file: name, identity, base64: whole.toString('base64'), expected: before });
      return identity;
    },
    needs: () => ({ records: [...needs.records.values()], lists: [...needs.lists.values()], files: [...needs.files] }),
    keep: () => keep.map(item => structuredClone(item)),
  };
}

/**
 * Runs a function with the rows its request hands in (input.stored). body(hand, request, context) returns the function's
 * answer; a run that asked for what it was not handed answers its needs and keeps nothing. A throw caused by something
 * the run was not handed is the need, never the error.
 */
export async function answering(request, context, body) {
  const hand = rowsInHand(request?.input?.stored ?? {});
  let result = null;
  let failure = null;
  try { result = await body(hand, request, context); } catch (error) { failure = error; }
  const needs = hand.needs();
  if (needs.records.length || needs.lists.length || needs.files.length) return { needs, keep: [], complete: false };
  if (failure) throw failure;
  return { ...result, keep: hand.keep(), complete: true };
}
