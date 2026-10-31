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
//   3. A refresh reads and writes bounded pages. It removes no old row until the source has answered a successful
//      terminal page, so a source read in part never removes unread rows. Existing rows are held as ids and BLAKE3
//      value identities, never as the whole source's bodies. A source with no rows array is refused, not read as empty.
//   4. A row source's record id is `<row type>:<source id>~<its id, URI-encoded>`. Its optional `id` distinguishes
//      logical collections served by the same source tool; without it the source kind keeps existing record ids.
//      A source id never holds the separator or a path separator, and each list's source ids are unique.
//   5. A write the door refuses for one row's values (a value that does not fit the list's field kind) is sent again
//      one row at a time, so the other rows are written and the refused ones are named.
//   6. Values are ordered by the bytes of their canonical JSON, the order the view publish gave (a published file's
//      hash depends on it), with the platform's TextEncoder, so the same code runs on a computer and in a page.
//
//   readListView({ list | view, after?, limit?, names }, door)
//     → { list, fields, rows: [{ id, record_id, values, title, source? }], next, complete, of? }
//     door: { read(type, id) → value | null, list({ type, limit, after?, prefix? }) → { records, next } }
//   refreshRowSources({ list, names, source_answer_bytes?, signal? }, door)
//     → { list, sources: [{ source, rows, written, removed, unchanged, refused: [ids] }] }
//     door: { read, list, run(tool, input) → its answer, write(records, { key }) → the door's answer }
import data from './list-view.json' with { type: 'json' };
import { filterRecords } from '../../formulas/do-work/requests.mjs';
import { writeBatches } from '../../records-door/read-data/write-batches.mjs';
import { makeHashCodeHexFromBytes } from '../../content-identity/read-data/identity.mjs';

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
  const ids = new Set();
  return declared.map(row => {
    const served = Object.hasOwn(data.row_sources, row?.source) ? data.row_sources[row.source] : null;
    if (!served) throw say('bad_list', `No tool serves the row source ${JSON.stringify(row?.source)}.`);
    const id = row.id ?? row.source;
    if (typeof id !== 'string' || !id.trim() || /[~\/\\\u0000-\u001f]/u.test(id)) {
      throw say('bad_list', 'A row source id must be nonempty text without ~, path separators or control characters.');
    }
    if (ids.has(id)) throw say('bad_list', `The row source id ${JSON.stringify(id)} is declared twice.`);
    ids.add(id);
    const values = row.values ?? {};
    if (!values || typeof values !== 'object' || Array.isArray(values)) throw say('bad_list', 'A source values projection must be an object.');
    for (const [field, expression] of Object.entries(values)) {
      if (!field || !expression || typeof expression !== 'object' || Array.isArray(expression) || Object.keys(expression).length !== 1 ||
          !(['from', 'row', 'const'].some(key => Object.hasOwn(expression, key))) ||
          (Object.hasOwn(expression, 'from') && (typeof expression.from !== 'string' || !expression.from)) ||
          (Object.hasOwn(expression, 'row') && (typeof expression.row !== 'string' || !expression.row))) {
        throw say('bad_list', `The source value ${JSON.stringify(field)} must name {from}, {row} or {const}.`);
      }
    }
    if (row.content !== undefined && typeof row.content !== 'boolean' && (!row.content || typeof row.content !== 'object' || Array.isArray(row.content))) {
      throw say('bad_list', 'Source content must be a boolean or an object.');
    }
    if (row.exclude !== undefined && (!Array.isArray(row.exclude) || row.exclude.some(glob => typeof glob !== 'string' || !glob))) {
      throw say('bad_list', 'Source exclude must be an array of nonempty glob strings.');
    }
    if (row.paths !== undefined && (!Array.isArray(row.paths) || row.paths.some(path => typeof path !== 'string' || !path))) {
      throw say('bad_list', 'Source paths must be an array of nonempty path strings.');
    }
    if (row.paths_file !== undefined && (typeof row.paths_file !== 'string' || !row.paths_file.trim())) {
      throw say('bad_list', 'Source paths_file must name a nonempty catalogue path.');
    }
    if (row.text_extensions !== undefined && (!Array.isArray(row.text_extensions) || row.text_extensions.some(extension => typeof extension !== 'string'))) {
      throw say('bad_list', 'Source text_extensions must be an array of extension strings; an empty string explicitly names extensionless text files.');
    }
    return { ...row, id, served, values };
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
      const source = sources.find(one => id.startsWith(`${one.id}${SOURCE_MARK}`))?.id;
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
const valueIdentity = value => makeHashCodeHexFromBytes(utf8.encode(canonical(value)));
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

// A source may place the same complete row in an existing list's vocabulary without changing the source document.
// `from` names one literal values key (document values include dots), `row` a row property, and `const` JSON DATA.
// All source fields remain; only explicitly mapped destination fields are added or replaced.
function projectedValues(source, row) {
  const values = { ...(row.values ?? {}) };
  for (const [field, expression] of Object.entries(source.values)) {
    const value = Object.hasOwn(expression, 'const') ? expression.const
      : Object.hasOwn(expression, 'from') ? row.values?.[expression.from] : row[expression.row];
    if (value !== undefined) values[field] = value;
  }
  return values;
}

function continued(next, after, cursors, what) {
  if (next === undefined || next === null) return null;
  if (typeof next !== 'string' || !next || next === after || cursors.has(next)) {
    throw say('source_cursor_stalled', `${what} did not advance its continuation cursor.`);
  }
  cursors.add(next);
  return next;
}

/** A source's bounded pages. A successful terminal page, never a read-count limit, proves the source is complete. */
async function* sourcePages(door, source, mostBytes, signal) {
  // A template the row source leaves empty is no value, so the tool gets only what the list says.
  // An exact placeholder keeps its value's JSON type. A fixed DATA input may itself be JSON; neither is coerced
  // through String or `.replace`, which would turn an object or boolean into a different source request.
  const context = Object.fromEntries(Object.entries(source).filter(([, value]) =>
    typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean'));
  const input = Object.fromEntries(Object.entries(source.served.input)
    .map(([key, template]) => {
      const exact = typeof template === 'string' && /^\{(\w+)\}$/.exec(template);
      const value = exact ? (source[exact[1]] === undefined ? '' : source[exact[1]])
        : typeof template === 'string' ? fill(template, context) : template;
      return [key, value];
    }).filter(([, value]) => value !== ''));
  if (source.content !== undefined) input.content = source.content;
  if (source.exclude !== undefined) input.exclude = source.exclude;
  if (source.paths !== undefined) input.paths = source.paths;
  if (source.text_extensions !== undefined) input.text_extensions = source.text_extensions;
  const cursors = new Set();
  for (let after = null; ;) {
    signal?.throwIfAborted();
    const answer = await door.run(source.served.tool, { ...input, limit: limits.read_page_rows, ...(after ? { after } : {}), ...(mostBytes ? { most_bytes: mostBytes } : {}) });
    signal?.throwIfAborted();
    const page = at(answer, source.served.rows_at);
    if (!Array.isArray(page)) throw say('source_unanswered', `The row source ${source.source} answered no rows: ${JSON.stringify(answer).slice(0, 300)}`);
    if (page.length > limits.read_page_rows) throw say('source_page_too_big', `The row source ${source.id} answered more than ${limits.read_page_rows} rows in one page.`);
    const continuation = at(answer, source.served.next_at);
    if (continuation === undefined) throw say('source_unanswered', `The row source ${source.id} answered no continuation or terminal null.`);
    const next = continued(continuation, after, cursors, `The row source ${source.id}`);
    for (const row of page) if (!row || typeof row.id !== 'string' || !row.id || !row.values || typeof row.values !== 'object' || Array.isArray(row.values)) {
      throw say('source_unanswered', `The row source ${source.id} answered a row without an id and values object.`);
    }
    yield page;
    if (next === null) return;
    after = next;
  }
}

/** The records a source wrote at its last refresh: Map(record id → BLAKE3 canonical value identity). */
async function writtenRows(door, type, source, signal) {
  const held = new Map();
  const cursors = new Set();
  const prefix = `${type}:${source}${SOURCE_MARK}`;
  for (let after = null; ;) {
    signal?.throwIfAborted();
    const page = await door.list({ type, prefix, limit: limits.door_page_rows, ...(after ? { after } : {}) });
    signal?.throwIfAborted();
    if (!Array.isArray(page?.records)) throw say('records_unanswered', `Listing ${type} answered no records.`);
    if (page.next === undefined) throw say('records_unanswered', `Listing ${prefix} answered no continuation or terminal null.`);
    for (const record of page.records) {
      if (typeof record.id !== 'string' || !record.id.startsWith(prefix) || record.type !== type || held.has(record.id)) {
        throw say('records_unanswered', `Listing ${prefix} answered a duplicate or unrelated record.`);
      }
      held.set(record.id, valueIdentity(record.value));
    }
    after = continued(page.next, after, cursors, `Listing ${prefix}`);
    if (!after) return held;
  }
}

// The writes in batches of at most write_rows records and write_bytes bytes.
const batches = records => writeBatches(records, { rows: limits.write_rows, bytes: limits.write_bytes });

/** Writes each batch; a batch the door refuses as written is sent again one record at a time. Answers the refused ids. */
async function writeAll(door, records, key, signal) {
  const refused = [];
  for (const [index, batch] of batches(records).entries()) {
    signal?.throwIfAborted();
    try {
      await door.write(batch, { key: `${key}:${index}` });
    } catch (error) {
      if (error.code !== 'original_input_refused') throw error;
      for (const record of batch) {
        signal?.throwIfAborted();
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
  input.signal?.throwIfAborted();
  const names = checkedNames(input);
  const list = await listOf(door, names, input.list);
  const type = rowTypeOf(list, names);
  const run = globalThis.crypto.randomUUID();
  const sources = [];
  for (const source of sourcesOf(list)) {
    const held = await writtenRows(door, type, source.id, input.signal);
    const seen = new Set(), refused = [];
    let rows = 0, written = 0, unchanged = 0, pageIndex = 0;
    const key = `refresh:${input.list}:${source.id}:${run}`;
    for await (const page of sourcePages(door, source, input.source_answer_bytes, input.signal)) {
      const writes = [];
      for (const row of page) {
        const id = `${type}:${source.id}${SOURCE_MARK}${encodeURIComponent(row.id)}`;
        if (seen.has(id)) throw say('source_duplicate_row', `The row source ${source.id} answered a row id twice.`);
        seen.add(id);
        const value = projectedValues(source, row);
        if (held.get(id) === valueIdentity(value)) unchanged += 1;
        else writes.push({ id, type, value });
        held.delete(id);
        rows += 1;
      }
      const pageRefused = await writeAll(door, writes, `${key}:page:${pageIndex++}`, input.signal);
      refused.push(...pageRefused);
      written += writes.length - pageRefused.length;
    }
    // Reaching here proves the source ended successfully. No deletion is attempted after a failed, stalled or
    // duplicate source page. Unread records and every other source's or own row remain untouched on that failure.
    input.signal?.throwIfAborted();
    const removals = [...held.keys()].map(id => ({ id, type, value: null }));
    const removalRefused = await writeAll(door, removals, `${key}:remove`, input.signal);
    refused.push(...removalRefused);
    sources.push({ source: source.id, rows, written, removed: removals.length - removalRefused.length, unchanged, refused });
  }
  return { list: input.list, sources };
}
