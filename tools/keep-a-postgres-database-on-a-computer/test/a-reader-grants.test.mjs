// tools/keep-a-postgres-database-on-a-computer/test/a-reader-grants.test.mjs
//
// A reader's `grants` (reads_from): the file prepare writes from the reads files of the tools that read through the login, run on
// PGlite as psql runs it. The reader starts with more than the tools read (a form's answers among them, as a live reader had);
// after the file it reads exactly the union of the files' columns, a table no file names is read by none, a table outside the
// files' schemas is left as it was, a second run changes nothing, and a file that fails part-way leaves the reads as they were.
// The tables are made from the reads files themselves plus invented ones.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { PGlite } from '@electric-sql/pglite';
import { prepare } from '../prepare-a-database-unit.mjs';

const WORKSHOP = new URL('../../../', import.meta.url);
const FILES = ['tools/read-published-clips/read-data/reader-rights.json', 'tools/take-payments/read-data/reader-rights.json'];
const unit = { unit: 'p-reader-login.service', description: 'Example reader', user: 'postgres', environment: ['PGHOST=/run/postgresql'] };
const grants = (extra = {}) => ({ login: 'p_reader', database: 'postgres', owner: 'p_owner', recipe: 'may-read-under-row-rules', reads_from: FILES, file: '/etc/example-database/reader-grants.sql', ...extra });
const fileOf = extra => prepare({ ...unit, grants: [grants(extra)] }).unit.files[0];
const reads = FILES.flatMap(from => JSON.parse(readFileSync(new URL(from, WORKSHOP), 'utf8')).reads);

/** Runs a rendered file as psql -1-free -v ON_ERROR_STOP=1 does: BEGIN and COMMIT lines run as they are, each query ending in
 * \gexec runs and each cell it answers runs; an error rolls the open transaction back, as psql does when it stops. */
const runAsPsql = async (db, text) => {
  try {
    for (const part of text.replace(/^--.*\n/gm, '').split(/ \\gexec\n|\n(?=BEGIN;|COMMIT;)|(?<=BEGIN;|COMMIT;)\n/).map(each => each.trim()).filter(Boolean)) {
      if (part === 'BEGIN;' || part === 'COMMIT;') { await db.exec(part); continue; }
      const { rows, fields } = await db.query(part);
      for (const row of rows) for (const { name } of fields) if (row[name] !== null) await db.exec(row[name]);
    }
  } catch (error) {
    await db.exec('ROLLBACK').catch(() => {});
    throw error;
  } finally {
    await db.exec('RESET ROLE').catch(() => {});
  }
};

/** A pursuit's database as a live one was: every table the files read, a form's answers and a booking's pages the reader read too,
 * one more column on each read table the tools never read, and a table in another schema. */
async function readerDatabase() {
  const db = new PGlite();
  const tables = new Map();
  for (const { table, columns } of reads) tables.set(table, new Set([...(tables.get(table) ?? []), ...columns]));
  const made = [...tables].map(([table, columns]) => `CREATE TABLE ${table} (${[...columns, 'never_read'].map(column => `"${column}" text`).join(', ')});`).join('\n');
  await db.exec(`CREATE ROLE p_owner; CREATE ROLE p_reader; GRANT ALL ON SCHEMA public TO p_owner; CREATE SCHEMA kept AUTHORIZATION p_owner; SET ROLE p_owner;
    ${made}
    CREATE TABLE form_rows (id text, type text, value jsonb); CREATE TABLE booking_pages (slug text, horizon_days int); CREATE TABLE kept.notes (id text);
    GRANT USAGE ON SCHEMA public, kept TO p_reader;
    GRANT SELECT (id, type, value) ON form_rows TO p_reader; GRANT SELECT ON booking_pages TO p_reader; GRANT SELECT ON kept.notes TO p_reader;
    ${[...tables.keys()].map(table => `GRANT SELECT ON ${table} TO p_reader;`).join('\n')}
    RESET ROLE;`);
  return { db, tables };
}

