import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac, randomBytes } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import EmbeddedPostgres from 'embedded-postgres';
import pg from 'pg';
import { tempFolder } from '../../../test-helpers/temp-folder.mjs';
import { runSql, withSqlWrite } from '../do-work/run-sql.mjs';
import { sqlStore } from '../../ask-questions-sort-answers-follow-up/steps/store.ts';

// A pursuit's writer login (role recipe may-write-named-columns-under-a-use) on a real PostgreSQL server: made by the
// computer's login maker (a-login), given by the owner only the column rights recipe.writes names, its runs claiming the use the
// engine signed once for a whole step (withSqlWrite). The tables are the shapes a site's lead, visit, price view, welcome stop,
// form sitting and booking write; every value is made up.
const PORT = 55000 + (process.pid % 900);
const ADMIN = { host: '127.0.0.1', port: PORT, user: 'postgres', password: 'made-up-admin-pw' };
const DATABASE = 'p_runs';
const OWNER = 'p_runs_owner', OWNER_PW = 'made-up-owner-pw';
const MAKER = 'p_runs_login_maker', MAKER_PW = 'made-up-maker-pw';
const READER = 'p_runs_reader', READER_PW = randomBytes(32).toString('base64url');
const WRITER = 'p_runs_writer', WRITER_PW = randomBytes(32).toString('base64url');
const KEY = randomBytes(32).toString('base64url');
const connectionFor = (user, password) => `postgres://${user}:${password}@127.0.0.1:${PORT}/${DATABASE}`;
const owner = connectionFor(OWNER, OWNER_PW), maker = connectionFor(MAKER, MAKER_PW);
const reader = connectionFor(READER, READER_PW), writer = connectionFor(WRITER, WRITER_PW);
const publish = { purpose: 'publish', surface: 'site/example.test' };
let server;

const ticketOf = (use, { nonce = randomBytes(16).toString('hex') } = {}) => {
  const payload = Buffer.from(JSON.stringify({ nonce, purpose: use.purpose, surface: use.surface, until: Date.now() + 60_000 })).toString('hex');
  return `${payload}.${createHmac('sha256', KEY).update(payload).digest('hex')}`;
};
// One step under the use, as a tool that reads and writes runs it: the writer login, one ticket, one transaction.
const step = work => withSqlWrite({ connection: writer, ticket: ticketOf(publish), use: publish }, work);
const one = sql => step(query => query(sql));

const WRITES = [
  { table: 'public.statements', insert: ['source', 'told', 'place', 'meaning', 'at', 'key', 'after'] },
  { table: 'public.mention_rules', select: ['source', 'place', 'path', 'role', 'scheme'] },
  { table: 'public.mentions', insert: ['statement', 'role', 'scheme', 'value'] },
  { table: 'public.price_views', select: ['offer_id', 'day', 'views'], insert: ['offer_id', 'day', 'views'], update: ['views'] },
  { table: 'public.offers', select: ['id'] },
  { function: 'public.stop_welcome_series(text)' },
  { table: 'public.form_rows', select: ['id', 'type', 'value'], insert: ['id', 'type', 'value'], update: ['value', 'kept_at'], delete: true },
  { table: 'public.bookings', insert: ['id', 'booker_email', 'made_at'] },
];

