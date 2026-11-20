// tools/better-auth-official/test/store-connection.test.mjs
//
// The store's connection comes only from the environment variable settings.json store.env names, handed over under the credential
// store.credential names; with none, the tool refuses to start and says which credential is missing, and never reads a vault. The
// driver is the one settings.json store names, so another store is a settings change: the same server signs a person up into a
// node:sqlite file with no code changed.
import { tempFolder } from '../../../test-helpers/temp-folder.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { closeStore, storeDriver } from '../store.mjs';
import { startStandInSender } from '../test-fixtures/stand-in-sender.mjs';

const settings = JSON.parse(readFileSync(new URL('../settings.json', import.meta.url), 'utf8'));
const tool = new URL('..', import.meta.url).pathname;
const freePort = () => new Promise(done => { const s = createServer().listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => done(port)); }); });

test('no connection in the environment is refused, naming the credential', async () => {
  await assert.rejects(storeDriver(settings, {}), error => error.message.includes(settings.store.credential) && error.message.includes(settings.store.env));
});

test('the driver is the one the settings name, made with the connection from the named variable', async () => {
  const pool = await storeDriver(settings, { [settings.store.env]: 'postgres://example:example@127.0.0.1:1/example' });
  assert.equal(pool.options.connectionString, 'postgres://example:example@127.0.0.1:1/example');
  assert.equal(pool.options.max, settings.store.arguments[0].max);
  await closeStore(settings, pool);
  await assert.rejects(storeDriver({ store: { ...settings.store, export: 'Nothing' } }, { [settings.store.env]: 'x' }), /exports no Nothing/);
});

test('another store is a settings change: the server signs a person up into a node:sqlite file', async () => {
  const dir = tempFolder(join(tmpdir(), 'sqlite-store-'));
  const file = join(dir, 'sign-in.db');
  const [home, port, internal] = [await freePort(), await freePort(), await freePort()];
  const sender = await startStandInSender();
  const store = { ...settings.store, module: 'node:sqlite', export: 'DatabaseSync', arguments: ['{connection}'], close: 'close', migration_lock: null };
  const given = {
    ...settings, store, port, internal: { ...settings.internal, port: internal }, email: sender.email,
    base_url: `http://localhost:${home}`, issuer: `http://localhost:${home}`, audience: `http://localhost:${home}`, trusted_origins: [`http://localhost:${home}`],
    email_password: { require_verification: false }, disabled_paths: [], rate_limit: { enabled: false },
  };
  writeFileSync(join(dir, 'settings.json'), JSON.stringify(given));
  const env = { ...process.env, BETTER_AUTH_SETTINGS: join(dir, 'settings.json'), BETTER_AUTH_SECRET: 'a-scratch-secret-for-this-test-only-0123456789', CREDENTIALS_DIRECTORY: sender.credentials, [store.env]: file };
  const child = spawn(process.execPath, [join(tool, 'server.mjs')], { env, stdio: ['ignore', 'pipe', 'inherit'] });
  try {
    await new Promise((done, fail) => {
      const timer = setTimeout(() => fail(new Error('the server did not listen')), 60000);
      child.stdout.on('data', chunk => { if (/better-auth internal/.test(String(chunk))) { clearTimeout(timer); done(); } });
      child.on('exit', code => fail(new Error(`the server exited ${code}`)));
    });
    const answer = await fetch(`http://127.0.0.1:${port}${given.base_path}/sign-up/email`, {
      method: 'POST', headers: { origin: given.base_url, 'content-type': 'application/json' },
      body: JSON.stringify({ email: 'person@example.com', password: 'a-long-enough-password-1', name: 'Example Person', firstName: 'Example', lastName: 'Person' }),
    });
    assert.equal(answer.status, 200, await answer.text());
    const db = new DatabaseSync(file, { readOnly: true });
    try { assert.deepEqual(db.prepare('select email from "user"').all().map(row => row.email), ['person@example.com']); } finally { db.close(); }
  } finally {
    child.kill();
    sender.stop();
  }
});
