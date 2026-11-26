// The write-audit stack (sql/write-audit.sql) on PGlite: each insert, update, delete and truncate of an audited table
// leaves one line naming the table, the row's key, the operation, the session's login, its application name and the
// transaction; never a value of the row. write_audit is never told to row_changes, and old lines go after keep_days.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { PGlite } from '@electric-sql/pglite';

const stack = readFileSync(new URL('../sql/write-audit.sql', import.meta.url), 'utf8');
const rowChanges = readFileSync(new URL('../sql/consent-stack.sql', import.meta.url), 'utf8').split('-- Consent stack')[0];
const SECRET = 'value-never-in-the-audit-7f3c';

type Line = { table_name: string; row_id: Record<string, unknown> | null; row_id_before: Record<string, unknown> | null; op: string; login: string; application_name: string | null; txid: string };

async function store(): Promise<PGlite> {
  const db = new PGlite();
  await db.exec(rowChanges);
  await db.exec(stack);
  await db.exec(`
    CREATE TABLE form_rows (id text PRIMARY KEY, value jsonb NOT NULL);
    CREATE TABLE welcome_series_sent (payment_event_id text, step_day int, sent_to text, PRIMARY KEY (payment_event_id, step_day));
    CREATE TABLE welcome_series_stops (email text PRIMARY KEY, stopped_at timestamptz DEFAULT now());
    CREATE TRIGGER tell_row_change AFTER INSERT OR DELETE OR UPDATE ON form_rows FOR EACH ROW EXECUTE FUNCTION record_row_change();
    SELECT audit_writes_on('form_rows'), audit_writes_on('welcome_series_sent'), audit_writes_on('welcome_series_stops', false);
    CREATE ROLE site_writer LOGIN;
    GRANT SELECT, INSERT, UPDATE, DELETE, TRUNCATE ON form_rows, welcome_series_sent, welcome_series_stops TO site_writer;
  `);
  return db;
}

const lines = async (db: PGlite): Promise<Line[]> =>
  (await db.query<Line>('SELECT table_name, row_id, row_id_before, op, login::text AS login, application_name, txid::text AS txid FROM write_audit ORDER BY id')).rows;

test('a delete by a named login records that login, the row key and the transaction', async () => {
  const db = await store();
  await db.query('INSERT INTO form_rows VALUES ($1, $2)', ['row-1', { email: SECRET }]);
  await db.exec(`SET SESSION AUTHORIZATION site_writer; SET application_name = 'the-site-front'`);
  await db.exec('BEGIN');
  await db.query('DELETE FROM form_rows WHERE id = $1', ['row-1']);
  const txid = (await db.query<{ txid: string }>('SELECT pg_current_xact_id()::text AS txid')).rows[0].txid;
  await db.exec('COMMIT');
  await db.exec('SET SESSION AUTHORIZATION postgres; RESET application_name');
  const [insert, removal] = await lines(db);
  assert.equal(insert.op, 'insert');
  assert.equal(insert.login, 'postgres');
  assert.deepEqual(removal, { table_name: 'form_rows', row_id: { id: 'row-1' }, row_id_before: null, op: 'delete', login: 'site_writer', application_name: 'the-site-front', txid });
});

test('the audit table has only the named columns, and no value of a row appears in any line', async () => {
  const db = await store();
  await db.query('INSERT INTO form_rows VALUES ($1, $2)', ['row-2', { note: SECRET }]);
  await db.query('UPDATE form_rows SET value = $2 WHERE id = $1', ['row-2', { note: `${SECRET}-changed` }]);
  await db.query('INSERT INTO welcome_series_stops (email) VALUES ($1)', [`${SECRET}@example.invalid`]);
  await db.query('UPDATE welcome_series_stops SET stopped_at = now()');
  await db.query('DELETE FROM welcome_series_stops');
  const columns = (await db.query<{ column_name: string }>(`SELECT column_name FROM information_schema.columns WHERE table_name = 'write_audit' ORDER BY ordinal_position`)).rows.map(row => row.column_name);
  assert.deepEqual(columns, ['id', 'at', 'table_name', 'row_id', 'row_id_before', 'op', 'login', 'application_name', 'txid']);
  const all = await lines(db);
  assert.equal(all.length, 5);
  assert.ok(!JSON.stringify(all).includes(SECRET), 'a value of an audited row reached the audit');
  assert.deepEqual(all.filter(line => line.table_name === 'welcome_series_stops').map(line => [line.op, line.row_id]), [['insert', null], ['update', null], ['delete', null]]);
});

