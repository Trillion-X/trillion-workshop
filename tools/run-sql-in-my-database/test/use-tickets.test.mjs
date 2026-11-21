import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHmac, randomBytes } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import EmbeddedPostgres from 'embedded-postgres';
import pg from 'pg';
import { tempFolder } from '../../../test-helpers/temp-folder.mjs';
import { runSql } from '../do-work/run-sql.mjs';

// A run's use bound by the engine (its use_ticket.rs), on a real PostgreSQL server: a run
// that declares a use is handed the database's reader login and a ticket of that use signed with the database's use key;
// the role recipe may-read-under-row-rules gives the reader its rights and keeps the key and the claims the row rules read.
// Tickets here are made the way the engine makes them (its test vector checks the same HMAC over the same payload).
const PORT = 55000 + (process.pid % 900);
const ADMIN = { host: '127.0.0.1', port: PORT, user: 'postgres', password: 'made-up-admin-pw' };
const DATABASE = 'p_uses';
const OWNER = 'p_uses_owner', OWNER_PW = 'made-up-owner-pw';
const MAKER = 'p_uses_login_maker', MAKER_PW = 'made-up-maker-pw';
const READER = 'p_uses_reader', READER_PW = randomBytes(32).toString('base64url');
const BYPASSER = 'p_uses_bypasser';
const KEY = randomBytes(32).toString('base64url');
const connectionFor = (user, password) => `postgres://${user}:${password}@127.0.0.1:${PORT}/${DATABASE}`;
const owner = connectionFor(OWNER, OWNER_PW), maker = connectionFor(MAKER, MAKER_PW), reader = connectionFor(READER, READER_PW);
let server;

const ticketOf = (use, { key = KEY, until = Date.now() + 60_000, nonce = randomBytes(16).toString('hex') } = {}) => {
  const payload = Buffer.from(JSON.stringify({ nonce, purpose: use.purpose, surface: use.surface, until })).toString('hex');
  return `${payload}.${createHmac('sha256', key).update(payload).digest('hex')}`;
};
// One run of the tool under a use, as the engine hands it: the reader login and a fresh ticket of that use.
const under = (use, sql, params = []) => runSql({ connection: reader, ticket: ticketOf(use), input: { database: DATABASE, sql, params, use } });
const ids = answer => answer.rows.map(row => row.id);
const publish = { purpose: 'publish', surface: 'social/instagram' };
const coach = { purpose: 'coach/review', surface: '' };

before(async () => {
  server = new EmbeddedPostgres({ databaseDir: tempFolder(join(tmpdir(), 'run-sql-uses-')), user: ADMIN.user, password: ADMIN.password, port: PORT, persistent: false, onLog: () => {}, onError: () => {} });
  await server.initialise();
  await server.start();
  const admin = new pg.Client({ ...ADMIN, database: 'postgres' });
  await admin.connect();
  await admin.query(`CREATE ROLE ${OWNER} LOGIN PASSWORD '${OWNER_PW}'`);
  await admin.query(`CREATE ROLE ${MAKER} LOGIN CREATEROLE PASSWORD '${MAKER_PW}'`);
  await admin.query(`CREATE ROLE ${BYPASSER} LOGIN BYPASSRLS`);
  await admin.query(`CREATE DATABASE ${DATABASE} OWNER ${OWNER}`);
  await admin.query(`REVOKE ALL ON DATABASE ${DATABASE} FROM PUBLIC`);
  // PUBLIC may make temporary tables here, as on a database made without own-database: the recipe must take that away.
  await admin.query(`GRANT TEMPORARY ON DATABASE ${DATABASE} TO PUBLIC`);
  await admin.query(`GRANT CONNECT ON DATABASE ${DATABASE} TO ${MAKER}`);
  await admin.end();
  // The reader is a standing login made by the computer's login maker (a-login), with the password the computer holds.
  await runSql({ connection: maker, roleConnection: reader, input: { recipe: { name: 'a-login', action: 'create' } } });
  await runSql({ connection: owner, heldValue: KEY, input: { recipe: { name: 'may-read-under-row-rules', action: 'create', role: READER } } });
  // A material table of the owner's: who may see each row is its own column here; the shape the pursuit's AI makes
  // (material_allowed over use_grants) reads the same two functions.
  for (const sql of [
    'CREATE TABLE clip (id text PRIMARY KEY, allowed text NOT NULL)',
    "INSERT INTO clip VALUES ('owner-alone', 'publish:social/instagram coach/review: manage:'), ('paid-private', 'coach/review:'), ('never-examined', 'manage:')",
    'ALTER TABLE clip ENABLE ROW LEVEL SECURITY',
    'ALTER TABLE clip FORCE ROW LEVEL SECURITY',
    "CREATE POLICY by_use ON clip USING (use_binding.run_purpose() || ':' || use_binding.run_surface() = ANY (string_to_array(allowed, ' ')))",
    "INSERT INTO use_settings VALUES ('purpose_when_unstated', 'manage')",
  ]) await runSql({ connection: owner, input: { sql } });
});

after(async () => { await server.stop(); });

