// tools/better-auth-official/test/scoped-key.test.mjs
//
// A program on the computer asks the internal listener for a key with exact permissions: POST settings.api_key.scoped_create.path
// {user_id, name, permissions, expires_in?} answers {key, id} once, for a key whose permissions are exactly the asked patterns, each
// one settings.api_key.scoped_create.allowed_patterns names. Anything else is refused with no key made: a pattern outside the list,
// an empty permissions object, an extra field, an unknown user, a caller that is not this computer or came through a proxy. The
// shipped settings are used as they are, so default_permissions stays null and a key a person makes reaches nothing.
import { tempFolder } from '../../../test-helpers/temp-folder.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { writeFileSync, readFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { startStore } from '../test-fixtures/embedded-store.mjs';

const freePort = () => new Promise(done => { const s = createServer().listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => done(port)); }); });
const dir = tempFolder(join(tmpdir(), 'scoped-key-'));
const [port, internal] = [await freePort(), await freePort()];
const base = JSON.parse(readFileSync(new URL('../settings.json', import.meta.url), 'utf8'));
const settings = { ...base, port, base_url: `http://localhost:${port}`, issuer: `http://localhost:${port}`, audience: `http://localhost:${port}`, trusted_origins: [`http://localhost:${port}`], email_password: { require_verification: false }, rate_limit: { enabled: false }, internal: { ...base.internal, port: internal } };
writeFileSync(join(dir, 'settings.json'), JSON.stringify(settings));
const store = await startStore();
const connection = await store.database();
const env = { ...process.env, BETTER_AUTH_STORE_CONNECTION: connection, BETTER_AUTH_SETTINGS: join(dir, 'settings.json'), BETTER_AUTH_SECRET: 'a-scratch-secret-for-this-test-only-0123456789' };
const tool = new URL('..', import.meta.url).pathname;
const { auth, pool } = await (async () => { process.env.BETTER_AUTH_SETTINGS = env.BETTER_AUTH_SETTINGS; process.env.BETTER_AUTH_STORE_CONNECTION = connection; process.env.BETTER_AUTH_SECRET = env.BETTER_AUTH_SECRET; return import('../auth.mjs'); })();
const { serveInternal } = await import('../internal-verify.mjs');
const { getMigrations } = await import('better-auth/db/migration');
await (await getMigrations(auth.options)).runMigrations();
const server = spawn(process.execPath, [join(tool, 'server.mjs')], { env, stdio: ['ignore', 'pipe', 'inherit'] });
store.hold(pool);
test.after(async () => { server.kill(); await store.stop(); });
await new Promise(done => { setTimeout(done, 30000); server.stdout.on('data', function wait(chunk) { if (/internal/.test(String(chunk))) { server.stdout.off('data', wait); done(); } }); });

const ORIGIN = settings.base_url;
const scoped = settings.api_key.scoped_create;
const post = (url, body, headers = {}) => fetch(url, { method: 'POST', headers: { origin: ORIGIN, 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) });
const up = await post(`${ORIGIN}/api/auth/sign-up/email`, { email: 'scoped@example.test', password: 'scratch-password-123', name: 'Scratch' });
const cookie = up.headers.getSetCookie().map(c => c.split(';')[0]).join('; ');
const user = (await (await auth.$context).internalAdapter.findUserByEmail('scoped@example.test')).user;
const create = (body, headers) => post(`http://127.0.0.1:${internal}${scoped.path}`, body, headers);
const verify = key => post(`http://127.0.0.1:${internal}${settings.internal.verify_path}`, { key });
const keyRows = async () => Number((await pool.query('select count(*) from apikey where "referenceId" = $1', [user.id])).rows[0].count);

test('the shipped allow list is exactly wake:arrive, and default_permissions stays null', () => {
  assert.deepEqual(base.api_key.scoped_create.allowed_patterns, ['wake:arrive']);
  assert.equal(base.api_key.default_permissions, null);
});

test('a key made with {"door":["wake:arrive"]} verifies to permissions that flatten to exactly ["wake:arrive"]', async () => {
  const asked = await create({ user_id: user.id, name: 'wake receiver', permissions: { door: ['wake:arrive'] }, expires_in: 86400 * 30 });
  assert.equal(asked.status, 200);
  const made = await asked.json();
  assert.deepEqual(Object.keys(made).sort(), ['id', 'key'], 'the answer is the key and its id, nothing else');
  assert.match(made.key, new RegExp(`^${settings.api_key.prefix}[A-Za-z]{64}$`), 'the settings prefix, like every key');
  const answer = await (await verify(made.key)).json();
  assert.equal(answer.valid, true);
  assert.equal(answer.key.id, made.id);
  assert.equal(answer.key.userId, user.id);
  assert.deepEqual(Object.values(answer.key.permissions).flat(), ['wake:arrive']);
  const row = (await pool.query('select "expiresAt" from apikey where id = $1', [made.id])).rows[0];
  const days = (new Date(row.expiresAt) - Date.now()) / 86400000;
  assert.ok(days > 29.9 && days <= 30, `expires_in is kept: ${days} days`);
});

