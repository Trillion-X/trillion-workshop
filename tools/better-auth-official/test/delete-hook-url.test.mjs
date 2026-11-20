// tools/better-auth-official/test/delete-hook-url.test.mjs
//
// Before a person's account is deleted, the business's own clean-up can be reached by a local address (settings.delete_user.before_delete_url):
// this tool POSTs {user_id, email} to it, signed with the secret the unit holds. A 2xx answer deletes the account; any other answer, a refused
// connection or a timeout keeps it, and the person is told. An address that is not on this computer is refused when the server starts.
import { tempFolder } from '../../../test-helpers/temp-folder.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { createServer } from 'node:http';
import { mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { startStore } from '../test-fixtures/embedded-store.mjs';

const KEY = 'scratch-clean-up-key-0123456789';
const dir = tempFolder(join(tmpdir(), 'delete-hook-url-'));
const credentials = join(dir, 'credentials');
mkdirSync(credentials);
writeFileSync(join(credentials, 'before-delete-secret'), `${KEY}\n`);
process.env.CREDENTIALS_DIRECTORY = credentials;

// The business's clean-up, on this computer: what it was sent, and what it answers (set by each test).
const received = [];
let answer = { status: 200 };
const cleanUp = createServer((request, response) => {
  const chunks = [];
  request.on('data', chunk => chunks.push(chunk));
  request.on('end', () => {
    received.push({ path: request.url, method: request.method, headers: request.headers, body: Buffer.concat(chunks).toString('utf8') });
    if (answer.status === 'hang') return;
    response.writeHead(answer.status).end(answer.status === 204 ? undefined : '{}');
  });
});
await new Promise(listening => cleanUp.listen(0, '127.0.0.1', listening));
const cleanUpUrl = `http://127.0.0.1:${cleanUp.address().port}/clean-up`;
test.after(() => { cleanUp.closeAllConnections(); cleanUp.close(); });

const shipped = JSON.parse(readFileSync(new URL('../settings.json', import.meta.url), 'utf8'));
const withDeleteUser = delete_user => ({
  ...shipped, email_password: { require_verification: false }, disabled_paths: [], rate_limit: { ...shipped.rate_limit, enabled: false },
  delete_user: { ...shipped.delete_user, ...delete_user },
});
const settingsFile = join(dir, 'settings.json');
writeFileSync(settingsFile, JSON.stringify(withDeleteUser({ before_delete_url: cleanUpUrl, before_delete_secret: 'before-delete-secret', before_delete_timeout_ms: 2000 })));
process.env.BETTER_AUTH_SETTINGS = settingsFile;
const store = await startStore();
process.env.BETTER_AUTH_STORE_CONNECTION = await store.database();
process.env.BETTER_AUTH_SECRET = 'a-scratch-secret-for-this-test-only-0123456789';
const { auth, pool } = await import('../auth.mjs');
store.hold(pool);
test.after(() => store.stop());
const { getMigrations } = await import('better-auth/db/migration');
await (await getMigrations(auth.options)).runMigrations();

const ORIGIN = shipped.base_url;
const PASSWORD = 'scratch-password-123';
const post = (instance, path, body, token) => instance.handler(new Request(`${ORIGIN}${shipped.base_path}${path}`, {
  method: 'POST',
  headers: { origin: ORIGIN, 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
  body: JSON.stringify(body),
}));
const signUp = async (email) => (await (await post(auth, '/sign-up/email', { email, password: PASSWORD, name: 'Scratch' })).json()).user;
const signIn = async (email) => (await post(auth, '/sign-in/email', { email, password: PASSWORD })).headers.get('set-auth-token');
const userOf = async (email) => (await (await auth.$context).internalAdapter.findUserByEmail(email))?.user ?? null;

test('a 2xx answer from the clean-up deletes the account, and the clean-up was told who', async () => {
  const user = await signUp('gone-200@example.test');
  await signUp('stays-200@example.test');
  const token = await signIn('gone-200@example.test');
  received.length = 0;
  answer = { status: 200 };
  const deleted = await post(auth, '/delete-user', { password: PASSWORD }, token);
  assert.equal(deleted.status, 200);
  assert.equal(await userOf('gone-200@example.test'), null);
  assert.ok(await userOf('stays-200@example.test'), 'another person stays');
  assert.equal(received.length, 1);
  assert.equal(received[0].method, 'POST');
  assert.equal(received[0].path, '/clean-up');
  assert.deepEqual(JSON.parse(received[0].body), { user_id: user.id, email: 'gone-200@example.test' });
});

test('a 204 answer is a 2xx too, and deletes the account', async () => {
  await signUp('gone-204@example.test');
  const token = await signIn('gone-204@example.test');
  answer = { status: 204 };
  assert.equal((await post(auth, '/delete-user', { password: PASSWORD }, token)).status, 200);
  assert.equal(await userOf('gone-204@example.test'), null);
});

test('a 500 answer keeps the account, and the person is told the deletion did not happen', async () => {
  await signUp('kept-500@example.test');
  const token = await signIn('kept-500@example.test');
  answer = { status: 500 };
  const refused = await post(auth, '/delete-user', { password: PASSWORD }, token);
  assert.ok(refused.status >= 400, `refused with ${refused.status}`);
  assert.ok(await userOf('kept-500@example.test'), 'the account stays');
});

test('every request to the clean-up carries a timestamp and an HMAC-SHA256 signature over it and the body, made with the held secret', async () => {
  await signUp('signed@example.test');
  const token = await signIn('signed@example.test');
  received.length = 0;
  answer = { status: 200 };
  assert.equal((await post(auth, '/delete-user', { password: PASSWORD }, token)).status, 200);
  const [request] = received;
  const timestamp = request.headers['x-sign-in-timestamp'];
  const signature = request.headers['x-sign-in-signature'];
  assert.match(timestamp, /^\d{10}$/, 'whole seconds');
  assert.ok(Math.abs(Date.now() / 1000 - Number(timestamp)) < 60, 'a fresh time');
  assert.match(signature, /^sha256=[0-9a-f]{64}$/);
  const expected = `sha256=${createHmac('sha256', KEY).update(`${timestamp}.${request.body}`).digest('hex')}`;
  assert.equal(signature, expected, 'the signature checks against the body received, with the held key');
  const wrongKey = `sha256=${createHmac('sha256', 'not-the-key').update(`${timestamp}.${request.body}`).digest('hex')}`;
  assert.notEqual(signature, wrongKey, 'a signature under another key does not check');
});

test('a clean-up that answers too late keeps the account (the timeout is settings.delete_user.before_delete_timeout_ms)', async () => {
  await signUp('slow@example.test');
  const token = await signIn('slow@example.test');
  const slowSettings = join(dir, 'settings-slow.json');
  writeFileSync(slowSettings, JSON.stringify(withDeleteUser({ before_delete_url: cleanUpUrl, before_delete_secret: 'before-delete-secret', before_delete_timeout_ms: 300 })));
  process.env.BETTER_AUTH_SETTINGS = slowSettings;
  const { auth: slow, pool: slowPool } = await import('../auth.mjs?delete-hook-slow');
  store.hold(slowPool);
  answer = { status: 'hang' };
  received.length = 0;
  const refused = await post(slow, '/delete-user', { password: PASSWORD }, token);
  answer = { status: 200 };
  assert.equal(received.length, 1, 'the clean-up was asked, and never answered');
  assert.ok(refused.status >= 400, `refused with ${refused.status}`);
  assert.ok(await userOf('slow@example.test'), 'the account stays');
});

test('a clean-up that cannot be reached keeps the account', async () => {
  const closed = createServer();
  await new Promise(listening => closed.listen(0, '127.0.0.1', listening));
  const deadUrl = `http://127.0.0.1:${closed.address().port}/clean-up`;
  await new Promise(done => closed.close(done));
  await signUp('unreachable@example.test');
  const token = await signIn('unreachable@example.test');
  const deadSettings = join(dir, 'settings-dead.json');
  writeFileSync(deadSettings, JSON.stringify(withDeleteUser({ before_delete_url: deadUrl, before_delete_secret: 'before-delete-secret' })));
  process.env.BETTER_AUTH_SETTINGS = deadSettings;
  const { auth: dead, pool: deadPool } = await import('../auth.mjs?delete-hook-dead');
  store.hold(deadPool);
  const refused = await post(dead, '/delete-user', { password: PASSWORD }, token);
  assert.ok(refused.status >= 400, `refused with ${refused.status}`);
  assert.ok(await userOf('unreachable@example.test'), 'the account stays');
});

// A settings file is read when the server starts; each case starts the reader on its own, as a computer's start does.
function startsWith(url, secret = 'before-delete-secret') {
  const file = join(dir, `start-${Math.random().toString(36).slice(2)}.json`);
  writeFileSync(file, JSON.stringify(withDeleteUser({ before_delete_url: url, before_delete_secret: secret })));
  const settingsModule = new URL('../settings.mjs', import.meta.url).href;
  return spawnSync(process.execPath, ['--input-type=module', '-e', `import { readSettings } from '${settingsModule}'; readSettings();`], {
    env: { ...process.env, BETTER_AUTH_SETTINGS: file }, encoding: 'utf8',
  });
}

test('an address that is not on this computer is refused when the server starts, and the start says why', () => {
  for (const url of ['http://example.test/clean-up', 'http://10.0.0.5:8080/clean-up', 'http://localhost.example.test/clean-up', 'https://example.test/clean-up', 'http://127.0.0.1.example.test/x']) {
    const started = startsWith(url);
    assert.notEqual(started.status, 0, `${url} must not start`);
    assert.match(started.stderr, /before_delete_url must be an http address on 127\.0\.0\.1 or localhost/, url);
  }
  const notAnAddress = startsWith('not an address');
  assert.notEqual(notAnAddress.status, 0);
  assert.match(notAnAddress.stderr, /is not an address/);
});

test('an address on this computer (127.0.0.1 or localhost) starts, and a missing secret name is refused at start', () => {
  assert.equal(startsWith('http://127.0.0.1:9/clean-up').status, 0);
  assert.equal(startsWith('http://localhost:9/clean-up').status, 0);
  const noSecret = startsWith('http://127.0.0.1:9/clean-up', null);
  assert.notEqual(noSecret.status, 0);
  assert.match(noSecret.stderr, /needs before_delete_secret/);
});
