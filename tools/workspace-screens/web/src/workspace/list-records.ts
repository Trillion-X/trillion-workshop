// src/workspace/list-records.ts
//
// PURPOSE
//   The page's lists as what they are: the person's own records. A list is the record `list:<id>` (its label, fields,
//   row type and title field, src/lists.json), each of its saved views the record `list-view:<id>:<view>` ({ list_id,
//   view, order }), each of its rows the record `record:<row_type>:<row>` (the row's values). Every read goes through
//   the page's one records road (records-door.ts: the records door's generic read, the read an AI's key reaches over
//   MCP, and the one records write). The screens over lists
//   (lists-screen.tsx) and the record picker's search (record-source.ts) use only this file.
//
// NON-NEGOTIABLE INVARIANTS
//   1. Nothing here names a list, a field or a kind of row: types and limits are src/lists.json DATA.
//   2. A row change merges the given values into the row as it is kept now (a value of null clears its field), so values
//      a tool kept on the row that the list does not show stay as they were; a removed row is written null.
//   3. A list change merges into the list record as it is kept now; a saved view is its own record, so saving one never
//      rewrites the list or its other views. A new view's order is the last view's order key with one digit added
//      (trillion-workshop/tools/keep-lists-of-rows/do-work/fractional-order.ts invariant 2: that key sorts after it).
//   4. A read that cannot be answered whole (a record larger than one answer) fails in words; it never draws a part.
//   5. A list's rows are read a page at a time (src/lists.json limits.read_page_rows) in the door's order (ids greatest
//      first), so a list of any length answers its first rows after one page; the next page is read when its screen asks.
//      Linked rows' titles are read after a page is drawn, only for the rows it links to.

import { listRecords, listRecordsFrom, readRecord as readOne, readRecordState, recordScope, writeRecords as write, type RecordScope, type RecordContext, type StoredRecord as Stored } from './records-door';
import { dependsOf } from '../record-depends.mjs';
import type { ReadDepends } from './store-changes';
import type { Rule, RuleNode } from '../../parts/ui/show/rule-filter/rule-tree';
import data from '../lists.json';

export type Field = { id: string; label: string; kind: string; links_to?: string; choices?: string[] } & Record<string, unknown>;
export type Kind = { id: string; label: string; icon?: string; kind: string; ruleKind: string; value: string; record_pick?: boolean; links?: boolean; document?: boolean; media?: boolean; carries?: { key: string } };
export type View = { id: string; label: string; search: string; rules?: unknown; sort?: {field: string; direction: 'asc' | 'desc'}[]; groups?: {field: string; bucket?: string}[]; columns?: {order?: string[]; hidden?: string[]}; time?: {field: string; after?: unknown; before?: unknown}; display?: {as: string; settings?: Record<string, unknown>} };
export type List = { scope?: RecordScope; context?: RecordContext; managed_rows?: {open_field?: string; create_on_screen?: boolean; share_record?: boolean}; id: string; label: string; icon?: string; about?: string; row_type: string; title_field: string | null; fields: Field[]; views?: View[] };
export type Row = { scope?: RecordScope; context?: RecordContext; id: string; title: string | null; values: Record<string, unknown>; links: Record<string, { id: string; title: string; scope?: RecordScope }[]> };
export type Read = { list: List; rows: Row[]; next: string | null; where: Record<string, unknown> | null; field_kinds: Kind[]; depends: ReadDepends | null };
export type RowPut = { id?: string; values: Record<string, unknown> };

const LIST = data.record_type;
const VIEW = data.view_records.type;
export const fieldKinds = data.field_kinds as Kind[];
const listId = (id: string) => `${LIST}:${id}`;
const viewPrefix = (id: string) => `${VIEW}:${id}:`;
const scopeOf = (list: Pick<List, 'scope'>) => list.scope === undefined ? undefined : recordScope(list.scope);
const rowType = (list: Pick<List, 'row_type'>) => `record:${list.row_type}`;
const rowPrefix = (list: Pick<List, 'row_type'>) => `${rowType(list)}:`;
const say = (words: string, status?: number) => Object.assign(new Error(words), status ? { status } : {});

/** Every record of one type (under `prefix` when given), following the door's pages to the end or until `most`. */
const readAll = (type: string, extra: { prefix?: string; fields?: string[]; scope?: RecordScope } = {}, most = Infinity) => listRecords({ type, ...extra }, most);

