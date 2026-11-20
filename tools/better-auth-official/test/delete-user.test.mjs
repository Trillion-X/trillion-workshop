// tools/better-auth-official/test/delete-user.test.mjs
//
// A signed-in person deletes their own user (Better Auth's user.deleteUser). On by default, as shipped (settings.json delete_user.enabled):
// the same person with their password deletes their own user and every other user stays; a wrong password deletes nothing. Off (a computer
// that must not offer it), POST /delete-user answers 404 and the user stays. The business's own module (delete_user.before_delete_module)
// runs before anything is deleted and a throw there keeps the account; the person's API keys go once the account is gone. The second start
// reads the new settings into a fresh copy of auth.mjs over the same database, as a computer restarted from its changed computer row does.
import { tempFolder } from '../../../test-helpers/temp-folder.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startStore } from '../test-fixtures/embedded-store.mjs';

const dir = tempFolder(join(tmpdir(), 'delete-user-'));
const shipped = JSON.parse(readFileSync(new URL('../settings.json', import.meta.url), 'utf8'));
const hookFile = join(dir, 'own-rows.mjs');
writeFileSync(hookFile, `
  export const calls = [];
  export let refuse = false;
  export function setRefuse(value) { refuse = value; }
  export async function beforeDelete(user) {
    calls.push(user.email);
    if (refuse) throw new Error('the business keeps this person');
  }
`);
// The limits are per client address; this test has none, so every sign-in would share one bucket: the limit is off for this scratch run.
const settings = { ...shipped, email_password: { require_verification: false }, disabled_paths: [], rate_limit: { ...shipped.rate_limit, enabled: false } };
const settingsFile = join(dir, 'settings.json');
writeFileSync(settingsFile, JSON.stringify({ ...settings, delete_user: { enabled: true, before_delete_module: hookFile } }));
process.env.BETTER_AUTH_SETTINGS = settingsFile;
const store = await startStore();
process.env.BETTER_AUTH_STORE_CONNECTION = await store.database();
process.env.BETTER_AUTH_SECRET = 'a-scratch-secret-for-this-test-only-0123456789';
const { auth: on, pool } = await import('../auth.mjs');
store.hold(pool);
test.after(() => store.stop());
const { getMigrations } = await import('better-auth/db/migration');
await (await getMigrations(on.options)).runMigrations();
const hook = await import(hookFile);

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
const keysOf = async (auth, userId) => (await (await auth.$context).adapter.findMany({ model: 'apikey', where: [{ field: 'referenceId', value: userId }] })).length;

await signUp(on, 'leaving@example.test');
await signUp(on, 'stays@example.test');
await signUp(on, 'refused@example.test');

test('as shipped, delete-user is on: settings.json names the default and the business hook is off', () => {
  assert.equal(shipped.delete_user.enabled, true);
  assert.equal(shipped.delete_user.before_delete_module, null);
});

test('turned on, a wrong password deletes nothing and the right one deletes only the person asking', async () => {
  const token = await signIn(on, 'leaving@example.test');
  assert.equal((await post(on, '/delete-user', { password: 'not-the-password-1' }, token)).status, 400);
  assert.ok(await userOf(on, 'leaving@example.test'));
  const deleted = await post(on, '/delete-user', { password: PASSWORD }, token);
  assert.equal(deleted.status, 200);
  assert.equal((await deleted.json()).success, true);
  assert.equal(await userOf(on, 'leaving@example.test'), null);
  assert.ok(await userOf(on, 'stays@example.test'));
});

test('the business hook runs before the account goes, and its throw keeps the account', async () => {
  const token = await signIn(on, 'refused@example.test');
  hook.setRefuse(true);
  const refused = await post(on, '/delete-user', { password: PASSWORD }, token);
  hook.setRefuse(false);
  assert.ok(refused.status >= 400);
  assert.ok(await userOf(on, 'refused@example.test'));
  assert.deepEqual(hook.calls, ['leaving@example.test', 'refused@example.test']);
  const again = await post(on, '/delete-user', { password: PASSWORD }, token);
  assert.equal(again.status, 200);
  assert.equal(await userOf(on, 'refused@example.test'), null);
});

test('a person\'s API keys go with their account, and another person\'s stay', async () => {
  const keeper = await signIn(on, 'stays@example.test');
  const made = await (await post(on, '/api-key/create', { name: 'scratch-key' }, keeper)).json();
  assert.ok(made.id);
  const leaver = await signUp(on, 'keys@example.test');
  const leaverToken = await signIn(on, 'keys@example.test');
  await post(on, '/api-key/create', { name: 'leaving-key' }, leaverToken);
  assert.equal(await keysOf(on, leaver.id), 1);
  assert.equal((await post(on, '/delete-user', { password: PASSWORD }, leaverToken)).status, 200);
  assert.equal(await keysOf(on, leaver.id), 0);
  assert.equal(await keysOf(on, (await userOf(on, 'stays@example.test')).id), 1);
});

test('turned off, the same address answers 404 and the user stays', async () => {
  writeFileSync(settingsFile, JSON.stringify({ ...settings, delete_user: { enabled: false } }));
  const { auth: off, pool: offPool } = await import('../auth.mjs?delete-user-off');
  store.hold(offPool);
  const token = await signIn(off, 'stays@example.test');
  assert.equal((await post(off, '/delete-user', { password: PASSWORD }, token)).status, 404);
  assert.ok(await userOf(off, 'stays@example.test'));
});
