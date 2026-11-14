// tools/decide-with-a-method/method-rows/view.mjs
//
// A method as the person's AI reads it: a saved view over the person's method rows, read a page at a time. The person's own order, Nov 14
// 2026: the person's files and their sections are rows, a method is a saved view over any mix of them (one row each), the AI
// reads it in one pass and answers it in one call (method-rows/answers.mjs), and how strictly an answer is checked is
// an open value, never a fixed list of steps with a judge on each check (case source:ZGVjaXNpb24tdG9vbC1pcy1yb3dzLWFuZC12aWV3cy0yMDI2LTExLTE0).
//
// A saved view is the record the person's lists keep (`list-view:<list>:<view>`, tools/read-a-list-view reads the same
// record): its `rules` keep rows, its `sort` orders them. The rules are decided by the rule filter of tools/formulas, the
// same one the list reader and the person's list screens use, so a method means by its rules what the person's own view of
// the list means.
//
// Non-Negotiable Invariants:
//   1. Which rows a method holds is decided by the rule filter of tools/formulas over the rows of the view's list, and
//      nothing else: no row, kind, field or list is named here (method-rows/settings.json names the record types).
//   2. Reading writes nothing. A page answers each row with the strictness it will be checked by, so the AI knows how an
//      answer to it is judged before it writes one.
//   3. A page never holds more rows than `read.page_rows_most`, and says where the next one starts; a method of any size is
//      read by following `next` until it is null.
import { filterRecords } from '../../formulas/do-work/requests.mjs';
import settings from './settings.json' with { type: 'json' };
import decide from '../read-data/decide-with-a-method.json' with { type: 'json' };

const { names, strictness: STRICT, words: WORDS } = settings;
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const fill = (template, values) => template.replace(/\{(\w+)\}/g, (_, key) => values[key] ?? '');
export const say = (name, parts = {}) => fill(WORDS[name], Object.fromEntries(Object.entries(parts).map(([key, value]) => [key, String(value).trim().replace(/[.\s]+$/, '')])));
export const refuse = (name, parts) => { throw new Error(say(name, parts)); };

// A call's fields are the ones its tool row declares (input_schemas of read-data/decide-with-a-method.json, a copy of each
// row's input_schema: the installed tool ships no tool-rows.json); a field it does not declare is refused by name.
export function refuseUnknownFields(toolId, input) {
  const fields = Object.keys(decide.input_schemas[toolId].properties);
  for (const name of Object.keys(object(input) ? input : {})) if (!fields.includes(name)) refuse('field_unknown', { name, fields: fields.join(', ') });
}

/** The saved view named, as its record holds it ({ list_id, view: { rules, sort, label }, strictness? }), or a refusal. */
export async function methodRecord(door, method) {
  if (typeof method !== 'string' || !method.trim()) refuse('no_method');
  const held = await door.read(names.view_type, method);
  if (!object(held) || typeof held.list_id !== 'string') refuse('method_not_found', { method });
  return held;
}

/** The list a saved view is over, as its record holds it: { row_type, fields }. */
export async function listOf(door, record) {
  const list = await door.read(names.list_type, fill(names.list_record, { list_id: record.list_id }));
  if (!object(list) || typeof list.row_type !== 'string') refuse('method_not_found', { method: record.list_id });
  return list;
}

/** Every row of the list, as { id, values } in the door's order. */
export async function rowsOfList(door, list) {
  const rows = [];
  for await (const row of door.list({ type: fill(names.row_type, { row_type: list.row_type }) })) rows.push({ id: row.id, values: row.value ?? {} });
  return rows;
}