const titleOf = (list: Pick<List, 'title_field'>, values: Record<string, unknown> | null | undefined): string | null => {
  const title = list.title_field ? values?.[list.title_field] : undefined;
  return typeof title === 'string' && title ? title : Array.isArray(title) ? title.join(', ') : null;
};
const listOf = (id: string, record: Stored): List => {
  const { scope: _userScope, context: _userContext, ...value } = record.value ?? {};
  return { ...value, id, ...(record.scope ? { scope: recordScope(record.scope) } : {}),
    ...(record.context ? { context: record.context } : {}) } as List;
};

// The catalog keeps a logical reference, never a physical home or a supply name.
// An already opened list carries it on every row operation without another lookup.
async function resolveList(id: string, record: Stored): Promise<List> {
  const reference = record.value?.record_scope;
  if (reference === undefined) return listOf(id, record);
  const scope = recordScope(reference);
  const selected = await readRecordState(listId(id), LIST, scope);
  if (!selected.value) throw say('This list is not kept any more.', 404);
  return listOf(id, selected);
}

/** Every list this person keeps. */
export async function readLists(): Promise<List[]> {
  // The door answers ids greatest first; the lists are shown in id order.
  return Promise.all((await readAll(LIST)).reverse().map(record => resolveList(record.id.slice(LIST.length + 1), record)));
}

/** One list as kept, or a refusal in words when it is not kept. */
export async function readListRecord(id: string, scope?: RecordScope): Promise<List> {
  const record = await readRecordState(listId(id), LIST, scope);
  if (!record.value) throw say('This list is not kept any more.', 404);
  return scope ? listOf(id, record) : resolveList(id, record);
}

/** The list's saved views: the ones it kept inside itself before, then its own view records (`kept`) in their order. */
function viewsOf(list: List, kept: Stored[]): View[] {
  const own = kept
    .map(record => ({ id: record.id, view: record.value!.view as View | undefined, order: String(record.value!.order ?? '') }))
    .filter((row): row is { id: string; view: View; order: string } => Boolean(row.view))
    .sort((a, b) => (a.order < b.order ? -1 : a.order > b.order ? 1 : a.id < b.id ? -1 : 1));
  const named = new Set(own.map(row => row.view.id));
  return [...(list.views ?? []).filter(view => !named.has(view.id)), ...own.map(row => row.view)];
}

// The fields of `list` that link to rows (a link kind naming the list it links to).
const linkFieldsOf = (list: List) => list.fields.filter(field => field.links_to && fieldKinds.find(kind => kind.id === field.kind)?.links);

/** `rows` with each link titled from `titles` (by the list linked to and row id); a row of this same list that `rows`
 *  hold titles itself, and a link not titled yet shows its id. */
const titledRows = (list: List, rows: Row[], titles: Map<string, Map<string, string>> = new Map(), histories: Map<string, RecordScope> = new Map()): Row[] => {
  const here = new Map(rows.map(row => [row.id, row.title]));
  const linkFields = linkFieldsOf(list);
  return rows.map(row => ({ ...row, links: Object.fromEntries(linkFields.filter(field => Array.isArray(row.values[field.id])).map(field => [field.id,
    (row.values[field.id] as unknown[]).map(linked => {
      const id = String(linked);
      const scope = field.links_to === list.id ? scopeOf(list) : histories.get(field.links_to!);
      return { id, title: titles.get(field.links_to!)?.get(id) ?? (field.links_to === list.id ? here.get(id) : null) ?? id, ...(scope ? { scope } : {}) };
    })])) }));
};

/** `rows` with every link titled: each linked row these rows name is read once by its id (a row of this same list that
 *  `rows` hold is its own answer), so a page costs the rows it names, never every row of a linked list. Read after the
 *  rows are drawn (invariant 5): a link shows its id until its title is read. */
