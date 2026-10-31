// tools/read-a-list-view/read-data/list-view.mjs
//
// Purpose: what a person's list shows, read from their records only, and the refresh that writes a list's row sources
// into those records. Reading a list is reads only: its rows are the records of its row type, a row source's rows
// among them (written there by the last refresh), so opening a list or a saved view runs no tool. Refreshing a list
// runs the tool each row source names and writes what it answers as the list's records, changing only the rows that
// changed and removing the rows the source no longer has. Ported from the read path of the lists in the earlier
// Trillion app (src/lists.mjs: a source row's id `<source>~<id>`) and from the view read of
// tools/export-records-as-list-rows (the person's rule filter decides which rows the view's rules keep, then the
// view's sort orders them).
//
// Non-Negotiable Invariants:
//   1. readListView reads records only: it never runs a tool and never writes. A view's rules are decided by the rule
//      filter of tools/formulas (filterRecords), imported here and called in the same process as the read.
//   2. No list, view, field, record type, source or tool is named here. The record names are the caller's (`names`),
//      the sources and their tools are DATA (list-view.json `row_sources`), and so are the bounds (list-view.json
//      `limits`), which a caller never passes.
//   3. A refresh writes a source only once it has read the whole source (at most `rows_per_read` rows): a source
//      read in part is refused and nothing of it is written, so a row is never removed because it was not read.
//      A source that answers no rows is refused, never written as empty.
//   4. A row source's record id is `<row type>:<source>~<its id, URI-encoded>`, so a row keeps its id from one
//      refresh to the next and the door's ids (which hold no `/`) can carry a document's path.
//   5. A write the door refuses for one row's values (a value that does not fit the list's field kind) is sent again
//      one row at a time, so the other rows are written and the refused ones are named.
//   6. Values are ordered by the bytes of their canonical JSON, the order the view publish gave (a published file's
//      hash depends on it), with the platform's TextEncoder, so the same code runs on a computer and in a page.
//
//   readListView({ list | view, after?, limit?, names }, door)
//     → { list, fields, rows: [{ id, record_id, values, title, source? }], next, complete, of? }
//     door: { read(type, id) → value | null, list({ type, limit, after?, prefix? }) → { records, next } }
//   refreshRowSources({ list, names, source_answer_bytes? }, door)
//     → { list, sources: [{ source, rows, written, removed, unchanged, refused: [ids] }] }
//     door: { read, list, run(tool, input) → its answer, write(records, { key }) → the door's answer }
import data from './list-view.json' with { type: 'json' };
import { filterRecords } from '../../formulas/do-work/requests.mjs';
import { writeBatches } from '../../records-door/read-data/write-batches.mjs';

const say = (code, words) => Object.assign(new Error(words), { code });
const fill = (template, values) => template.replace(/\{(\w+)\}/g, (_, key) => values[key] ?? '');
const at = (value, path) => path.split('.').reduce((held, part) => (held == null ? held : held[part]), value);
const SOURCE_MARK = '~';
// The bounds of a list read and a refresh are this reader's own DATA (list-view.json `limits`).
const { limits } = data;

function checkedNames(input) {
  const names = input.names;
  if (!names || ['list_type', 'list_record', 'row_type'].some(key => typeof names[key] !== 'string') || (input.view && typeof names.view_type !== 'string')) {
    throw say('bad_input', 'names must give list_type, list_record (with {list_id}), row_type (with {row_type}) and, to read a view, view_type.');
  }
  return names;
}

function checkedLimit(input) {
  const limit = input.limit ?? limits.read_page_rows;
  if (!Number.isSafeInteger(limit) || limit < 1) throw say('bad_input', 'limit must be a whole number from 1.');
  return Math.min(limit, limits.rows_per_read);
}

/** The sources a list declares, each with the row of the tool that serves it. */
function sourcesOf(list) {
  const declared = list.row_sources ?? [];
  if (!Array.isArray(declared) || declared.length > limits.row_sources_per_list) {
    throw say('bad_list', `A list shows at most ${limits.row_sources_per_list} row sources.`);
  }
  return declared.map(row => {
    const served = data.row_sources[row?.source];
    if (!served) throw say('bad_list', `No tool serves the row source ${JSON.stringify(row?.source)}.`);
    return { ...row, served };
  });
}

async function listOf(door, names, listId) {
  if (typeof listId !== 'string' || !listId) throw say('bad_input', 'Name a list (list) or a saved view (view).');
  const list = await door.read(names.list_type, fill(names.list_record, { list_id: listId }));
  if (!list) throw say('not_found', `There is no list ${listId}.`);
  return list;
}

