// tools/keep-lists-of-rows/read-data/table-lists.ts
//
// PURPOSE
//   The Lists screen's owner: a person's lists are the tables of their own databases (the person's ruling that their
//   kinds are real tables, one table per list, never lists kept as records). Every database the person's vault holds a
//   connection for (table-lists.json) is read with SQL through the SQL tool, each base table is a list, its columns its
//   fields and its primary key its rows' ids. A cell edited, a row added or removed and a field added are SQL on that
//   table; a new list is a new table; saved views are rows of the views table, made on first save. The functions have the
//   shape the screen (web/src/workspace/lists-screen.tsx) always called, so the screen is unchanged.
//
// NON-NEGOTIABLE INVARIANTS
//   1. Nothing here names a database, a table or a column: they are the person's own, and the rest is table-lists.json.
//   2. Every name put into SQL is quoted as an identifier; every value is a parameter.
//   3. A table with no primary key is read, never changed: a change to it is refused in plain words.
//   4. A database that cannot be read leaves its tables out; the others are drawn.
//   5. A list is read a page at a time (lists.json limits), newest key first.
//
// AI DIRECTIVE: You are forbidden from simplifying or removing this documentation.

import { postJson } from '../../workspace-screens/web/src/workspace/api';
import { runWorkshopTool } from '../../workspace-screens/web/src/workspace/workshop-tool-api';
import type { ReadDepends } from '../../workspace-screens/web/src/workspace/store-changes';
import type { RuleNode } from '../../ui/show/rule-filter/rule-tree';
import lists from '../../keep-and-wake-ai-sessions-on-this-computer/src/lists.json';
import data from './table-lists.json';
import { fencedReadOf, NO_USE_BINDING } from './consent-fence.mjs';

export type Field = { id: string; label: string; kind: string; links_to?: string; choices?: string[] } & Record<string, unknown>;
export type Kind = { id: string; label: string; icon?: string; kind: string; ruleKind: string; value: string; record_pick?: boolean; links?: boolean; document?: boolean; media?: boolean; carries?: { key: string } };
export type View = { id: string; label: string; search: string; rules?: unknown; sort?: { field: string; direction: 'asc' | 'desc' }[]; groups?: { field: string; bucket?: string }[]; columns?: { order?: string[]; hidden?: string[] }; time?: { field: string; after?: unknown; before?: unknown }; display?: { as: string; settings?: Record<string, unknown> } };
export type List = { scope?: undefined; context?: undefined; managed_rows?: { open_field?: string; create_on_screen?: boolean; share_record?: boolean }; id: string; label: string; icon?: string; about?: string; row_type: string; title_field: string | null; fields: Field[]; views?: View[]; offered_views?: string[]; add_label?: string; key: string[] };
export type Row = { scope?: undefined; context?: undefined; id: string; title: string | null; values: Record<string, unknown>; links: Record<string, { id: string; title: string }[]> };
export type Read = { list: List; rows: Row[]; next: string | null; refused: boolean; where: Record<string, unknown> | null; field_kinds: Kind[]; depends: ReadDepends | null };
export type RowPut = { id?: string; values: Record<string, unknown> };

export const fieldKinds = lists.field_kinds as Kind[];
const say = (words: string, status?: number) => Object.assign(new Error(words), status ? { status } : {});
const quote = (name: string) => `"${name.replace(/"/g, '""')}"`;
const plain = (name: string) => name.replace(/_/g, ' ').replace(/^./, first => first.toUpperCase());

/** A list's id names where its table is: the connection, the schema and the table. */
const idOf = (credential: string, schema: string, table: string) => [credential, schema, table].map(encodeURIComponent).join('/');
const placeOf = (id: string) => {
  const [credential, schema, table] = id.split('/').map(decodeURIComponent);
  if (!credential || !schema || !table) throw say(data.words.unknown, 404);
  return { credential, schema, table, name: `${quote(schema)}.${quote(table)}` };
};

async function sql<T = Record<string, unknown>>(credential: string, statement: string, params: unknown[] = []): Promise<T[]> {
  const ran = await runWorkshopTool<{ rows?: T[] }>(data.tool, { credential_name: credential, sql: statement, params, statement_timeout_ms: data.statement_timeout_ms });
  if (!Array.isArray(ran.result?.rows)) throw say(data.words.not_read);
  return ran.result.rows;
}

// Databases with no use_binding schema, so no table in them is fenced: read as they are from then on.
const unfenced = new Set<string>();
/** One page of a table's rows, asked of the fence in the same statement (consent-fence.mjs); a fenced table this use is not allowed for is refused. */
async function pageOf(credential: string, name: string, order: string, limit: number, offset: number): Promise<{ refused: boolean; values: Record<string, unknown>[] }> {
  if (!unfenced.has(credential)) {
    try {
      const [answer] = await sql<Record<string, unknown>>(credential, `with f as (select * from use_binding.fenced($1::regclass)) select f.fenced, f.allowed, (select coalesce(json_agg(r), '[]') from (select * from ${name} order by ${order} limit $2 offset $3) r) as rows from f`, [name, limit, offset]);
      const page = fencedReadOf(answer);
      return { refused: page.refused, values: page.rows as Record<string, unknown>[] };
    } catch (error) {
      if (!NO_USE_BINDING.test(String((error as Error)?.message ?? error))) throw error;
      unfenced.add(credential);
    }
  }
  return { refused: false, values: await sql(credential, `select * from ${name} order by ${order} limit $1 offset $2`, [limit, offset]) };
}