export async function titleLinks(list: List, rows: Row[]): Promise<Row[]> {
  const linkFields = linkFieldsOf(list);
  const here = new Set(rows.map(row => row.id));
  const histories = new Map<string, RecordScope>();
  const titles = new Map(await Promise.all([...new Set(linkFields.map(field => field.links_to!))].map(async target => {
    const other = target === list.id ? list : await readListRecord(target).catch(() => null);
    const named = [...new Set(rows.flatMap(row => linkFields.filter(field => field.links_to === target)
      .flatMap(field => (Array.isArray(row.values[field.id]) ? (row.values[field.id] as unknown[]).map(String) : []))))]
      .filter(id => !(target === list.id && here.has(id)));
    if (!other) return [target, new Map<string, string>()] as const;
    const scope = scopeOf(other);
    if (scope) histories.set(target, scope);
    return [target, new Map(await Promise.all(named.map(async id =>
      [id, titleOf(other, await readOne(`${rowPrefix(other)}${id}`, rowType(other), scopeOf(other)).catch(() => null)) ?? id] as const)))] as const;
  })));
  return titledRows(list, rows, titles, histories);
}

/** What the records door decides of `rules` itself (src/lists.json store_narrows): `where`, each top-level field equal
 *  to one value, from the rules of a top-level `and` group the door can decide, and whether that is `whole`, every rule
 *  in force (a rule the door cannot decide is left to the page, over every row it reads). */
export function whereOf(rules: RuleNode | null | undefined): { where: Record<string, unknown> | null; whole: boolean } {
  const group = rules && rules.kind === 'group' ? rules : null;
  const kept = group?.rules ?? [];
  if (!group || kept.length === 0) return { where: null, whole: true };
  if (group.negate || (group.combinator !== 'and' && kept.length > 1)) return { where: null, whole: false };
  const where: Record<string, unknown> = {};
  let whole = true;
  for (const rule of kept) {
    const narrows = rule.kind === 'rule' ? (data.store_narrows.operators as Record<string, { param?: string; equals?: unknown }>)[rule.operator] : undefined;
    const given = narrows?.param !== undefined ? (rule as Rule).params[narrows.param] : undefined;
    const value = narrows?.equals !== undefined ? narrows.equals : Array.isArray(given) && given.length === 1 ? given[0] : undefined;
    if (rule.kind !== 'rule' || value === undefined || (rule.field in where && where[rule.field] !== value)) { whole = false; continue; }
    where[rule.field] = value;
  }
  return { where: Object.keys(where).length ? where : null, whole };
}

/** One page of `list`'s rows from `after` (a previous page's `next`; the first page when null), each with its title and
 *  its links (titled by titleLinks after they are drawn), and where the page after it starts (null after the last). A
 *  page is what one door call answers of read_page_rows (the door may cut it shorter to fit one message); `most` reads
 *  on until that many, and `every` (the caller is reading every row: a search or rule decided over all of them) until
  *  rows_per_read; with `where` (whereOf), only the rows the door finds equal to it, read until read_page_rows of them. */
export async function readRows(list: List, after: string | null, { every = false, most, where = null }: { every?: boolean; most?: number; where?: Record<string, unknown> | null } = {}): Promise<{ rows: Row[]; next: string | null }> {
  const asked = most ?? (every ? data.limits.rows_per_read : data.limits.read_page_rows);
  // A narrowed read goes on until it has a page of rows or none are left, since one door call may keep none.
  const pages = most === undefined && !every && !where ? 1 : Infinity;
  const { records: stored, next } = await listRecordsFrom({ type: rowType(list), ...(scopeOf(list) ? { scope: scopeOf(list) } : {}), ...(where ? { where } : {}) }, asked, after, pages);
  const rows = stored.map(record => ({ id: record.id.slice(rowPrefix(list).length), title: titleOf(list, record.value), values: record.value!, links: {}, ...(record.scope ? { scope: record.scope } : {}), ...(record.context ? { context: record.context } : {}) }));
  return { rows: titledRows(list, rows), next };
}

/** What a read of `list` depended on: the list, its view records and every record of its row type. */
const dependsOfList = (list: List): ReadDepends | null => {
  const depends = dependsOf({
  version: null, ids: [listId(list.id)], rows: [],
  members: [{ prefix: rowPrefix(list), fields: null }, { prefix: viewPrefix(list.id), fields: null }],
  });
  return depends ? { ...depends, ...(scopeOf(list) ? { scope: scopeOf(list) } : {}) } : null;
};