const rowTypeOf = (list, names) => fill(names.row_type, { row_type: list.row_type });
const titleOf = (list, values, otherwise) => (list.title_field && values?.[list.title_field]) ?? otherwise;

/** One page of the list's rows, the records of its row type: { rows, next }. */
async function rowPage(door, list, names, sources, { after, limit }) {
  const type = rowTypeOf(list, names);
  const page = await door.list({ type, limit, ...(after ? { after } : {}) });
  if (!Array.isArray(page?.records)) throw say('records_unanswered', `Listing ${type} answered no records.`);
  return {
    rows: page.records.map(record => {
      const id = record.id.startsWith(`${type}:`) ? record.id.slice(type.length + 1) : record.id;
      const source = sources.find(one => id.startsWith(`${one.source}${SOURCE_MARK}`))?.source;
      return { id, record_id: record.id, values: record.value ?? {}, title: titleOf(list, record.value, id), ...(source ? { source } : {}) };
    }),
    next: page.records.length ? page.next ?? null : null,
  };
}

/** Rows from `after` on until `room` rows, each request asking for at most door_page_rows: { rows, next }. */
async function rowsFrom(door, list, names, sources, after, room) {
  const rows = [];
  while (rows.length < room) {
    // The door refuses a bigger page, so one request asks for at most door_page_rows and this loop gathers the rest.
    const page = await rowPage(door, list, names, sources, { after, limit: Math.min(room - rows.length, limits.door_page_rows) });
    rows.push(...page.rows);
    after = page.next;
    if (!after || !page.rows.length) return { rows, next: null };
  }
  return { rows, next: after };
}

// Every field a rule tree names.
function ruleFields(tree) {
  if (!tree || typeof tree !== 'object') return new Set();
  if (tree.kind === 'rule') return new Set(typeof tree.field === 'string' ? [tree.field] : []);
  return new Set((tree.rules ?? []).flatMap(rule => [...ruleFields(rule)]));
}

// The positions of the rows a view's rules keep, as the rule filter of tools/formulas decides; only the fields the
// rules read are given to it.
function keptPositions(rows, fields, tree) {
  const reads = ruleFields(tree);
  const found = filterRecords({
    records: rows.map(row => ({ value: Object.fromEntries([...reads].filter(name => name in row.values).map(name => [name, row.values[name]])) })),
    fields: fields.filter(field => reads.has(field.id)).map(field => ({ id: field.id, kind: field.kind, path: ['value', field.id] })),
    tree,
  });
  if (!Array.isArray(found?.matches)) throw say('filter_unanswered', `The rule filter did not answer: ${JSON.stringify(found).slice(0, 300)}`);
  if (found.incomplete?.length) throw say('view_rules_unusable', `The view has rules the filter could not use: ${JSON.stringify(found.incomplete).slice(0, 300)}`);
  return found.matches;
}

// A value's canonical JSON (keys sorted, no spaces) as UTF-8 bytes: values are ordered by these bytes, whatever their
// kind, the same order the view publish of export-records-as-list-rows gave (its published file's hash depends on it).
const canonical = value => (Array.isArray(value) ? `[${value.map(canonical).join(',')}]`
  : value && typeof value === 'object' ? `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`
    : JSON.stringify(value));
const utf8 = new TextEncoder();
function compare(x, y) {
  const a = utf8.encode(canonical(x)), b = utf8.encode(canonical(y));
  for (let index = 0; index < Math.min(a.length, b.length); index += 1) if (a[index] !== b[index]) return a[index] - b[index];
  return a.length - b.length;
}

// The rows in a view's order: each sort entry { field, direction } from the last to the first, a missing value last.
function ordered(rows, sort) {
  for (const entry of [...(sort ?? [])].reverse()) {
    const held = rows.filter(row => row.values[entry.field] != null);
    const empty = rows.filter(row => row.values[entry.field] == null);
    held.sort((a, b) => (entry.direction === 'desc' ? -1 : 1) * compare(a.values[entry.field], b.values[entry.field]));
    rows = [...held, ...empty];
  }
  return rows;
}