// The rows a rule tree keeps, as the rule filter decides; only the fields the rules read are handed to it. A rule it could
// not use refuses the read: a view that cannot be decided holds no rows rather than all of them.
export function keptRows(rows, fields, tree) {
  if (!tree) return rows;
  const read = new Set();
  const collect = node => (node?.kind === 'rule' ? (typeof node.field === 'string' ? read.add(node.field) : null) : (node?.rules ?? []).forEach(collect));
  collect(tree);
  const found = filterRecords({
    records: rows.map(row => ({ value: Object.fromEntries([...read].filter(name => name in row.values).map(name => [name, row.values[name]])) })),
    fields: fields.filter(field => read.has(field.id)).map(field => ({ id: field.id, kind: field.kind, path: ['value', field.id] })),
    tree,
  });
  if (!Array.isArray(found?.matches)) refuse('view_unusable', { why: 'the rule filter gave no answer' });
  if (found.incomplete?.length) refuse('view_unusable', { why: JSON.stringify(found.incomplete).slice(0, 300) });
  return found.matches.map(at => rows[at]);
}

// The view's order: each sort entry { field, direction } from the last to the first, a row with no value last. Numbers
// order as numbers and text by its bytes; a value of another shape by its JSON.
const rank = value => (typeof value === 'number' ? [0, value] : typeof value === 'string' ? [1, value] : [2, JSON.stringify(value)]);
const compare = (a, b) => { const [ka, va] = rank(a), [kb, vb] = rank(b); return ka !== kb ? ka - kb : va < vb ? -1 : va > vb ? 1 : 0; };
export function ordered(rows, sort) {
  let out = rows;
  for (const entry of [...(sort ?? [])].reverse()) {
    const held = out.filter(row => row.values[entry.field] != null);
    const empty = out.filter(row => row.values[entry.field] == null);
    held.sort((a, b) => (entry.direction === 'desc' ? -1 : 1) * compare(a.values[entry.field], b.values[entry.field]));
    out = [...held, ...empty];
  }
  return out;
}

/** Every row of the saved view, in its order: the one pass both tools of the pair make. */
export async function rowsOfMethod(door, method) {
  const record = await methodRecord(door, method);
  const list = await listOf(door, record);
  const view = record.view ?? {};
  const rows = ordered(keptRows(await rowsOfList(door, list), list.fields ?? [], view.rules), view.sort);
  return { record, list, rows };
}

/** The strictness one row is checked by: its own value, else the method's, else the default; { rules, review, from }. */
export function strictnessOf(rowValues, record) {
  const row = rowValues?.[STRICT.row_field];
  if (object(row)) return { ...row, from: 'row' };
  const view = record?.[STRICT.view_field];
  if (object(view)) return { ...view, from: 'method' };
  return { ...STRICT.default, from: 'default' };
}

/** tool:read-a-method. input { method, after?, limit? }: one page of the rows of the saved view `method`, each with the strictness it is checked by. */
export async function readAMethod(input, { door }) {
  refuseUnknownFields('tool:read-a-method', input);
  const limit = input?.limit ?? settings.read.page_rows;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > settings.read.page_rows_most) refuse('bad_limit', { most: settings.read.page_rows_most });
  const from = input.after === undefined || input.after === null ? 0 : Number(input.after);
  if (!Number.isSafeInteger(from) || from < 0) refuse('bad_after');
  const { record, list, rows } = await rowsOfMethod(door, input?.method);
  // A page ends at `limit` rows or when the next row would pass `page_bytes`, but always holds one row.
  const page = [];
  let held = 0;
  for (const row of rows.slice(from, from + limit)) {
    const shown = { id: row.id, values: row.values, strictness: strictnessOf(row.values, record) };
    const size = Buffer.byteLength(JSON.stringify(shown));
    if (page.length && held + size > settings.read.page_bytes) break;
    page.push(shown);
    held += size;
  }
  const end = from + page.length;
  return {
    method: input.method,
    label: record.view?.label ?? input.method,
    list: record.list_id,
    strictness: strictnessOf(null, record),
    rows: page,
    next: end < rows.length ? String(end) : null,
    of: rows.length,
    fields: (list.fields ?? []).map(field => field.id),
  };
}
