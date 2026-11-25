// tools/better-auth-official/test/scoped-key-by-pass.test.mjs
//
// A person's own engine asks for a key with its caller's pass: POST <base_path><by_pass.create_path> {name, permissions, expires_in}
// with `Authorization: Bearer <pass>` makes a key for the pass's user only, and only when every pattern is in allowed_patterns and
// held by the caller's own credential, expires_in is given and at most most_seconds, and the key ends no later than the caller's
// credential. The answer is {key, id, expires_at}. Revoke {key_id} deletes only a key that user made this way. The passes are the
// sign-in's own: a session pass and a key's pass signed by its jwt plugin, and an AI's access token from the OAuth flow.
import { tempFolder } from '../../../test-helpers/temp-folder.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash, randomBytes } from 'node:crypto';
import { startStore } from '../test-fixtures/embedded-store.mjs';

const dir = tempFolder(join(tmpdir(), 'scoped-key-by-pass-'));
const base = JSON.parse(readFileSync(new URL('../settings.json', import.meta.url), 'utf8'));
const settings = { ...base, email_password: { require_verification: false }, disabled_paths: [], email: { sender: null, from: null }, rate_limit: { enabled: false } };
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
const { signedQuery } = await import('../pages/oauth-query.mjs');
const { mintScopedKey } = await import('../scoped-key.mjs');

const ORIGIN = settings.base_url;
const scoped = settings.api_key.scoped_create;
const DAY = 86400;
const REDIRECT = 'http://127.0.0.1:9/callback';
let from = 0;
const call = (path, { body, cookie, form, bearer } = {}) => auth.handler(new Request(`${ORIGIN}${settings.base_path}${path}`, {
  method: body || form ? 'POST' : 'GET',
  headers: { origin: ORIGIN, 'content-type': form ? 'application/x-www-form-urlencoded' : 'application/json', 'x-forwarded-for': `198.51.100.${(from++ % 250) + 1}`,
    ...(cookie ? { cookie } : {}), ...(bearer ? { authorization: `Bearer ${bearer}` } : {}) },
  body: form ? new URLSearchParams(form) : body && JSON.stringify(body),
}));
// The engine's own call: a pass and a JSON body, no cookie and no origin.
const byPass = (path, bearer, body) => auth.handler(new Request(`${ORIGIN}${settings.base_path}${path}`, {
  method: 'POST', headers: { 'content-type': 'application/json', ...(bearer ? { authorization: `Bearer ${bearer}` } : {}) }, body: JSON.stringify(body),
}));
const create = async (bearer, body) => { const answer = await byPass(scoped.by_pass.create_path, bearer, body); return [answer.status, await answer.json()]; };
const revoke = async (bearer, body) => { const answer = await byPass(scoped.by_pass.revoke_path, bearer, body); return [answer.status, await answer.json()]; };

async function signUp(email) {
  const up = await call('/sign-up/email', { body: { email, password: 'scratch-password-123', name: 'Scratch' } });
  const cookie = up.headers.getSetCookie().map(c => c.split(';')[0]).join('; ');
  return { cookie, user: (await (await auth.$context).internalAdapter.findUserByEmail(email)).user };
}
const one = await signUp('by-pass@example.test');
const other = await signUp('by-pass-other@example.test');
const sign = async payload => (await auth.api.signJWT({ body: { payload } })).token;
const sessionPass = user => sign({ sub: user.id });
const keyPass = (user, key, scope) => { const now = Math.floor(Date.now() / 1000); return sign({ sub: user.id, aud: settings.internal.pass_audience, key_id: key.id, scope, iat: now, exp: now + 300 }); };
const keyRows = async user => Number((await pool.query('select count(*) from apikey where "referenceId" = $1', [user.id])).rows[0].count);
const rowOf = async id => (await pool.query('select "referenceId", "expiresAt", metadata from apikey where id = $1', [id])).rows[0];
const ask = (expires_in, permissions = { door: ['wake:arrive'] }) => ({ name: 'forward facts', permissions, expires_in });

