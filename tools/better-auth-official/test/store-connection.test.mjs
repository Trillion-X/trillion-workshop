// tools/better-auth-official/test/store-connection.test.mjs
//
// The store's connection comes only from the environment variable settings.json store.env names, handed over under the credential
// store.credential names; with none, the tool refuses to start and says which credential is missing, and never reads a vault.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { storePool } from '../store.mjs';

const settings = JSON.parse(readFileSync(new URL('../settings.json', import.meta.url), 'utf8'));

test('no connection in the environment is refused, naming the credential', () => {
  assert.throws(() => storePool(settings, {}), error => error.message.includes(settings.store.credential) && error.message.includes(settings.store.env));
});

test('the connection in the named variable is the one used, with the pool size the settings give', async () => {
  const pool = storePool(settings, { [settings.store.env]: 'postgres://example:example@127.0.0.1:1/example' });
  assert.equal(pool.options.connectionString, 'postgres://example:example@127.0.0.1:1/example');
  assert.equal(pool.options.max, settings.store.pool_size);
  await pool.end();
});
