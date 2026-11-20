// tools/better-auth-official/test/internal-verify.test.mjs
//
// The engine checks a personal API key with one call: settings.internal names a loopback listener that answers only
// POST <verify_path> {key} with Better Auth's own verifyApiKey, as {valid, key: {id, userId, permissions}}. The public
// listener (the one Caddy reaches) never answers it. New keys start with settings.api_key.prefix, whatever the request asked
// for; a key's user is the person it signs in.
import { tempFolder } from '../../../test-helpers/temp-folder.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { writeFileSync, readFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startStore } from '../test-fixtures/embedded-store.mjs';

const freePort = () => new Promise(done => { const s = createServer().listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => done(port)); }); });
const dir = tempFolder(join(tmpdir(), 'internal-verify-'));
const [port, internal] = [await freePort(), await freePort()];
const base = JSON.parse(readFileSync(new URL('../settings.json', import.meta.url), 'utf8'));
const settings = { ...base, port, base_url: `http://localhost:${port}`, issuer: `http://localhost:${port}`, audience: `http://localhost:${port}`, trusted_origins: [`http://localhost:${port}`], email_password: { require_verification: false }, rate_limit: { enabled: false }, internal: { ...base.internal, port: internal }, api_key: { ...base.api_key, default_permissions: { example: ['wake:*', 'tools:*'] } } };
writeFileSync(join(dir, 'settings.json'), JSON.stringify(settings));
const store = await startStore();
const connection = await store.database();
const env = { ...process.env, BETTER_AUTH_STORE_CONNECTION: connection, BETTER_AUTH_SETTINGS: join(dir, 'settings.json'), BETTER_AUTH_SECRET: 'a-scratch-secret-for-this-test-only-0123456789' };
const tool = new URL('..', import.meta.url).pathname;
const { auth, pool } = await (async () => { process.env.BETTER_AUTH_SETTINGS = env.BETTER_AUTH_SETTINGS; process.env.BETTER_AUTH_STORE_CONNECTION = connection; process.env.BETTER_AUTH_SECRET = env.BETTER_AUTH_SECRET; return import('../auth.mjs'); })();
const { getMigrations } = await import('better-auth/db/migration');
await (await getMigrations(auth.options)).runMigrations();
const server = spawn(process.execPath, [join(tool, 'server.mjs')], { env, stdio: ['ignore', 'pipe', 'inherit'] });
store.hold(pool);
test.after(async () => { server.kill(); await store.stop(); });
await new Promise(done => { setTimeout(done, 30000); server.stdout.on('data', function wait(chunk) { if (/internal/.test(String(chunk))) { server.stdout.off('data', wait); done(); } }); });

const ORIGIN = settings.base_url;
const post = (url, body, cookie) => fetch(url, { method: 'POST', headers: { origin: ORIGIN, 'content-type': 'application/json', ...(cookie ? { cookie } : {}) }, body: JSON.stringify(body) });
const up = await post(`${ORIGIN}/api/auth/sign-up/email`, { email: 'keys@example.test', password: 'scratch-password-123', name: 'Scratch' });
const cookie = up.headers.getSetCookie().map(c => c.split(';')[0]).join('; ');
const ctx = await auth.$context;
const user = (await ctx.internalAdapter.findUserByEmail('keys@example.test')).user;
const made = await (await post(`${ORIGIN}/api/auth/api-key/create`, { name: 'scratch' }, cookie)).json();
const verify = key => post(`http://127.0.0.1:${internal}${settings.internal.verify_path}`, { key });

test('a new key is the settings prefix and 64 letters, whatever prefix the request asks for', async () => {
  assert.match(made.key ?? '', new RegExp(`^${settings.api_key.prefix}[A-Za-z]{64}$`));
  const asked = await (await post(`${ORIGIN}/api/auth/api-key/create`, { name: 'own prefix', prefix: 'mine_' }, cookie)).json();
  assert.match(asked.key ?? '', new RegExp(`^${settings.api_key.prefix}[A-Za-z]{64}$`));
});

test('the internal listener verifies a key: valid, its id, its user and its permissions', async () => {
  const answer = await (await verify(made.key)).json();
  assert.deepEqual(answer, { valid: true, key: { id: made.id, userId: user.id, permissions: settings.api_key.default_permissions } });
});

