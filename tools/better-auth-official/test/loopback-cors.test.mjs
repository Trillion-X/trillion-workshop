// tools/better-auth-official/test/loopback-cors.test.mjs
//
// A page on a person's own loopback address exchanges its code at the token endpoint by its own fetch: the endpoint names exactly that
// loopback origin, never with credentials, and names no other origin or path; the metadata document that names that endpoint does the
// same for GET. Against the real Better Auth, a code exchange sent from such
// a page (its loopback Origin, no cookie) is answered with a token.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash, randomBytes } from 'node:crypto';
import { startStore } from '../test-fixtures/embedded-store.mjs';
import { loopbackCorsHeaders, loopbackOrigin } from '../loopback-cors.mjs';

const dir = mkdtempSync(join(tmpdir(), 'loopback-cors-'));
const settings = { ...JSON.parse(readFileSync(new URL('../settings.json', import.meta.url), 'utf8')), email_password: { require_verification: false }, disabled_paths: [] };
const rule = settings.mcp.loopback_resources;
const TOKEN = `${settings.base_path}/oauth2/token`;
const asked = (url, origin) => ({ url, headers: origin === undefined ? {} : { origin } });

test('only an exact loopback origin with a port is named, and only at the token endpoint', () => {
  for (const origin of ['http://127.0.0.1:8788', 'http://localhost:1', 'http://[::1]:65535']) {
    assert.equal(loopbackOrigin(origin, rule), origin);
    const headers = loopbackCorsHeaders(asked(TOKEN, origin), settings);
    assert.equal(headers['access-control-allow-origin'], origin);
    assert.equal(headers['access-control-allow-credentials'], undefined, 'no cookie rides with it');
    assert.equal(headers.vary, 'Origin');
  }
  for (const origin of ['https://127.0.0.1:8788', 'http://127.0.0.1', 'http://127.0.0.1:0', 'http://127.0.0.1:8788/', 'http://user@127.0.0.1:8788',
    'http://10.0.0.5:8788', 'http://localhost.evil.test:8788', 'https://evil.example', 'null', '', undefined]) {
    assert.equal(loopbackCorsHeaders(asked(TOKEN, origin), settings), null, String(origin));
  }
  for (const path of [`${settings.base_path}/oauth2/authorize`, `${settings.base_path}/oauth2/consent`, `${settings.base_path}/get-session`, `${TOKEN}/x`, '/oauth2/token']) {
    assert.equal(loopbackCorsHeaders(asked(path, 'http://127.0.0.1:8788'), settings), null, path);
  }
  assert.ok(loopbackCorsHeaders(asked(`${TOKEN}?x=1`, 'http://127.0.0.1:8788'), settings), 'a query does not change the path');});

test('the authorization server metadata names a loopback origin for GET, in both its forms', () => {
  for (const path of ['/.well-known/oauth-authorization-server', `/.well-known/oauth-authorization-server${settings.base_path}`]) {
    const headers = loopbackCorsHeaders(asked(path, 'http://127.0.0.1:8788'), settings);
    assert.equal(headers['access-control-allow-origin'], 'http://127.0.0.1:8788', path);
    assert.equal(headers['access-control-allow-methods'], 'GET');
    assert.equal(headers['access-control-allow-credentials'], undefined);
    assert.equal(loopbackCorsHeaders(asked(path, 'https://evil.example'), settings), null, path);
  }
  for (const path of ['/.well-known/oauth-authorization-serverx', '/.well-known/openid-configuration/x', '/.well-known/webauthn']) {
    assert.equal(loopbackCorsHeaders(asked(path, 'http://127.0.0.1:8788'), settings), null, path);
  }
  assert.equal(loopbackCorsHeaders(asked(TOKEN, 'http://127.0.0.1:8788'), settings)['access-control-allow-methods'], 'POST');
});

test('a code exchange sent from a loopback page with no cookie is answered with a token', async () => {
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
  const ORIGIN = settings.base_url;
  const PAGE = 'http://127.0.0.1:8788';
  const REDIRECT = `${PAGE}/pages/tasks/signed-in`;
  const call = (path, { body, cookie, form, origin = ORIGIN } = {}) => auth.handler(new Request(`${ORIGIN}${settings.base_path}${path}`, {
    method: body || form ? 'POST' : 'GET',
    headers: { origin, 'content-type': form ? 'application/x-www-form-urlencoded' : 'application/json', ...(cookie ? { cookie } : {}) },
    body: form ? new URLSearchParams(form) : body && JSON.stringify(body),
  }));
  const up = await call('/sign-up/email', { body: { email: 'page@example.test', password: 'scratch-password-123', name: 'Scratch' } });
  const cookie = up.headers.getSetCookie().map(c => c.split(';')[0]).join('; ');
  const clientId = (await (await call('/oauth2/create-client', { cookie, body: { redirect_uris: [REDIRECT], token_endpoint_auth_method: 'none', application_type: 'native', client_name: 'Task page' } })).json()).client_id;
  const verifier = randomBytes(32).toString('base64url');
  const query = new URLSearchParams({ response_type: 'code', client_id: clientId, redirect_uri: REDIRECT, scope: 'openid wake:* tools:*', state: 's',
    code_challenge: createHash('sha256').update(verifier).digest('base64url'), code_challenge_method: 'S256', resource: settings.mcp.resource });
  const location = (await call(`/oauth2/authorize?${query}`, { cookie })).headers.get('location');
  const answered = await (await call('/oauth2/consent', { cookie, body: { accept: true, oauth_query: signedQuery(new URL(location, ORIGIN).search) } })).json();
  const code = new URL(answered.url).searchParams.get('code');
  const token = await call('/oauth2/token', { origin: PAGE, form: { grant_type: 'authorization_code', code, redirect_uri: REDIRECT, client_id: clientId, code_verifier: verifier, resource: settings.mcp.resource } });
  const body = await token.json();
  assert.equal(token.status, 200, JSON.stringify(body));
  assert.ok(body.access_token);
});