test('two runs of one statement under two uses read different rows', async () => {
  assert.deepEqual(ids(await under(publish, 'SELECT id FROM clip ORDER BY id')), ['owner-alone']);
  assert.deepEqual(ids(await under(coach, 'SELECT id FROM clip ORDER BY id')), ['owner-alone', 'paid-private']);
});

test('a run with no use is the owner\'s own work: the pursuit\'s purpose_when_unstated row decides what it reads', async () => {
  assert.deepEqual(ids(await runSql({ connection: owner, input: { database: DATABASE, sql: 'SELECT id FROM clip ORDER BY id' } })), ['never-examined', 'owner-alone']);
  const read = await runSql({ connection: owner, input: { sql: 'SELECT use_binding.run_purpose() AS purpose, use_binding.run_surface() AS surface' } });
  assert.deepEqual(read.rows, [{ purpose: 'manage', surface: '' }]);
});

test('a run cannot SET its purpose and be believed: the row rules read only the claimed ticket', async () => {
  const said = await under(publish, "SELECT set_config('run_use.purpose', 'coach/review', true) AS set, use_binding.run_purpose() AS believed, (SELECT count(*)::int FROM clip) AS rows");
  assert.deepEqual(said.rows, [{ set: 'coach/review', believed: 'publish', rows: 1 }]);
});

test('a ticket is claimed once, only when this database\'s key signed it, and only before it ends', async () => {
  const ticket = ticketOf(coach);
  const once = { connection: reader, ticket, input: { database: DATABASE, sql: 'SELECT id FROM clip', use: coach } };
  assert.equal((await runSql(once)).row_count, 2);
  await assert.rejects(runSql(once), /claimed already/, 'the same ticket again');
  await assert.rejects(runSql({ ...once, ticket: ticketOf(coach, { key: 'a-key-this-database-never-kept' }) }), /not signed with a key this database keeps/);
  const [payload, mac] = ticketOf(publish).split('.');
  const widened = Buffer.from(Buffer.from(payload, 'hex').toString().replace('publish', 'coach/review')).toString('hex');
  await assert.rejects(runSql({ ...once, ticket: `${widened}.${mac}` }), /not signed with a key this database keeps/, 'a changed use under the old MAC');
  await assert.rejects(runSql({ ...once, ticket: ticketOf(coach, { until: Date.now() - 1 }) }), /has ended/);
  await assert.rejects(runSql({ ...once, ticket: 'not-a-ticket' }), /not a use ticket/);
  await assert.rejects(under(publish, `SELECT * FROM use_binding.claim_use('${ticketOf(coach)}')`), /this transaction holds a use/, 'a second claim inside the run');
});

// The command as the engine runs it under a use: the request on stdin, the reader login on descriptor 3 and the ticket on 5.
const runCommand = (input, given) => new Promise((resolve) => {
  const child = spawn(process.execPath, [fileURLToPath(new URL('../do-work/run-sql.mjs', import.meta.url))], { stdio: ['pipe', 'pipe', 'pipe', 'pipe', 'pipe', 'pipe'], env: {} });
  let out = ''; let err = '';
  child.stdout.on('data', chunk => { out += chunk; });
  child.stderr.on('data', chunk => { err += chunk; });
  child.stdio[3].end(reader);
  child.stdio[4].end('');
  child.stdio[5].end(given);
  child.stdin.end(JSON.stringify(input));
  child.on('close', code => resolve({ code, out, err }));
});

test('the command reads the ticket from descriptor 5 when its input declares a use, and its error holds neither secret', async () => {
  const ok = await runCommand({ database: DATABASE, sql: 'SELECT id FROM clip ORDER BY id', use: coach }, ticketOf(coach));
  assert.equal(ok.code, 0, ok.err);
  assert.deepEqual(JSON.parse(ok.out).rows.map(row => row.id), ['owner-alone', 'paid-private']);
  const forged = ticketOf(coach, { key: 'a-key-this-database-never-kept' });
  const refused = await runCommand({ database: DATABASE, sql: 'SELECT id FROM clip', use: coach }, forged);
  assert.equal(refused.code, 1);
  assert.match(refused.err, /not signed with a key this database keeps/);
  assert.ok(!refused.err.includes(READER_PW) && !refused.err.includes(forged));
});

