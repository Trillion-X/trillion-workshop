import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import EmbeddedPostgres from 'embedded-postgres';
import pg from 'pg';
import { runSql, sayWithout, shapeOf } from '../do-work/run-sql.mjs';

// A real PostgreSQL server in a temp folder (no sudo), with an owner that may make roles of its own (as set-up-postgres-role.sh
// PG_MAKES_ROLES=yes makes it) and a SELECT-only reader.
const PORT = 54000 + (process.pid % 900);
const ADMIN = { host: '127.0.0.1', port: PORT, user: 'postgres', password: 'made-up-admin-pw' };
const OWNER = 'p_example_owner';
const READER = 'p_example_reader';
const OWNER_PW = 'made-up-owner-pw';
const READER_PW = 'made-up-reader-pw';
const connectionFor = (user, password) => `postgres://${user}:${password}@127.0.0.1:${PORT}/p_example`;
const ownerConnection = connectionFor(OWNER, OWNER_PW);
const readerConnection = connectionFor(READER, READER_PW);
const row = JSON.parse(readFileSync(new URL('../tool-rows.json', import.meta.url), 'utf8')).records[0].payload;
let server;

before(async () => {
  server = new EmbeddedPostgres({ databaseDir: mkdtempSync(join(tmpdir(), 'run-sql-')), user: ADMIN.user, password: ADMIN.password, port: PORT, persistent: false, onLog: () => {}, onError: () => {} });
  await server.initialise();
  await server.start();
  const admin = new pg.Client({ ...ADMIN, database: 'postgres' });
  await admin.connect();
  await admin.query(`CREATE ROLE ${OWNER} LOGIN CREATEROLE PASSWORD '${OWNER_PW}'`);
  await admin.query(`CREATE ROLE ${READER} LOGIN PASSWORD '${READER_PW}'`);
  await admin.query(`CREATE DATABASE p_example OWNER ${OWNER}`);
  await admin.end();
  const own = new pg.Client({ connectionString: ownerConnection });
  await own.connect();
  await own.query(`GRANT CONNECT ON DATABASE p_example TO ${READER}`);
  await own.query(`GRANT USAGE ON SCHEMA public TO ${READER}`);
  await own.query('CREATE TABLE tasks (id text PRIMARY KEY, title text)');
  await own.query(`ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT ON TABLES TO ${READER}`);
  await own.query(`GRANT SELECT ON ALL TABLES IN SCHEMA public TO ${READER}`);
  await own.end();
});

after(async () => { await server.stop(); });

test('the row mounts one held connection by the name the input gives and reaches only the local port it names', () => {
  assert.equal(row.id, 'tool:run-sql-in-my-database');
  assert.deepEqual(row.invoke.local_doors, ['own-rows-postgres']);
  assert.ok(!row.invoke.internet);
  assert.deepEqual(row.invoke.credential_mounts.map(mount => [mount.secret_name, mount.fd, mount.only_when.input, mount.only_when.equals]), [
    ['own-rows-postgres-connection', 3, 'credential_name', 'own-rows-postgres-connection'],
    ['own-rows-postgres-read-connection', 3, 'credential_name', 'own-rows-postgres-read-connection'],
    ['own-rows-postgres-read-connection', 4, 'role_credential_name', 'own-rows-postgres-read-connection'],
  ]);
  const mounted = input => row.invoke.credential_mounts.filter(mount => mount.only_when.input === input).map(mount => mount.secret_name);
  assert.deepEqual(row.input_schema.properties.credential_name.enum, mounted('credential_name'));
  assert.deepEqual(row.input_schema.properties.role_credential_name.enum, mounted('role_credential_name'));
  assert.ok(row.invoke.files.package_files[0].paths.includes('read-data'), 'the recipes are packed with the program');
});

