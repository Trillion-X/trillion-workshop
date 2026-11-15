// A literal whole document held by ONE native record, read without a mutable file copy.
// The host supplies its actual authorized readRecord(type,id) door. Native identity is an opaque root stamp,
// never a fabricated revision or a snapshot of linked/computed dependencies. Content/value identities describe
// only the captured bytes/JSON. No disk, cache, write, retry, multipart assembly or source normalization belongs here.
import { makeHashCodeHexFromBytes, makeHashCodeHexFromJson } from '../../content-identity/read-data/identity.mjs';

const say = (code, message) => Object.assign(new Error(message), { code });
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const fields = ['type', 'id', 'content_field'];

function checked(input) {
  if (!object(input) || Object.keys(input).some(key => !fields.includes(key)) ||
      fields.some(key => !Object.hasOwn(input, key) || typeof input[key] !== 'string' || !input[key])) {
    throw say('bad_input', 'Name only the native record type, id and literal top-level content_field.');
  }
  return Object.freeze(Object.fromEntries(fields.map(key => [key, input[key]])));
}

/** Exact in-memory source: {type,id,content_field,text,source_identity,content_identity,record_value_identity}.
 * content_field is a literal own field, including names containing dots; it is not a path or a computed selector.
 * The caller must select root-owned authored text. The transport's root stamp does not cover derived dependencies. */
export async function readRecordDocument(input, { door } = {}) {
  const selected = checked(input);
  if (typeof door?.readRecord !== 'function') throw say('bad_input', 'An authorized native readRecord door is required.');
  const record = await door.readRecord(selected.type, selected.id);
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

/** A pure projector receives (capturedText, frozenSource); its derived result is withheld until a fresh native
 * read still matches the whole source's type, opaque root identity and JSON value. Native refusals/unknowns propagate.
 * The projector must have no effects: this comparison cannot roll back effects or revoke already disclosed bytes.
 * This is a release-time comparison, not cross-store atomicity or a promise of perpetual current rights. Native
 * admission, key/erasure checks and protected answer custody remain the actual transport owner's responsibility. */
export async function projectRecordDocument(input, { door, project } = {}) {
  const selected = checked(input);
  if (typeof project !== 'function') throw say('bad_input', 'A pure in-memory document projector is required.');
  const source = await readRecordDocument(selected, { door });
  const projection = await project(source.text, source);
  const current = await readRecordDocument(selected, { door });
  if (current.source_identity !== source.source_identity || current.record_value_identity !== source.record_value_identity) {
    throw say('document_source_changed', 'The canonical whole document changed before its derived result could be released.');
  }
  return { source, projection };
}
