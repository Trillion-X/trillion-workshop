import { tempFolder } from '../../../test-helpers/temp-folder.mjs';
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import net from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import EmbeddedPostgres from 'embedded-postgres';
import pg from 'pg';
import { namesTarget, runSql, sayWithout, shapeOf, timeLimitOf } from '../do-work/run-sql.mjs';
import { passwordOf, verifierOf } from '../do-work/make-a-login-verifier.mjs';

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
const row = JSON.parse(readFileSync(new URL('../what-this-tool-does-and-how-to-run-it.json', import.meta.url), 'utf8')).records[0].payload;
const TIME_LIMITS = JSON.parse(readFileSync(new URL('../read-data/time-limits.json', import.meta.url), 'utf8'));
let server;

before(async () => {
  server = new EmbeddedPostgres({ databaseDir: tempFolder(join(tmpdir(), 'run-sql-')), user: ADMIN.user, password: ADMIN.password, port: PORT, persistent: false, onLog: () => {}, onError: () => {} });
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

test('the row mounts one held connection by the name the input gives and reaches the network only through the run\'s proxy', () => {
  assert.equal(row.id, 'tool:run-sql-in-my-database');
  assert.equal(row.invoke.local_doors, undefined, 'no local port: a database is reached by its address');
  assert.ok(Array.isArray(row.invoke.may_reach));
  assert.deepEqual(row.invoke.key, [
    { secret_name_from_input: 'credential_name', fd: 3, only_when: { input: 'credential_name', present: true } },
    { secret_name_from_input: 'database', held_suffix: '-connection', fd: 3, only_when: { input: 'database', present: true }, under_use: { use_from_input: 'use', ticket_fd: 5, held_suffix: '-reader-connection', key_suffix: '-use-key' } },
    { secret_name_from_input: 'role_credential_name', fd: 4, only_when: { input: 'role_credential_name', present: true } },
    { secret_name_from_input: 'value_credential_name', fd: 6, only_when: { input: 'value_credential_name', present: true } },
  ], 'the login is the person\'s: the run names its vault name or, by database, the computer maps it (its reader login and a ticket of the use when the input declares one); the row lists none');
  assert.equal(row.input_schema.properties.credential_name.enum, undefined);
  assert.equal(row.input_schema.properties.role_credential_name.enum, undefined);
  assert.ok(row.invoke.files.package_files[0].paths.includes('read-data'), 'the recipes are packed with the program');
});

test('the input names one way to the connection: credential_name or database, never both', () => {
  const schema = row.input_schema;
  assert.deepEqual(schema.anyOf, [{ required: ['credential_name'] }, { required: ['database'] }]);
  assert.deepEqual(schema.not, { required: ['credential_name', 'database'] }, 'both are two mounts on descriptor 3, which the engine refuses');
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
});

test('statement_timeout_ms cuts a long statement with the database\'s own text', async () => {
  const margin = TIME_LIMITS.margin_ms;
  await assert.rejects(runSql({ connection: ownerConnection, input: { sql: 'SELECT pg_sleep(5)', statement_timeout_ms: margin + 200 }, usedMs: 0 }), /statement timeout/);
  await assert.rejects(runSql({ connection: ownerConnection, input: { sql: 'SELECT 1', statement_timeout_ms: 0 } }), /whole number of milliseconds/);
});

test('every connection ends its statements and open transactions at what is left of the run, from the row and time-limits.json', async () => {
  const { default_ms: byDefault, margin_ms: margin } = TIME_LIMITS;
  const ceiling = row.invoke.max_run_ms;
  assert.ok(Number.isInteger(ceiling) && ceiling > byDefault, 'the row declares its own ceiling, above the default');
  assert.deepEqual(row.invoke.files.package_files[0].paths, ['do-work', 'read-data', 'what-this-tool-does-and-how-to-run-it.json'], 'the run reads its own row');
  assert.equal(timeLimitOf(undefined, 500), byDefault - margin - 500, 'a call that asks none: the default, less the margin and the time used');
  assert.equal(timeLimitOf(ceiling - margin, 0), ceiling - 2 * margin, 'a longer time within the ceiling is given');
  assert.throws(() => timeLimitOf(ceiling, 0), /at most/);
  assert.throws(() => timeLimitOf(undefined, byDefault), /no time left/);
  assert.throws(() => timeLimitOf(undefined, 0, { ceilingMs: null }), /declares no invoke.max_run_ms/);
  // What the server is told, read back on the connection the run opens.
  const set = await runSql({ connection: ownerConnection, input: { sql: "SELECT current_setting('statement_timeout') AS statement, current_setting('idle_in_transaction_session_timeout') AS idle" } });
  for (const value of Object.values(set.rows[0])) assert.ok(Number.parseInt(value, 10) > 0 && Number.parseInt(value, 10) <= byDefault - margin, value);
  const longer = await runSql({ connection: ownerConnection, input: { sql: "SELECT current_setting('statement_timeout') AS statement", statement_timeout_ms: ceiling - margin } });
  assert.ok(Number.parseInt(longer.rows[0].statement, 10) > byDefault, `a longer time asked is given: ${longer.rows[0].statement}`);
});

test('a request that is neither shape, or both, or has no connection, is refused before any connection', () => {
  assert.throws(() => shapeOf({}), /Give sql/);
  assert.throws(() => shapeOf({ sql: 'SELECT 1', recipe: { name: 'read-only', action: 'create' } }), /Give one of/);
  assert.throws(() => shapeOf({ recipe: { name: 'no-such-recipe', action: 'create' } }), /recipe.name must be one of read-only/);
  assert.throws(() => shapeOf({ recipe: { name: 'read-only', action: 'alter' } }), /create, drop or reset/);
  assert.throws(() => shapeOf({ recipe: { name: 'read-only', action: 'create', valid_until: 'soon' } }), /must be a time/);
  assert.throws(() => shapeOf({ sql: '  ' }), /statement as text/);
  assert.throws(() => shapeOf({ sql: 'SELECT 1', params: 'x' }), /list of values/);
  assert.throws(() => shapeOf({ list: 'a', id: 'b', value: 1 }), /Give sql/, 'a tool-made table of rows is not a shape: a list is a table the person makes');
  return assert.rejects(runSql({ connection: '', input: { sql: 'SELECT 1' } }), /No database connection/);
});

// The engine mounts descriptor 3 only for a request that names a connection, and an unmounted descriptor may never answer. Here
// descriptors 3 and 4 are left open, as an unmounted one is: a request naming no connection must be refused without reading them.
const runWithoutConnection = input => new Promise((resolve) => {
  const child = spawn(process.execPath, [fileURLToPath(new URL('../do-work/run-sql.mjs', import.meta.url))], { stdio: ['pipe', 'pipe', 'pipe', 'pipe', 'pipe'], env: {} });
  let out = ''; let err = '';
  child.stdout.on('data', chunk => { out += chunk; });
  child.stderr.on('data', chunk => { err += chunk; });
  const waited = setTimeout(() => { child.kill(); resolve({ code: 'hung', out, err }); }, 10000);
  child.on('exit', code => { clearTimeout(waited); resolve({ code, out, err }); });
  child.stdin.end(JSON.stringify(input));
});

test('a request that names no connection is refused at once, before any descriptor is read', async () => {
  for (const input of [{ sql: 'SELECT 1' }, { sql: 'SELECT 1', credential_name: null }, { sql: 'SELECT 1', database: '' }]) {
    const refused = await runWithoutConnection(input);
    assert.equal(refused.code, 1, JSON.stringify(input));
    assert.match(refused.err, /no credential_name \(or other target\) in the input/);
    assert.equal(refused.out, '');
  }
});

test('a connection is named by credential_name or database as text: null and empty are not given', () => {
  assert.equal(namesTarget({ sql: 'SELECT 1', credential_name: 'own-rows-postgres-connection' }), true);
  assert.equal(namesTarget({ sql: 'SELECT 1', database: 'shop_for_who_runs_it' }), true);
  assert.equal(namesTarget({ sql: 'SELECT 1', credential_name: null }), false);
  assert.equal(namesTarget({ sql: 'SELECT 1', database: '' }), false);
  assert.equal(namesTarget(['credential_name']), false);
  assert.equal(namesTarget(null), false);
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

// The verifier maker as its keeper runs it: the kept connection string on stdin, the verifier alone on stdout.
const makeVerifier = (kept) => new Promise((resolve) => {
  const child = spawn(process.execPath, [fileURLToPath(new URL('../do-work/make-a-login-verifier.mjs', import.meta.url))], { stdio: ['pipe', 'pipe', 'pipe'], env: {} });
  let out = ''; let err = '';
  child.stdout.on('data', chunk => { out += chunk; });
  child.stderr.on('data', chunk => { err += chunk; });
  child.stdin.end(kept);
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
const SHARE_PW = "made-up-share-pw-with-'quote-and-long-enough-to-pass";
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

test('a minted member login reads, adds, changes and removes rows, of a table made after it too, and cannot change a table or make a login', async () => {
  const until = new Date(Date.now() + 3600000).toISOString();
  const minted = await runSql({ connection: ownerConnection, input: { recipe: { name: 'may-change-rows', action: 'create', valid_until: until } } });
  const [{ role, connection }] = minted.rows;
  assert.match(role, /^may_change_rows_[0-9a-f]{12}$/);
  await runSql({ connection: ownerConnection, input: { sql: 'CREATE TABLE notes (id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY, words text)' } });
  await runSql({ connection, input: { sql: "INSERT INTO tasks (id, title) VALUES ('t-member', 'added by a member')" } });
  await runSql({ connection, input: { sql: "UPDATE tasks SET title = 'changed by a member' WHERE id = 't-member'" } });
  await runSql({ connection, input: { sql: "INSERT INTO notes (words) VALUES ('a table made after the login')" } });
  assert.deepEqual((await runSql({ connection, input: { sql: 'SELECT words FROM notes' } })).rows, [{ words: 'a table made after the login' }]);
  await runSql({ connection, input: { sql: "DELETE FROM tasks WHERE id = 't-member'" } });
  await assert.rejects(runSql({ connection, input: { sql: 'ALTER TABLE tasks ADD COLUMN extra text' } }), /must be owner/);
  await assert.rejects(runSql({ connection, input: { sql: 'DROP TABLE notes' } }), /must be owner/);
  await assert.rejects(runSql({ connection, input: { sql: "CREATE ROLE p_member_made LOGIN PASSWORD 'x'" } }), /permission denied/);
  await runSql({ connection: ownerConnection, input: { recipe: { name: 'may-change-rows', action: 'drop', role } } });
  await runSql({ connection: ownerConnection, input: { sql: 'DROP TABLE notes' } });
  assert.deepEqual((await runSql({ connection: ownerConnection, input: { sql: 'SELECT id FROM tasks ORDER BY id' } })).rows, [{ id: 't1' }]);
  assert.deepEqual(await roles(), []);
});

test('a login for someone else is made from the verifier they sent: they sign in with the password only they hold, the owner never sees it, and the drop takes it away', async () => {
  const member = 'p_example_share_member';
  const password = randomBytes(32).toString('base64url');
  const kept = connectionFor(member, password);
  const sent = await makeVerifier(kept);
  assert.equal(sent.code, 0, sent.err);
  const { password_verifier: verifier } = JSON.parse(sent.out);
  assert.ok(!sent.out.includes(password), 'the verifier answer holds no password');
  const made = await runSql({ connection: ownerConnection, input: { recipe: { name: 'may-change-rows', action: 'create', role: member, password_verifier: verifier } } });
  assert.deepEqual(made.rows, [{ role: member, recipe: 'may-change-rows', action: 'create', valid_until: 'infinity' }], 'nothing is answered but the role');
  const admin = new pg.Client({ ...ADMIN, database: 'postgres' });
  await admin.connect();
  assert.equal((await admin.query('SELECT rolpassword FROM pg_authid WHERE rolname = $1', [member])).rows[0].rolpassword, verifier, 'the server keeps the verifier as sent');
  await admin.end();
  await runSql({ connection: kept, input: { sql: "INSERT INTO tasks (id, title) VALUES ('t-kept', 'added by the password keeper')" } });
  await runSql({ connection: kept, input: { sql: "DELETE FROM tasks WHERE id = 't-kept'" } });
  await assert.rejects(runSql({ connection: connectionFor(member, randomBytes(32).toString('base64url')), input: { sql: 'SELECT 1' } }), /password authentication failed/);
  await runSql({ connection: ownerConnection, input: { recipe: { name: 'may-change-rows', action: 'drop', role: member } } });
  await assert.rejects(runSql({ connection: kept, input: { sql: 'SELECT 1' } }), /password authentication failed|does not exist/);
  assert.deepEqual(await roles(), []);
});

test('where the database\'s owner may not make logins, the computer\'s role maker makes the login from the verifier and the owner gives it rights in its own database; leaving takes the rights back, then the login', async () => {
  // A pursuit's owner as a computer makes one: no right to make roles, a database closed to everyone else, the role maker too.
  const admin = new pg.Client({ ...ADMIN, database: 'postgres' });
  await admin.connect();
  await admin.query("CREATE ROLE p_example_plain_owner LOGIN PASSWORD 'made-up-plain-owner-pw'");
  await admin.query('CREATE DATABASE p_plain OWNER p_example_plain_owner');
  await admin.query('REVOKE ALL ON DATABASE p_plain FROM PUBLIC');
  await admin.end();
  const plainOwner = `postgres://p_example_plain_owner:made-up-plain-owner-pw@127.0.0.1:${PORT}/p_plain`;
  await runSql({ connection: plainOwner, input: { sql: 'CREATE TABLE payments (id text PRIMARY KEY, email text)' } });
  const member = 'p_example_share_coach';
  const password = randomBytes(32).toString('base64url');
  const kept = `postgres://${member}:${password}@127.0.0.1:${PORT}/p_plain`;
  const password_verifier = verifierOf(password);
  await assert.rejects(runSql({ connection: plainOwner, input: { recipe: { name: 'may-change-rows', action: 'create', role: member, password_verifier } } }), /permission denied to create role/, 'the owner alone cannot make the login');
  await assert.rejects(runSql({ connection: `postgres://${OWNER}:${OWNER_PW}@127.0.0.1:${PORT}/p_plain`, input: { sql: 'SELECT 1' } }), /permission denied for database|not have CONNECT/, 'the role maker cannot reach the pursuit\'s database');
  const login = await runSql({ connection: ownerConnection, input: { recipe: { name: 'a-login', action: 'create', role: member, password_verifier } } });
  assert.deepEqual(login.rows, [{ role: member, recipe: 'a-login', action: 'create', valid_until: 'infinity' }]);
  await assert.rejects(runSql({ connection: kept, input: { sql: 'SELECT 1' } }), /permission denied for database|not have CONNECT/, 'a login alone reaches nothing');
  const rights = await runSql({ connection: plainOwner, input: { recipe: { name: 'may-change-rows-for-a-login', action: 'create', role: member } } });
  assert.deepEqual(rights.rows, [{ role: member, recipe: 'may-change-rows-for-a-login', action: 'create', valid_until: 'infinity' }]);
  await runSql({ connection: kept, input: { sql: "INSERT INTO payments VALUES ('pay-1', 'bo@example.test')" } });
  await runSql({ connection: plainOwner, input: { sql: 'CREATE TABLE later (id int)' } });
  await runSql({ connection: kept, input: { sql: 'INSERT INTO later VALUES (1)' } });
  await assert.rejects(runSql({ connection: kept, input: { sql: 'DROP TABLE payments' } }), /must be owner/);
  await assert.rejects(runSql({ connection: plainOwner, input: { recipe: { name: 'may-change-rows-for-a-login', action: 'create' } } }), /give recipe.role/);
  await assert.rejects(runSql({ connection: plainOwner, input: { recipe: { name: 'may-change-rows-for-a-login', action: 'create', role: member, password_verifier } } }), /makes no login/);
  await runSql({ connection: plainOwner, input: { recipe: { name: 'may-change-rows-for-a-login', action: 'drop', role: member } } });
  await assert.rejects(runSql({ connection: kept, input: { sql: 'SELECT 1' } }), /permission denied for database|not have CONNECT/, 'with its rights taken back the login reaches nothing');
  await runSql({ connection: ownerConnection, input: { recipe: { name: 'a-login', action: 'drop', role: member } } });
  await assert.rejects(runSql({ connection: kept, input: { sql: 'SELECT 1' } }), /password authentication failed|does not exist/);
  assert.deepEqual((await runSql({ connection: plainOwner, input: { sql: 'SELECT id FROM payments' } })).rows, [{ id: 'pay-1' }], 'what they made stays');
  assert.deepEqual(await roles(), []);
});

test('a verifier is checked before any connection: its shape, its iterations, a role and create only, and never with a held role connection', async () => {
  const verifier = verifierOf(randomBytes(32).toString('base64url'));
  assert.match(verifier, /^SCRAM-SHA-256\$4096:/);
  assert.throws(() => shapeOf({ recipe: { name: 'may-change-rows', action: 'create', role: 'r', password_verifier: 'plain-password-is-not-a-verifier' } }), /must be a SCRAM-SHA-256 verifier/);
  assert.throws(() => shapeOf({ recipe: { name: 'may-change-rows', action: 'create', role: 'r', password_verifier: verifier.replace('$4096:', '$1000:') } }), /at least 4096 iterations/);
  assert.throws(() => shapeOf({ recipe: { name: 'may-change-rows', action: 'drop', role: 'r', password_verifier: verifier } }), /give it with create/);
  assert.throws(() => shapeOf({ recipe: { name: 'may-change-rows', action: 'create', password_verifier: verifier } }), /needs recipe.role/);
  await assert.rejects(runSql({ connection: ownerConnection, roleConnection: shareConnection, input: { recipe: { name: 'may-change-rows', action: 'create', role: 'r', password_verifier: verifier } } }), /Give one of/);
  assert.throws(() => verifierOf('short'), /at least 43 characters/);
  assert.throws(() => verifierOf(`${'é'.repeat(43)}`), /printable ASCII/);
  assert.equal(passwordOf(connectionFor('someone', 'p%40ss' + 'x'.repeat(40))), 'p@ss' + 'x'.repeat(40));
  assert.deepEqual(await roles(), []);
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

// The login of whoever runs a computer (CREATEROLE and CREATEDB, as set-up-postgres-role.sh PG_MAKES_ROLES=yes
// PG_MAKES_DATABASES=yes makes it) makes a pursuit's login and its database as SQL, and cannot open that database itself.
test('own-database: the operator makes a login and the database it owns, closed to everyone else, the operator too, and drops both', async () => {
  const admin = new pg.Client({ ...ADMIN, database: 'postgres' });
  await admin.connect();
  await admin.query("CREATE ROLE p_example_operator LOGIN CREATEROLE CREATEDB PASSWORD 'made-up-operator-pw'");
  await admin.query('CREATE DATABASE p_example_operator OWNER p_example_operator');
  await admin.end();
  const operator = `postgres://p_example_operator:made-up-operator-pw@127.0.0.1:${PORT}/p_example_operator`;
  const PURSUIT_PW = 'made-up-pursuit-password-of-forty-three-chars';
  const pursuit = `postgres://p_example_pursuit:${PURSUIT_PW}@127.0.0.1:${PORT}/p_example_pursuit`;
  await assert.rejects(runSql({ connection: operator, input: { recipe: { name: 'own-database', action: 'create', valid_until: '2099-01-01T00:00:00Z' } } }), /names the held role connection's database: give role_credential_name/);
  const made = await runSql({ connection: operator, roleConnection: pursuit, input: { recipe: { name: 'own-database', action: 'create' } } });
  assert.deepEqual(made.rows, [{ role: 'p_example_pursuit', recipe: 'own-database', action: 'create', valid_until: 'infinity' }]);
  await runSql({ connection: pursuit, input: { sql: 'CREATE TABLE notes (id int)' } });
  assert.deepEqual((await runSql({ connection: pursuit, input: { sql: 'SELECT current_user AS u, current_database() AS d' } })).rows, [{ u: 'p_example_pursuit', d: 'p_example_pursuit' }]);
  await assert.rejects(runSql({ connection: pursuit.replace(`p_example_pursuit:${PURSUIT_PW}`, 'p_example_operator:made-up-operator-pw'), input: { sql: 'SELECT 1' } }), /permission denied for database "p_example_pursuit"/);
  await assert.rejects(runSql({ connection: pursuit.replace(`p_example_pursuit:${PURSUIT_PW}`, `${OWNER}:${OWNER_PW}`), input: { sql: 'SELECT 1' } }), /permission denied for database "p_example_pursuit"/);
  assert.deepEqual((await runSql({ connection: operator, input: { sql: "SELECT pg_has_role('p_example_pursuit', 'SET') AS can_set, pg_has_role('p_example_pursuit', 'USAGE') AS inherits" } })).rows, [{ can_set: false, inherits: false }]);
  await runSql({ connection: operator, roleConnection: pursuit, input: { recipe: { name: 'own-database', action: 'drop' } } });
  assert.deepEqual((await runSql({ connection: operator, input: { sql: "SELECT (SELECT count(*)::int FROM pg_database WHERE datname = 'p_example_pursuit') AS dbs, (SELECT count(*)::int FROM pg_roles WHERE rolname = 'p_example_pursuit') AS roles" } })).rows, [{ dbs: 0, roles: 0 }]);
});

// The operator that made a pursuit's login is its admin, so it sets a new password from the held role connection: the server
// reads the new value (descriptor 4), the old one is refused from then on, and a reset takes no valid_until and needs the held value.
test('own-database reset: the operator that made the login sets its new password, the old one is refused, and a reset needs the held value', async () => {
  const admin = new pg.Client({ ...ADMIN, database: 'postgres' });
  await admin.connect();
  await admin.query("CREATE ROLE p_example_reset_operator LOGIN CREATEROLE CREATEDB PASSWORD 'made-up-reset-operator-pw'");
  await admin.query('CREATE DATABASE p_example_reset_operator OWNER p_example_reset_operator');
  await admin.end();
  const operator = `postgres://p_example_reset_operator:made-up-reset-operator-pw@127.0.0.1:${PORT}/p_example_reset_operator`;
  const OLD_PW = 'made-up-old-password-of-more-than-forty-three-chars';
  const NEW_PW = 'made-up-new-password-of-more-than-forty-three-chars';
  const pursuit = password => `postgres://p_example_reset:${password}@127.0.0.1:${PORT}/p_example_reset`;
  await runSql({ connection: operator, roleConnection: pursuit(OLD_PW), input: { recipe: { name: 'own-database', action: 'create' } } });
  await assert.rejects(runSql({ connection: operator, input: { recipe: { name: 'own-database', action: 'reset' } } }), /A reset needs role_credential_name/);
  await assert.rejects(runSql({ connection: operator, roleConnection: pursuit(NEW_PW), input: { recipe: { name: 'own-database', action: 'reset', valid_until: '2099-01-01T00:00:00Z' } } }), /stops only when it is dropped/);
  await assert.rejects(runSql({ connection: operator, roleConnection: pursuit(NEW_PW), input: { recipe: { name: 'read-only', action: 'reset' } } }), /The read-only recipe has no reset/);
  await runSql({ connection: operator, roleConnection: pursuit(NEW_PW), input: { recipe: { name: 'own-database', action: 'reset' } } });
  await assert.rejects(runSql({ connection: pursuit(OLD_PW), input: { sql: 'SELECT 1' } }), /password authentication failed/);
  assert.deepEqual((await runSql({ connection: pursuit(NEW_PW), input: { sql: 'SELECT 1 AS one' } })).rows, [{ one: 1 }]);
  await runSql({ connection: operator, roleConnection: pursuit(NEW_PW), input: { recipe: { name: 'own-database', action: 'drop' } } });
});

// Per-login limits (role-recipes.json limits rows): set when the login is made, each only when the caller gives a whole number,
// read back from the server; a limit the recipe does not list, a number that is not whole, a limit on a drop and a standing
// password shorter than 32 random bytes are refused before anything is made.
test('own-database with limits: the login is made holding the connection limit and statement timeout it was given', async () => {
  const operator = `postgres://p_example_operator:made-up-operator-pw@127.0.0.1:${PORT}/p_example_operator`;
  const pursuit = `postgres://p_example_limited:made-up-limited-password-of-forty-three-chars@127.0.0.1:${PORT}/p_example_limited`;
  const create = limits => ({ recipe: { name: 'own-database', action: 'create', limits } });
  await assert.rejects(runSql({ connection: operator, roleConnection: pursuit, input: create({ max_rows: 5 }) }), /recipe.limits.max_rows is not a limit of the own-database recipe/);
  await assert.rejects(runSql({ connection: operator, roleConnection: pursuit, input: create({ connection_limit: 2.5 }) }), /whole number above zero/);
  await assert.rejects(runSql({ connection: operator, roleConnection: pursuit, input: create(null) }), /recipe.limits must be an object/);
  await assert.rejects(runSql({ connection: operator, roleConnection: pursuit, input: create({ connection_limit: '5; DROP ROLE x' }) }), /whole number above zero/);
  await assert.rejects(runSql({ connection: operator, roleConnection: pursuit, input: { recipe: { name: 'own-database', action: 'drop', limits: { connection_limit: 5 } } } }), /give them with create/);
  await assert.rejects(runSql({ connection: operator, roleConnection: pursuit.replace('made-up-limited-password-of-forty-three-chars', 'short-pw'), input: create({}) }), /at least 43 characters/);
  const made = await runSql({ connection: operator, roleConnection: pursuit, input: create({ connection_limit: 7, statement_timeout_ms: 1500 }) });
  assert.deepEqual(made.rows[0].limits, { connection_limit: 7, statement_timeout_ms: 1500 });
  assert.deepEqual((await runSql({ connection: operator, input: { sql: "SELECT rolconnlimit AS n, rolconfig AS config FROM pg_roles WHERE rolname = 'p_example_limited'" } })).rows, [{ n: 7, config: ['statement_timeout=1500'] }]);
  await assert.rejects(runSql({ connection: pursuit, input: { sql: 'SELECT pg_sleep(3)' } }), /statement timeout/);
  await runSql({ connection: operator, roleConnection: pursuit, input: { recipe: { name: 'own-database', action: 'drop' } } });
});

test('a minted login\'s password is 32 random bytes', async () => {
  const minted = await runSql({ connection: ownerConnection, input: { recipe: { name: 'read-only', action: 'create', role: 'p_example_share_bytes', valid_until: '2099-01-01T00:00:00Z' } } });
  assert.equal(Buffer.from(decodeURIComponent(new URL(minted.rows[0].connection).password), 'base64url').length, 32);
  await runSql({ connection: ownerConnection, input: { recipe: { name: 'read-only', action: 'drop', role: 'p_example_share_bytes' } } });
});

// A sandboxed run reaches its database by address through the run's own proxy (HTTPS_PROXY): one CONNECT tunnel per connection.
// A stand-in proxy here opens a tunnel to the test server, notes what was asked, and refuses when told to, as the engine's does
// for a host the held value may not go to.
test('with HTTPS_PROXY the statement goes through a CONNECT tunnel to the database\'s address, and a refused tunnel says so', async () => {
  const asked = [];
  let refuse = false;
  const proxy = net.createServer(client => {
    client.once('data', head => {
      const target = head.toString('latin1').split(' ')[1];
      asked.push(target);
      if (refuse) return client.end('HTTP/1.1 403 Forbidden\r\n\r\n');
      const [host, port] = target.split(':');
      const server = net.connect(Number(port), host, () => { client.write('HTTP/1.1 200 Connection established\r\n\r\n'); client.pipe(server).pipe(client); });
      server.on('error', () => client.destroy());
    });
  });
  await new Promise(done => proxy.listen(0, '127.0.0.1', done));
  const before = process.env.HTTPS_PROXY;
  process.env.HTTPS_PROXY = `http://127.0.0.1:${proxy.address().port}`;
  try {
    const answer = await runSql({ connection: ownerConnection, input: { sql: 'SELECT $1::text AS word', params: ['through'] } });
    assert.deepEqual(answer.rows, [{ word: 'through' }]);
    assert.deepEqual(asked, [`127.0.0.1:${PORT}`], 'the tunnel is to the address the connection string names');
    refuse = true;
    await assert.rejects(runSql({ connection: ownerConnection, input: { sql: 'SELECT 1' } }), /the run's proxy did not open 127\.0\.0\.1:\d+ \(answered 403\)/);
  } finally {
    if (before === undefined) delete process.env.HTTPS_PROXY; else process.env.HTTPS_PROXY = before;
    proxy.close();
  }
});



// A login that may only add one kind of row: the role maker makes the login, the pursuit's owner (no right to make roles) gives it a
// column-limited INSERT and a rule the server holds each added row to.
test('may-only-add-rows-for-a-login: the login adds a row naming only its columns, the server sets the fixed ones, and it reads, changes, removes and reaches nothing else', async () => {
  const admin = new pg.Client({ ...ADMIN, database: 'postgres' });
  await admin.connect();
  await admin.query("CREATE ROLE p_example_adds_owner LOGIN PASSWORD 'made-up-adds-owner-pw'");
  await admin.query('CREATE DATABASE p_adds OWNER p_example_adds_owner');
  await admin.query('REVOKE ALL ON DATABASE p_adds FROM PUBLIC');
  await admin.end();
  const owner = `postgres://p_example_adds_owner:made-up-adds-owner-pw@127.0.0.1:${PORT}/p_adds`;
  await runSql({ connection: owner, input: { sql: "CREATE TABLE tasks (id text PRIMARY KEY, title text, description text, labels jsonb, status text DEFAULT 'To do', made_at timestamptz)" } });
  await runSql({ connection: owner, input: { sql: 'CREATE TABLE secrets (id text PRIMARY KEY, words text)' } });
  await runSql({ connection: owner, input: { sql: "INSERT INTO tasks (id, title, labels) VALUES ('t-own', 'an owner row', '[\"work\"]')" } });
  const member = 'p_example_adds_only';
  const password = randomBytes(32).toString('base64url');
  const kept = `postgres://${member}:${password}@127.0.0.1:${PORT}/p_adds`;
  const password_verifier = verifierOf(password);
  await runSql({ connection: ownerConnection, input: { recipe: { name: 'a-login', action: 'create', role: member, password_verifier } } });
  const recipe = { name: 'may-only-add-rows-for-a-login', role: member, table: 'tasks' };
  await assert.rejects(runSql({ connection: owner, input: { recipe: { ...recipe, action: 'create', fixed: { labels: ['feedback'] } } } }), /recipe.columns must be the list/);
  await assert.rejects(runSql({ connection: owner, input: { recipe: { ...recipe, action: 'create', columns: ['id', 'labels'], fixed: { labels: ['feedback'] } } } }), /recipe.fixed.labels is also in recipe.columns/);
  await assert.rejects(runSql({ connection: owner, input: { recipe: { name: 'may-change-rows-for-a-login', action: 'create', role: member, table: 'tasks' } } }), /are for a recipe that adds rows/);
  await assert.rejects(runSql({ connection: owner, input: { recipe: { name: 'may-only-add-rows-for-a-login', action: 'create', role: member, columns: ['id'] } } }), /needs recipe.table/);
  await runSql({ connection: owner, input: { recipe: { ...recipe, action: 'create', columns: ['id', 'title', 'description', 'made_at'], fixed: { labels: ['feedback'], status: 'To do' } } } });
  // Adds a row; the server sets the labels whatever the login sends, and a default is the table's own.
  await runSql({ connection: kept, input: { sql: "INSERT INTO tasks (id, title, description, made_at) VALUES ('t-fb', 'It broke', 'words about it', now())" } });
  assert.deepEqual((await runSql({ connection: owner, input: { sql: "SELECT id, labels, status FROM tasks WHERE id = 't-fb'" } })).rows, [{ id: 't-fb', labels: ['feedback'], status: 'To do' }]);
  // A row that breaks the rule: it cannot name a fixed column or one that is not listed, and cannot take a row back out.
  await assert.rejects(runSql({ connection: kept, input: { sql: "INSERT INTO tasks (id, labels) VALUES ('t-bad', '[\"work\"]')" } }), /permission denied for table tasks/);
  await assert.rejects(runSql({ connection: kept, input: { sql: "INSERT INTO tasks (id, status) VALUES ('t-bad2', 'Done')" } }), /permission denied for table tasks/);
  await assert.rejects(runSql({ connection: kept, input: { sql: "INSERT INTO tasks (id, title) VALUES ('t-fb', 'taken key')" } }), /duplicate key value/);
  await assert.rejects(runSql({ connection: kept, input: { sql: "INSERT INTO tasks (id, title) VALUES ('t-ret', 'x') RETURNING id" } }), /permission denied for table tasks/);
  await assert.rejects(runSql({ connection: kept, input: { sql: "INSERT INTO tasks (id, title) VALUES ('t-fb', 'x') ON CONFLICT (id) DO UPDATE SET title = 'x'" } }), /permission denied for table tasks/);
  assert.equal((await runSql({ connection: kept, input: { sql: "INSERT INTO tasks (id, title) VALUES ('t-fb', 'x') ON CONFLICT DO NOTHING" } })).row_count, 0, 'a taken key adds nothing, and says no more than the duplicate-key text did');
  // Nothing but adding, in this table or another.
  await assert.rejects(runSql({ connection: kept, input: { sql: 'SELECT id FROM tasks' } }), /permission denied for table tasks/);
  await assert.rejects(runSql({ connection: kept, input: { sql: "UPDATE tasks SET title = 'changed' WHERE id = 't-fb'" } }), /permission denied for table tasks/);
  await assert.rejects(runSql({ connection: kept, input: { sql: 'DELETE FROM tasks' } }), /permission denied for table tasks/);
  await assert.rejects(runSql({ connection: kept, input: { sql: 'TRUNCATE tasks' } }), /permission denied for table tasks/);
  await assert.rejects(runSql({ connection: kept, input: { sql: "INSERT INTO secrets (id, words) VALUES ('s1', 'x')" } }), /permission denied for table secrets/);
  await assert.rejects(runSql({ connection: kept, input: { sql: 'SELECT id FROM secrets' } }), /permission denied for table secrets/);
  await assert.rejects(runSql({ connection: kept, input: { sql: 'ALTER TABLE tasks ADD COLUMN extra text' } }), /must be owner/);
  // The owner's own rows are untouched by the rule, and only the login's rows are held to it.
  await runSql({ connection: owner, input: { sql: "INSERT INTO tasks (id, title, labels, status) VALUES ('t-own2', 'owner again', '[\"work\"]', 'Done')" } });
  assert.deepEqual((await runSql({ connection: owner, input: { sql: "SELECT labels, status FROM tasks WHERE id = 't-own2'" } })).rows, [{ labels: ['work'], status: 'Done' }]);
  // Leaving takes the trigger and every right back, then the login.
  await runSql({ connection: owner, input: { recipe: { ...recipe, action: 'drop' } } });
  await assert.rejects(runSql({ connection: kept, input: { sql: "INSERT INTO tasks (id, title) VALUES ('t-after', 'x')" } }), /permission denied for database|not have CONNECT/);
  assert.deepEqual((await runSql({ connection: owner, input: { sql: "SELECT count(*)::int AS n FROM pg_trigger WHERE tgname = 'rule_' || $1" , params: [member] } })).rows, [{ n: 0 }]);
  await runSql({ connection: ownerConnection, input: { recipe: { name: 'a-login', action: 'drop', role: member } } });
  assert.deepEqual(await roles(), []);
});

test('statements are one request, one transaction or nothing: a list of statements, a known ending, never with sql or a fence', () => {
  assert.throws(() => shapeOf({ sql: 'SELECT 1', statements: [{ sql: 'SELECT 1' }] }), /Give one of/);
  assert.throws(() => shapeOf({ statements: [] }), /list of 1 to 200/);
  assert.throws(() => shapeOf({ statements: [{ sql: ' ' }] }), /statements\[0\]\.sql/);
  assert.throws(() => shapeOf({ statements: [{ sql: 'SELECT 1', params: 'x' }] }), /statements\[0\]\.params/);
  assert.throws(() => shapeOf({ statements: [{ sql: 'SELECT 1' }], then: 'keep' }), /then must be rollback/);
  assert.throws(() => shapeOf({ statements: [{ sql: 'SELECT 1' }], fence: 'public.tasks' }), /fence is answered for one statement/);
  assert.deepEqual(shapeOf({ statements: [{ sql: 'SELECT 1', params: null }] }), { kind: 'statements', statements: [{ sql: 'SELECT 1', params: [] }], then: 'rollback', use: undefined });
});

test('statements run in order in one transaction that keeps nothing unless it says commit, and a refused one answers its words while the rest run', async () => {
  await runSql({ connection: ownerConnection, input: { sql: 'CREATE TABLE trial_rows (id text PRIMARY KEY, score int CHECK (score BETWEEN 1 AND 5))' } });
  const tried = await runSql({ connection: ownerConnection, input: { statements: [
    { sql: 'INSERT INTO trial_rows VALUES ($1, $2)', params: ['r1', 5] },
    { sql: 'INSERT INTO trial_rows VALUES ($1, $2)', params: ['r2', 9] },
    { sql: 'INSERT INTO trial_rows VALUES ($1, $2)', params: ['r1', 3] },
    { sql: 'SELECT id, score FROM trial_rows ORDER BY id' },
  ] } });
  assert.equal(tried.then, 'rollback');
  assert.equal(tried.row_count, 4);
  assert.equal(tried.refused, 2);
  assert.deepEqual(tried.rows.map(row => row.statement), [0, 1, 2, 3]);
  assert.equal(tried.rows[0].row_count, 1);
  assert.match(tried.rows[1].error, /violates check constraint/);
  assert.match(tried.rows[2].error, /duplicate key value/);
  assert.deepEqual(tried.rows[3].rows, [{ id: 'r1', score: 5 }], 'the read sees the write that held, inside the transaction');
  const after = await runSql({ connection: ownerConnection, input: { sql: 'SELECT count(*)::int AS n FROM trial_rows' } });
  assert.equal(after.rows[0].n, 0, 'the rollback kept nothing');
  const kept = await runSql({ connection: ownerConnection, input: { then: 'commit', statements: [{ sql: "INSERT INTO trial_rows VALUES ('r3', 4)" }] } });
  assert.equal(kept.refused, 0);
  const now = await runSql({ connection: ownerConnection, input: { sql: 'SELECT id FROM trial_rows' } });
  assert.deepEqual(now.rows, [{ id: 'r3' }], 'commit keeps what the statements did');
  const read = await runSql({ connection: readerConnection, input: { statements: [{ sql: "INSERT INTO trial_rows VALUES ('r4', 2)" }, { sql: 'SELECT count(*)::int AS n FROM trial_rows' }] } });
  assert.match(read.rows[0].error, /permission denied/, 'the login\'s own rights still decide');
  assert.deepEqual(read.rows[1].rows, [{ n: 1 }]);
  await runSql({ connection: ownerConnection, input: { sql: 'DROP TABLE trial_rows' } });
});