test('a key of several columns is kept whole, and an update that changes it keeps the old key too', async () => {
  const db = await store();
  await db.query('INSERT INTO welcome_series_sent VALUES ($1, $2, $3)', ['payment:pi_1', 0, SECRET]);
  await db.query('UPDATE welcome_series_sent SET sent_to = $1', [`${SECRET}-2`]);
  await db.query('UPDATE welcome_series_sent SET payment_event_id = $1', ['payment:pi_2']);
  const all = await lines(db);
  assert.deepEqual(all.map(line => [line.op, line.row_id, line.row_id_before]), [
    ['insert', { payment_event_id: 'payment:pi_1', step_day: 0 }, null],
    ['update', { payment_event_id: 'payment:pi_1', step_day: 0 }, null],
    ['update', { payment_event_id: 'payment:pi_2', step_day: 0 }, { payment_event_id: 'payment:pi_1', step_day: 0 }],
  ]);
});

test('a truncate is one line with no row id', async () => {
  const db = await store();
  await db.query('INSERT INTO form_rows VALUES ($1, $2)', ['row-3', {}]);
  await db.exec('SET SESSION AUTHORIZATION site_writer; TRUNCATE form_rows; SET SESSION AUTHORIZATION postgres');
  const last = (await lines(db)).at(-1);
  assert.deepEqual([last?.op, last?.row_id, last?.login], ['truncate', null, 'site_writer']);
});

test('write_audit is never told to row_changes, and neither it nor row_changes can be audited', async () => {
  const db = await store();
  await db.query('INSERT INTO form_rows VALUES ($1, $2)', ['row-4', {}]);
  await db.query('DELETE FROM form_rows');
  const told = (await db.query<{ table_name: string }>('SELECT table_name FROM row_changes ORDER BY position')).rows.map(row => row.table_name);
  assert.deepEqual(told, ['form_rows', 'form_rows']);
  const triggers = (await db.query<{ n: number }>(`SELECT count(*)::int AS n FROM pg_trigger WHERE tgrelid = 'write_audit'::regclass AND NOT tgisinternal`)).rows[0].n;
  assert.equal(triggers, 0);
  for (const table of ['write_audit', 'row_changes']) {
    await assert.rejects(db.query(`SELECT audit_writes_on('${table}')`), /is never audited/);
  }
});

test('a writer writes audited rows but can neither read, add nor remove audit lines', async () => {
  const db = await store();
  await db.exec('SET SESSION AUTHORIZATION site_writer');
  await db.query('INSERT INTO form_rows VALUES ($1, $2)', ['row-5', {}]);
  await assert.rejects(db.query('SELECT * FROM write_audit'), /permission denied/);
  await assert.rejects(db.query(`INSERT INTO write_audit (table_name, op) VALUES ('form_rows', 'delete')`), /permission denied/);
  await assert.rejects(db.query('DELETE FROM write_audit'), /permission denied/);
  await assert.rejects(db.query('SELECT forget_old_write_audit(1)'), /permission denied/);
  await db.exec('SET SESSION AUTHORIZATION postgres');
  assert.deepEqual((await lines(db)).map(line => [line.op, line.login]), [['insert', 'site_writer']]);
});

test('a table with no primary key is refused unless it is audited without row ids', async () => {
  const db = await store();
  await db.exec('CREATE TABLE loose (note text)');
  await assert.rejects(db.query(`SELECT audit_writes_on('loose')`), /has no primary key/);
  await db.query(`SELECT audit_writes_on('loose', false)`);
  await db.query(`SELECT audit_writes_on('loose', false)`);
  await db.query('INSERT INTO loose VALUES ($1)', [SECRET]);
  assert.deepEqual((await lines(db)).map(line => [line.table_name, line.op, line.row_id]), [['loose', 'insert', null]]);
});

test('retention forgets lines older than keep_days and keeps the rest; keep_days under 1 is refused', async () => {
  const db = await store();
  await db.query('INSERT INTO form_rows VALUES ($1, $2)', ['row-6', {}]);
  await db.query('INSERT INTO form_rows VALUES ($1, $2)', ['row-7', {}]);
  await db.query(`UPDATE write_audit SET at = clock_timestamp() - interval '31 days' WHERE row_id = '{"id": "row-6"}'`);
  assert.equal((await db.query<{ gone: number }>('SELECT forget_old_write_audit(30)::int AS gone')).rows[0].gone, 1);
  assert.deepEqual((await lines(db)).map(line => line.row_id), [{ id: 'row-7' }]);
  await assert.rejects(db.query('SELECT forget_old_write_audit(0)'), /at least 1/);
});
