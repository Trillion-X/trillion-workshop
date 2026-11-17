// tools/better-auth-official/test/store-migration.test.mjs
//
// migrate-sqlite-to-postgres.mjs moves the old SQLite file's rows into the shared store: a fixture file in the old format (the old
// schema, rows as the old build wrote them: booleans as 0 and 1, dates as ISO text, JSON as text; test-fixtures/sqlite-rows.json) is
// copied, every table keeps its rows and ids, the jwks keys come out byte for byte, the person signs in with the password they set, and
// a second run on a store that holds a user refuses and changes nothing.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import pg from 'pg';
import { startStore } from '../test-fixtures/embedded-store.mjs';
import { startTwoProcesses } from '../test-fixtures/two-processes.mjs';

const tool = new URL('..', import.meta.url).pathname;
const rows = JSON.parse(readFileSync(new URL('../test-fixtures/sqlite-rows.json', import.meta.url), 'utf8'));
const dir = mkdtempSync(join(tmpdir(), 'store-migration-'));
const file = join(dir, 'better-auth.db');
const old = new DatabaseSync(file);
old.exec(readFileSync(new URL('../test-fixtures/sqlite-schema.sql', import.meta.url), 'utf8'));
for (const [table, tableRows] of Object.entries(rows)) {
  for (const row of tableRows) {
    const columns = Object.keys(row);
    old.prepare(`insert into "${table}" (${columns.map(c => `"${c}"`).join(', ')}) values (${columns.map(() => '?').join(', ')})`).run(...columns.map(c => row[c]));
  }
}
old.close();

const store = await startStore();
const connection = await store.database();
const sql = new pg.Pool({ connectionString: connection });
let pair;
test.after(async () => { pair?.stop(); await sql.end(); await store.stop(); });
const shipped = JSON.parse(readFileSync(new URL('../settings.json', import.meta.url), 'utf8'));
const migrate = () => spawnSync(process.execPath, [join(tool, 'migrate-sqlite-to-postgres.mjs'), file], {
  env: { ...process.env, BETTER_AUTH_SECRET: 'a-scratch-secret-for-this-test-only-0123456789', [shipped.store.env]: connection }, encoding: 'utf8',
});

test('every table keeps its rows and ids, jwks keys byte for byte, and booleans, dates and JSON arrive as the store\'s types', async () => {
  const done = migrate();
  assert.equal(done.status, 0, done.stderr);
  for (const [table, tableRows] of Object.entries(rows)) {
    const stored = (await sql.query(`select * from "${table}" order by id`)).rows;
    assert.deepEqual(stored.map(row => row.id), tableRows.map(row => row.id).sort(), `${table} ids`);
  }
  const keys = (await sql.query('select id, "privateKey", "publicKey" from jwks order by id')).rows;
  for (const key of keys) {
    const source = rows.jwks.find(row => row.id === key.id);
    assert.ok(Buffer.from(key.privateKey).equals(Buffer.from(source.privateKey)), `${key.id} private key`);
    assert.ok(Buffer.from(key.publicKey).equals(Buffer.from(source.publicKey)), `${key.id} public key`);
  }
  const person = (await sql.query('select "emailVerified", banned, "createdAt" from "user"')).rows[0];
  assert.equal(person.emailVerified, false);
  assert.equal(person.createdAt.toISOString(), rows.user[0].createdAt);
  assert.deepEqual((await sql.query('select scopes from "oauthRefreshToken"')).rows[0].scopes, ['records', 'offline_access']);
  assert.equal((await sql.query('select "backedUp" from passkey')).rows[0].backedUp, true);
});

test('the person signs in with the password they set before the move, and the moved keys are the ones served', async () => {
  pair = await startTwoProcesses(connection);
  const signedIn = await pair.call(pair.b, '/sign-in/email', { body: { email: rows.user[0].email, password: 'scratch-password-123' } });
  assert.equal(signedIn.status, 200, await signedIn.clone().text());
  assert.equal((await signedIn.json()).user.id, rows.user[0].id);
  const served = (await (await pair.call(pair.a, '/jwks')).json()).keys.map(key => key.kid);
  for (const key of rows.jwks) assert.ok(served.includes(key.id), `${key.id} is served`);
});

test('a store that already holds a user is refused and changes nothing', async () => {
  const before = (await sql.query('select count(*)::int as n from jwks')).rows[0].n;
  const done = migrate();
  assert.notEqual(done.status, 0);
  assert.match(done.stderr, /already holds a user/);
  assert.equal((await sql.query('select count(*)::int as n from jwks')).rows[0].n, before);
});