test('an altered key, or no key, is not valid', async () => {
  assert.deepEqual(await (await verify(`${made.key.slice(0, -2)}zz`)).json(), { valid: false, key: null });
  assert.equal((await verify('')).status, 400);
});

test('the public listener never answers the verify path, and Better Auth\'s own verify stays server-only', async () => {
  assert.equal((await post(`${ORIGIN}${settings.internal.verify_path}`, { key: made.key })).status, 404);
  assert.equal((await post(`${ORIGIN}/api/auth/api-key/verify`, { key: made.key })).status, 404);
  assert.equal((await fetch(`http://127.0.0.1:${internal}/api/auth/ok`)).status, 404, 'the internal listener answers nothing else');
});

test('a key stays valid however often the engine checks it (the settings rate limit, not the plugin default of 10 a day)', async () => {
  for (let check = 0; check < 12; check++) assert.equal((await (await verify(made.key)).json()).valid, true, `check ${check + 1}`);
});

test('a key checked on the internal listener has its last use noted (the use fact a grant\'s end reads)', async () => {
  const before = (await pool.query('select "lastRequest" from apikey where id = $1', [made.id])).rows[0].lastRequest;
  assert.equal((await (await verify(made.key)).json()).valid, true);
  const after = (await pool.query('select "lastRequest" from apikey where id = $1', [made.id])).rows[0].lastRequest;
  assert.ok(after && (!before || new Date(after) > new Date(before)), `lastRequest ${before} -> ${after}`);
});

test('a verified key is handed a short pass signed with the sign-in\'s own keys: its person, key and scopes, for the MCP resource', async () => {
  const asked = await post(`http://127.0.0.1:${internal}${settings.internal.pass_path}`, { key: made.key });
  const answer = await asked.json();
  assert.equal(answer.expires_in, settings.internal.pass_seconds);
  const [, body] = answer.pass.split('.');
  const claims = JSON.parse(Buffer.from(body, 'base64url').toString());
  assert.equal(claims.sub, user.id);
  assert.equal(claims.key_id, made.id);
  assert.equal(claims.aud, settings.internal.pass_audience, 'its own audience, so no door takes it for a sign-in or an AI\'s pass');
  assert.equal(claims.iss, settings.issuer);
  assert.equal(claims.exp - claims.iat, settings.internal.pass_seconds);
  assert.deepEqual(claims.scope.split(' ').sort(), [...new Set(Object.values(settings.api_key.default_permissions).flat())].sort());
  const { createLocalJWKSet, jwtVerify } = await import('jose');
  const keys = createLocalJWKSet(await (await fetch(`${ORIGIN}/api/auth/jwks`)).json());
  const { payload } = await jwtVerify(answer.pass, keys, { issuer: settings.issuer, audience: settings.internal.pass_audience });
  assert.equal(payload.sub, user.id, 'the pass checks against the sign-in\'s published keys, as every computer checks it');
  assert.deepEqual(await (await post(`http://127.0.0.1:${internal}${settings.internal.pass_path}`, { key: `${made.key.slice(0, -2)}zz` })).json(), { valid: false }, 'an altered key gets no pass');
  assert.equal((await post(`${ORIGIN}${settings.internal.pass_path}`, { key: made.key })).status, 404, 'the public listener never answers it');
});

test('a key pass stands while its key does and is its user\'s; a URL client id is kept whole', async () => {
  const { credentialStands } = await import('../credential-standing.mjs');
  const standing = settings.credential_standing;
  assert.equal(await credentialStands(auth, standing, `key-pass:${user.id}:${made.id}`), true);
  assert.equal(await credentialStands(auth, standing, `key-pass:someone-else:${made.id}`), false, 'another user\'s id never stands for this key');
  const gone = await (await post(`${ORIGIN}/api/auth/api-key/create`, { name: 'to delete' }, cookie)).json();
  await post(`${ORIGIN}/api/auth/api-key/delete`, { keyId: gone.id }, cookie);
  assert.equal(await credentialStands(auth, standing, `key-pass:${user.id}:${gone.id}`), false, 'a deleted key\'s pass does not stand');
  assert.equal(await credentialStands(auth, standing, `mcp-access:${user.id}:https://example.test/client.json`), false, 'a URL client is looked up whole (no grant here)');
});