test('a pattern outside the allow list is refused and no key row is made', async () => {
  for (const permissions of [{ door: ['tools:*'] }, { door: ['*'] }, { door: ['secrets:put'] }, { door: ['wake:arrive', 'secrets:put'] }, { door: ['wake:*'] }, { door: ['wake:arrive '] }, { door: [7] }]) {
    const before = await keyRows();
    const asked = await create({ user_id: user.id, name: 'too wide', permissions });
    assert.equal(asked.status, 400, JSON.stringify(permissions));
    assert.equal((await asked.json()).error, 'pattern_not_allowed');
    assert.equal(await keyRows(), before, `no key row for ${JSON.stringify(permissions)}`);
  }
});

test('an empty permissions object, an empty pattern list, an extra field or a missing name is refused with no key made', async () => {
  const before = await keyRows();
  const cases = [
    [{ user_id: user.id, name: 'none', permissions: {} }, 'permissions_required'],
    [{ user_id: user.id, name: 'none', permissions: { door: [] } }, 'permissions_required'],
    [{ user_id: user.id, name: 'none' }, 'permissions_required'],
    [{ user_id: user.id, name: 'extra', permissions: { door: ['wake:arrive'] }, prefix: 'mine_' }, 'unknown_field'],
    [{ user_id: user.id, name: 'extra', permissions: { door: ['wake:arrive'] }, remaining: 5 }, 'unknown_field'],
    [{ user_id: user.id, permissions: { door: ['wake:arrive'] } }, 'name_required'],
    [{ user_id: user.id, name: 'bad end', permissions: { door: ['wake:arrive'] }, expires_in: -1 }, 'expires_in_invalid'],
    [['wake:arrive'], 'body_not_an_object'],
  ];
  for (const [body, error] of cases) {
    const asked = await create(body);
    assert.equal(asked.status, 400, JSON.stringify(body));
    assert.equal((await asked.json()).error, error, JSON.stringify(body));
  }
  assert.equal(await keyRows(), before);
});

test('an unknown user is refused', async () => {
  const total = Number((await pool.query('select count(*) from apikey')).rows[0].count);
  const asked = await create({ user_id: 'no-such-user', name: 'nobody', permissions: { door: ['wake:arrive'] } });
  assert.equal(asked.status, 404);
  assert.deepEqual(await asked.json(), { error: 'unknown_user' });
  assert.equal(Number((await pool.query('select count(*) from apikey')).rows[0].count), total);
  assert.equal((await create({ name: 'nobody', permissions: { door: ['wake:arrive'] } })).status, 400, 'no user_id');
});

test('a caller that is not this computer is refused before its body is read, and so is one a proxy carried', async () => {
  const before = await keyRows();
  const listener = serveInternal(auth, { ...settings.internal, port: 0 }, null, scoped);
  const answered = await new Promise(done => {
    const request = Object.assign(Readable.from([JSON.stringify({ user_id: user.id, name: 'far', permissions: { door: ['wake:arrive'] } })]), { method: 'POST', url: scoped.path, headers: {}, socket: { remoteAddress: '203.0.113.7' } });
    const response = { writeHead(status) { this.status = status; return this; }, end(body) { done({ status: this.status, body: JSON.parse(body) }); } };
    listener.emit('request', request, response);
  });
  listener.close();
  assert.deepEqual(answered, { status: 403, body: { error: 'loopback_only' } });
  for (const header of [{ 'x-forwarded-for': '203.0.113.7' }, { forwarded: 'for=203.0.113.7' }, { 'x-real-ip': '203.0.113.7' }]) {
    const asked = await create({ user_id: user.id, name: 'carried', permissions: { door: ['wake:arrive'] } }, header);
    assert.equal(asked.status, 403, JSON.stringify(header));
  }
  assert.equal(await keyRows(), before);
});

test('only the internal listener answers the path; the public one never does', async () => {
  assert.equal((await post(`${ORIGIN}${scoped.path}`, { user_id: user.id, name: 'public', permissions: { door: ['wake:arrive'] } })).status, 404);
});

test('default_permissions is untouched: a key a person makes carries none, and the client still cannot set permissions', async () => {
  const made = await (await post(`${ORIGIN}/api/auth/api-key/create`, { name: 'mine' }, { cookie })).json();
  assert.equal((await (await verify(made.key)).json()).key.permissions, null);
  const widened = await post(`${ORIGIN}/api/auth/api-key/create`, { name: 'wide', permissions: { door: ['wake:arrive'] } }, { cookie });
  assert.equal(widened.status, 400, 'permissions stay server-only');
});
