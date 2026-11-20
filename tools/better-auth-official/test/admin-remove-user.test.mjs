// tools/better-auth-official/test/admin-remove-user.test.mjs
//
// A user is removed only by an admin, and the admins are the user ids settings.json names (admin.user_ids, the admin plugin's
// adminUserIds). A signed-in person the settings do not name is refused and the user stays; once the settings name them, the
// same person removes that user (Better Auth's removeUser) and every other user stays. The second start reads the new settings
// into a fresh copy of auth.mjs over the same database, as a computer restarted from its changed computer row does.
import { tempFolder } from '../../../test-helpers/temp-folder.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startStore } from '../test-fixtures/embedded-store.mjs';

const dir = tempFolder(join(tmpdir(), 'admin-remove-user-'));
const shipped = JSON.parse(readFileSync(new URL('../settings.json', import.meta.url), 'utf8'));
const settings = { ...shipped, email_password: { require_verification: false }, disabled_paths: [] };
const settingsFile = join(dir, 'settings.json');
writeFileSync(settingsFile, JSON.stringify(settings));
process.env.BETTER_AUTH_SETTINGS = settingsFile;
const store = await startStore();
process.env.BETTER_AUTH_STORE_CONNECTION = await store.database();
process.env.BETTER_AUTH_SECRET = 'a-scratch-secret-for-this-test-only-0123456789';
const { auth: unnamed, pool } = await import('../auth.mjs');
store.hold(pool);
test.after(() => store.stop());
const { getMigrations } = await import('better-auth/db/migration');
await (await getMigrations(unnamed.options)).runMigrations();

const ORIGIN = settings.base_url;
const PASSWORD = 'scratch-password-123';
const post = (auth, path, body, token) => auth.handler(new Request(`${ORIGIN}${settings.base_path}${path}`, {
  method: 'POST',
  headers: { origin: ORIGIN, 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
  body: JSON.stringify(body),
}));
const signUp = async (auth, email) => (await (await post(auth, '/sign-up/email', { email, password: PASSWORD, name: 'Scratch' })).json()).user;
// The session token the bearer plugin hands back on sign-in (set-auth-token), sent as Authorization: Bearer.
const signIn = async (auth, email) => (await post(auth, '/sign-in/email', { email, password: PASSWORD })).headers.get('set-auth-token');
const userOf = async (auth, email) => (await (await auth.$context).internalAdapter.findUserByEmail(email))?.user ?? null;

const operator = await signUp(unnamed, 'operator@example.test');
const target = await signUp(unnamed, 'target@example.test');
await signUp(unnamed, 'stays@example.test');

test('no session is refused', async () => {
  assert.equal((await post(unnamed, '/admin/remove-user', { userId: target.id })).status, 401);
  assert.ok(await userOf(unnamed, 'target@example.test'));
});

test('a signed-in person the settings do not name as admin is refused and the user stays', async () => {
  const token = await signIn(unnamed, 'operator@example.test');
  assert.ok(token);
  assert.equal((await post(unnamed, '/admin/remove-user', { userId: target.id }, token)).status, 403);
  assert.ok(await userOf(unnamed, 'target@example.test'));
});

test('an admin the settings name removes the user and no other', async () => {
  writeFileSync(settingsFile, JSON.stringify({ ...settings, admin: { user_ids: [operator.id] } }));
  const { auth: named, pool: namedPool } = await import('../auth.mjs?admin-named');
  store.hold(namedPool);
  const token = await signIn(named, 'operator@example.test');
  const removed = await post(named, '/admin/remove-user', { userId: target.id }, token);
  assert.equal(removed.status, 200);
  assert.deepEqual(await removed.json(), { success: true });
  assert.equal(await userOf(named, 'target@example.test'), null);
  assert.ok(await userOf(named, 'stays@example.test'));
  assert.ok(await userOf(named, 'operator@example.test'));
  assert.equal((await post(named, '/admin/remove-user', { userId: target.id }, token)).status, 404);
});