// An AI's access token for `resource` with `scope`, by the OAuth flow the sign-in serves.
const clientId = (await (await call('/oauth2/create-client', { cookie: one.cookie, body: { redirect_uris: [REDIRECT], token_endpoint_auth_method: 'none', application_type: 'native', client_name: 'Local AI' } })).json()).client_id;
async function accessToken(scope, resource) {
  const verifier = randomBytes(32).toString('base64url');
  const query = new URLSearchParams({ response_type: 'code', client_id: clientId, redirect_uri: REDIRECT, scope, state: 's', code_challenge: createHash('sha256').update(verifier).digest('base64url'), code_challenge_method: 'S256', resource });
  const location = (await call(`/oauth2/authorize?${query}`, { cookie: one.cookie })).headers.get('location') ?? '';
  assert.ok(location.startsWith(settings.mcp.consent_page), location);
  const answered = await (await call('/oauth2/consent', { cookie: one.cookie, body: { accept: true, oauth_query: signedQuery(new URL(location, ORIGIN).search) } })).json();
  const code = new URL(answered.url).searchParams.get('code');
  const token = await (await call('/oauth2/token', { form: { grant_type: 'authorization_code', code, redirect_uri: REDIRECT, client_id: clientId, code_verifier: verifier, resource } })).json();
  assert.ok(token.access_token, JSON.stringify(token));
  return token.access_token;
}

test("the person's session pass makes a key for its own user with exactly the asked patterns, marked as made by pass", async () => {
  const [status, made] = await create(await sessionPass(one.user), ask(30 * DAY));
  assert.equal(status, 200, JSON.stringify(made));
  assert.deepEqual(Object.keys(made).sort(), ['expires_at', 'id', 'key'], 'the key, its id and its end, nothing else');
  assert.match(made.key, new RegExp(`^${settings.api_key.prefix}`));
  const verified = await auth.api.verifyApiKey({ body: { key: made.key } });
  assert.equal(verified.valid, true);
  assert.equal(verified.key.referenceId, one.user.id, "the pass's user");
  assert.deepEqual(Object.values(verified.key.permissions).flat(), ['wake:arrive']);
  const row = await rowOf(made.id);
  assert.equal(new Date(row.expiresAt).toISOString(), made.expires_at);
  const metadata = typeof row.metadata === 'string' ? JSON.parse(row.metadata) : row.metadata;
  assert.deepEqual(metadata, { made_by: scoped.by_pass.mark, credential: `session:${one.user.id}` });
});

test('the user comes only from the pass: a body naming a user is refused and no key is made', async () => {
  const before = [await keyRows(one.user), await keyRows(other.user)];
  const [status, refused] = await create(await sessionPass(one.user), { ...ask(DAY), user_id: other.user.id });
  assert.deepEqual([status, refused], [400, { error: 'unknown_field', field: 'user_id' }]);
  assert.deepEqual([await keyRows(one.user), await keyRows(other.user)], before);
});

test('a pattern outside allowed_patterns gets the allow list refusal and no key row', async () => {
  const pass = await sessionPass(one.user);
  for (const permissions of [{ door: ['tools:*'] }, { door: ['*'] }, { door: ['secrets:put'] }, { door: ['wake:arrive', 'sharing.grant'] }, { door: ['wake:*'] }]) {
    const before = await keyRows(one.user);
    const [status, refused] = await create(pass, ask(DAY, permissions));
    assert.deepEqual([status, refused.error], [400, 'pattern_not_allowed'], JSON.stringify(permissions));
    assert.equal(await keyRows(one.user), before);
  }
});

test("a pattern the caller's own credential does not hold is refused, though the allow list names it", async () => {
  const before = await keyRows(one.user);
  const narrow = await accessToken('openid tools:list offline_access', settings.mcp.resource);
  const [status, refused] = await create(narrow, ask(DAY));
  assert.deepEqual([status, refused], [403, { error: 'pattern_not_held_by_caller', pattern: 'wake:arrive' }]);
  assert.equal(await keyRows(one.user), before);
  const wide = await accessToken('openid wake:* offline_access', 'http://127.0.0.1:8788/mcp');
  const [madeStatus, made] = await create(wide, ask(DAY));
  assert.equal(madeStatus, 200, "an AI's access to the person's own engine that holds wake:* makes a wake:arrive key");
  const metadata = (await rowOf(made.id)).metadata;
  assert.equal((typeof metadata === 'string' ? JSON.parse(metadata) : metadata).credential, `mcp-access:${one.user.id}:${clientId}`);
});

