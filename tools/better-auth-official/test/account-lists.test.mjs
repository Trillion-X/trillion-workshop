// tools/better-auth-official/test/account-lists.test.mjs
//
// The /account page lists where the person is signed in, their keys for scripts and AIs, and lets them sign another browser out and turn a key
// off. These run the same Better Auth endpoints the page calls, on the embedded Postgres store: two real sign-ins make two sessions, one is
// revoked from the other, and the list reads back without it (and the revoked token no longer signs anyone in). A key is made, listed, turned
// off and listed again. A passkey cannot be made without a browser authenticator, so its removal is only checked for a made-up id.
import { tempFolder } from '../../../test-helpers/temp-folder.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startStore } from '../test-fixtures/embedded-store.mjs';

const dir = tempFolder(join(tmpdir(), 'account-lists-'));
const shipped = JSON.parse(readFileSync(new URL('../settings.json', import.meta.url), 'utf8'));
const settings = { ...shipped, email_password: { require_verification: false }, disabled_paths: [], rate_limit: { ...shipped.rate_limit, enabled: false } };
writeFileSync(join(dir, 'settings.json'), JSON.stringify(settings));
process.env.BETTER_AUTH_SETTINGS = join(dir, 'settings.json');
const store = await startStore();
process.env.BETTER_AUTH_STORE_CONNECTION = await store.database();
process.env.BETTER_AUTH_SECRET = 'a-scratch-secret-for-this-test-only-0123456789';
const { auth, pool } = await import('../auth.mjs');
store.hold(pool);
test.after(() => store.stop());
const { getMigrations } = await import('better-auth/db/migration');
await (await getMigrations(auth.options)).runMigrations();

const ORIGIN = settings.base_url;
const API = `${ORIGIN}${settings.base_path}`;
const PASSWORD = 'scratch-password-123';
const call = (path, { method = 'GET', body, token } = {}) => auth.handler(new Request(`${API}${path}`, {
  method, headers: { 'content-type': 'application/json', origin: ORIGIN, ...(token ? { authorization: `Bearer ${token}` } : {}) },
  body: body === undefined ? undefined : JSON.stringify(body),
}));
// The bearer token is the session's raw token and a signature; the list names the raw token, so the test compares those.
const signIn = async email => (await call('/sign-in/email', { method: 'POST', body: { email, password: PASSWORD } })).headers.get('set-auth-token');
const raw = bearer => bearer.split('.')[0];

const EMAIL = 'lists@example.test';
assert.equal((await call('/sign-up/email', { method: 'POST', body: { email: EMAIL, password: PASSWORD, name: 'Scratch' } })).status, 200);

test('two sign-ins are two sessions; the list shows both; signing one out removes it and it no longer signs anyone in', async () => {
  const here = await signIn(EMAIL);
  const there = await signIn(EMAIL);
  assert.ok(here && there && raw(here) !== raw(there), 'each sign-in is its own session');

  const before = await (await call('/list-sessions', { token: here })).json();
  const tokens = before.map(found => found.token);
  assert.ok(tokens.includes(raw(here)) && tokens.includes(raw(there)), 'the list shows both sessions, this one and the other');

  const revoked = await call('/revoke-session', { method: 'POST', body: { token: raw(there) }, token: here });
  assert.equal(revoked.status, 200, await revoked.clone().text());

  const after = await (await call('/list-sessions', { token: here })).json();
  assert.ok(after.some(found => found.token === raw(here)), 'this session is still listed');
  assert.ok(!after.some(found => found.token === raw(there)), 'the signed-out session is gone from the list');

  const gone = await call('/get-session', { token: there });
  assert.equal((await gone.json())?.session ?? null, null, 'the signed-out token no longer signs anyone in');
  const stillIn = await (await call('/get-session', { token: here })).json();
  assert.equal(stillIn?.user?.email, EMAIL, 'this session is unaffected');
});

test('a key is made, listed, turned off and then listed without it', async () => {
  const token = await signIn(EMAIL);
  const made = await call('/api-key/create', { method: 'POST', body: { name: 'a script' }, token });
  assert.equal(made.status, 200, await made.clone().text());
  const key = await made.json();
  const listed = await (await call('/api-key/list', { token })).json();
  assert.ok(listed.apiKeys.some(found => found.id === key.id && found.name === 'a script'), 'the key is listed by its name');

  const off = await call('/api-key/delete', { method: 'POST', body: { keyId: key.id }, token });
  assert.equal(off.status, 200, await off.clone().text());
  const after = await (await call('/api-key/list', { token })).json();
  assert.ok(!after.apiKeys.some(found => found.id === key.id), 'the turned-off key is no longer listed');
});

test('a passkey id that is not the person\'s is refused by the removal', async () => {
  const token = await signIn(EMAIL);
  const refused = await call('/passkey/delete-passkey', { method: 'POST', body: { id: 'not-a-passkey-of-this-person' }, token });
  assert.notEqual(refused.status, 200, 'an id that is no passkey of this person is not removed');
});
