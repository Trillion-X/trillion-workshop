// tools/check-against-a-persons-rules-and-verdicts/do-work/records-in-hand.mjs
//
// Purpose
//   The person's records a run was handed: { id, type, value } rows the caller read from the person's own store and gave
//   as the input's `records`. A run reads and writes no store, so every read of a record is a filter over these rows.
//
// Non-negotiable invariants
//   1. A row matches a type and a `where` when its type is that type and every field of `where` deep-equals the same
//      field of its value. No other match is made here.
//   2. Nothing is written: the rows are read, never changed, and a row not handed in is not there.
//
// Shapes
//   recordsHandedIn(records)           -> the records, or a refusal when any is not { id, type, value }; undefined is a
//                                         refusal (no rows handed in is not an empty store); [] is an empty store read
//   recordsOf(records, type, where?)   -> the rows of that type matching `where`, in the order handed in
//   recordOf(records, type, id)        -> the row of that type and id, or null
import { isDeepStrictEqual } from 'node:util';

const isRecord = record => record !== null && typeof record === 'object' && typeof record.id === 'string' && typeof record.type === 'string';

export function recordsHandedIn(records) {
  if (records === undefined) {
    throw new Error('records is missing: send the rows read from the person\'s store as records, or [] when the store is empty. Nothing is checked against no rows.');
  }
  if (!Array.isArray(records) || !records.every(isRecord)) {
    throw new Error('records must be the rows the caller read from the person\'s store, each { id, type, value }.');
  }
  return records;
}

export function recordsOf(records, type, where = null) {
  return records.filter(record => record.type === type
    && (!where || Object.entries(where).every(([name, value]) => isDeepStrictEqual(record.value?.[name], value))));
}

export function recordOf(records, type, id) {
  return records.find(record => record.type === type && record.id === id) ?? null;
}