test('expires_in is required and at most most_seconds', async () => {
  const pass = await sessionPass(one.user);
  const before = await keyRows(one.user);
  assert.deepEqual(await create(pass, { name: 'no end', permissions: { door: ['wake:arrive'] } }), [400, { error: 'expires_in_required' }]);
  assert.deepEqual(await create(pass, ask(scoped.by_pass.most_seconds + 1)), [400, { error: 'expires_in_too_long', most_seconds: scoped.by_pass.most_seconds }]);
  assert.deepEqual(await create(pass, ask(0)), [400, { error: 'expires_in_invalid' }]);
  assert.equal(await keyRows(one.user), before);
  const [status] = await create(pass, ask(scoped.by_pass.most_seconds));
  assert.equal(status, 200, 'most_seconds itself is allowed');
});

test("a key made by a key's pass ends no later than that key", async () => {
  const [, parent] = await mintScopedKey(auth, scoped, { user_id: one.user.id, name: 'parent', permissions: { door: ['wake:arrive'] }, expires_in: 30 * DAY });
  const pass = await keyPass(one.user, parent, 'wake:arrive');
  const before = await keyRows(one.user);
  const [status, refused] = await create(pass, ask(31 * DAY));
  assert.equal(status, 400);
  assert.equal(refused.error, 'expires_after_credential');
  assert.equal(refused.credential_ends_at, new Date((await rowOf(parent.id)).expiresAt).toISOString());
  assert.equal(await keyRows(one.user), before);
  const [madeStatus, made] = await create(pass, ask(10 * DAY));
  assert.equal(madeStatus, 200);
  assert.ok(new Date(made.expires_at) <= new Date((await rowOf(parent.id)).expiresAt));
});

test('no pass, a pass of no kind here, a forged pass and a credential that no longer stands are each refused 401 with no key', async () => {
  const before = await keyRows(one.user);
  assert.deepEqual(await create(null, ask(DAY)), [401, { error: 'pass_required' }]);
  assert.deepEqual(await create('not-a-pass', ask(DAY)), [401, { error: 'pass_required' }]);
  assert.deepEqual(await create(await sign({ sub: one.user.id, aud: 'https://elsewhere.example/mcp' }), ask(DAY)), [401, { error: 'pass_not_accepted' }]);
  const real = await sessionPass(one.user);
  const [head, body] = real.split('.');
  const forged = [head, Buffer.from(JSON.stringify({ ...JSON.parse(Buffer.from(body, 'base64url')), sub: other.user.id })).toString('base64url'), real.split('.')[2]].join('.');
  assert.deepEqual(await create(forged, ask(DAY)), [401, { error: 'pass_not_accepted' }], 'a pass whose subject was changed does not verify');
  const [, gone] = await mintScopedKey(auth, scoped, { user_id: one.user.id, name: 'gone', permissions: { door: ['wake:arrive'] }, expires_in: 30 * DAY });
  const pass = await keyPass(one.user, gone, 'wake:arrive');
  await pool.query('delete from apikey where id = $1', [gone.id]);
  assert.deepEqual(await create(pass, ask(DAY)), [401, { error: 'credential_not_standing' }], "a key's pass outlives its deleted key by nothing here");
  assert.equal(await keyRows(one.user), before, 'no key was made');
});

test('revoke deletes only a key its own user made by pass, and the key stops verifying', async () => {
  const pass = await sessionPass(one.user);
  const [, made] = await create(pass, ask(DAY));
  const [, theirs] = await create(await sessionPass(other.user), ask(DAY));
  const [, loopback] = await mintScopedKey(auth, scoped, { user_id: one.user.id, name: 'loopback', permissions: { door: ['wake:arrive'] }, expires_in: DAY });
  assert.deepEqual(await revoke(pass, { key_id: theirs.id }), [404, { error: 'key_not_found' }], "another user's key");
  assert.deepEqual(await revoke(pass, { key_id: loopback.id }), [404, { error: 'key_not_found' }], 'a key of this user not made by pass');
  assert.deepEqual(await revoke(pass, { key_id: made.id, also: 1 }), [400, { error: 'key_id_required' }]);
  assert.deepEqual(await revoke(null, { key_id: made.id }), [401, { error: 'pass_required' }]);
  assert.ok(await rowOf(theirs.id) && await rowOf(loopback.id) && await rowOf(made.id), 'nothing was deleted');
  assert.deepEqual(await revoke(pass, { key_id: made.id }), [200, { key_id: made.id, revoked: true }]);
  assert.equal((await auth.api.verifyApiKey({ body: { key: made.key } })).valid, false, 'the revoked key no longer verifies');
  assert.deepEqual(await revoke(pass, { key_id: made.id }), [404, { error: 'key_not_found' }], 'a second revoke finds nothing');
});