export async function readListView(input = {}, door) {
  const names = checkedNames(input);
  const limit = checkedLimit(input);
  let listId = input.list, view = null;
  if (input.view) {
    const held = await door.read(names.view_type, input.view);
    if (!held) throw say('not_found', `There is no view ${input.view}.`);
    listId = held.list_id;
    view = held.view ?? {};
  }
  const list = await listOf(door, names, listId);
  const sources = sourcesOf(list);
  const fields = list.fields ?? [];
  if (!view?.rules && !view?.sort?.length) {
    const page = await rowsFrom(door, list, names, sources, input.after ?? null, limit);
    return { list: listId, fields, rows: page.rows, next: page.next, complete: true };
  }
  const every = await rowsFrom(door, list, names, sources, null, limits.rows_per_read);
  let rows = every.rows;
  if (view.rules) rows = keptPositions(rows, fields, view.rules).map(position => rows[position]);
  rows = ordered(rows, view.sort);
  const from = input.after === undefined || input.after === null ? 0 : Number(input.after);
  if (!Number.isSafeInteger(from) || from < 0) throw say('bad_input', 'after is not a cursor of this view.');
  return { list: listId, fields, rows: rows.slice(from, from + limit), next: from + limit < rows.length ? String(from + limit) : null,
    of: every.rows.length, complete: every.next === null };
}

/** Every row a source's tool answers, page after page: [{ id, values }]. Refused when there are more than rows_per_read. */
async function sourceRows(door, source, mostBytes) {
  // A template the row source leaves empty is no value, so the tool gets only what the list says.
  const input = Object.fromEntries(Object.entries(source.served.input)
    .map(([key, template]) => [key, fill(template, { of: source.of ?? '', match: source.match ?? '' })]).filter(([, value]) => value !== ''));
  const rows = [];
  for (let after = null; ;) {
    const answer = await door.run(source.served.tool, { ...input, limit: limits.read_page_rows, ...(after ? { after } : {}), ...(mostBytes ? { most_bytes: mostBytes } : {}) });
    const page = at(answer, source.served.rows_at);
    if (!Array.isArray(page)) throw say('source_unanswered', `The row source ${source.source} answered no rows: ${JSON.stringify(answer).slice(0, 300)}`);
    rows.push(...page.map(row => ({ id: row.id, values: row.values ?? {} })));
    if (rows.length > limits.rows_per_read) throw say('source_too_big', `The row source ${source.source} has more than ${limits.rows_per_read} rows; nothing of it was written.`);
    after = at(answer, source.served.next_at) ?? null;
    if (!after || !page.length) return rows;
  }
}

/** The records a source wrote at its last refresh: Map(record id → value). */
async function writtenRows(door, type, source) {
  const held = new Map();
  for (let after = null; ;) {
    const page = await door.list({ type, prefix: `${type}:${source}${SOURCE_MARK}`, limit: limits.door_page_rows, ...(after ? { after } : {}) });
    if (!Array.isArray(page?.records)) throw say('records_unanswered', `Listing ${type} answered no records.`);
    for (const record of page.records) held.set(record.id, record.value);
    after = page.records.length ? page.next ?? null : null;
    if (!after) return held;
  }
}

// The writes in batches of at most write_rows records and write_bytes bytes.
const batches = records => writeBatches(records, { rows: limits.write_rows, bytes: limits.write_bytes });

/** Writes each batch; a batch the door refuses as written is sent again one record at a time. Answers the refused ids. */
async function writeAll(door, records, key) {
  const refused = [];
  for (const [index, batch] of batches(records).entries()) {
    try {
      await door.write(batch, { key: `${key}:${index}` });
    } catch (error) {
      if (error.code !== 'original_input_refused') throw error;
      for (const record of batch) {
        await door.write([record], { key: `${key}:${index}:${record.id}` }).catch(one => {
          if (one.code !== 'original_input_refused') throw one;
          refused.push(record.id);
        });
      }
    }
  }
  return refused;
}

export async function refreshRowSources(input = {}, door) {
  const names = checkedNames(input);
  const list = await listOf(door, names, input.list);
  const type = rowTypeOf(list, names);
  const run = globalThis.crypto.randomUUID();
  const sources = [];
  for (const source of sourcesOf(list)) {
    const rows = await sourceRows(door, source, input.source_answer_bytes);
    const held = await writtenRows(door, type, source.source);
    const writes = [];
    let unchanged = 0;
    for (const row of rows) {
      const id = `${type}:${source.source}${SOURCE_MARK}${encodeURIComponent(row.id)}`;
      if (held.has(id) && canonical(held.get(id)) === canonical(row.values)) unchanged += 1;
      else writes.push({ id, type, value: row.values });
      held.delete(id);
    }
    const removals = [...held.keys()].map(id => ({ id, type, value: null }));
    const refused = await writeAll(door, [...writes, ...removals], `refresh:${input.list}:${source.source}:${run}`);
    const done = record => !refused.includes(record.id);
    sources.push({ source: source.source, rows: rows.length, written: writes.filter(done).length, removed: removals.filter(done).length, unchanged, refused });
  }
  return { list: input.list, sources };
}