/** One list with its saved views, its first page of rows or as many as `drawn` (invariant 5; each with its title, its
 *  links titled by titleLinks once drawn; only those equal to `where` when given), where the page after them starts, and
 *  the field kinds. */
export async function readList(selected: string | List, drawn = 0, where: Record<string, unknown> | null = null): Promise<Read> {
  const id = typeof selected === 'string' ? selected : selected.id;
  const kept = await readListRecord(id, typeof selected === 'string' ? undefined : scopeOf(selected));
  const viewRecords = await readAll(VIEW, { prefix: viewPrefix(id), ...(scopeOf(kept) ? { scope: scopeOf(kept) } : {}) });
  const list = { ...kept, views: viewsOf(kept, viewRecords) };
  return { list, ...await readRows(list, null, { ...(drawn > 0 ? { most: drawn } : {}), where }), where, field_kinds: fieldKinds, depends: dependsOfList(list) };
}

/** Merges `change` into the list record as kept now (invariant 3). */
export async function changeList(selected: string | List, change: Record<string, unknown>): Promise<void> {
  const list = typeof selected === 'string' ? await readListRecord(selected) : selected;
  const scope = scopeOf(list);
  const kept = await readRecordState(listId(list.id), LIST, scope);
  if (!kept.value) throw say('This list is not kept any more.', 404);
  const value = { ...kept.value, ...change };
  if (change.row_records === null) delete value.row_records;
  await write([{ id: listId(list.id), type: LIST, value }], { scope });
}

/** Makes a list; answers it. */
export async function makeList(label: string, fields: Field[]): Promise<List> {
  const id = `list-${crypto.randomUUID()}`;
  return ensureList(id, { label, title_field: fields[0]?.id ?? null, fields });
}

/** Makes the list once. The complete identity is kept in its existing catalog record. */
export async function ensureList(id: string, value: { label: string; title_field: string | null; fields: Field[] }, { quiet = false } = {}): Promise<List> {
  const kept = await readRecordState(listId(id), LIST);
  if (kept.value) return resolveList(id, kept);
  const made = { ...value, row_type: id };
  const generation = kept.context?.generation;
  if (!Number.isSafeInteger(generation) || generation! < 1) throw say('The current record history could not be read.');
  // Deterministic logical references let the same named creation recover an
  // initialized domain after losing its catalog publication reply.
  const scope = recordScope({ id: listId(id), incarnation: listId(id), generation });
  try {
    await write([{ id: listId(id), type: LIST, value: made, expected: null }], { quiet, scope, create: true });
  } catch (error) {
    if ((error as { status?: number }).status !== 409) throw error;
    // Only the same complete history can recover an initialized named list.
    await readListRecord(id, scope);
  }
  try {
    await write([{ id: listId(id), type: LIST, value: { record_scope: scope }, expected: null }], { quiet });
  } catch (error) {
    if ((error as { status?: number }).status !== 409) throw error;
  }
  // Read the published winner; never acknowledge a catalog link that we did
  // not observe, nor overwrite a concurrent creation with our prepared copy.
  return readListRecord(id);
}

/** Keeps rows (a row with no id is a new row) and removes rows, merging each into its row as kept now (invariant 2).
 *  Answers the ids of the rows kept, in the order given. */
export async function putRows(list: Pick<List, 'row_type' | 'scope'>, rows: RowPut[], remove: string[] = [], { quiet = false } = {}): Promise<string[]> {
  const type = rowType(list);
  const kept = await Promise.all(rows.map(async row => {
    const id = row.id ?? crypto.randomUUID();
    const now = row.id ? await readOne(`${rowPrefix(list)}${id}`, type, scopeOf(list)) : null;
    const merged = Object.fromEntries(Object.entries({ ...now, ...row.values }).filter(([, value]) => value !== null && value !== undefined));
    return { id, record: { id: `${rowPrefix(list)}${id}`, type, value: merged } };
  }));
  await write([...kept.map(row => row.record), ...remove.map(id => ({ id: `${rowPrefix(list)}${id}`, type, value: null }))], { quiet, scope: scopeOf(list) });
  return kept.map(row => row.id);
}

