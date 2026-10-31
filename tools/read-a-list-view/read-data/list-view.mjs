// tools/read-a-list-view/read-data/list-view.mjs
//
// Purpose: one page of what a person's list shows: the list's own rows (records of its row type), then the rows of each
// row source the list declares (`row_sources: [{ source, of?, match? }]`), each source read by running the tool that serves it.
// With a saved view, the rows its rules keep, in its order. Ported from the read path of the lists in the earlier
// Trillion app (src/lists.mjs withRowSources: own rows first, then each source in order, a source row's id
// `<source>~<id>`, a cursor that says which source to go on in) and from the view read of
// tools/export-records-as-list-rows (the person's rule-filter tool decides which rows the view's rules keep, then the
// view's sort orders them).
//
// Non-Negotiable Invariants:
//   1. Nothing is copied: a source's rows are read from the source at every read and are never written anywhere.
//   2. No list, view, field, record type, source or tool is named here. The record names are the config's (`names`),
//      the sources and their tools are DATA (list-view.json `row_sources`, which a config's `sources` may add to), and
//      so are the bounds of a list read (list-view.json `limits`: read_page_rows, rows_per_read, row_sources_per_list).
//   3. A list declaring more row sources than `row_sources_per_list`, or a source no row serves, is refused with words;
//      a source tool that answers no rows is refused, never shown as empty.
//   4. A page holds at most `limit` rows (`read_page_rows` when not given, never more than `rows_per_read`). A view with
//      rules or a sort reads at most `rows_per_read` rows in all, since its order needs every row, and says
//      `complete: false` when there were more.
//   5. A source is told the room its answer has (`source_answer_bytes`, as `most_bytes`) when the door that carries it
//      answers within a bounded message, so a page of big rows ends early and goes on, never becomes an unknown outcome.
//
//   readListView({ list | view, after?, limit?, names, sources?, filter?, source_answer_bytes? }, door)
//     → { list, fields, rows: [{ id, record_id?, values, title, source? }], next, complete, of? }   (of: a view's rows before its rules)
//   door: { read(type, id) → value | null, list({ type, limit, after? }) → { records, next }, run(tool, input) → its answer }
import data from './list-view.json' with { type: 'json' };

const say = (code, words) => Object.assign(new Error(words), { code });
const fill = (template, values) => template.replace(/\{(\w+)\}/g, (_, key) => values[key] ?? '');
const at = (value, path) => path.split('.').reduce((held, part) => (held == null ? held : held[part]), value);
const SOURCE_CURSOR = 'src~';
// The bounds of a list read are this reader's own DATA (list-view.json `limits`): the list read is this tool's job.
const { limits } = data;

function checked(input) {
  const names = input.names;
  if (!names || ['list_type', 'list_record', 'row_type'].some(key => typeof names[key] !== 'string') || (input.view && typeof names.view_type !== 'string')) {
    throw say('bad_input', 'names must give list_type, list_record (with {list_id}), row_type (with {row_type}) and, to read a view, view_type.');
  }
  const limit = input.limit ?? limits.read_page_rows;
  if (!Number.isSafeInteger(limit) || limit < 1) throw say('bad_input', 'limit must be a whole number from 1.');
  return { names, limit: Math.min(limit, limits.rows_per_read) };
}

/** The sources a list declares, each with the row of the tool that serves it. */
function sourcesOf(list, sources) {
  const declared = list.row_sources ?? [];
  if (!Array.isArray(declared) || declared.length > limits.row_sources_per_list) {
    throw say('bad_list', `A list shows at most ${limits.row_sources_per_list} row sources.`);
  }
  return declared.map(row => {
    const served = sources[row?.source];
    if (!served) throw say('bad_list', `No tool serves the row source ${JSON.stringify(row?.source)}.`);
    return { ...row, served };
  });
}

const titleOf = (list, values, otherwise) => (list.title_field && values?.[list.title_field]) ?? otherwise;

/** One page of a source's rows, as list rows: { rows, next }. */
async function sourcePage(door, list, source, { after, limit, mostBytes }) {
  // A template the row source leaves empty is no value, so the tool gets only what the list says.
  const input = Object.fromEntries(Object.entries(source.served.input)
    .map(([key, template]) => [key, fill(template, { of: source.of ?? '', match: source.match ?? '' })]).filter(([, value]) => value !== ''));
  const answer = await door.run(source.served.tool, { ...input, limit, ...(after ? { after } : {}), ...(mostBytes ? { most_bytes: mostBytes } : {}) });
  const rows = at(answer, source.served.rows_at);
  if (!Array.isArray(rows)) throw say('source_unanswered', `The row source ${source.source} answered no rows: ${JSON.stringify(answer).slice(0, 300)}`);
  return {
    rows: rows.slice(0, limit).map(row => ({ id: `${source.source}~${row.id}`, values: row.values ?? {}, title: titleOf(list, row.values, row.title ?? row.id), source: source.source })),
    next: at(answer, source.served.next_at) ?? null,
  };
}

