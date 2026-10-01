// tools/person-list/do-work/find-people.mjs
//
// Searches a list of people (or any records) by any of their fields and gives each one a title, subtitle and detail to
// show. Run by the Workshop tool `tool:find-people` in the tool container:
//
//   node do-work/find-people.mjs < <the input as JSON>
//
// The records (bare or as { payload }) come in `records`, or as a JSON file from the person's own files
// (`records_file`). `fields` says which fields to read (key, label, source_keys, searchable, display_role, order);
// without it every field the records carry is read and searched. Prints { people, total, matched } on its last line.
import { text } from 'node:stream/consumers';
import { decodeAddressedRecords, decodeRecordFieldDescriptors, filterAddressedRecords, joinFieldValuesToRecords } from '../read-data/read-people.ts';

const input = JSON.parse((await text(process.stdin)) || '{}');
const listed = value => (Array.isArray(value) ? value : Array.isArray(value?.records) ? value.records : []);
const rows = (input.records ?? listed(input.records_file ? await (await fetch(input.records_file)).json() : []))
  .map(row => (row && typeof row.payload === 'object' && row.payload !== null && !Array.isArray(row.payload) ? { id: row.id, ...row.payload } : row));
const fields = input.fields
  ? decodeRecordFieldDescriptors(input.fields)
  : [...new Set(rows.flatMap(row => (row && typeof row === 'object' ? Object.keys(row) : [])))].map(key => ({ key }));
const { records } = joinFieldValuesToRecords(decodeAddressedRecords(rows, fields), new Map(), fields);
const people = filterAddressedRecords(records, String(input.search ?? ''), fields);
console.log(JSON.stringify({ people, total: records.length, matched: people.length }));