before(async () => {
  server = new EmbeddedPostgres({ databaseDir: tempFolder(join(tmpdir(), 'run-sql-writer-')), user: ADMIN.user, password: ADMIN.password, port: PORT, persistent: false, onLog: () => {}, onError: () => {} });
  await server.initialise();
  await server.start();
  const admin = new pg.Client({ ...ADMIN, database: 'postgres' });
  await admin.connect();
  await admin.query(`CREATE ROLE ${OWNER} LOGIN PASSWORD '${OWNER_PW}'`);
  await admin.query(`CREATE ROLE ${MAKER} LOGIN CREATEROLE PASSWORD '${MAKER_PW}'`);
  await admin.query(`CREATE DATABASE ${DATABASE} OWNER ${OWNER}`);
  await admin.query(`REVOKE ALL ON DATABASE ${DATABASE} FROM PUBLIC`);
  await admin.query(`GRANT TEMPORARY ON DATABASE ${DATABASE} TO PUBLIC`);
  await admin.query(`GRANT CONNECT ON DATABASE ${DATABASE} TO ${MAKER}`);
  // A sign-in store of its own, closed to PUBLIC as each pursuit's is: no login of the pursuit's reaches it.
  await admin.query('CREATE DATABASE p_sign_ins');
  await admin.query('REVOKE ALL ON DATABASE p_sign_ins FROM PUBLIC');
  await admin.end();
  for (const sql of [
    'CREATE TABLE statements (id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY, source text NOT NULL, told text, place text, meaning text, at timestamptz, key text, after jsonb)',
    'CREATE TABLE mention_rules (source text, place text, path text NOT NULL, role text NOT NULL, scheme text NOT NULL)',
    'CREATE TABLE mentions (statement bigint NOT NULL, role text NOT NULL, scheme text NOT NULL, value text NOT NULL, PRIMARY KEY (statement, role, scheme, value))',
    // The trigger runs as whoever adds the statement: it reads the rules and adds mentions, so the writer needs both rights.
    "CREATE FUNCTION mention_what_rules_find() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN INSERT INTO mentions (statement, role, scheme, value) SELECT NEW.id, r.role, r.scheme, v #>> '{}' FROM mention_rules r CROSS JOIN LATERAL jsonb_path_query(NEW.after, r.path::jsonpath) v WHERE (r.source IS NULL OR r.source = NEW.source) ON CONFLICT DO NOTHING; RETURN NULL; END $$",
    'CREATE TRIGGER mention_what_rules_find AFTER INSERT ON statements FOR EACH ROW EXECUTE FUNCTION mention_what_rules_find()',
    "INSERT INTO mention_rules VALUES ('site-form', NULL, '$.email', 'person', 'email')",
    'CREATE TABLE offers (id text PRIMARY KEY, price_options jsonb)',
    "INSERT INTO offers VALUES ('offer:one', '[]'), ('offer:two', '[]')",
    'CREATE TABLE price_views (offer_id text NOT NULL, day date NOT NULL, views integer NOT NULL DEFAULT 0, PRIMARY KEY (offer_id, day))',
    'CREATE TABLE welcome_series_stops (email text NOT NULL, token text NOT NULL, stopped_at timestamptz)',
    "INSERT INTO welcome_series_stops VALUES ('made.up@example.test', 'made-up-token', NULL)",
    // The owner's stand-in for a read the writer must not hold: it matches the token, and only the writer may call it.
    'CREATE FUNCTION stop_welcome_series(token text) RETURNS boolean LANGUAGE sql SECURITY DEFINER SET search_path = public, pg_temp AS $$ WITH s AS (UPDATE welcome_series_stops SET stopped_at = coalesce(stopped_at, now()) WHERE welcome_series_stops.token = $1 AND $1 <> \'\' RETURNING 1) SELECT EXISTS (SELECT 1 FROM s) $$',
    'REVOKE EXECUTE ON FUNCTION stop_welcome_series(text) FROM PUBLIC',
    'CREATE TABLE form_rows (id text PRIMARY KEY, type text NOT NULL, value jsonb NOT NULL, kept_at timestamptz NOT NULL DEFAULT now())',
    'CREATE TABLE bookings (id text PRIMARY KEY, booker_email text NOT NULL, made_at timestamptz NOT NULL, status text)',
    'CREATE TABLE subscribers (email text PRIMARY KEY)',
  ]) await runSql({ connection: owner, input: { sql } });
  // The reader recipe makes the use binding and keeps the key; the writer recipe needs it.
  await runSql({ connection: maker, roleConnection: reader, input: { recipe: { name: 'a-login', action: 'create' } } });
  await runSql({ connection: owner, heldValue: KEY, input: { recipe: { name: 'may-read-under-row-rules', action: 'create', role: READER, tables: ['public.offers'] } } });
  await runSql({ connection: maker, roleConnection: writer, input: { recipe: { name: 'a-login', action: 'create' } } });
  await runSql({ connection: owner, input: { recipe: { name: 'may-write-named-columns-under-a-use', action: 'create', role: WRITER, writes: WRITES } } });
});

after(async () => { await server.stop(); });

