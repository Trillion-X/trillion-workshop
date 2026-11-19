// tools/keep-a-postgres-database-on-a-computer/do-work/compare-two-databases.mjs
//
// Proves a database copy (scripts/copy-a-database.sh) equal to its old database, table by table, so a move under a new name
// is shown to have lost nothing. Each database is opened by its own login. It compares every object of the schema (columns,
// constraints, indexes, views, functions, triggers, sequences' values, extensions; owners and grants are left out, since each
// database has its own login) and every table's rows: their count and the BLAKE3 of the rows as text, sorted, with json read
// as jsonb, so neither row order nor key order counts as a difference. For a table that differs it counts the rows only in
// the first and only in the second. No row value is ever printed.
//
// usage: FIRST_CONNECTION=postgresql://... SECOND_CONNECTION=postgresql://... node compare-two-databases.mjs [SCHEMA]
// The connection strings come in the environment only, never in the arguments, so no process list shows them.
import { blake3 } from '@noble/hashes/blake3.js';
import { bytesToHex } from '@noble/hashes/utils.js';
import { pathToFileURL } from 'node:url';

const hash = text => bytesToHex(blake3(new TextEncoder().encode(text)));

/** Every object of `schema` as one line of text each, sorted, with the database's own name and its login's name taken out. */
export async function objectsOf(db, schema = 'public') {
  const lines = [];
  const add = async (kind, sql) => { for (const row of await db.query(sql, [schema])) lines.push(`${kind} ${row.line}`); };
  await add('column', `select table_name||'.'||column_name||' '||data_type||coalesce('('||character_maximum_length||')','')||' null='||is_nullable||' default='||coalesce(column_default,'')||' identity='||is_identity||' generated='||coalesce(generation_expression,'') as line from information_schema.columns where table_schema=$1`);
  await add('constraint', `select t.relname||' '||k.conname||' '||pg_get_constraintdef(k.oid) as line from pg_constraint k join pg_class t on t.oid=k.conrelid join pg_namespace n on n.oid=t.relnamespace where n.nspname=$1`);
  await add('index', `select indexname||' '||indexdef as line from pg_indexes where schemaname=$1`);
  await add('view', `select c.relname||' '||c.relkind::text||' '||pg_get_viewdef(c.oid) as line from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname=$1 and c.relkind in ('v','m')`);
  await add('function', `select pg_get_functiondef(p.oid) as line from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname=$1 and p.prokind in ('f','p') and not exists (select from pg_depend d where d.objid=p.oid and d.deptype='e')`);
  await add('trigger', `select pg_get_triggerdef(g.oid) as line from pg_trigger g join pg_class t on t.oid=g.tgrelid join pg_namespace n on n.oid=t.relnamespace where n.nspname=$1 and not g.tgisinternal`);
  await add('comment', `select c.relname||coalesce('.'||a.attname,'')||' '||d.description as line from pg_description d join pg_class c on c.oid=d.objoid and d.classoid='pg_class'::regclass join pg_namespace n on n.oid=c.relnamespace left join pg_attribute a on a.attrelid=c.oid and a.attnum=d.objsubid and d.objsubid>0 where n.nspname=$1`);
  await add('sequence', `select sequencename||' last='||coalesce(last_value::text,'none') as line from pg_sequences where schemaname=$1`);
  await add('extension', `select extname||' '||extversion as line from pg_extension where $1::text is not null`);
  const [{ database, login }] = await db.query('select current_database() as database, current_user as login');
  return lines.map(line => line.split(database).join('<database>').split(login).join('<login>')).sort();
}

/** Every row of one table as text (json as jsonb), sorted. */
export async function rowsOf(db, table, schema = 'public') {
  const columns = await db.query(`select column_name as name, data_type as type from information_schema.columns where table_schema=$1 and table_name=$2 order by ordinal_position`, [schema, table]);
  const select = columns.map(c => (c.type === 'json' ? `"${c.name}"::jsonb as "${c.name}"` : `"${c.name}"`)).join(', ');
  return (await db.query(`select x::text as row from (select ${select} from "${schema}"."${table}") x`)).map(r => r.row).sort();
}