const canRead = async (db, table, column) => (await db.query('SELECT has_column_privilege($1, $2, $3, $4) AS ok', ['p_reader', table, column, 'SELECT'])).rows[0].ok;
const readsOf = async (db, tables) => {
  const seen = {};
  for (const [table, columns] of tables) for (const column of [...columns, 'never_read']) seen[`${table}.${column}`] = await canRead(db, table, column);
  for (const [table, column] of [['form_rows', 'value'], ['form_rows', 'id'], ['booking_pages', 'slug'], ['kept.notes', 'id']]) seen[`${table}.${column}`] = await canRead(db, table, column);
  return seen;
};

test('a reader\'s grants file is the union of the tools\' reads, in one transaction, from files only', () => {
  const file = fileOf();
  assert.equal(file.path, '/etc/example-database/reader-grants.sql');
  assert.deepEqual(file.then, [['runuser', '-u', 'postgres', '--', 'psql', '-X', '-q', '-v', 'ON_ERROR_STOP=1', '-h', '/run/postgresql', '-d', 'postgres', '-f', file.path]]);
  assert.match(file.text, /^-- Rendered from this computer's row: the reads of .* for the login p_reader in postgres \(may-read-under-row-rules\), exactly\.\nBEGIN;\n/);
  assert.match(file.text, /COMMIT;\n$/);
  assert.throws(() => fileOf({ reads_from: ['../../etc/passwd'] }), /reads_from is a list of tools' read-data JSON files/);
  assert.throws(() => fileOf({ reads_from: [] }), /reads_from is a list/);
  assert.throws(() => fileOf({ recipe: 'may-write-named-columns-under-a-use' }), /grants-only per-table recipe/);
  assert.throws(() => fileOf({ writes_from: 'tools/gather-words-from-people/read-data/writer-rights.json' }), /reads_from or writes_from, not both/);
  assert.throws(() => fileOf({ action: 'drop' }), /always the union of what the tools read/);
  assert.throws(() => fileOf({ reads_from: ['tools/gather-words-from-people/read-data/writer-rights.json'] }), /names no reads/);
});

test('after the file the reader reads exactly the columns the tools read: the form answers and the booking pages by none, another schema as it was', async () => {
  const { db, tables } = await readerDatabase();
  const before = await readsOf(db, tables);
  assert.equal(before['form_rows.value'], true, 'the reader read every form answer before');
  await runAsPsql(db, fileOf().text);
  const after = await readsOf(db, tables);
  for (const [table, columns] of tables) {
    for (const column of columns) assert.equal(after[`${table}.${column}`], true, `${table}.${column} is read by a tool`);
    assert.equal(after[`${table}.never_read`], false, `${table}.never_read is read by no tool`);
  }
  assert.equal(after['form_rows.value'], false, 'no tool reads a form\'s answers through the reader');
  assert.equal(after['form_rows.id'], false);
  assert.equal(after['booking_pages.slug'], false);
  assert.equal(after['kept.notes.id'], true, 'a table in a schema no file names is left as it was');
  await db.exec('SET ROLE p_reader');
  await assert.rejects(db.query('SELECT value FROM form_rows'), /permission denied/);
  await db.exec('RESET ROLE');
  await runAsPsql(db, fileOf().text);
  assert.deepEqual(await readsOf(db, tables), after, 'a second run changes nothing');
});

test('a file that fails part-way leaves the reader\'s reads as they were', async () => {
  const { db, tables } = await readerDatabase();
  const before = await readsOf(db, tables);
  await db.exec('DROP TABLE public.offers');
  const text = fileOf().text;
  await assert.rejects(runAsPsql(db, text), /offers/);
  const left = await readsOf(db, new Map([...tables].filter(([table]) => table !== 'public.offers')));
  for (const [key, value] of Object.entries(left)) assert.equal(value, before[key], `${key} is as it was`);
});