test('the writer adds a statement through its trigger, with no right on the identity\'s sequence and none to read the row back', async () => {
  const made = await one("INSERT INTO statements (source, told, place, meaning, at, key, after) VALUES ('site-form', 'site-form:lead:k1', 'site-form', 'lead', now(), 'k1', '{\"email\": \"made.up@example.test\"}')");
  assert.equal(made.row_count, 1);
  const kept = await runSql({ connection: owner, input: { sql: "SELECT s.key, m.value FROM statements s JOIN mentions m ON m.statement = s.id WHERE s.key = 'k1'" } });
  assert.deepEqual(kept.rows, [{ key: 'k1', value: 'made.up@example.test' }]);
  await assert.rejects(one("INSERT INTO statements (source, key) VALUES ('site-form', 'k2') RETURNING id"), /permission denied for table statements/);
  await assert.rejects(one('SELECT count(*) FROM statements'), /permission denied for table statements/);
  await assert.rejects(one("INSERT INTO statements (source, told, place, meaning, at, key, after, id) OVERRIDING SYSTEM VALUE VALUES ('x', 'x', 'x', 'x', now(), 'k3', '{}', 9)"), /permission denied/);
});

test('a price view is counted with its upsert, from offers it may read only by id', async () => {
  const sql = "INSERT INTO price_views (offer_id, day, views) SELECT id, current_date, 1 FROM offers WHERE id = ANY($1::text[]) ON CONFLICT (offer_id, day) DO UPDATE SET views = price_views.views + 1";
  for (let n = 0; n < 2; n += 1) await step(query => query(sql, [['offer:one', 'offer:none']]));
  const counted = await runSql({ connection: owner, input: { sql: "SELECT offer_id, views FROM price_views" } });
  assert.deepEqual(counted.rows, [{ offer_id: 'offer:one', views: 2 }]);
  await assert.rejects(one('SELECT price_options FROM offers'), /permission denied for table offers/);
});

test('the welcome stop goes through the owner\'s function: the writer can never list a token', async () => {
  assert.deepEqual((await one("SELECT public.stop_welcome_series('made-up-token') AS matched")).rows, [{ matched: true }]);
  assert.deepEqual((await one("SELECT public.stop_welcome_series('no-such-token') AS matched")).rows, [{ matched: false }]);
  await assert.rejects(one('SELECT token FROM welcome_series_stops'), /permission denied for table welcome_series_stops/);
  await assert.rejects(runSql({ connection: reader, ticket: ticketOf(publish), input: { database: DATABASE, use: publish, sql: "SELECT public.stop_welcome_series('made-up-token')" } }), /permission denied for function stop_welcome_series/);
});

test('a step\'s reads and writes are one transaction claimed once: a refusal keeps nothing of it', async () => {
  const claimed = await step(async query => {
    await query("INSERT INTO form_rows (id, type, value) VALUES ('form-sitting:s1', 'form-sitting', '{}')");
    await query("UPDATE form_rows SET value = value || '{\"lastStep\": \"q1\"}', kept_at = now() WHERE id = 'form-sitting:s1'");
    return (await query('SELECT use_binding.run_purpose() AS purpose, (SELECT count(*)::int FROM form_rows) AS rows')).rows[0];
  });
  assert.deepEqual(claimed, { purpose: 'publish', rows: 1 });
  await assert.rejects(step(async query => {
    await query("INSERT INTO form_rows (id, type, value) VALUES ('answer-fact:a1', 'answer-fact', '{}')");
    await query("INSERT INTO bookings (id, booker_email, made_at, status) VALUES ('b1', 'made.up@example.test', now(), 'booked')");
  }), /permission denied for table bookings/);
  const left = await runSql({ connection: owner, input: { sql: "SELECT id FROM form_rows ORDER BY id" } });
  assert.deepEqual(left.rows, [{ id: 'form-sitting:s1' }], 'the answer fact before the refused write was not kept');
  await one("INSERT INTO bookings (id, booker_email, made_at) VALUES ('b1', 'made.up@example.test', now())");
  assert.equal((await one("DELETE FROM form_rows WHERE id = 'form-sitting:s1'")).row_count, 1);
  await assert.rejects(one("DELETE FROM bookings WHERE id = 'b1'"), /permission denied for table bookings/);
});

