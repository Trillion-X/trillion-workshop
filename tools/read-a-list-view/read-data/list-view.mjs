// tools/read-a-list-view/read-data/list-view.mjs
//
// Purpose: what a person's list shows, read from the records the caller hands in, and the refresh that reconciles a
// list's row sources with those records. Reading a list is reads only: its rows are the records of its row type, a row
// source's rows among them (written there by the last refresh), so opening a list or a saved view runs no tool.
// Refreshing a list reads each row source's folder on this computer (read-data/sources.mjs) and answers the records to
// write as `keep` rows, each with the value it expected, changing only the rows that changed and removing the rows the
// source no longer has. Ported from the read path of the lists in the earlier Trillion app (src/lists.mjs: a source
// row's id `<source>~<id>`) and from the view read of tools/export-records-as-list-rows (the person's rule filter decides
// which rows the view's rules keep, then the view's sort orders them).
//
// Non-Negotiable Invariants:
//   1. readListView reads the records it is handed and never writes. A view's rules are decided by the rule filter of
//      tools/formula-engine (the Rust engine's filterRecords), called here in the same process as the read.
//   2. No list, view, field, record type, source or tool is named here. The record names are the caller's (`names`),
//      the sources and their folder kinds are DATA (list-view.json `row_sources`), and so are the bounds (list-view.json
//      `limits`), which a caller never passes.
//   3. A refresh reads each selected source completely before its stale rows can be removed. A source read in part
//      (no terminal page) removes nothing; a source with no rows array is refused, not read as empty.
//   4. A row source's record id is `<row type>:<source id>~<its id, URI-encoded>`. Its optional `id` distinguishes
//      logical collections served by the same source kind; without it the source kind keeps existing record ids.
//      A source id never holds the separator or a path separator, and each list's source ids are unique.
//   5. Values are ordered by the bytes of their canonical JSON, the order the view publish gave (a published file's
//      hash depends on it), with the platform's TextEncoder, so the same code runs on a computer and in a page.
//   6. A source declared original: "list" is the copy of the list, not its origin: its refresh is the two-way sync of
//      list-copy.mjs, which never removes a row only because its file is absent.
//   7. A refresh answers `keep` rows for every record it would write or remove, each { id, type, value, expected }
//      (value null removes; expected is the record as it was handed in, null for a new one). Nothing is written here.
//
//   readListView({ list | view, after?, limit?, names, stored })
//     → { list, fields, rows: [{ id, record_id, values, title, source? }], next, complete, of? }
//     stored: { records: [{ id, type, value }] } (store.mjs)
//   refreshRowSources({ list, names, stored, source_ids?, paths?, changes?, dry_run?, source_answer_bytes?,
//     restore?, history?, signal? })
//     → { list, sources: [{ source, rows, written, removed, unchanged } | the sync's answer], keep: [{ id, type, value, expected }] }
//     changes: { <selected document source id>: { paths: ["/a.md"], removed: ["/b.md"] } } reconciles only those
//     documents (each read and written by its own path) and leaves the source's other rows as they are.
//     paths and dry_run apply to the list-original sources only (list-copy.mjs).
import data from './list-view.json' with { type: 'json' };
import { readFileSync } from 'node:fs';
import { evaluateFormula, filterRecords, initSync } from 'trillion-workshop/tools/formula-engine/built-stored-bytes/formula-engine/formula_engine.js';
import { makeHashCodeHexFromBytes } from '../../content-identity/read-data/identity.mjs';
import { syncRowSource } from './list-copy.mjs';
import { storeOf } from './store.mjs';
import { readSourcePage } from './sources.mjs';
import { rowRecordAddress } from '../../keep-lists-of-rows/read-data/row-record-address.mjs';
import { prepareListTitles } from '../../keep-lists-of-rows/read-data/list-title-projection.mjs';
import documentData from '../../documents-as-list-rows/read-data/document-properties.json' with { type: 'json' };