test('a use with no ticket is refused by the tool before it is sent: only the engine binds a use', async () => {
  await assert.rejects(runSql({ connection: owner, input: { database: DATABASE, sql: 'SELECT id FROM clip', use: coach } }), /bound only by the engine's ticket/);
});

test('the reader cannot read the keys or the claims, add a claim, drop or loosen the rule, make a table or write a row', async () => {
  for (const [sql, refused] of [
    ['SELECT * FROM use_binding.ticket_keys', /permission denied for table ticket_keys/],
    ['SELECT * FROM use_binding.claims', /permission denied for table claims/],
    ["INSERT INTO use_binding.claims VALUES ('n', pg_current_xact_id(), 'coach/review', '', current_user, now(), now() + interval '1 hour')", /permission denied for table claims/],
    ['DROP POLICY by_use ON clip', /must be owner of relation clip/],
    ['ALTER TABLE clip DISABLE ROW LEVEL SECURITY', /must be owner of table clip/],
    ["CREATE OR REPLACE FUNCTION use_binding.run_purpose() RETURNS text LANGUAGE sql AS $$ SELECT 'coach/review' $$", /permission denied for schema use_binding/],
    ['CREATE TABLE mine (a int)', /permission denied for schema public/],
    ['CREATE TEMP TABLE mine (a int)', /permission denied to create temporary tables/],
    ['CREATE TEMP TABLE use_settings (name text, value text)', /permission denied to create temporary tables/],
    ['CREATE TEMP TABLE use_grants (subject text)', /permission denied to create temporary tables/],
    ["UPDATE clip SET allowed = 'publish:social/instagram'", /permission denied for table clip/],
  ]) await assert.rejects(under(publish, sql), refused, sql);
  const flags = await runSql({ connection: owner, input: { sql: 'SELECT rolsuper, rolbypassrls, rolcreaterole, rolcreatedb FROM pg_roles WHERE rolname = $1', params: [READER] } });
  assert.deepEqual(flags.rows, [{ rolsuper: false, rolbypassrls: false, rolcreaterole: false, rolcreatedb: false }]);
});

test('a login that bypasses row rules is refused the reader\'s rights, and the drop takes the rights back', async () => {
  await assert.rejects(runSql({ connection: owner, heldValue: KEY, input: { recipe: { name: 'may-read-under-row-rules', action: 'create', role: BYPASSER } } }), /may get round the row rules/);
  await assert.rejects(runSql({ connection: owner, input: { recipe: { name: 'may-read-under-row-rules', action: 'create', role: READER } } }), /takes a held value/);
  await runSql({ connection: owner, input: { recipe: { name: 'may-read-under-row-rules', action: 'drop', role: READER } } });
  await assert.rejects(under(coach, 'SELECT id FROM clip'), /permission denied for database/, 'the drop takes even its connect right back');
  await runSql({ connection: owner, heldValue: KEY, input: { recipe: { name: 'may-read-under-row-rules', action: 'create', role: READER } } });
  assert.deepEqual(ids(await under(coach, 'SELECT id FROM clip ORDER BY id')), ['owner-alone', 'paid-private'], 'made again, the same key still binds');
});

test('a named table outside public is granted alone: the schema\'s other tables and any table made later stay closed', async () => {
  for (const sql of [
    'CREATE SCHEMA proof_side',
    'CREATE TABLE proof_side.open_clip (id text PRIMARY KEY)',
    "INSERT INTO proof_side.open_clip VALUES ('clip-a'), ('clip-b')",
    'CREATE TABLE proof_side.subjects (name text PRIMARY KEY)',
    "INSERT INTO proof_side.subjects VALUES ('a person who must not be named')",
  ]) await runSql({ connection: owner, input: { sql } });
  await assert.rejects(under(publish, 'SELECT id FROM proof_side.open_clip'), /permission denied for schema proof_side/, 'before it is named');
  await runSql({ connection: owner, heldValue: KEY, input: { recipe: { name: 'may-read-under-row-rules', action: 'create', role: READER, tables: ['proof_side.open_clip'] } } });
  assert.deepEqual(ids(await under(publish, 'SELECT id FROM proof_side.open_clip ORDER BY id')), ['clip-a', 'clip-b']);
  await assert.rejects(under(publish, 'SELECT name FROM proof_side.subjects'), /permission denied for table subjects/, 'a table not named');
  await runSql({ connection: owner, input: { sql: 'CREATE TABLE proof_side.later (id text)' } });
  await assert.rejects(under(publish, 'SELECT id FROM proof_side.later'), /permission denied for table later/, 'a table made after it is named');
  await assert.rejects(under(publish, 'SELECT * FROM use_binding.claims'), /permission denied for table claims/, 'the use binding stays closed');
  await assert.rejects(runSql({ connection: owner, input: { recipe: { name: 'may-read-under-row-rules', action: 'create', role: READER, tables: ['use_binding.claims'] } } }), /may not name the use_binding schema/);
  await assert.rejects(runSql({ connection: owner, input: { recipe: { name: 'a-login', action: 'create', tables: ['proof_side.open_clip'] } } }), /recipe.tables is for a recipe that grants per table/);
  await assert.rejects(runSql({ connection: owner, input: { recipe: { name: 'may-read-under-row-rules', action: 'create', role: READER, tables: ['no_dot'] } } }), /one each/);
  await runSql({ connection: owner, heldValue: KEY, input: { recipe: { name: 'may-read-under-row-rules', action: 'create', role: READER, tables: ['proof_side.open_clip'] } } });
  await runSql({ connection: owner, input: { recipe: { name: 'may-read-under-row-rules', action: 'drop', role: READER, tables: ['proof_side.open_clip'] } } });
  await runSql({ connection: owner, heldValue: KEY, input: { recipe: { name: 'may-read-under-row-rules', action: 'create', role: READER } } });
  await assert.rejects(under(publish, 'SELECT id FROM proof_side.open_clip'), /permission denied for schema proof_side/, 'the drop takes the named table back, and the rights made again do not name it');
});