test('a form or booking step\'s store writes as the writer: its one statement of parts needs no read of the rows it adds', async () => {
  await step(async query => {
    const store = sqlStore({ execute: async (sql, params = []) => (await query(sql, params)).rows });
    await store.apply([
      { kind: 'insert', id: 'form-sitting:s2', type: 'form-sitting', value: { lastStep: 'email' } },
      { kind: 'sql', sql: "INSERT INTO bookings (id, booker_email, made_at) VALUES ($1, $2, now())", params: ['b2', 'made.up@example.test'] },
    ]);
    await store.apply([{ kind: 'merge', id: 'form-sitting:s2', changes: { lastStep: 'slot' } }, { kind: 'delete_many', ids: ['form-sitting:none'] }]);
    assert.deepEqual(await store.value('form-sitting:s2', 'form-sitting'), { lastStep: 'slot' });
  });
  const kept = await runSql({ connection: owner, input: { sql: "SELECT (SELECT count(*)::int FROM bookings WHERE id = 'b2') AS bookings, (SELECT value->>'lastStep' FROM form_rows WHERE id = 'form-sitting:s2') AS last" } });
  assert.deepEqual(kept.rows, [{ bookings: 1, last: 'slot' }]);
});

test('the writer reaches nothing else: no other table, no table of its own, no other database, no use binding secret', async () => {
  for (const [sql, refused] of [
    ["INSERT INTO subscribers VALUES ('made.up@example.test')", /permission denied for table subscribers/],
    ['SELECT * FROM subscribers', /permission denied for table subscribers/],
    ['CREATE TABLE mine (a int)', /permission denied for schema public/],
    ['CREATE TEMP TABLE mine (a int)', /permission denied to create temporary tables/],
    ['SELECT * FROM use_binding.ticket_keys', /permission denied for table ticket_keys/],
    ['DROP TABLE form_rows', /must be owner of table form_rows/],
    ['ALTER TABLE statements DISABLE TRIGGER mention_what_rules_find', /must be owner of table statements/],
  ]) await assert.rejects(one(sql), refused, sql);
  const other = new pg.Client({ connectionString: `postgres://${WRITER}:${WRITER_PW}@127.0.0.1:${PORT}/p_sign_ins` });
  await assert.rejects(other.connect(), /permission denied for database "p_sign_ins"|not have CONNECT privilege/);
});

test('a writes entry is refused unless it names known rights on a schema.table, or one function the database has', async () => {
  const create = writes => runSql({ connection: owner, input: { recipe: { name: 'may-write-named-columns-under-a-use', action: 'create', role: WRITER, writes } } });
  await assert.rejects(runSql({ connection: owner, input: { recipe: { name: 'may-write-named-columns-under-a-use', action: 'create', role: WRITER } } }), /give writes/);
  await assert.rejects(create([{ table: 'form_rows', select: ['id'] }]), /schema.table/);
  await assert.rejects(create([{ table: 'public.form_rows', truncate: true }]), /names truncate/);
  await assert.rejects(create([{ table: 'public.form_rows' }]), /names no right/);
  await assert.rejects(create([{ table: 'use_binding.claims', select: ['nonce'] }]), /use_binding/);
  await assert.rejects(create([{ function: 'public.no_such_function(text)' }]), /no function public.no_such_function/);
  await assert.rejects(runSql({ connection: owner, input: { recipe: { name: 'may-read-under-row-rules', action: 'create', role: READER, writes: WRITES } } }), /grants per write/);
});

test('the drop takes every right the writes named back and leaves the login', async () => {
  await runSql({ connection: owner, input: { recipe: { name: 'may-write-named-columns-under-a-use', action: 'drop', role: WRITER, writes: WRITES } } });
  const rights = await runSql({ connection: owner, input: { sql: "SELECT count(*)::int AS n FROM information_schema.role_table_grants WHERE grantee = $1", params: [WRITER] } });
  assert.equal(rights.rows[0].n, 0);
  const columns = await runSql({ connection: owner, input: { sql: "SELECT count(*)::int AS n FROM information_schema.role_column_grants WHERE grantee = $1", params: [WRITER] } });
  assert.equal(columns.rows[0].n, 0);
  const calls = await runSql({ connection: owner, input: { sql: "SELECT has_function_privilege($1, 'public.stop_welcome_series(text)', 'EXECUTE') AS may", params: [WRITER] } });
  assert.equal(calls.rows[0].may, false);
  const client = new pg.Client({ connectionString: writer });
  await assert.rejects(client.connect(), /permission denied for database|not have CONNECT privilege/);
});