const say = (code, words) => Object.assign(new Error(words), { code });
const fill = (template, values) => template.replace(/\{(\w+)\}/g, (_, key) => values[key] ?? '');
const at = (value, path) => path.split('.').reduce((held, part) => (held == null ? held : held[part]), value);
const SOURCE_MARK = '~';
// The formula engine is read the first time a view's rules or a title's formula is decided, never by a list that has neither.
let engineReady = false;
const loadEngine = () => {
  if (engineReady) return;
  initSync({ module: readFileSync(new URL(import.meta.resolve('trillion-workshop/tools/formula-engine/built-stored-bytes/formula-engine/formula_engine_bg.wasm'))) });
  engineReady = true;
};
const filterRecordsWithEngine = request => { loadEngine(); return filterRecords(request); };
const evaluateFormulaWithEngine = request => { loadEngine(); return evaluateFormula(request); };
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

/** The sources a list declares, each with the folder kind that serves it. */
function sourcesOf(list) {
  const declared = list.row_sources ?? [];
  if (!Array.isArray(declared) || declared.length > limits.row_sources_per_list) {
    throw say('bad_list', `A list shows at most ${limits.row_sources_per_list} row sources.`);
  }
  const ids = new Set();
  return declared.map(row => {
    const served = Object.hasOwn(data.row_sources, row?.source) ? { ...data.row_sources[row.source], kind: row.source } : null;
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
    if (row.original !== undefined && !['list', 'source'].includes(row.original)) throw say('bad_list', 'Source original is "list" or "source".');
    if (row.original === 'list' && (!served.change || !served.copy)) throw say('bad_list', `The row source ${row.source} has no copy a list can write.`);
    if (row.require_atomic !== undefined && typeof row.require_atomic !== 'boolean') throw say('bad_list', 'Source require_atomic is a boolean.');
    if (row.require_atomic && served.change?.input?.require_atomic !== '{require_atomic}') {
      throw say('bad_list', 'This source cannot forward its atomic publication requirement to its change owner.');
    }
    if (row.adopt_own_rows !== undefined && (typeof row.adopt_own_rows !== 'boolean' || (row.adopt_own_rows && row.original !== 'list'))) {
      throw say('bad_list', 'Source adopt_own_rows is a boolean, and only a list-original source adopts rows.');
    }
    if (row.adopt_own_rows && (typeof row.copy_name !== 'string' || !/\{[\w.]+(\|[\w-]+)?\}/.test(row.copy_name) || row.copy_name.startsWith('/') || row.copy_name.includes('..'))) {
      throw say('bad_list', 'A source that adopts rows names their files with copy_name, a relative path template such as "{note.by|person}/{note.name}.md" ({field|word}: the word when a row has no such value).');
    }
    return { ...row, id, served, values };
  });
}

function listOf(store, names, listId) {
  if (typeof listId !== 'string' || !listId) throw say('bad_input', 'Name a list (list) or a saved view (view).');
  const list = store.record(names.list_type, fill(names.list_record, { list_id: listId }));
  if (!list) throw say('not_found', `There is no list ${listId}.`);
  return list;
}

const addressOf = (list, names) => rowRecordAddress(list, names.row_type);
const titleOf = (list, values, otherwise) => (list.title_field && values?.[list.title_field]) ?? otherwise;

/** The rows for these records of the list's row type, in the order given: { id, record_id, values, title, source? }. */
function rowsFor(list, names, sources, records) {
  const address = addressOf(list, names);
  const prepared = prepareListTitles(list, records.map(record => record.value ?? {}));
  const projected = prepared.request ? prepared.finish(evaluateFormulaWithEngine(prepared.request)) : null;
  return records.map((record, index) => {
    const id = address.localId(record.id);
    const source = sources.find(one => id.startsWith(`${one.id}${SOURCE_MARK}`))?.id;
    return { id, record_id: record.id, values: record.value ?? {},
      title: projected ? projected[index] ?? id : titleOf(list, record.value, id), ...(source ? { source } : {}) };
  });
}

// Ordered as the store lists them (greatest id first): the list's own rows of its row type.
const rowRecordsOf = (store, list, names) => {
  const address = addressOf(list, names);
  return store.recordsOf(address.type, address.prefix);
};

