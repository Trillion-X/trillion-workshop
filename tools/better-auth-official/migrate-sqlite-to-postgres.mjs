// One-time move of the sign-in rows from the old SQLite file into the shared Postgres store, keeping every id and every value.
//
//   BETTER_AUTH_SETTINGS=<settings.json> BETTER_AUTH_SECRET=... <settings.store.env>=<connection> node migrate-sqlite-to-postgres.mjs <better-auth.db>
//
// It makes or updates Better Auth's tables for the options this tool runs (store.mjs), then copies every table the file holds, in
// foreign-key order, in one transaction: each column of the file goes to the same-named column, converted to the column's type (the
// file keeps booleans as 0 and 1, dates as ISO text and JSON as text). Before the transaction commits it reads every row back and
// refuses unless the row counts match and every value equals its source (text exactly, so the jwks keys are byte-identical; dates by
// their instant; JSON by its parsed value). It refuses outright when the store already holds a user, so a store in use is never
// overwritten. Values are never printed.

import { DatabaseSync } from 'node:sqlite';
import { isDeepStrictEqual } from 'node:util';
import { auth, pool } from './auth.mjs';
import { migrateStore } from './store.mjs';

const file = process.argv[2];
if (!file) throw new Error('usage: node migrate-sqlite-to-postgres.mjs <better-auth.db>');

const source = new DatabaseSync(file, { readOnly: true });
const sourceTables = source.prepare("select name from sqlite_master where type = 'table' and name not like 'sqlite_%'").all().map(row => row.name);
const quote = name => `"${name.replaceAll('"', '""')}"`;

await migrateStore(auth, pool);

const types = new Map();
for (const row of (await pool.query("select table_name, column_name, data_type from information_schema.columns where table_schema = 'public'")).rows) {
  if (!types.has(row.table_name)) types.set(row.table_name, new Map());
  types.get(row.table_name).set(row.column_name, row.data_type);
}
const missing = sourceTables.filter(table => !types.has(table));
if (missing.length) throw new Error(`the store has no table for: ${missing.join(', ')}`);
if ((await pool.query('select 1 from "user" limit 1')).rowCount) throw new Error('the store already holds a user; nothing was copied');

// Parents before children: a table comes after every table its foreign keys name.
const edges = (await pool.query(`select child.relname as child, parent.relname as parent from pg_constraint c
  join pg_class child on child.oid = c.conrelid join pg_class parent on parent.oid = c.confrelid where c.contype = 'f' and child.relnamespace = 'public'::regnamespace`)).rows;
const ordered = [];
const placed = new Set();
while (ordered.length < sourceTables.length) {
  const next = sourceTables.find(table => !placed.has(table) && edges.every(edge => edge.child !== table || edge.parent === table || placed.has(edge.parent) || !sourceTables.includes(edge.parent)));
  if (!next) throw new Error('the tables\' foreign keys form a cycle');
  placed.add(next);
  ordered.push(next);
}

// A value as the store's column holds it.
function toColumn(value, type, where) {
  if (value === null || value === undefined) return null;
  if (type === 'boolean') return Boolean(Number(value));
  if (type === 'timestamp with time zone') { const date = new Date(value); if (Number.isNaN(date.getTime())) throw new Error(`${where}: not a date`); return date; }
  if (type === 'jsonb') return String(value);
  if (type === 'integer' || type === 'bigint') return Number(value);
  if (type === 'text') return String(value);
  throw new Error(`${where}: column type ${type} has no conversion`);
}
const same = (stored, wanted, type) => (type === 'timestamp with time zone' ? stored?.getTime() === wanted?.getTime()
  : type === 'jsonb' ? isDeepStrictEqual(stored, wanted === null ? null : JSON.parse(wanted))
  : stored === wanted);

const client = await pool.connect();
const report = [];
try {
  await client.query('begin');
  // A fresh store may hold rows the server seeded (the MCP resource); they go so the file's rows are the only rows.
  for (const table of [...ordered].reverse()) await client.query(`delete from ${quote(table)}`);
  for (const table of ordered) {
    const columns = source.prepare(`pragma table_info(${quote(table)})`).all().map(column => column.name);
    const unknown = columns.filter(column => !types.get(table).has(column));
    if (unknown.length) throw new Error(`${table}: the store has no column ${unknown.join(', ')}`);
    const rows = source.prepare(`select * from ${quote(table)}`).all();
    const insert = `insert into ${quote(table)} (${columns.map(quote).join(', ')}) values (${columns.map((_, i) => `$${i + 1}`).join(', ')})`;
    const wanted = rows.map(row => columns.map(column => toColumn(row[column], types.get(table).get(column), `${table}.${column}`)));
    for (const values of wanted) await client.query(insert, values);
    const stored = (await client.query(`select ${columns.map(quote).join(', ')} from ${quote(table)}`)).rows;
    if (stored.length !== rows.length) throw new Error(`${table}: ${rows.length} rows in the file, ${stored.length} in the store`);
    const byId = new Map(stored.map(row => [row.id, row]));
    for (const [at, row] of rows.entries()) {
      const there = byId.get(row.id);
      if (!there) throw new Error(`${table}: row ${row.id} is not in the store`);
      for (const [index, column] of columns.entries()) {
        if (!same(there[column], wanted[at][index], types.get(table).get(column))) throw new Error(`${table}.${column} of row ${row.id} differs after the copy`);
      }
    }
    report.push(`${table}: ${rows.length}`);
  }
  await client.query('commit');
} catch (error) {
  await client.query('rollback');
  throw error;
} finally {
  client.release();
  await pool.end();
}
console.log(`copied and read back identical: ${report.join(', ')}`);