test('every package of the pinned closure is a tgz with a https address and a BLAKE3, and is placed under node_modules', () => {
  const placed = row.invoke.files.package_files.filter(item => item.packages).map(item => item.packages[0]);
  assert.deepEqual(placed.sort(), Object.keys(row.invoke.packages).sort());
  for (const [name, entry] of Object.entries(row.invoke.packages)) {
    assert.equal(entry.archive, 'tgz', name);
    assert.match(entry.fetch.any.url, /^https:\/\/registry\.npmjs\.org\//, name);
    assert.match(entry.fetch.any.blake3, /^[0-9a-f]{64}$/, name);
    assert.equal(row.invoke.files.package_files.find(item => item.packages?.[0] === name).at, `/opt/node_modules/${name}`);
  }
  const lock = JSON.parse(readFileSync(new URL('../package-lock.json', import.meta.url), 'utf8'));
  for (const [name, entry] of Object.entries(row.invoke.packages)) assert.equal(lock.packages[`node_modules/${name}`]?.version, entry.version, `${name} matches the lockfile`);
});

test('a statement answers its columns, rows and count, and params fill $1', async () => {
  const answer = await runSql({ connection: ownerConnection, input: { sql: 'SELECT $1::int AS n, $2::text AS word', params: [7, 'seven'] } });
  assert.deepEqual(answer, { columns: ['n', 'word'], rows: [{ n: 7, word: 'seven' }], row_count: 1 });
  const version = await runSql({ connection: ownerConnection, input: { sql: 'SELECT version()' } });
  assert.match(version.rows[0].version, /^PostgreSQL 18/);
});

test('a statement with no params is still sent as one prepared statement, and the server refuses two commands', async () => {
  await assert.rejects(runSql({ connection: ownerConnection, input: { sql: "INSERT INTO tasks VALUES ('a', 'kept'); INSERT INTO tasks VALUES ('b', 'kept')" } }), /cannot insert multiple commands into a prepared statement/);
  await assert.rejects(runSql({ connection: ownerConnection, input: { sql: 'SELECT 1; SELECT 2' } }), /multiple commands/);
  const none = await runSql({ connection: ownerConnection, input: { sql: 'SELECT id FROM tasks' } });
  assert.equal(none.row_count, 0, 'the refused text wrote nothing');
});

test('a write answers its count; the database\'s own error text comes back for a bad statement', async () => {
  const wrote = await runSql({ connection: ownerConnection, input: { sql: 'INSERT INTO tasks (id, title) VALUES ($1, $2)', params: ['t1', 'Ada Example'] } });
  assert.deepEqual(wrote, { columns: [], rows: [], row_count: 1 });
  await assert.rejects(runSql({ connection: ownerConnection, input: { sql: 'SELECT * FROM missing_table' } }), /relation "missing_table" does not exist/);
});

test('the read login reads and cannot write, create or drop: the database refuses, not the tool', async () => {
  const read = await runSql({ connection: readerConnection, input: { sql: 'SELECT id, title FROM tasks' } });
  assert.deepEqual(read.rows, [{ id: 't1', title: 'Ada Example' }]);
  await assert.rejects(runSql({ connection: readerConnection, input: { sql: "INSERT INTO tasks VALUES ('x', 'y')" } }), /permission denied for table tasks/);
  await assert.rejects(runSql({ connection: readerConnection, input: { sql: 'CREATE TABLE made_by_reader (a int)' } }), /permission denied for schema public/);
  await assert.rejects(runSql({ connection: readerConnection, input: { list: 'reader-rows', id: 'a', value: { n: 1 } } }), /permission denied/);
});

test('a step output is an upsert into the table named list, made when missing, and a second one replaces the value', async () => {
  const handed = { store: 'postgres://held-by-name', credential_name: 'own-rows-postgres-connection', list: 'task-rows', id: 'run-1:step-2:result', value: { title: 'Ada Example', done: false } };
  const first = await runSql({ connection: ownerConnection, input: handed });
  assert.equal(first.row_count, 1);
  await runSql({ connection: ownerConnection, input: { ...handed, value: { title: 'Ada Example', done: true } } });
  const kept = await runSql({ connection: ownerConnection, input: { sql: 'SELECT id, value, updated_at IS NOT NULL AS stamped FROM "task-rows"' } });
  assert.deepEqual(kept.rows, [{ id: 'run-1:step-2:result', value: { title: 'Ada Example', done: true }, stamped: true }]);
  const columns = await runSql({ connection: ownerConnection, input: { sql: "SELECT column_name, data_type FROM information_schema.columns WHERE table_name = 'task-rows' ORDER BY ordinal_position" } });
  assert.deepEqual(columns.rows.map(column => [column.column_name, column.data_type]), [['id', 'text'], ['value', 'jsonb'], ['updated_at', 'timestamp with time zone']]);
});

test('a list name is quoted as an identifier, never run as SQL', async () => {
  await runSql({ connection: ownerConnection, input: { list: 'x"; DROP TABLE tasks; --', id: 'a', value: 1 } });
  const still = await runSql({ connection: ownerConnection, input: { sql: 'SELECT count(*)::int AS n FROM tasks' } });
  assert.equal(still.rows[0].n, 1);
});

test('statement_timeout_ms cuts a long statement with the database\'s own text', async () => {
  await assert.rejects(runSql({ connection: ownerConnection, input: { sql: 'SELECT pg_sleep(5)', statement_timeout_ms: 200 } }), /statement timeout/);
  await assert.rejects(runSql({ connection: ownerConnection, input: { sql: 'SELECT 1', statement_timeout_ms: 0 } }), /whole number of milliseconds/);
});

test('a request that is neither shape, or both, or has no connection, is refused before any connection', () => {
  assert.throws(() => shapeOf({}), /Give sql/);
  assert.throws(() => shapeOf({ sql: 'SELECT 1', list: 'a', id: 'b', value: 1 }), /Give one of/);
  assert.throws(() => shapeOf({ sql: 'SELECT 1', recipe: { name: 'read-only', action: 'create' } }), /Give one of/);
  assert.throws(() => shapeOf({ recipe: { name: 'no-such-recipe', action: 'create' } }), /recipe.name must be one of read-only/);
  assert.throws(() => shapeOf({ recipe: { name: 'read-only', action: 'alter' } }), /create or drop/);
  assert.throws(() => shapeOf({ recipe: { name: 'read-only', action: 'create', valid_until: 'soon' } }), /must be a time/);
  assert.throws(() => shapeOf({ sql: '  ' }), /statement as text/);
  assert.throws(() => shapeOf({ sql: 'SELECT 1', params: 'x' }), /list of values/);
  assert.throws(() => shapeOf({ list: 'a', id: 'b' }), /list and id as text and a value/);
  return assert.rejects(runSql({ connection: '', input: { sql: 'SELECT 1' } }), /No database connection/);
});

test('a refused login says so without the connection string or its password', async () => {
  const wrong = connectionFor(OWNER, 'wrong-password-canary');
  await assert.rejects(runSql({ connection: wrong, input: { sql: 'SELECT 1' } }), error => /password authentication failed/.test(error.message) && !sayWithout(error, wrong).includes('wrong-password-canary'));
  assert.equal(sayWithout(new Error(`cannot use ${wrong} or wrong-password-canary`), wrong), 'cannot use [held] or [held]');
});

// The command as the engine runs it: the request on stdin, the connection on descriptor 3 (and a recipe's standing role
// connection on descriptor 4), an answer on stdout.
const runCommand = (connection, input, roleConnection = '') => new Promise((resolve) => {
  const child = spawn(process.execPath, [fileURLToPath(new URL('../do-work/run-sql.mjs', import.meta.url))], { stdio: ['pipe', 'pipe', 'pipe', 'pipe', 'pipe'], env: {} });
  let out = ''; let err = '';
  child.stdout.on('data', chunk => { out += chunk; });
  child.stderr.on('data', chunk => { err += chunk; });
  child.stdio[3].end(connection);
  child.stdio[4].end(roleConnection);
  child.stdin.end(JSON.stringify(input));
  child.on('close', code => resolve({ code, out, err }));
});

test('the command reads the connection from descriptor 3 and the request from stdin', async () => {
  const ok = await runCommand(ownerConnection, { credential_name: 'own-rows-postgres-connection', sql: 'SELECT $1::text AS word', params: ['hello'] });
  assert.equal(ok.code, 0);
  assert.deepEqual(JSON.parse(ok.out), { columns: ['word'], rows: [{ word: 'hello' }], row_count: 1 });
  const refused = await runCommand(readerConnection, { credential_name: 'own-rows-postgres-read-connection', sql: 'DELETE FROM tasks' });
  assert.equal(refused.code, 1);
  assert.match(refused.err, /permission denied for table tasks/);
  assert.ok(!refused.err.includes(READER_PW) && refused.out === '');
});

// Role recipes, run as the owner login: a standing read-only login with the password the person holds, a minted one that stops
// working at its time, and the drop that takes each away; every value goes through the server's format().
const SHARE = 'p_example_share';
const SHARE_PW = "made-up-share-pw-with-'quote";
const shareConnection = connectionFor(SHARE, encodeURIComponent(SHARE_PW));
const roles = async () => (await runSql({ connection: ownerConnection, input: { sql: "SELECT rolname, rolvaliduntil FROM pg_roles WHERE rolname LIKE 'p_example_share%' OR rolname LIKE 'read_only_%' ORDER BY rolname" } })).rows;

test('a standing read-only login is made from the held role connection, reads every table, writes none, and is dropped', async () => {
  const made = await runCommand(ownerConnection, { credential_name: 'own-rows-postgres-connection', role_credential_name: 'own-rows-postgres-read-connection', recipe: { name: 'read-only', action: 'create' } }, shareConnection);
  assert.equal(made.code, 0, made.err);
  assert.deepEqual(JSON.parse(made.out).rows, [{ role: SHARE, recipe: 'read-only', action: 'create', valid_until: 'infinity' }]);
  assert.ok(!made.out.includes(SHARE_PW) && !made.out.includes('made-up-share-pw'), 'a standing login\'s password is never answered');
  assert.deepEqual((await runSql({ connection: shareConnection, input: { sql: 'SELECT id FROM tasks ORDER BY id' } })).rows, [{ id: 't1' }]);
  await runSql({ connection: ownerConnection, input: { sql: 'CREATE TABLE later_notes (id text)' } });
  assert.equal((await runSql({ connection: shareConnection, input: { sql: 'SELECT count(*)::int AS n FROM later_notes' } })).rows[0].n, 0, 'a table made later is readable too');
  await assert.rejects(runSql({ connection: shareConnection, input: { sql: "INSERT INTO tasks VALUES ('s', 'no')" } }), /permission denied for table tasks/);
  await assert.rejects(runSql({ connection: shareConnection, input: { sql: 'CREATE TABLE share_made (a int)' } }), /permission denied for schema public/);
  const dropped = await runCommand(ownerConnection, { credential_name: 'own-rows-postgres-connection', role_credential_name: 'own-rows-postgres-read-connection', recipe: { name: 'read-only', action: 'drop' } }, shareConnection);
  assert.equal(dropped.code, 0, dropped.err);
  assert.deepEqual(await roles(), []);
  await assert.rejects(runSql({ connection: shareConnection, input: { sql: 'SELECT 1' } }), /password authentication failed|does not exist/);
});

test('a minted read-only login works until its time and is refused after it; a past time makes a login that cannot sign in', async () => {
  const until = new Date(Date.now() + 3600000).toISOString();
  const minted = await runSql({ connection: ownerConnection, input: { recipe: { name: 'read-only', action: 'create', valid_until: until } } });
  const [{ role, connection, valid_until: validUntil }] = minted.rows;
  assert.match(role, /^read_only_[0-9a-f]{12}$/);
  assert.equal(validUntil, until);
  assert.deepEqual((await runSql({ connection, input: { sql: 'SELECT id FROM tasks ORDER BY id' } })).rows, [{ id: 't1' }]);
  await assert.rejects(runSql({ connection, input: { sql: 'DELETE FROM tasks' } }), /permission denied/);
  await runSql({ connection: ownerConnection, input: { recipe: { name: 'read-only', action: 'drop', role } } });
  const past = await runSql({ connection: ownerConnection, input: { recipe: { name: 'read-only', action: 'create', role: 'p_example_share_past', valid_until: '2020-01-01T00:00:00Z' } } });
  await assert.rejects(runSql({ connection: past.rows[0].connection, input: { sql: 'SELECT 1' } }), /password authentication failed/);
  await runSql({ connection: ownerConnection, input: { recipe: { name: 'read-only', action: 'drop', role: 'p_example_share_past' } } });
  assert.deepEqual(await roles(), []);
});

test('a recipe makes all of a role or none of it, and a minted login needs its time', async () => {
  await assert.rejects(runSql({ connection: ownerConnection, input: { recipe: { name: 'read-only', action: 'create' } } }), /needs recipe.valid_until/);
  await assert.rejects(runSql({ connection: ownerConnection, input: { recipe: { name: 'read-only', action: 'drop' } } }), /needs recipe.role/);
  // The reader cannot make roles: the server refuses the first statement and the transaction leaves nothing behind.
  await assert.rejects(runSql({ connection: readerConnection, input: { recipe: { name: 'read-only', action: 'create', role: 'p_example_share_refused', valid_until: '2099-01-01T00:00:00Z' } } }), /permission denied to create role/);
  assert.deepEqual(await roles(), []);
});

// A read login made by the server's superuser before the owner could make roles (the gateway's first read role): the owner may
// drop it once set-up-postgres-role.sh made the owner its admin (WITH ADMIN TRUE, INHERIT FALSE, SET FALSE), and not before.
test('a read login the superuser made is dropped by the owner\'s recipe once the owner is its admin, and the owner never inherits it', async () => {
  const admin = new pg.Client({ ...ADMIN, database: 'postgres' });
  await admin.connect();
  await admin.query("CREATE ROLE p_example_share_old LOGIN PASSWORD 'made-up-old-pw'");
  await admin.query('GRANT CONNECT ON DATABASE p_example TO p_example_share_old');
  await admin.query('GRANT pg_read_all_data TO p_example_share_old');
  const drop = { recipe: { name: 'read-only', action: 'drop', role: 'p_example_share_old' } };
  await assert.rejects(runSql({ connection: ownerConnection, input: drop }), /permission denied to drop role/);
  await admin.query(`GRANT p_example_share_old TO ${OWNER} WITH ADMIN TRUE, INHERIT FALSE, SET FALSE`);
  await admin.end();
  assert.deepEqual((await runSql({ connection: ownerConnection, input: { sql: "SELECT pg_has_role('pg_read_all_data', 'USAGE') AS inherits" } })).rows, [{ inherits: false }]);
  await runSql({ connection: ownerConnection, input: drop });
  assert.deepEqual(await roles(), []);
});
