// tools/better-auth-official/test/account-claim.test.mjs
//
// The account a person signed in to rides in every pass the tool signs: settings.account_claim names the user field that
// holds it and the claim it goes out as. The field cannot be set by the person (not at sign-up, not by an update), the
// session JWT carries the claim beside its default claims, and an MCP access token carries it through the provider's
// customAccessTokenClaims. A user with no account gets no claim.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash, randomBytes } from 'node:crypto';

const dir = mkdtempSync(join(tmpdir(), 'account-claim-'));
const settings = { ...JSON.parse(readFileSync(new URL('../settings.json', import.meta.url), 'utf8')), database_path: 'auth.db', disabled_paths: [], email: { outbox: 'outbox.jsonl', command: null } };
writeFileSync(join(dir, 'settings.json'), JSON.stringify(settings));
process.env.BETTER_AUTH_SETTINGS = join(dir, 'settings.json');
process.env.BETTER_AUTH_SECRET = 'a-scratch-secret-for-this-test-only-0123456789';
const { auth } = await import('../auth.mjs');
const { getMigrations } = await import('better-auth/db/migration');
await (await getMigrations(auth.options)).runMigrations();
const { accessTokenClaims } = await import('../account-claim.mjs');

const ACCOUNT = 'ab'.repeat(32);
const ORIGIN = settings.base_url;
const call = (path, { body, cookie } = {}) => auth.handler(new Request(`${ORIGIN}${settings.base_path}${path}`, {
  method: body ? 'POST' : 'GET', headers: { origin: ORIGIN, 'content-type': 'application/json', ...(cookie ? { cookie } : {}) }, body: body && JSON.stringify(body),
}));
const claimsOf = jwt => JSON.parse(Buffer.from(jwt.split('.')[1], 'base64url').toString());

test('a person cannot set their own account at sign-up', async () => {
  const response = await call('/sign-up/email', { body: { email: 'self-set@example.test', password: 'scratch-password-123', name: 'Scratch', trillionAccount: ACCOUNT } });
  assert.notEqual(response.status, 200);
});

test('the session JWT carries trillion_account beside its default claims, and none when the user has no account', async () => {
  const up = await call('/sign-up/email', { body: { email: 'claim@example.test', password: 'scratch-password-123', name: 'Scratch' } });
  assert.equal(up.status, 200);
  const cookie = up.headers.getSetCookie().map(c => c.split(';')[0]).join('; ');
  const before = claimsOf((await (await call('/token', { cookie })).json()).token);
  assert.equal(before.trillion_account, undefined);
  const ctx = await auth.$context;
  const user = await ctx.internalAdapter.findUserByEmail('claim@example.test');
  await ctx.internalAdapter.updateUser(user.user.id, { trillionAccount: ACCOUNT });
  const pass = claimsOf((await (await call('/token', { cookie })).json()).token);
  assert.equal(pass.trillion_account, ACCOUNT);
  assert.equal(pass.sub, user.user.id);
  assert.equal(pass.email, 'claim@example.test');
  assert.equal(pass.iss, settings.issuer);
});

test('an MCP access token (at+jwt for the MCP resource) carries trillion_account', async () => {
  const up = await call('/sign-up/email', { body: { email: 'mcp@example.test', password: 'scratch-password-123', name: 'Scratch' } });
  const cookie = up.headers.getSetCookie().map(c => c.split(';')[0]).join('; ');
  const ctx = await auth.$context;
  await ctx.internalAdapter.updateUser((await ctx.internalAdapter.findUserByEmail('mcp@example.test')).user.id, { trillionAccount: ACCOUNT });
  const redirect = 'http://127.0.0.1:9/callback';
  const client = await (await call('/oauth2/create-client', { cookie, body: { redirect_uris: [redirect], token_endpoint_auth_method: 'none', application_type: 'native', client_name: 'scratch' } })).json();
  const verifier = randomBytes(32).toString('base64url');
  const query = new URLSearchParams({ response_type: 'code', client_id: client.client_id, redirect_uri: redirect, scope: 'openid profile email offline_access records tools', state: 's', code_challenge: createHash('sha256').update(verifier).digest('base64url'), code_challenge_method: 'S256', resource: settings.mcp.resource });
  const step = await call(`/oauth2/authorize?${query}`, { cookie });
  let location = step.headers.get('location') ?? (await step.json().catch(() => ({}))).url ?? '';
  if (/consent/.test(location)) {
    const consent = await (await call('/oauth2/consent', { cookie, body: { accept: true, oauth_query: new URL(location, ORIGIN).search.slice(1) } })).json();
    location = consent.url ?? consent.redirect_uri ?? '';
  }
  const code = new URL(location, ORIGIN).searchParams.get('code');
  assert.ok(code, 'an authorization code');
  const token = await (await auth.handler(new Request(`${ORIGIN}${settings.base_path}/oauth2/token`, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ grant_type: 'authorization_code', code, redirect_uri: redirect, client_id: client.client_id, code_verifier: verifier, resource: settings.mcp.resource }) }))).json();
  const header = JSON.parse(Buffer.from(token.access_token.split('.')[0], 'base64url').toString());
  const claims = claimsOf(token.access_token);
  assert.equal(header.typ, 'at+jwt');
  assert.ok([claims.aud].flat().includes(settings.mcp.resource));
  assert.equal(claims.trillion_account, ACCOUNT);
  assert.deepEqual(claims.scope.split(' ').filter(word => settings.mcp.resource_scopes.includes(word)).sort(), ['records', 'tools'], 'the scope claim carries the Trillion scopes asked for');
  assert.equal(claims.email, 'mcp@example.test');
  assert.equal(claims.email_verified, false, 'the email and whether it is verified, as OIDC names them');
});

test('the provider and the MCP resource offer every Trillion scope', async () => {
  const server = await (await auth.handler(new Request(`${ORIGIN}/.well-known/oauth-authorization-server`))).json();
  for (const scope of settings.mcp.resource_scopes) assert.ok(server.scopes_supported.includes(scope), `scopes_supported names ${scope}`);
  const resource = await (await auth.handler(new Request(`${ORIGIN}/.well-known/oauth-protected-resource${new URL(settings.mcp.resource).pathname}`))).json();
  assert.equal(resource.resource, settings.mcp.resource);
  assert.deepEqual([...resource.scopes_supported].sort(), [...settings.mcp.resource_scopes].sort(), 'the MCP resource allows exactly the Trillion scopes');
});

test('the claim comes only from the user a token is for, and an absent account gives none', async () => {
  assert.deepEqual(await accessTokenClaims(settings)({ user: { id: 'u', trillionAccount: ACCOUNT }, scopes: [] }), { trillion_account: ACCOUNT });
  assert.deepEqual(await accessTokenClaims(settings)({ user: { id: 'u' }, scopes: [] }), {});
  assert.deepEqual(await accessTokenClaims(settings)({ user: null, scopes: [] }), {});
  assert.deepEqual(await accessTokenClaims({ ...settings, account_claim: undefined })({ user: { trillionAccount: ACCOUNT }, scopes: [] }), {});
});