const kindOf = (type: string) => (data.kinds.find(kind => kind.types.includes(type)) ?? data.kinds.at(-1)!).kind;
const columnOf = (kind: string) => (data.kinds.find(one => one.kind === kind) ?? data.kinds.at(-1)!).column;

type Table = { schema: string; table: string; columns: { name: string; type: string }[]; key: string[] | null };
const TABLES = `select c.table_schema as schema, c.table_name as "table",
  json_agg(json_build_object('name', c.column_name, 'type', c.data_type) order by c.ordinal_position) as columns,
  (select json_agg(k.column_name order by k.ordinal_position) from information_schema.table_constraints t
     join information_schema.key_column_usage k on k.constraint_name = t.constraint_name and k.table_schema = t.table_schema and k.table_name = t.table_name
     where t.constraint_type = 'PRIMARY KEY' and t.table_schema = c.table_schema and t.table_name = c.table_name) as key
  from information_schema.columns c
  join information_schema.tables b on b.table_schema = c.table_schema and b.table_name = c.table_name and b.table_type = 'BASE TABLE'
  where c.table_schema <> all($1::text[])
  group by c.table_schema, c.table_name order by 1, 2`;

const listOfTable = (credential: string, { schema, table, columns, key }: Table): List => {
  const fields = columns.map(column => ({ id: column.name, label: plain(column.name), kind: kindOf(column.type) }));
  const titled = fields.find(field => /^(title|name|label)$/i.test(field.id)) ?? fields.find(field => field.kind === 'text' && !(key ?? []).includes(field.id)) ?? fields[0];
  return { id: idOf(credential, schema, table), label: plain(table), about: plain(credential.slice(0, -data.credential_suffix.length)),
    row_type: idOf(credential, schema, table), title_field: titled?.id ?? null, fields, key: key ?? [] };
};

let known = new Map<string, List>();

/** Every table of every database the person's vault holds a connection for, each one list (invariant 4). */
export async function readLists(): Promise<List[]> {
  const answer = await postJson<{ names?: unknown }>(data.names_method, {});
  if (!Array.isArray(answer?.names)) throw say(data.words.not_read);
  const credentials = (answer.names as string[]).filter(name => name.endsWith(data.credential_suffix)).sort();
  const read = await Promise.allSettled(credentials.map(async credential =>
    (await sql<Table>(credential, TABLES, [data.skip_schemas])).map(table => listOfTable(credential, table))));
  const found = read.flatMap(one => (one.status === 'fulfilled' ? one.value : []));
  if (!found.length && read.some(one => one.status === 'rejected')) throw (read.find(one => one.status === 'rejected') as PromiseRejectedResult).reason;
  known = new Map(found.map(list => [list.id, list]));
  return found;
}

async function listNamed(selected: string | List): Promise<List> {
  if (typeof selected !== 'string') return selected;
  const kept = known.get(selected) ?? (await readLists(), known.get(selected));
  if (!kept) throw say(data.words.unknown, 404);
  return kept;
}

const rowIdOf = (list: List, values: Record<string, unknown>, at: number) =>
  list.key.length ? JSON.stringify(list.key.map(column => values[column])) : `#${at}`;
const titleOf = (list: List, values: Record<string, unknown>) => {
  const title = list.title_field ? values[list.title_field] : null;
  return title === null || title === undefined || title === '' ? null : String(title);
};

/** Rules are decided by the screen over the rows it reads; the table is never narrowed here. */
export function whereOf(rules: RuleNode | null | undefined): { where: Record<string, unknown> | null; whole: boolean } {
  const group = rules && rules.kind === 'group' ? rules : null;
  return { where: null, whole: !group || (group.rules ?? []).length === 0 };
}

/** One page of rows from `after` (the offset a previous page answered), newest key first (invariant 5). */
export async function readRows(list: List, after: string | null, { every = false, most }: { every?: boolean; most?: number; where?: Record<string, unknown> | null } = {}): Promise<{ rows: Row[]; next: string | null; refused: boolean }> {
  const { credential, name } = placeOf(list.id);
  const asked = most ?? (every ? lists.limits.rows_per_read : lists.limits.read_page_rows);
  const offset = Number(after ?? 0) || 0;
  const order = list.key.length ? list.key.map(column => `${quote(column)} desc`).join(', ') : '1';
  const page = await pageOf(credential, name, order, asked + 1, offset);
  if (page.refused) return { rows: [], next: null, refused: true };
  const rows = page.values.slice(0, asked).map((row, at) => ({ id: rowIdOf(list, row, offset + at), title: titleOf(list, row), values: row, links: {} }));
  return { rows, next: page.values.length > asked ? String(offset + asked) : null, refused: false };
}

