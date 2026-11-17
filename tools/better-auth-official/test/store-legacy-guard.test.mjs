// tools/better-auth-official/test/store-legacy-guard.test.mjs
//
// While settings.json store.migrate_from names an old SQLite file that holds users, the server refuses to listen on a store that holds
// none (exit non-zero, naming the file, no values); migrate-sqlite-to-postgres.mjs with no argument moves that file; then the
// server starts. With migrate_from null, or the file absent or empty, an empty store starts as before.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, writeFileSync, readFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startStore } from '../test-fixtures/embedded-store.mjs';

const tool = new URL('..', import.meta.url).pathname;
const shipped = JSON.parse(readFileSync(new URL('../settings.json', import.meta.url), 'utf8'));
const rows = JSON.parse(readFileSync(new URL('../test-fixtures/sqlite-rows.json', import.meta.url), 'utf8'));
const dir = mkdtempSync(join(tmpdir(), 'legacy-guard-'));
const freePort = () => new Promise(done => { const s = createServer().listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => done(port)); }); });
const legacy = join(dir, 'better-auth.db');
const old = new DatabaseSync(legacy);
old.exec(readFileSync(new URL('../test-fixtures/sqlite-schema.sql', import.meta.url), 'utf8'));
for (const row of rows.user) {
  const columns = Object.keys(row);
  old.prepare(`insert into "user" (${columns.map(c => `"${c}"`).join(', ')}) values (${columns.map(() => '?').join(', ')})`).run(...columns.map(c => row[c]));
}
old.close();

const store = await startStore();
const connection = await store.database();
test.after(() => store.stop());

async function environment(migrateFrom) {
  const port = await freePort();
  const home = `http://localhost:${port}`;
  const settings = { ...shipped, port, base_url: home, issuer: home, audience: home, trusted_origins: [home], internal: { ...shipped.internal, port: await freePort() },
    store: { ...shipped.store, migrate_from: migrateFrom } };
  const file = join(dir, `settings-${port}.json`);
  writeFileSync(file, JSON.stringify(settings));
  return { ...process.env, BETTER_AUTH_SETTINGS: file, BETTER_AUTH_SECRET: 'a-scratch-secret-for-this-test-only-0123456789', [shipped.store.env]: connection };
}
const runServer = env => new Promise(done => {
  const child = spawn(process.execPath, [join(tool, 'server.mjs')], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  let err = '';
  child.stderr.on('data', chunk => { err += chunk; });
  child.stdout.on('data', chunk => { if (/better-auth internal/.test(String(chunk))) { child.kill(); done({ listening: true, err }); } });
  child.on('exit', code => done({ listening: false, code, err }));
});

test('an empty store with a waiting file that holds users: the server refuses to listen, names the file, prints no value', async () => {
  const answer = await runServer(await environment(legacy));
  assert.equal(answer.listening, false);
  assert.notEqual(answer.code, 0);
  assert.ok(answer.err.includes(legacy));
  assert.ok(!answer.err.includes(rows.user[0].email));
});

test('with no file argument the migration moves the file migrate_from names, and then the server listens', async () => {
  const moved = spawnSync(process.execPath, [join(tool, 'migrate-sqlite-to-postgres.mjs')], { env: await environment(legacy), encoding: 'utf8' });
  assert.equal(moved.status, 0, moved.stderr);
  assert.equal((await runServer(await environment(legacy))).listening, true);
});

test('migrate_from null, or a file that is absent, starts an empty store as before', async () => {
  const empty = await store.database();
  for (const migrateFrom of [null, join(dir, 'gone.db')]) {
    assert.equal((await runServer({ ...(await environment(migrateFrom)), [shipped.store.env]: empty })).listening, true);
  }
});
