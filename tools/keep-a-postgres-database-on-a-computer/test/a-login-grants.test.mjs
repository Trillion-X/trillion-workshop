// tools/keep-a-postgres-database-on-a-computer/test/a-login-grants.test.mjs
//
// A unit's `grants`: the file prepare writes from run-sql's own recipe plan and a tool's rights file, run on PGlite as psql runs
// it (each `\gexec` answer run), on a words table shaped as a live one: an owner, a login that is a member of the owner (as a
// pursuit's bare-name login is), a reader, and the writer the grants are for. Every name and line is invented.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHmac, randomBytes } from 'node:crypto';
import { PGlite } from '@electric-sql/pglite';
import { pgcrypto } from '@electric-sql/pglite/contrib/pgcrypto';
import { prepare } from '../prepare-a-database-unit.mjs';
import { runSql } from '../../run-sql-in-my-database/do-work/run-sql.mjs';

const RIGHTS = 'tools/gather-words-from-people/read-data/writer-rights.json';
const grants = (extra = {}) => ({ login: 'p_words_writer', database: 'postgres', owner: 'p_words_owner', recipe: 'may-write-named-columns-under-a-use', writes_from: RIGHTS, table_names: { '<words_table>': 'p_words' }, file: '/etc/example-database/words-writer-grants.sql', ...extra });
const unit = { unit: 'p-words-writer-login.service', description: 'Example writer', user: 'postgres', environment: ['PGHOST=/run/postgresql'] };
const fileOf = extra => prepare({ ...unit, grants: [grants(extra)] }).unit.files[0];
const KEY = randomBytes(32).toString('base64url');
const ticket = () => {
  const payload = Buffer.from(JSON.stringify({ nonce: randomBytes(16).toString('hex'), purpose: 'publish', surface: 'site/example.test', until: Date.now() + 60_000 })).toString('hex');
  return `${payload}.${createHmac('sha256', KEY).update(payload).digest('hex')}`;
};

/** Runs a rendered file as psql -v ON_ERROR_STOP=1 does: each query ending in \gexec runs, and each cell it answers runs. */
const runAsPsql = async (db, text) => {
  for (const query of text.split(/ \\gexec\n/).map(each => each.replace(/^--.*\n/gm, '').trim()).filter(Boolean)) {
    const { rows, fields } = await db.query(query);
    for (const row of rows) for (const { name } of fields) if (row[name] !== null) await db.exec(row[name]);
  }
  await db.exec('RESET ROLE');
};

/** A words database as a live one is: rows kept before any writer, an asked row, and the use binding the reader recipe made. */
async function wordsDatabase() {
  const db = new PGlite({ extensions: { pgcrypto } });
  await db.exec(`CREATE ROLE p_words_owner; CREATE ROLE p_words_bare IN ROLE p_words_owner; CREATE ROLE p_words_reader; CREATE ROLE p_words_writer;
    ALTER DATABASE postgres OWNER TO p_words_owner; GRANT ALL ON SCHEMA public TO p_words_owner; SET ROLE p_words_owner;
    CREATE TABLE words_gathering (site text PRIMARY KEY, ask_days int, page_url text, "case" text, came_from text, list jsonb, page jsonb);
    CREATE TABLE p_words (id text PRIMARY KEY, author text, text text, consent_basis text, words_state jsonb NOT NULL DEFAULT '{}', came_from text, created text, changed_at timestamptz, shown boolean NOT NULL DEFAULT false);
    INSERT INTO p_words (id, author, text, shown) VALUES ('kept-1', 'Grace', 'Shown words.', true), ('kept-2', 'Alan', 'Private words.', false);`);
  const connect = async () => ({ query: async ({ text, values }) => { const result = await db.query(text, values); return { fields: result.fields, rows: result.rows, rowCount: result.affectedRows ?? result.rows.length }; }, end: async () => {} });
  await runSql({ connection: 'postgres://p_words_owner@127.0.0.1/postgres', heldValue: KEY, connect, input: { recipe: { name: 'may-read-under-row-rules', action: 'create', role: 'p_words_reader', tables: ['public.p_words'] } } });
  await db.exec('RESET ROLE');
  return db;
}

