// tools/better-auth-official/test/oauth-rate-limit.test.mjs
//
// The token and authorize paths are limited per client address with the numbers settings.json names under rate_limit.oauth, in the
// OAuth provider plugin's own rateLimit shape (auth.mjs passes them through). A small max proves the numbers are the ones enforced:
// the call past max from one address is refused 429, and another address is counted on its own.
import { tempFolder } from '../../../test-helpers/temp-folder.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startStore } from '../test-fixtures/embedded-store.mjs';

const shipped = JSON.parse(readFileSync(new URL('../settings.json', import.meta.url), 'utf8'));
process.env.BETTER_AUTH_SECRET = 'a-scratch-secret-for-this-test-only-0123456789';
const { getMigrations } = await import('better-auth/db/migration');
const store = await startStore();
test.after(() => store.stop());
let made = 0;

// A scratch Better Auth on the shipped settings with only rate_limit.oauth changed.
async function scratch(oauth) {
  const dir = tempFolder(join(tmpdir(), 'oauth-rate-limit-'));
  const settings = { ...shipped, disabled_paths: [], email_password: { require_verification: false }, rate_limit: { ...shipped.rate_limit, oauth } };
  writeFileSync(join(dir, 'settings.json'), JSON.stringify(settings));
  process.env.BETTER_AUTH_SETTINGS = join(dir, 'settings.json');
  process.env.BETTER_AUTH_STORE_CONNECTION = await store.database();
  const { auth, pool } = await import(`../auth.mjs?oauth-rate-limit-${made++}`);
  store.hold(pool);
  await (await getMigrations(auth.options)).runMigrations();
  const origin = settings.base_url;
  const call = (path, from) => auth.handler(new Request(`${origin}${settings.base_path}${path}`, {
    method: 'POST', headers: { origin, 'content-type': 'application/json', 'x-forwarded-for': from }, body: '{}',
  }));
  return { auth, call };
}

test('the token and authorize numbers in settings reach the plugin, and a call past max from one address is refused 429', async () => {
  const { auth, call } = await scratch({ token: { window: 60, max: 2 }, authorize: { window: 60, max: 3 } });
  const rules = auth.options.plugins.flatMap(plugin => plugin.rateLimit ?? []);
  assert.equal(rules.find(rule => rule.pathMatcher('/oauth2/token')).max, 2, 'the token rule is the one settings names');
  assert.equal(rules.find(rule => rule.pathMatcher('/oauth2/authorize')).max, 3, 'the authorize rule is the one settings names');

  const from = '198.51.100.10';
  const token = [];
  for (let i = 0; i < 3; i++) token.push((await call('/oauth2/token', from)).status);
  assert.notEqual(token[0], 429);
  assert.notEqual(token[1], 429);
  assert.equal(token[2], 429, 'the third token call from one address is refused');

  const other = await call('/oauth2/token', '198.51.100.11');
  assert.notEqual(other.status, 429, 'another address has its own count');

  const authorize = [];
  for (let i = 0; i < 4; i++) authorize.push((await call('/oauth2/authorize?client_id=example&response_type=code', '198.51.100.12')).status);
  assert.deepEqual(authorize.slice(0, 3).filter(status => status === 429), [], 'the first three authorize calls are answered');
  assert.equal(authorize[3], 429, 'the fourth authorize call from one address is refused');
});