/** The list's saved views, rows of the views table (none while it is not made yet). */
async function viewsOf(list: List): Promise<View[]> {
  const rows = await sql<{ view: string }>(data.new_lists_in, `select view from ${quote(data.views_table)} where list_id = $1 order by order_key, view_id`, [list.id]).catch(() => []);
  return rows.flatMap(row => { try { return [JSON.parse(row.view) as View]; } catch { return []; } });
}

export async function readList(selected: string | List, drawn = 0, where: Record<string, unknown> | null = null): Promise<Read> {
  const kept = await listNamed(selected);
  const list = { ...kept, views: await viewsOf(kept) };
  return { list, ...await readRows(list, null, drawn > 0 ? { most: drawn } : {}), where, field_kinds: fieldKinds, depends: null };
}

/** Tables hold no links between lists: rows are answered as they are. */
export async function titleLinks(_list: List, rows: Row[]): Promise<Row[]> { return rows; }

/** A field added is a column added; a list keeps its table's own name. */
export async function changeList(selected: string | List, change: Record<string, unknown>): Promise<void> {
  const list = await listNamed(selected);
  const { credential, name } = placeOf(list.id);
  const asked = Array.isArray(change.fields) ? (change.fields as Field[]).filter(field => !list.fields.some(one => one.id === field.id)) : [];
  if (Object.keys(change).some(key => key !== 'fields')) throw say(data.words.rename);
  for (const field of asked) await sql(credential, `alter table ${name} add column if not exists ${quote(field.id)} ${columnOf(field.kind)}`);
  known.delete(list.id);
}

/** A new list is a new table, keyed by a made id, with the fields asked. */
export async function makeList(label: string, fields: Field[]): Promise<List> {
  const table = label.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '') || 'list';
  const columns = fields.filter(field => field.id !== 'id').map(field => `${quote(field.id)} ${columnOf(field.kind)}`);
  await sql(data.new_lists_in, `create table if not exists ${quote(table)} (id text primary key default gen_random_uuid()::text${columns.map(column => `, ${column}`).join('')})`);
  await readLists();
  return listNamed(idOf(data.new_lists_in, 'public', table));
}

/** Keeps rows (a row with no id is a new row; null clears a cell) and removes rows, by the table's key (invariant 3). */
export async function putRows(selected: Pick<List, 'row_type'> & Partial<List>, rows: RowPut[], remove: string[] = []): Promise<string[]> {
  const list = await listNamed(selected.row_type);
  if (!list.key.length) throw say(data.words.no_key);
  const { credential, name } = placeOf(list.id);
  const columns = new Set(list.fields.map(field => field.id));
  const keyOf = (id: string) => JSON.parse(id) as unknown[];
  const match = (from: number) => list.key.map((column, at) => `${quote(column)} = $${from + at}`).join(' and ');
  const ids: string[] = [];
  for (const row of rows) {
    const set = Object.entries(row.values).filter(([column]) => columns.has(column));
    if (row.id) {
      if (set.length) await sql(credential, `update ${name} set ${set.map(([column], at) => `${quote(column)} = $${at + 1}`).join(', ')} where ${match(set.length + 1)}`, [...set.map(([, value]) => value), ...keyOf(row.id)]);
      ids.push(row.id);
    } else {
      const made = await sql(credential, set.length
        ? `insert into ${name} (${set.map(([column]) => quote(column)).join(', ')}) values (${set.map((_, at) => `$${at + 1}`).join(', ')}) returning *`
        : `insert into ${name} default values returning *`, set.map(([, value]) => value));
      ids.push(rowIdOf(list, made[0] ?? {}, 0));
    }
  }
  for (const id of remove) await sql(credential, `delete from ${name} where ${match(1)}`, keyOf(id));
  return ids;
}

/** Keeps one saved view as a row of the views table, made on first save. */
export async function saveView(selected: string | List, view: View): Promise<void> {
  const list = await listNamed(selected);
  const table = quote(data.views_table);
  await sql(data.new_lists_in, `create table if not exists ${table} (list_id text, view_id text, view text, order_key text, primary key (list_id, view_id))`);
  await sql(data.new_lists_in, `insert into ${table} (list_id, view_id, view, order_key) values ($1, $2, $3, coalesce((select max(order_key) from ${table} where list_id = $1), '') || 'V')
    on conflict (list_id, view_id) do update set view = excluded.view`, [list.id, view.id, JSON.stringify(view)]);
}

export async function removeView(selected: string | List, viewId: string): Promise<void> {
  const list = await listNamed(selected);
  await sql(data.new_lists_in, `delete from ${quote(data.views_table)} where list_id = $1 and view_id = $2`, [list.id, viewId]).catch(() => []);
}