test('the grants file holds only run-sql\'s plan filled by the server, and runs by psql when it changes', () => {
  const file = fileOf();
  assert.equal(file.path, '/etc/example-database/words-writer-grants.sql');
  assert.deepEqual(file.then, [['runuser', '-u', 'postgres', '--', 'psql', '-X', '-q', '-v', 'ON_ERROR_STOP=1', '-h', '/run/postgresql', '-d', 'postgres', '-f', file.path]]);
  assert.ok(file.text.split('\n').filter(Boolean).slice(1).every(line => line.startsWith('SELECT pg_catalog.format(') || line.startsWith('  ') || line.startsWith('DO $check$')));
  assert.match(file.text, /CREATE POLICY %9\$I ON %11\$I\.%12\$I AS RESTRICTIVE FOR ALL TO %1\$I %13\$s/);
  assert.throws(() => fileOf({ table_names: {} }), /table_names gives no name for its placeholder/);
  assert.throws(() => fileOf({ writes_from: '../../etc/passwd' }), /writes_from names a tool's read-data JSON file/);
  assert.throws(() => fileOf({ recipe: 'a-login' }), /grants-only per-write recipe/);
  assert.throws(() => fileOf({ login: 'Writer; DROP' }), /each a lower-case name/);
  assert.throws(() => prepare({ ...unit, environment: [], grants: [grants()] }), /needs PGHOST/);
});

test('every login that read the words table before reads every row after the writer\'s grants; the writer reaches only its own', async () => {
  const db = await wordsDatabase();
  await db.exec("GRANT SELECT ON p_words TO p_words_reader");
  await runAsPsql(db, fileOf().text);
  await runAsPsql(db, fileOf().text);
  // The owner's own asking makes the asked rows, each with its token's digest.
  const tokenA = randomBytes(32).toString('base64url'), tokenB = randomBytes(32).toString('base64url');
  for (const [id, token] of [['asked-a', tokenA], ['asked-b', tokenB]]) await db.query("INSERT INTO p_words (id, words_state, ask_key_digest) VALUES ($1, '{\"status\": \"asked\"}', encode(sha256(convert_to($2, 'UTF8')), 'hex'))", [id, token]);
  const all = ['asked-a', 'asked-b', 'kept-1', 'kept-2'];
  const ids = async role => { await db.exec(`SET ROLE ${role}`); try { return (await db.query('SELECT id FROM p_words ORDER BY id')).rows.map(row => row.id); } finally { await db.exec('RESET ROLE'); } };
  assert.deepEqual(await ids('p_words_owner'), all, 'the owner');
  assert.deepEqual(await ids('p_words_bare'), all, 'a member of the owner (as the bare-name login is) counts as the owner: no row rule holds it');
  await db.exec('SET ROLE p_words_reader; BEGIN');
  await db.query('SELECT use_binding.claim_use($1)', [ticket()]);
  // The reader is under row rules: rows_as_they_were is what keeps every row in its reads (without it, it reads none).
  assert.deepEqual((await db.query('SELECT id FROM p_words ORDER BY id')).rows.map(row => row.id), all, 'the reader under its use');
  await db.exec('COMMIT; RESET ROLE');
  await db.exec('SET ROLE p_words_bare');
  assert.equal((await db.query("UPDATE p_words SET shown = true WHERE id = 'kept-2'")).affectedRows, 1, 'the bare-name login still changes any row');
  await db.exec("UPDATE p_words SET shown = false WHERE id = 'kept-2'; RESET ROLE");
  // The writer, holding A's token under its claimed use.
  await db.exec('SET ROLE p_words_writer; BEGIN');
  await db.query('SELECT use_binding.claim_use($1)', [ticket()]);
  await db.query('SELECT use_binding.present_key($1)', [tokenA]);
  assert.deepEqual((await db.query('SELECT id FROM p_words ORDER BY id')).rows.map(row => row.id), ['asked-a'], 'it reads only its own row');
  assert.equal((await db.query("UPDATE p_words SET text = 'rewritten' WHERE id = 'asked-b'")).affectedRows, 0, 'another ask\'s row is refused');
  assert.equal((await db.query("UPDATE p_words SET text = 'rewritten' WHERE id = 'kept-1'")).affectedRows, 0, 'a row kept before the writer is refused');
  assert.equal((await db.query(`UPDATE p_words SET text = 'My words.', words_state = '{"status": "received"}' WHERE id = 'asked-a'`)).affectedRows, 1, 'its own row passes');
  for (const [sql, refused] of [
    [`UPDATE p_words SET words_state = '{"status": "approved", "approved_identity": "made-up"}' WHERE id = 'asked-a'`, /row-level security/],
    ["INSERT INTO p_words (id, text) VALUES ('made-up', 'x')", /row-level security|permission denied/],
    ["UPDATE p_words SET shown = true WHERE id = 'asked-a'", /permission denied/],
  ]) {
    await db.exec('SAVEPOINT each');
    await assert.rejects(db.query(sql), refused, sql);
    await db.exec('ROLLBACK TO SAVEPOINT each');
  }
  await db.exec('COMMIT; RESET ROLE');
  const kept = (await db.query('SELECT id, text, words_state, shown FROM p_words ORDER BY id')).rows;
  assert.deepEqual(kept.map(row => [row.id, row.text, row.words_state.approved_identity ?? null, row.shown]), [['asked-a', 'My words.', null, false], ['asked-b', null, null, false], ['kept-1', 'Shown words.', null, true], ['kept-2', 'Private words.', null, false]]);
});

test('a table that already had row rules keeps its own: the writer\'s grants add no rule that opens it to other logins', async () => {
  const db = await wordsDatabase();
  await db.exec("SET ROLE p_words_owner; ALTER TABLE p_words ENABLE ROW LEVEL SECURITY; CREATE POLICY shown_only ON p_words FOR SELECT TO p_words_reader USING (shown); GRANT SELECT ON p_words TO p_words_reader; RESET ROLE");
  await runAsPsql(db, fileOf().text);
  const rules = (await db.query("SELECT polname FROM pg_policy WHERE polrelid = 'p_words'::regclass ORDER BY 1")).rows.map(row => row.polname);
  assert.deepEqual(rules, ['rule_p_words_writer', 'shown_only']);
  await db.exec('SET ROLE p_words_reader');
  assert.deepEqual((await db.query('SELECT id FROM p_words')).rows.map(row => row.id), ['kept-1'], 'the reader still sees only shown rows');
  await db.exec('RESET ROLE');
});

test('the drop file takes the writer\'s rule and rights away and leaves every other login as it was', async () => {
  const db = await wordsDatabase();
  await runAsPsql(db, fileOf().text);
  await runAsPsql(db, fileOf({ action: 'drop' }).text);
  const rules = (await db.query("SELECT polname FROM pg_policy WHERE polrelid = 'p_words'::regclass ORDER BY 1")).rows.map(row => row.polname);
  assert.deepEqual(rules, ['rows_as_they_were']);
  const held = (await db.query("SELECT has_table_privilege('p_words_writer', 'p_words', 'SELECT') OR has_column_privilege('p_words_writer', 'p_words', 'text', 'UPDATE') AS any, has_function_privilege('p_words_writer', 'use_binding.present_key(text)', 'EXECUTE') AS present")).rows[0];
  assert.deepEqual(held, { any: false, present: false });
  await db.exec('SET ROLE p_words_bare');
  assert.equal((await db.query('SELECT count(*)::int AS n FROM p_words')).rows[0].n, 2);
  await db.exec('RESET ROLE');
});