const tablesOf = async (db, schema) => (await db.query(`select c.relname as name from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname=$1 and c.relkind in ('r','p') order by 1`, [schema])).map(r => r.name);

/** The two databases compared: the objects only one has, and each table's count, digest and rows only one has. `first` and
 * `second` each answer `query(sql, params)` with rows. */
export async function compareTwoDatabases(first, second, schema = 'public') {
  const [a, b] = [await objectsOf(first, schema), await objectsOf(second, schema)];
  const inB = new Set(b), inA = new Set(a);
  const objects = { first: a.length, second: b.length, only_in_first: a.filter(x => !inB.has(x)), only_in_second: b.filter(x => !inA.has(x)) };
  const names = [...new Set([...(await tablesOf(first, schema)), ...(await tablesOf(second, schema))])].sort();
  const [hasA, hasB] = [new Set(await tablesOf(first, schema)), new Set(await tablesOf(second, schema))];
  const tables = [];
  for (const table of names) {
    if (!hasA.has(table) || !hasB.has(table)) { tables.push({ table, missing_in: hasA.has(table) ? 'second' : 'first' }); continue; }
    const [ra, rb] = [await rowsOf(first, table, schema), await rowsOf(second, table, schema)];
    const [da, db] = [hash(ra.join('\n')), hash(rb.join('\n'))];
    const equal = ra.length === rb.length && da === db;
    const setA = new Set(ra), setB = new Set(rb);
    tables.push({ table, first: ra.length, second: rb.length, equal, digest_first: da, digest_second: db,
      ...(equal ? {} : { only_in_first: ra.filter(r => !setB.has(r)).length, only_in_second: rb.filter(r => !setA.has(r)).length }) });
  }
  return { objects, tables, tables_equal: tables.filter(t => t.equal).length, tables_differ: tables.filter(t => !t.equal).length };
}

/** A pg Client as `query(sql, params)` answering rows, from the run-sql tool's own pg. */
export async function openConnection(connectionString) {
  const { createRequire } = await import('node:module');
  const pg = createRequire(new URL('../../run-sql-in-my-database/package.json', import.meta.url))('pg');
  const client = new pg.Client({ connectionString });
  await client.connect();
  return { query: async (sql, params = []) => (await client.query(sql, params)).rows, raw: client, end: () => client.end() };
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const { FIRST_CONNECTION, SECOND_CONNECTION } = process.env;
  if (!FIRST_CONNECTION || !SECOND_CONNECTION) throw new Error('Give FIRST_CONNECTION and SECOND_CONNECTION in the environment.');
  const [first, second] = [await openConnection(FIRST_CONNECTION), await openConnection(SECOND_CONNECTION)];
  try {
    const result = await compareTwoDatabases(first, second, process.argv[2] ?? 'public');
    console.log(`objects: ${result.objects.first} and ${result.objects.second}; only in first ${result.objects.only_in_first.length}, only in second ${result.objects.only_in_second.length}`);
    for (const x of result.objects.only_in_first) console.log(`  only in first: ${x.split('\n')[0].slice(0, 160)}`);
    for (const x of result.objects.only_in_second) console.log(`  only in second: ${x.split('\n')[0].slice(0, 160)}`);
    for (const t of result.tables) {
      console.log(t.missing_in ? `${t.table}\tmissing in ${t.missing_in}` : t.equal ? `${t.table}\t${t.first}\t${t.second}\tequal\t${t.digest_first.slice(0, 16)}`
        : `${t.table}\t${t.first}\t${t.second}\tDIFFER\t${t.digest_first.slice(0, 16)}\t${t.digest_second.slice(0, 16)}\tonly in first ${t.only_in_first}, only in second ${t.only_in_second}`);
    }
    console.log(`tables: ${result.tables.length}; equal ${result.tables_equal}; differ ${result.tables_differ}`);
  } finally { await first.end(); await second.end(); }
}