/** One page of the list's own rows, the records of its row type: { rows, next }. */
async function ownPage(door, list, names, { after, limit }) {
  const type = fill(names.row_type, { row_type: list.row_type });
  const page = await door.list({ type, limit, ...(after ? { after } : {}) });
  if (!Array.isArray(page?.records)) throw say('records_unanswered', `Listing ${type} answered no records.`);
  return {
    rows: page.records.map(record => {
      const id = record.id.startsWith(`${type}:`) ? record.id.slice(type.length + 1) : record.id;
      return { id, record_id: record.id, values: record.value ?? {}, title: titleOf(list, record.value, id) };
    }),
    next: page.records.length ? page.next ?? null : null,
  };
}

/** Rows from `cursor` on, own rows first and then each source in order, until `room` rows: { rows, next }. */
async function pageFrom(door, list, names, sources, cursor, room, mostBytes) {
  const rows = [];
  let part = 0, after = cursor;
  if (typeof cursor === 'string' && cursor.startsWith(SOURCE_CURSOR)) {
    const [index, ...rest] = cursor.slice(SOURCE_CURSOR.length).split('~');
    part = Number(index) + 1;
    after = rest.join('~') || null;
    if (!Number.isSafeInteger(part) || part < 1 || part > sources.length) throw say('bad_input', 'after is not a cursor of this list.');
  }
  while (part <= sources.length) {
    const left = room - rows.length;
    if (left <= 0) return { rows, next: part === 0 ? after : `${SOURCE_CURSOR}${part - 1}~${after ?? ''}` };
    // One request asks for at most read_page_rows: the door refuses a bigger page, and this loop gathers the rest.
    const asked = Math.min(left, limits.read_page_rows);
    const page = part === 0 ? await ownPage(door, list, names, { after, limit: asked }) : await sourcePage(door, list, sources[part - 1], { after, limit: asked, mostBytes });
    rows.push(...page.rows);
    if (page.next && page.rows.length) { after = page.next; continue; }
    part += 1;
    after = null;
  }
  return { rows, next: null };
}

// Every field a rule tree names.
function ruleFields(tree) {
  if (!tree || typeof tree !== 'object') return new Set();
  if (tree.kind === 'rule') return new Set(typeof tree.field === 'string' ? [tree.field] : []);
  return new Set((tree.rules ?? []).flatMap(rule => [...ruleFields(rule)]));
}

// The positions of the rows a view's rules keep, as the person's rule-filter tool decides; only the fields the rules
// read are sent.
async function keptPositions(door, filter, rows, fields, tree) {
  const reads = ruleFields(tree);
  const answer = await door.run(filter.tool, {
    records: rows.map(row => ({ value: Object.fromEntries([...reads].filter(name => name in row.values).map(name => [name, row.values[name]])) })),
    fields: fields.filter(field => reads.has(field.id)).map(field => ({ id: field.id, kind: field.kind, path: ['value', field.id] })),
    tree,
  });
  const found = answer?.result ?? answer;
  if (!Array.isArray(found?.matches)) throw say('filter_unanswered', `The rule filter did not answer: ${JSON.stringify(answer).slice(0, 300)}`);
  if (found.incomplete?.length) throw say('view_rules_unusable', `The view has rules the filter could not use: ${JSON.stringify(found.incomplete).slice(0, 300)}`);
  return found.matches;
}

// A value's canonical JSON (keys sorted, no spaces) as UTF-8 bytes: values are ordered by these bytes, whatever their
// kind, the same order the view publish of export-records-as-list-rows gave (its published file's hash depends on it).
const canonical = value => (Array.isArray(value) ? `[${value.map(canonical).join(',')}]`
  : value && typeof value === 'object' ? `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`
    : JSON.stringify(value));
const compare = (x, y) => Buffer.compare(Buffer.from(canonical(x)), Buffer.from(canonical(y)));

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
  const { names, limit } = checked(input);
  let listId = input.list, view = null;
  if (input.view) {
    const held = await door.read(names.view_type, input.view);
    if (!held) throw say('not_found', `There is no view ${input.view}.`);
    listId = held.list_id;
    view = held.view ?? {};
  }
  if (typeof listId !== 'string' || !listId) throw say('bad_input', 'Name a list (list) or a saved view (view).');
  const list = await door.read(names.list_type, fill(names.list_record, { list_id: listId }));
  if (!list) throw say('not_found', `There is no list ${listId}.`);
  const sources = sourcesOf(list, { ...data.row_sources, ...(input.sources ?? {}) });
  const fields = list.fields ?? [];
  if (!view?.rules && !view?.sort?.length) {
    const page = await pageFrom(door, list, names, sources, input.after ?? null, limit, input.source_answer_bytes);
    return { list: listId, fields, rows: page.rows, next: page.next, complete: true };
  }
  const every = await pageFrom(door, list, names, sources, null, limits.rows_per_read, input.source_answer_bytes);
  let rows = every.rows;
  if (view.rules) {
    if (!input.filter?.tool) throw say('bad_input', 'A view with rules needs filter: { tool }, the person\'s rule-filter tool.');
    rows = (await keptPositions(door, input.filter, rows, fields, view.rules)).map(position => rows[position]);
  }
  rows = ordered(rows, view.sort);
  const from = input.after === undefined || input.after === null ? 0 : Number(input.after);
  if (!Number.isSafeInteger(from) || from < 0) throw say('bad_input', 'after is not a cursor of this view.');
  return { list: listId, fields, rows: rows.slice(from, from + limit), next: from + limit < rows.length ? String(from + limit) : null,
    of: every.rows.length, complete: every.next === null };
}
