// tools/use-your-tools-from-a-shell/test/command-connection-says-the-held-credential.test.mjs
//
// `connection` says the credential this command holds. Signed in by `login`, it names the sign-in and offers no recipe
// that sends a key: the pass is held and renewed only by this command, so a bridge told to send a key would carry one the
// engine never gave it. Holding a key, it names the key and offers every recipe.
import assert from 'node:assert/strict';
import test from 'node:test';
import { connectionOf } from '../do-work/command.mjs';
import settings from '../do-work/command.json' with { type: 'json' };

const store = { where: 'the Keychain item example-key' };
const sendsKey = (row) => row.template?.includes('{key_env}');

test('signed in, the connection names the sign-in and offers no recipe that sends a key', () => {
  const made = connectionOf({ origin: 'https://door.example', store, credential: { kind: 'sign-in', where: 'the Keychain item example-grant' } });
  assert.deepEqual(made.key_source, { kind: 'sign-in', where: 'the Keychain item example-grant' });
  const keyRecipes = settings.connection.recipes.filter(sendsKey).map((row) => row.id);
  assert.ok(keyRecipes.length > 0, 'the settings do offer a recipe that sends a key');
  assert.ok(made.recipes.every((row) => !keyRecipes.includes(row.id)), JSON.stringify(made.recipes));
  assert.equal(made.recipes.length, settings.connection.recipes.length - keyRecipes.length, 'every other recipe stays');
});

test('holding a key, the connection names where the key lives and offers every recipe', () => {
  const made = connectionOf({ origin: 'https://door.example', store, credential: { kind: 'key', where: store.where } });
  assert.equal(made.key_source.kind, 'key');
  assert.equal(made.key_source.where, store.where);
  assert.equal(made.recipes.length, settings.connection.recipes.length);
  assert.ok(!JSON.stringify(made).includes('Bearer ey'), 'never a credential');
});
