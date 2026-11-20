// tools/better-auth-official/test/loopback-resource.test.mjs
//
// A person's own engine names itself as the resource an AI asks for (its loopback address, a port, /mcp), one per computer, so no list of them
// can be configured: such a resource is accepted when it is exactly a host of settings.mcp.loopback_resources over http at a port with the
// path, and every other resource is refused as before (the sign-in tool's own door stays configured).
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash, randomBytes } from 'node:crypto';
import { startStore } from '../test-fixtures/embedded-store.mjs';
import { loopbackResource } from '../loopback-resource.mjs';

const dir = mkdtempSync(join(tmpdir(), 'loopback-resource-'));
const settings = { ...JSON.parse(readFileSync(new URL('../settings.json', import.meta.url), 'utf8')), email_password: { require_verification: false }, disabled_paths: [], email: { sender: null, from: null } };
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
const rule = settings.mcp.loopback_resources;

const ORIGIN = settings.base_url;
const REDIRECT = 'http://127.0.0.1:9/callback';
let from = 0;
const call = (path, { body, cookie, form } = {}) => auth.handler(new Request(`${ORIGIN}${settings.base_path}${path}`, {
  method: body || form ? 'POST' : 'GET',
  headers: { origin: ORIGIN, 'content-type': form ? 'application/x-www-form-urlencoded' : 'application/json', 'x-forwarded-for': `198.51.100.${(from++ % 250) + 1}`, ...(cookie ? { cookie } : {}) },
  body: form ? new URLSearchParams(form) : body && JSON.stringify(body),
}));
const up = await call('/sign-up/email', { body: { email: 'loopback@example.test', password: 'scratch-password-123', name: 'Scratch' } });
const cookie = up.headers.getSetCookie().map(c => c.split(';')[0]).join('; ');
const clientId = (await (await call('/oauth2/create-client', { cookie, body: { redirect_uris: [REDIRECT], token_endpoint_auth_method: 'none', application_type: 'native', client_name: 'Local AI' } })).json()).client_id;

// An AI's connect to the end for `resource`: { refused } when authorize turns it away, else the token answer.
async function connect(resource) {
  const verifier = randomBytes(32).toString('base64url');
  const query = new URLSearchParams({ response_type: 'code', client_id: clientId, redirect_uri: REDIRECT, scope: 'openid wake:* offline_access', state: 's', code_challenge: createHash('sha256').update(verifier).digest('base64url'), code_challenge_method: 'S256', resource });
  const asked = await call(`/oauth2/authorize?${query}`, { cookie });
  const location = asked.headers.get('location') ?? '';
  if (!location.startsWith(settings.mcp.consent_page)) return { refused: location || asked.status };
  const answered = await (await call('/oauth2/consent', { cookie, body: { accept: true, oauth_query: signedQuery(new URL(location, ORIGIN).search) } })).json();
  const code = new URL(answered.url).searchParams.get('code');
  assert.ok(code, answered.url);
  const token = await (await call('/oauth2/token', { form: { grant_type: 'authorization_code', code, redirect_uri: REDIRECT, client_id: clientId, code_verifier: verifier, resource } })).json();
  return { token };
}
const audienceOf = token => JSON.parse(Buffer.from(token.access_token.split('.')[1], 'base64url').toString()).aud;

test('a loopback engine of any port is accepted as the resource in each spelling the settings list, and its token is for that engine', async () => {
  for (const resource of ['http://127.0.0.1:8788/mcp', 'http://[::1]:39001/mcp', 'http://localhost:54718/mcp']) {
    const { token, refused } = await connect(resource);
    assert.equal(refused, undefined, `${resource} was refused: ${refused}`);
    assert.ok([audienceOf(token)].flat().includes(resource), `the token is for ${resource}: ${JSON.stringify(audienceOf(token))}`);
    assert.ok(token.refresh_token, 'and it stays connected');
  }
  assert.equal((await pool.query('select count(*)::int as n from "oauthResource" where identifier like $1', ['http://127.0.0.1:8788%'])).rows[0].n, 1, 'one row, however often it is asked');
  await connect('http://127.0.0.1:8788/mcp');
  assert.equal((await pool.query('select count(*)::int as n from "oauthResource" where identifier = $1', ['http://127.0.0.1:8788/mcp'])).rows[0].n, 1);
});

test('every other resource is refused: another host, a lookalike, a spelling of loopback the list does not name, a user name, https, no port, another path', async () => {
  for (const resource of ['https://evil.example.test/mcp', 'http://127.0.0.1.evil.example.test:8788/mcp', 'http://0.0.0.0:8788/mcp', 'http://127.1:8788/mcp', 'http://user@127.0.0.1:8788/mcp', 'https://127.0.0.1:8788/mcp', 'http://127.0.0.1/mcp', 'http://127.0.0.1:8788/other', 'http://127.0.0.1:8788/mcp?x=1', 'http://127.0.0.1:99999/mcp', 'http://127.0.0.1:08788/mcp']) {
    const { refused } = await connect(resource);
    assert.ok(refused, `${resource} must be refused`);
    assert.equal(loopbackResource(resource, rule), null, resource);
  }
  assert.equal((await pool.query('select count(*)::int as n from "oauthResource" where identifier like $1', ['%evil%'])).rows[0].n, 0, 'a refused resource leaves no row');
  assert.equal(loopbackResource('http://127.0.0.1:8788/mcp', rule), 'http://127.0.0.1:8788/mcp');
  assert.equal(loopbackResource('http://[::1]:8788/mcp', rule), 'http://[::1]:8788/mcp');
});

test('a row kept with scopes from before is brought to the settings\' scopes, so the engine is not refused', async () => {
  const resource = 'http://127.0.0.1:8799/mcp';
  await pool.query(`insert into "oauthResource" (id, identifier, name, "allowedScopes", "createdAt", "updatedAt") values ($1, $2, $3, $4, now(), now())`,
    ['old-row-8799', resource, rule.name, JSON.stringify(['records', 'tools', 'records-read', 'tools-list'])]);
  const { token, refused } = await connect(resource);
  assert.equal(refused, undefined, `${resource} was refused: ${refused}`);
  assert.ok([audienceOf(token)].flat().includes(resource));
  const held = (await pool.query('select "allowedScopes" as s from "oauthResource" where identifier = $1', [resource])).rows;
  assert.equal(held.length, 1);
  assert.deepEqual(held[0].s, settings.mcp.resource_scopes);
});
