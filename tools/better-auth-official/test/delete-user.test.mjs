// tools/better-auth-official/test/delete-user.test.mjs
//
// A signed-in person deletes their own user only while settings.json delete_user.enabled is true (Better Auth's
// user.deleteUser). Off, as shipped, POST /delete-user answers 404 and the user stays. Turned on, the same person with their
// password deletes their own user and every other user stays; a wrong password deletes nothing. The second start reads the new
// settings into a fresh copy of auth.mjs over the same database, as a computer restarted from its changed layout row does.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const dir = mkdtempSync(join(tmpdir(), 'delete-user-'));
const shipped = JSON.parse(readFileSync(new URL('../settings.json', import.meta.url), 'utf8'));
const settings = { ...shipped, database_path: 'auth.db', email_password: { require_verification: false }, disabled_paths: [], email: { outbox: 'outbox.jsonl', command: null } };
const settingsFile = join(dir, 'settings.json');
writeFileSync(settingsFile, JSON.stringify(settings));
process.env.BETTER_AUTH_SETTINGS = settingsFile;
process.env.BETTER_AUTH_SECRET = 'a-scratch-secret-for-this-test-only-0123456789';
const { auth: off } = await import('../auth.mjs');
const { getMigrations } = await import('better-auth/db/migration');
await (await getMigrations(off.options)).runMigrations();

const ORIGIN = settings.base_url;
const PASSWORD = 'scratch-password-123';
const post = (auth, path, body, token) => auth.handler(new Request(`${ORIGIN}${settings.base_path}${path}`, {
  method: 'POST',
  headers: { origin: ORIGIN, 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
  body: JSON.stringify(body),
}));
const signUp = async (auth, email) => (await (await post(auth, '/sign-up/email', { email, password: PASSWORD, name: 'Scratch' })).json()).user;
const signIn = async (auth, email) => (await post(auth, '/sign-in/email', { email, password: PASSWORD })).headers.get('set-auth-token');
const userOf = async (auth, email) => (await (await auth.$context).internalAdapter.findUserByEmail(email))?.user ?? null;

await signUp(off, 'leaving@example.test');
await signUp(off, 'stays@example.test');

test('as shipped, deleting one\'s own user answers 404 and the user stays', async () => {
  assert.equal(shipped.delete_user.enabled, false);
  const token = await signIn(off, 'leaving@example.test');
  assert.equal((await post(off, '/delete-user', { password: PASSWORD }, token)).status, 404);
  assert.ok(await userOf(off, 'leaving@example.test'));
});

test('turned on, a person deletes their own user with their password and no other user', async () => {
  writeFileSync(settingsFile, JSON.stringify({ ...settings, delete_user: { enabled: true } }));
  const { auth: on } = await import('../auth.mjs?delete-user-on');
  const token = await signIn(on, 'leaving@example.test');
  assert.equal((await post(on, '/delete-user', { password: 'not-the-password-1' }, token)).status, 400);
  assert.ok(await userOf(on, 'leaving@example.test'));
  const deleted = await post(on, '/delete-user', { password: PASSWORD }, token);
  assert.equal(deleted.status, 200);
  assert.equal((await deleted.json()).success, true);
  assert.equal(await userOf(on, 'leaving@example.test'), null);
  assert.ok(await userOf(on, 'stays@example.test'));
});