// Every field a rule tree names.
function ruleFields(tree) {
  if (!tree || typeof tree !== 'object') return new Set();
  if (tree.kind === 'rule') return new Set(typeof tree.field === 'string' ? [tree.field] : []);
  return new Set((tree.rules ?? []).flatMap(rule => [...ruleFields(rule)]));
}

// The positions of the rows a view's rules keep, as the rule filter of tools/formula-engine decides; only the fields the
// rules read are given to it.
function keptPositions(rows, fields, tree) {
  const reads = ruleFields(tree);
  const found = filterRecordsWithEngine({
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

export function readListView(input = {}) {
  const names = checkedNames(input);
  const limit = checkedLimit(input);
  const store = storeOf(input.stored);
  let listId = input.list, view = null;
  if (input.view) {
    const held = store.record(names.view_type, input.view);
    if (!held) throw say('not_found', `There is no view ${input.view}.`);
    listId = held.list_id;
    view = held.view ?? {};
  }
  const list = listOf(store, names, listId);
  const sources = sourcesOf(list);
  const fields = list.fields ?? [];
  const records = rowRecordsOf(store, list, names);
  if (!view?.rules && !view?.sort?.length) {
    // The cursor is the record id the page before ended on: this page holds the records after it, greatest first.
    const after = input.after ?? null;
    const eligible = records.filter(record => after === null || record.id < after);
    const shown = eligible.slice(0, limit);
    return { list: listId, fields, rows: rowsFor(list, names, sources, shown),
      next: eligible.length > limit ? shown.at(-1).id : null, complete: true };
  }
  const every = rowsFor(list, names, sources, records.slice(0, limits.rows_per_read));
  let rows = every;
  if (view.rules) rows = keptPositions(rows, fields, view.rules).map(position => rows[position]);
  rows = ordered(rows, view.sort);
  const from = input.after === undefined || input.after === null ? 0 : Number(input.after);
  if (!Number.isSafeInteger(from) || from < 0) throw say('bad_input', 'after is not a cursor of this view.');
  return { list: listId, fields, rows: rows.slice(from, from + limit), next: from + limit < rows.length ? String(from + limit) : null,
    of: every.length, complete: records.length <= limits.rows_per_read };
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

/** A source's bounded pages, read from its folder. A successful terminal page, never a read-count limit, proves the source is complete. */
async function* sourcePages(source, mostBytes, signal) {
  // A template the row source leaves empty is no value, so the folder reader gets only what the list says.
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
    const answer = await readSourcePage(source.served.kind, { ...input, limit: limits.read_page_rows, ...(after ? { after } : {}), ...(mostBytes ? { most_bytes: mostBytes } : {}) });
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
function writtenRows(store, address, source) {
  const held = new Map();
  for (const record of store.recordsOf(address.type, address.recordId(`${source}${SOURCE_MARK}`))) held.set(record.id, valueIdentity(record.value));
  return held;
}

/** The records one document holds now: its own row and its text-part rows (id <path>#..., whose parent or source field is
 * the document: a file whose name holds # is not its part), as Map(record id -> value identity). */
function heldDocumentRows(store, address, source, path, { parentField, sourceField }) {
  const held = new Map();
  const own = address.recordId(`${source}${SOURCE_MARK}${encodeURIComponent(path)}`);
  const parts = address.recordId(`${source}${SOURCE_MARK}${encodeURIComponent(`${path}#`)}`);
  for (const record of store.recordsOf(address.type, own)) {
    // The own-row prefix also matches another document whose name starts with this one's; only this document's rows count.
    if (record.id === own) held.set(record.id, valueIdentity(record.value));
  }
  for (const record of store.recordsOf(address.type, parts)) {
    if (record.value?.[parentField] === path || record.value?.[sourceField] === path) held.set(record.id, valueIdentity(record.value));
  }
  return held;
}

// The fields that name the document a part row belongs to: the source's own content settings, else the document reader's.
function documentFields(source) {
  const content = source.content === true ? {} : source.content ?? {};
  return { parentField: content.parent_field ?? documentData.content.parent_field, sourceField: content.source_field ?? documentData.content.source_field };
}

// The keep rows a run answers: one per record id (the last value wins), each with the value the store held when it was
// read (expected), so the store refuses a row whose record moved. A removal of a record the store did not hold is no row.
export function keeperOf(store) {
  const rows = new Map();
  return {
    put(type, id, value) {
      const held = store.record(type, id);
      if (value === null && held === null) {
        rows.delete(id);
        return;
      }
      rows.set(id, { id, type, value, expected: held === null ? null : { type, value: structuredClone(held) } });
    },
    current(type, id) {
      return rows.has(id) ? rows.get(id).value : store.record(type, id);
    },
    list: () => [...rows.values()],
  };
}

// A changed document: its rows (the row of the document and, when it is long, its linked text-part rows) are reconciled
// from a source answer for that one path only, so every other document stays as it is. A part the document no longer
// has is removed; a source that answers no row for a path it still holds keeps the old rows: a deletion is named in
// `removed`, never inferred from a missing answer.
async function refreshChangedSource({ keep, store, address, source, paths, removedPaths, mostBytes, signal }) {
  const { type } = address;
  const fields = documentFields(source);
  let rows = 0, written = 0, removed = 0, unchanged = 0;
  for (const path of paths) {
    signal?.throwIfAborted();
    const held = heldDocumentRows(store, address, source.id, path, fields);
    const seen = new Set(), writes = [];
    // A source read from a catalogue file (paths_file) answers one changed path by that path alone: the document reader takes
    // paths or a paths_file, never both. The caller names only paths its catalogue lists, from a catalogue that did not change;
    // a path the catalogue stopped listing, or a catalogue that changed, is a whole-source refresh, never a delta here.
    const { paths_file: catalogue, ...scoped } = source;
    for await (const page of sourcePages({ ...scoped, paths: [path] }, mostBytes, signal)) {
      for (const row of page) {
        if (row.id !== path && (!row.id.startsWith(`${path}#`) ||
            (row.values?.[fields.parentField] !== path && row.values?.[fields.sourceField] !== path))) {
          throw say('source_changed_path_mismatch', `The source answered ${row.id} for the changed document ${path}.`);
        }
        const id = address.recordId(`${source.id}${SOURCE_MARK}${encodeURIComponent(row.id)}`);
        if (seen.has(id)) throw say('source_duplicate_row', `The row source ${source.id} answered a row id twice.`);
        seen.add(id);
        const value = projectedValues(source, row);
        if (held.get(id) === valueIdentity(value)) unchanged += 1;
        else writes.push({ id, type, value });
        held.delete(id);
        rows += 1;
      }
    }
    if (!seen.size && held.size) {
      throw say('source_changed_path_unanswered', `The source did not answer the existing changed document ${path}; its old rows were preserved.`);
    }
    const stale = [...held.keys()];
    for (const write of writes) keep.put(type, write.id, write.value);
    for (const id of stale) keep.put(type, id, null);
    written += writes.length;
    removed += stale.length;
  }
  for (const path of removedPaths) {
    signal?.throwIfAborted();
    const held = heldDocumentRows(store, address, source.id, path, fields);
    for (const id of held.keys()) {
      keep.put(type, id, null);
      removed += 1;
    }
  }
  return { source: source.id, rows, written, removed, unchanged };
}

/** The changes a refresh names: exact changed and removed document paths for selected, unpositioned document sources. */
function checkedChanges(input, declared, selected) {
  if (input.changes === undefined) return {};
  if (!input.changes || typeof input.changes !== 'object' || Array.isArray(input.changes)) {
    throw say('bad_input', 'changes maps selected document source ids to exact changed and removed paths.');
  }
  const changedPath = path => typeof path === 'string' && path.startsWith('/') && !path.split('/').includes('..');
  for (const [id, change] of Object.entries(input.changes)) {
    const source = declared.find(one => one.id === id);
    if (!source || !selected.includes(source) || source.original === 'list' || source.paths !== undefined || source.served.tool !== data.row_sources.documents.tool) {
      throw say('bad_input', 'changes can narrow only selected, non-list-original document sources without a positive path catalogue.');
    }
    const lists = [change?.paths, change?.removed];
    if (!lists.every(list => Array.isArray(list) && list.every(changedPath)) || new Set([...lists[0], ...lists[1]]).size !== lists[0].length + lists[1].length || lists[0].length + lists[1].length === 0) {
      throw say('bad_input', 'each changes entry has distinct absolute paths and removed paths without traversal.');
    }
  }
  return input.changes;
}

export async function refreshRowSources(input = {}) {
  input.signal?.throwIfAborted();
  const names = checkedNames(input);
  const store = storeOf(input.stored);
  const list = listOf(store, names, input.list);
  const address = addressOf(list, names), { type } = address;
  const declared = sourcesOf(list);
  if (input.source_ids !== undefined && (!Array.isArray(input.source_ids) || !input.source_ids.length ||
      input.source_ids.some(id => typeof id !== 'string' || !id) || new Set(input.source_ids).size !== input.source_ids.length)) {
    throw say('bad_input', 'source_ids is a nonempty array of distinct declared source ids.');
  }
  if (input.source_ids?.some(id => !declared.some(source => source.id === id))) {
    throw say('bad_input', 'source_ids names a source this list does not declare.');
  }
  const selected = input.source_ids ? declared.filter(source => input.source_ids.includes(source.id)) : declared;
  if (input.paths !== undefined && (!Array.isArray(input.paths) || !input.paths.length || input.paths.some(path => typeof path !== 'string' || !path.startsWith('/')))) {
    throw say('bad_input', 'paths is a nonempty array of document names, each starting with /.');
  }
  if ((input.paths !== undefined || input.dry_run) && selected.some(source => source.original !== 'list')) {
    throw say('bad_input', 'paths and dry_run settle list-original sources; select only those with source_ids.');
  }
  const changes = checkedChanges(input, declared, selected);
  const keep = keeperOf(store);
  const sources = [];
  for (const source of selected) {
    if (changes[source.id]) {
      sources.push(await refreshChangedSource({ keep, store, address, source, paths: changes[source.id].paths,
        removedPaths: changes[source.id].removed, mostBytes: input.source_answer_bytes, signal: input.signal }));
      continue;
    }
    if (source.original === 'list') {
      sources.push(await syncRowSource({ list: input.list, type, record_prefix: address.prefix, source, sources: declared, paths: input.paths,
        dry_run: Boolean(input.dry_run), source_answer_bytes: input.source_answer_bytes, stored: input.stored, store, keep, signal: input.signal }));
      continue;
    }
    const held = writtenRows(store, address, source.id);
    const seen = new Set();
    let rows = 0, written = 0, unchanged = 0;
    for await (const page of sourcePages(source, input.source_answer_bytes, input.signal)) {
      for (const row of page) {
        const id = address.recordId(`${source.id}${SOURCE_MARK}${encodeURIComponent(row.id)}`);
        if (seen.has(id)) throw say('source_duplicate_row', `The row source ${source.id} answered a row id twice.`);
        seen.add(id);
        const value = projectedValues(source, row);
        if (held.get(id) === valueIdentity(value)) unchanged += 1;
        else {
          keep.put(type, id, value);
          written += 1;
        }
        held.delete(id);
        rows += 1;
      }
    }
    // Reaching here proves the source ended successfully. No deletion is attempted after a failed, stalled or
    // duplicate source page. Unread records and every other source's or own row remain untouched on that failure.
    input.signal?.throwIfAborted();
    const removals = [...held.keys()];
    for (const id of removals) keep.put(type, id, null);
    sources.push({ source: source.id, rows, written, removed: removals.length, unchanged });
  }
  return { list: input.list, sources, keep: keep.list() };
}

// The pieces the two-way sync of a list-original source shares with the one-way refresh (list-copy.mjs).
export { projectedValues, sourcePages, valueIdentity, SOURCE_MARK };