/** Keeps one saved view as its own record, in the place it holds (a new one after the others, invariant 3). */
export async function saveView(selected: string | List, view: View): Promise<void> {
  const list = typeof selected === 'string' ? await readListRecord(selected) : selected;
  const id = list.id, scope = scopeOf(list);
  const own = await readAll(VIEW, { prefix: viewPrefix(id), ...(scope ? { scope } : {}) });
  const held = own.find(record => record.id === `${viewPrefix(id)}${view.id}`)?.value?.order;
  const last = own.map(record => record.value!.order).filter((order): order is string => typeof order === 'string' && order !== '').sort().pop();
  const order = typeof held === 'string' && held ? held : `${last ?? ''}V`;
  await write([{ id: `${viewPrefix(id)}${view.id}`, type: VIEW, value: { list_id: id, view, order } }], { scope });
}

/** Removes one saved view's record. */
export async function removeView(selected: string | List, viewId: string): Promise<void> {
  const list = typeof selected === 'string' ? await readListRecord(selected) : selected;
  await write([{ id: `${viewPrefix(list.id)}${viewId}`, type: VIEW, value: null }], { scope: scopeOf(list) });
}

// How well a row answers the words searched, as the lists owner scored it (src/lists.mjs search): its title exactly,
// from its start, from a word's start, inside, holding every word, then its other words; 0 is no match.
const scoreOf = (title: string, rest: string, needle: string) => {
  const lower = title.toLowerCase();
  const words = needle.split(/\s+/).filter(Boolean);
  if (!needle) return 1;
  if (lower === needle) return 100;
  if (lower.startsWith(needle)) return 80;
  if (lower.split(/[^\p{L}\p{N}]+/u).some(word => word.startsWith(needle))) return 60;
  if (lower.includes(needle)) return 40;
  if (words.length && words.every(word => lower.includes(word))) return 30;
  return rest.toLowerCase().includes(needle) ? 10 : 0;
};
// Whether a list holds what src/lists.json `holds` names (people: its row type, or a field of a named kind).
const holdsList = (holds: string | undefined, list: List) => {
  const row = holds ? (data.holds as unknown as Record<string, { row_types?: string[]; field_kinds?: string[] } | undefined>)[holds] : undefined;
  return Boolean(row && typeof row === 'object' && (row.row_types?.includes(list.row_type) || list.fields.some(field => row.field_kinds?.includes(field.kind))));
};

/** Rows across the named lists (`lists`, `row_types`, `holds`; every list when none is named), best match first, each
 *  with its other words as its detail, bounded by src/lists.json limits (search_lists lists, rows_per_read newest rows of
 *  each, search_default or the limit asked, at most search_most answers). */
export async function searchRows(query: string, from: { lists?: string[]; row_types?: string[]; holds?: string }, limit?: number) {
  const needle = query.trim().toLowerCase();
  const wanted = (from.lists ?? []).map(name => name.replace(/^list:/, ''));
  const types = from.row_types ?? [];
  const everything = !wanted.length && !types.length && !from.holds;
  const lists = (await readLists())
    .filter(list => everything || wanted.includes(list.id) || types.includes(list.row_type) || holdsList(from.holds, list))
    .slice(0, data.limits.search_lists);
  const scored = (await Promise.all(lists.map(async list => {
    const linking = new Set(fieldKinds.filter(kind => kind.links).map(kind => kind.id));
    return (await readAll(rowType(list), { ...(scopeOf(list) ? { scope: scopeOf(list) } : {}) }, data.limits.rows_per_read)).flatMap(row => {
      const title = titleOf(list, row.value);
      if (!title) return [];
      const rest = list.fields.filter(field => field.id !== list.title_field && !linking.has(field.kind))
        .map(field => row.value?.[field.id]).filter((value): value is string => typeof value === 'string' && value !== '').join(' · ');
      const score = scoreOf(title, rest, needle);
      return score ? [{ score, row: { id: row.id.slice(rowPrefix(list).length), list_id: list.id, list_label: list.label, title, detail: rest.slice(0, data.limits.search_detail_chars), ...(row.scope ? { scope: row.scope } : {}) } }] : [];
    });
  }))).flat().sort((a, b) => b.score - a.score || a.row.title.localeCompare(b.row.title) || a.row.id.localeCompare(b.row.id));
  const most = Math.min(Math.max(Number.parseInt(String(limit), 10) || data.limits.search_default, 1), data.limits.search_most);
  return scored.slice(0, most).map(item => item.row);
}
