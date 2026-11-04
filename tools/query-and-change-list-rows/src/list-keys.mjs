// src/list-keys.mjs
//
// Purpose: identity keys. A field marked `unique` (a person's emails, a company's domains) holds values no other row of
// the list holds in their shared form (src/list-identity.mjs): "Ana@Example.com" and "ana@example.com" are one email, so
// the second row is refused naming the row that has it. Import, workflows, agents and match_on all meet the same key,
// because the key is the list's DATA and the check is the list owner's write. Built for src/lists.mjs.
//
// Non-Negotiable Invariants:
//   1. Each held form is a record of its own, <keys.type>:<list>:<field>:<BLAKE3 of the form> { list_id, field_id, row_id },
//      written in the same write as the row that holds it and taken away with it; asking who holds a form is one point
//      read, never a walk of the rows. The form itself is never kept in the key's id.
//   2. A key counts only while the row it names still holds that form (checked by a point read of that row), so a key a
//      write outside the lists left behind never refuses anyone; it is written over.
//   3. Rows kept before a field was unique gain their keys a page at a time (fillKeys); until every page is done a write
//      that would add a form is refused as being prepared (`unique_index_building`), never checked against half the keys.
//      Rows that already shared a form before are kept, the first one holding the key, and the rest are named in the fill's
//      mark so a person can merge them.
//
import { blake3 } from '@noble/hashes/blake3.js';
import { bytesToHex } from '@noble/hashes/utils.js';
import data from '../../keep-and-wake-ai-sessions-on-this-computer/src/lists.json' with { type: 'json' };
import { matchable, normalizedKeys, normalizerOf } from './list-identity.mjs';

const { keys: keyData, open_rows: openRows } = data;
const encoder = new TextEncoder();

/** The fields of a list that are identity keys. */
export const uniqueFields = list => (list.fields ?? []).filter(field => field.unique === true && matchable(field));

/** The record that says which row holds `form` in one field of one list. */
export const keyRecordId = (slug, fieldId, form) => `${keyData.type}:${slug}:${fieldId}:${bytesToHex(blake3(encoder.encode(form)))}`;

/** The forms a value holds in a field. */
export const formsOf = (field, value) => [...new Set(normalizedKeys(value, normalizerOf(field)))];

export const keysMarkId = slug => `${openRows.mark_type}:${keyData.mark}${slug}`;
export const keysSignature = list => JSON.stringify([list.row_type, uniqueFields(list).map(field => [field.id, normalizerOf(field)])]);

/**
 * The key records a write makes and takes away, and the first form it would give a second row. `rows` are the written
 * rows { recordId, rowId, before, after, merging? } (after null for a removed row; merging the rows a merge folds into this
 * one); `read(recordId)` a point read; `prefix` the
 * list's row record prefix. Answers { records, taken } where taken is null or { row_id, field_id, value, holder }.
 */
export function keyWrites({ list, slug, rows, read, prefix }) {
  const fields = uniqueFields(list);
  const records = new Map();
  if (!fields.length) return { records: [], taken: null };
  const afterOf = new Map(rows.map(row => [row.recordId, row.after]));
  const claimed = new Map();
  for (const field of fields) {
    // Forms let go first, so a form one row lets go and another takes in the same write goes to the one taking it.
    for (const row of rows) {
      const kept = new Set(row.after ? formsOf(field, row.after[field.id]) : []);
      for (const form of formsOf(field, row.before?.[field.id])) {
        if (kept.has(form)) continue;
        const id = keyRecordId(slug, field.id, form);
        if (read(id)?.row_id === row.rowId) records.set(id, { id, type: keyData.type, value: null });
      }
    }
    for (const row of rows) {
      if (!row.after) continue;
      const had = new Set(formsOf(field, row.before?.[field.id]));
      for (const form of formsOf(field, row.after[field.id])) {
        const id = keyRecordId(slug, field.id, form);
        // A form the row held already stays as it was (a duplicate kept from before a field became unique is the fill's to
        // name, not this write's to refuse); its key is written only if nothing holds it yet.
        if (had.has(form)) {
          if (read(id)?.row_id === undefined && !claimed.has(id)) { claimed.set(id, row.rowId); records.set(id, { id, type: keyData.type, value: { list_id: slug, field_id: field.id, row_id: row.rowId } }); }
          continue;
        }
        const other = claimed.get(id);
        if (other !== undefined && other !== row.rowId) return { records: [], taken: { row_id: row.rowId, field_id: field.id, value: form, holder: other } };
        claimed.set(id, row.rowId);
        const holder = read(id)?.row_id;
        // A row folding another into itself (a merge) takes over the keys of the row it folds in.
        if (holder !== undefined && holder !== row.rowId && !records.has(id) && !(row.merging ?? []).includes(holder)) {
          const holderRecord = `${prefix}${holder}`;
          const holderValue = afterOf.has(holderRecord) ? afterOf.get(holderRecord) : read(holderRecord);
          if (holderValue && formsOf(field, holderValue[field.id]).includes(form)) return { records: [], taken: { row_id: row.rowId, field_id: field.id, value: form, holder } };
        }
        records.set(id, { id, type: keyData.type, value: { list_id: slug, field_id: field.id, row_id: row.rowId } });
      }
    }
  }
  return { records: [...records.values()], taken: null };
}

/** Whether a write adds a form to a unique field (and so needs every key in place first). */
export const addsForms = (list, rows) => uniqueFields(list).some(field => rows.some(row => row.after
  && formsOf(field, row.after[field.id]).some(form => !formsOf(field, row.before?.[field.id]).includes(form))));

/**
 * One page of the keys of rows kept before: the key records to write for `page` ([{ id, value }] of row records, the
 * next older page) and the rows found sharing a form with the row already holding its key. `read` is a point read.
 */
export function fillPage({ list, slug, page, read, prefix }) {
  const fields = uniqueFields(list);
  const records = new Map();
  const shared = [];
  for (const { id: recordId, value } of page) {
    if (!value) continue;
    const rowId = recordId.slice(prefix.length);
    for (const field of fields) for (const form of formsOf(field, value[field.id])) {
      const id = keyRecordId(slug, field.id, form);
      const holder = records.get(id)?.value.row_id ?? read(id)?.row_id;
      const holderValue = holder !== undefined && holder !== rowId ? read(`${prefix}${holder}`) : null;
      if (holderValue && formsOf(field, holderValue[field.id]).includes(form)) { shared.push({ field_id: field.id, row_ids: [holder, rowId] }); continue; }
      if (holder !== rowId) records.set(id, { id, type: keyData.type, value: { list_id: slug, field_id: field.id, row_id: rowId } });
    }
  }
  return { records: [...records.values()], shared };
}
