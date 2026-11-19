// A literal whole document held by ONE native record, read without a mutable file copy.
// The caller reads the native record (its type, opaque current root identity and JSON value) with its own authorized
// read and hands it in as `record`; this module only checks and shapes it. Native identity is an opaque root stamp,
// never a fabricated revision or a snapshot of linked/computed dependencies. Content/value identities describe
// only the captured bytes/JSON. No disk, cache, write, retry, multipart assembly or source normalization belongs here.
import { makeHashCodeHexFromBytes, makeHashCodeHexFromJson } from '../../content-identity/read-data/identity.mjs';

const say = (code, message) => Object.assign(new Error(message), { code });
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const fields = ['type', 'id', 'content_field'];

function checked(input) {
  if (!object(input) || Object.keys(input).some(key => ![...fields, 'record'].includes(key)) ||
      fields.some(key => !Object.hasOwn(input, key) || typeof input[key] !== 'string' || !input[key])) {
    throw say('bad_input', 'Name only the native record type, id and literal top-level content_field, with the record the caller read.');
  }
  // Leaving the record out is a refusal, never an absent source read as empty.
  if (input.record === undefined) throw say('bad_input', 'The native record the caller read must be handed in as record.');
  return Object.freeze(Object.fromEntries(fields.map(key => [key, input[key]])));
}

/** Exact in-memory source: {type,id,content_field,text,source_identity,content_identity,record_value_identity}.
 * `input.record` is the native record as the caller read it ({type, identity, value}), or null when it is absent.
 * content_field is a literal own field, including names containing dots; it is not a path or a computed selector.
 * The caller must select root-owned authored text. The transport's root stamp does not cover derived dependencies. */
export function readRecordDocument(input) {
  const selected = checked(input);
  const { record } = input;
  if (record === null) throw say('document_not_found', 'The selected whole document record is absent.');
  if (!object(record) || record.type !== selected.type || typeof record.identity !== 'string' || !record.identity) {
    throw say('document_source_invalid', 'The document needs its matching native record type and opaque current root identity.');
  }
  if (!object(record.value) || !Object.hasOwn(record.value, selected.content_field) ||
      typeof record.value[selected.content_field] !== 'string') {
    throw say('document_source_invalid', 'The selected native record does not hold literal document text.');
  }
  const text = record.value[selected.content_field];
  if (!text.isWellFormed()) throw say('document_source_invalid', 'Document text must preserve complete Unicode characters in UTF-8.');
  return Object.freeze({ ...selected, source_identity: record.identity, text,
    content_identity: makeHashCodeHexFromBytes(new TextEncoder().encode(text)),
    record_value_identity: makeHashCodeHexFromJson(record.value) });
}

/** A pure projector receives (capturedText, frozenSource); its derived result is withheld until the fresh read the caller
 * hands in as `current_record` still matches the whole source's type, opaque root identity and JSON value. Leaving
 * current_record out is refused before the projector runs.
 * The projector must have no effects: this comparison cannot roll back effects or revoke already disclosed bytes.
 * This is a release-time comparison, not cross-store atomicity or a promise of perpetual current rights. Native
 * admission, key/erasure checks and protected answer custody remain the actual transport owner's responsibility. */
export async function projectRecordDocument({ current_record: current, ...input } = {}, { project } = {}) {
  if (current === undefined) throw say('bad_input', 'The fresh read of the same record must be handed in as current_record; leaving it out is refused.');
  if (typeof project !== 'function') throw say('bad_input', 'A pure in-memory document projector is required.');
  const source = readRecordDocument(input);
  const projection = await project(source.text, source);
  const after = readRecordDocument({ ...input, record: current });
  if (after.source_identity !== source.source_identity || after.record_value_identity !== source.record_value_identity) {
    throw say('document_source_changed', 'The canonical whole document changed before its derived result could be released.');
  }
  return { source, projection };
}
